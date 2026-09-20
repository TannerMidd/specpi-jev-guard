/**
 * e2e-charts.mjs — figures for the Testing page, from tests/pi-e2e-results.json.
 * No network: run `npm run e2e` first, then `npm run e2e:charts`.
 *
 * Writes, tokenized for both themes (see svg-util.mjs):
 *   tests/e2e-batches.svg    scenarios per area, passed and failed
 *   tests/e2e-decisions.svg  what the guard did with every call it judged
 *   tests/e2e-table.html     the full scenario list, inlined by docs:sync
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  ON, P, axisLine, barSeg, gridV, label, legend, subtitle, svgClose, svgOpen, title,
} from "./svg-util.mjs";

const data = JSON.parse(readFileSync(new URL("./pi-e2e-results.json", import.meta.url), "utf-8"));
const { meta, rows } = data;

const write = (base, render) => writeFileSync(new URL(`./${base}.svg`, import.meta.url), render(), "utf-8");

/* ------------------------------------------------ 1. scenarios per area */

const AREA = {
  "batch A: command surface": ["The commands you type", "/jev-guard status, check, on, off, model, backend"],
  "batch B: the gate": ["The gate itself", "a real agent proposing real tool calls"],
  "batch C: failure modes and config": ["When things go wrong", "no key, no network, a timeout, odd config"],
  "batch D: install and setup": ["Getting started", "the install commands and the guided setup"],
};

function renderBatches() {
  const order = [...new Set(rows.map((r) => r.batch))];
  const bars = order.map((b) => {
    const mine = rows.filter((r) => r.batch === b);
    return {
      name: AREA[b]?.[0] ?? b,
      note: AREA[b]?.[1] ?? "",
      passed: mine.filter((r) => r.pass).length,
      failed: mine.filter((r) => !r.pass && !r.declined).length,
      skipped: mine.filter((r) => r.declined).length,
    };
  });

  const W = 1020, L = 330, RH = 26, PITCH = 62, T = 170;
  const H = T + bars.length * PITCH + 70;
  const plotW = W - L - 90;
  const max = Math.max(...bars.map((b) => b.passed + b.failed + b.skipped));
  const sx = (n) => (n / max) * plotW;

  let s = svgOpen(W, H, { alt: "Scenarios run in each area of the extension" });
  s += title(40, 46, `${meta.scenarios} scenarios, run against a real pi installation`);
  s += subtitle(40, 70, `Every one drives the packed extension inside a sandboxed pi, with ${meta.agentModel} proposing the calls.`);
  s += subtitle(40, 90, "Longer is more coverage. Red is a scenario that did not do what it should.");
  s += legend(L, 118, [
    { label: "behaved as specified", color: P.allow },
    { label: "did not", color: P.block },
    { label: "not exercised: the agent declined", color: P.muted },
  ]);

  const ticks = [];
  for (let t = 0; t <= max; t += max > 10 ? 5 : 2) ticks.push(t);
  const axisY = T + bars.length * PITCH - 18;
  s += gridV(ticks.slice(1).map((t) => L + sx(t)), T - 12, axisY);
  s += axisLine(L, axisY, L + plotW);

  let y = T;
  for (const b of bars) {
    s += label(L - 18, y + 12, b.name, { anchor: "end", size: 13.5, weight: 650 });
    s += label(L - 18, y + 30, b.note, { anchor: "end", size: 11.5, fill: P.muted });
    let x = L;
    const WORD = { allow: "behaved as specified", block: "did not", muted: "was not exercised" };
    const FILL = { allow: P.allow, block: P.block, muted: P.muted };
    const INK = { allow: ON.allow, block: ON.block, muted: "#ffffff" };
    const parts = [[b.passed, "allow"], [b.failed, "block"], [b.skipped, "muted"]].filter(([n]) => n > 0);
    parts.forEach(([n, kind], i) => {
      const w = sx(n);
      const last = i === parts.length - 1;
      s += barSeg({
        x, y, width: Math.max(w - (last ? 0 : 2), 2), height: RH, fill: FILL[kind], end: last,
        tip: `${n} scenario${n === 1 ? "" : "s"} ${WORD[kind]}`,
      });
      if (w > 26) {
        s += label(x + w / 2, y + RH / 2 + 5, String(n), { anchor: "middle", size: 12.5, weight: 700, fill: INK[kind] });
      }
      x += w;
    });
    s += label(x + 12, y + RH / 2 + 5, `${b.passed + b.failed + b.skipped} scenarios`, { size: 12, fill: P.muted });
    y += PITCH;
  }
  for (const t of ticks) s += label(L + sx(t), axisY + 22, String(t), { anchor: "middle", size: 11.5, fill: P.muted, tabular: true });
  s += svgClose();
  return s;
}

/* -------------------------------- 2. what the guard did with each call */

const OUTCOMES = [
  { key: "rules-block", band: "block", label: "Refused by a local rule", note: "hard-deny or your own list, 0 ms, no network" },
  { key: "jev-block", band: "block", label: "Refused by the classifier", note: "scored at or above the block threshold" },
  { key: "asked-no", band: "ask", label: "Asked, and the answer was no", note: "middle band, confirmation declined" },
  { key: "asked-yes", band: "ask", label: "Asked, and the answer was yes", note: "middle band, confirmation given, call ran" },
  { key: "jev-allow", band: "allow", label: "Allowed after judging", note: "scored below the ask threshold" },
  { key: "list-allow", band: "allow", label: "Allowed by your own list", note: "allowedCommands, recorded but not judged" },
  { key: "no-key", band: "block", label: "Refused: no classifier key", note: "fails closed rather than running unvouched" },
  { key: "error", band: "block", label: "Refused: classifier unreachable", note: "network error or timeout, fails closed" },
];

function classify(a) {
  if (a.decision === "asked-allowed") return "asked-yes";
  if (a.decision === "asked-blocked") return "asked-no";
  if (a.source === "rules") return "rules-block";
  if (a.source === "no-key") return "no-key";
  if (a.source === "error") return "error";
  if (a.source === "allowlist") return "list-allow";
  if (a.source === "jev") return a.decision === "blocked" ? "jev-block" : "jev-allow";
  return null;
}

function renderDecisions() {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o.key, 0]));
  for (const row of rows) for (const a of row.audits ?? []) {
    const k = classify(a);
    if (k) counts[k] += 1;
  }
  const bars = OUTCOMES.filter((o) => counts[o.key] > 0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const W = 1020, L = 360, RH = 24, PITCH = 56, T = 160;
  const H = T + bars.length * PITCH + 64;
  const plotW = W - L - 110;
  const max = Math.max(1, ...bars.map((b) => counts[b.key]));
  const sx = (n) => (n / max) * plotW;
  const BAND = { block: P.block, ask: P.ask, allow: P.allow };

  let s = svgOpen(W, H, { alt: "What the guard did with every call it judged during the run" });
  s += title(40, 46, `Every call the guard judged, and what it did`);
  s += subtitle(40, 70, `${total} decisions recorded across the run, read from the audit entries the extension writes into the session.`);
  s += subtitle(40, 90, "One bar per outcome. Red refused the call, amber stopped to ask, green let it run.");

  const ticks = [];
  for (let t = 0; t <= max; t += max > 8 ? 2 : 1) ticks.push(t);
  const axisY = T + bars.length * PITCH - 16;
  s += gridV(ticks.slice(1).map((t) => L + sx(t)), T - 10, axisY);
  s += axisLine(L, axisY, L + plotW);

  let y = T;
  for (const b of bars) {
    const n = counts[b.key];
    s += label(L - 18, y + 11, b.label, { anchor: "end", size: 13, weight: 650 });
    s += label(L - 18, y + 28, b.note, { anchor: "end", size: 11.5, fill: P.muted });
    const w = sx(n);
    s += barSeg({ x: L, y, width: Math.max(w, 3), height: RH, fill: BAND[b.band], end: true, tip: `${n} call${n === 1 ? "" : "s"}: ${b.label.toLowerCase()}` });
    const inside = w > 30;
    s += label(inside ? L + w - 10 : L + w + 10, y + RH / 2 + 5, String(n), {
      anchor: inside ? "end" : "start", size: 13, weight: 700, fill: inside ? ON[b.band] : P.text,
    });
    y += PITCH;
  }
  for (const t of ticks) s += label(L + sx(t), axisY + 22, String(t), { anchor: "middle", size: 11.5, fill: P.muted, tabular: true });
  s += label(40, H - 22, "A call the guard never saw is not counted here: read-only commands and ordinary project files never reach it.", { size: 12.5, fill: P.muted });
  s += svgClose();
  return s;
}

/* ------------------------------------------- 3. the full scenario list */

const esc = (v) =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The throwaway sandbox path is noise on a published page. */
const tidy = (text) =>
  String(text).split(meta.sandbox).join("<sandbox>").split(meta.sandbox.split("\\").join("/")).join("<sandbox>");

/** One line of evidence per scenario: what the guard actually did. */
function evidence(row) {
  const audits = (row.audits ?? [])
    .map((a) => `${a.source}: ${a.decision}${typeof a.danger === "number" ? ` at ${a.danger.toFixed(2)}` : ""}`)
    .join(", ");
  const bits = [];
  if (audits) bits.push(audits);
  if (row.dialogs > 0) bits.push(`${row.dialogs} confirmation prompt${row.dialogs === 1 ? "" : "s"}`);
  if (row.declined) return "the agent would not issue the command, so the guard was never reached";
  if (!audits && !row.dialogs) {
    const first = tidy(row.observed).split("|")[0].trim();
    bits.push(first.length > 120 ? first.slice(0, 120) + "..." : first || "no gate involved");
  }
  return bits.join(", ");
}

function renderTable() {
  const order = [...new Set(rows.map((r) => r.batch))];
  let html = "";
  for (const b of order) {
    const mine = rows.filter((r) => r.batch === b);
    const [name, note] = AREA[b] ?? [b, ""];
    html += `<h3>${esc(name)}</h3>
`;
    if (note) html += `<p class="table-note">${esc(note)}</p>
`;
    html += `<table class="results">
<thead>
<tr><th>Check</th><th>What happened</th><th>Verdict</th></tr>
</thead>
<tbody>
`;
    for (const r of mine) {
      html +=
        `<tr><td>${esc(r.title)}</td>` +
        `<td class="ev">${esc(evidence(r))}</td>` +
        `<td class="${r.declined ? "skip" : r.pass ? "ok" : "bad"}">` +
        `${r.declined ? "not exercised" : r.pass ? "as specified" : "not yet"}</td></tr>
`;
    }
    html += `</tbody>
</table>
`;
  }
  return html;
}

/** The four numbers at the top of the page, so they cannot drift from the run. */
function renderStats() {
  const decisions = rows.flatMap((r) => r.audits ?? []);
  const latencies = decisions.map((a) => a.latencyMs).filter((n) => typeof n === "number" && n > 0).sort((a, b) => a - b);
  const median = latencies.length
    ? latencies.length % 2
      ? latencies[(latencies.length - 1) / 2]
      : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2)
    : 0;
  const exercised = rows.filter((r) => !r.declined).length;
  return `<div class="stat-grid">
  <div class="stat-card"><strong>${rows.length}</strong><span>scenarios in one recorded run</span></div>
  <div class="stat-card"><strong>${decisions.length}</strong><span>decisions the guard recorded, live</span></div>
  <div class="stat-card"><strong>${median} ms</strong><span>median classifier answer in the run</span></div>
  <div class="stat-card good"><strong>${meta.passed} of ${exercised}</strong><span>exercised scenarios behaved as specified</span></div>
</div>`;
}

write("e2e-batches", renderBatches);
write("e2e-decisions", renderDecisions);
writeFileSync(new URL("./e2e-table.html", import.meta.url), renderTable(), "utf-8");
writeFileSync(new URL("./e2e-stats.html", import.meta.url), renderStats() + "\n", "utf-8");
console.log("e2e:charts — wrote e2e-batches.svg, e2e-decisions.svg, e2e-table.html, e2e-stats.html");
