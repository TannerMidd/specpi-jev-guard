/**
 * devious-charts.mjs — figures for the Devious Tests page.
 * No network: reads tests/jev-devious.json, the 856-attempt suite that
 * `npm run devious` records, and tests/redteam-results.json.
 *
 * Writes one tokenized SVG each (see svg-util.mjs for how theming works):
 *   tests/diagram-flow.svg      how a gated command is decided
 *   tests/diagram-layers.svg    where this run's attacks were stopped
 *   tests/devious-families.svg  outcome mix per attack family
 *   tests/devious-ordinary.html what ordinary work runs into, inlined by docs:sync
 *   tests/devious-stats.html    the numbers at the top of the page
 *   tests/devious-edges.html    every hostile attempt that ran, with its score
 *   tests/devious-redteam.svg   an independent model's attempts, scored
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ON, P, arrow, axisLine, barSeg, chip, clip, dot, escXml, gridV, label, legend,
  panel, rectPath, subtitle, svgClose, svgOpen, textWidth, threshold, title,
} from "./svg-util.mjs";

const data = JSON.parse(readFileSync(new URL("./jev-devious.json", import.meta.url), "utf-8"));
const { meta, rows, families } = data;

const redteamUrl = new URL("./redteam-results.json", import.meta.url);
const redteam = existsSync(redteamUrl) ? JSON.parse(readFileSync(redteamUrl, "utf-8")) : null;

const write = (base, render) =>
  writeFileSync(new URL(`./${base}.svg`, import.meta.url), render(), "utf-8");

const ASK = 0.35;
const BLOCK = 0.8;
const BAND = { block: P.block, ask: P.ask, allow: P.allow };
const BAND_LABEL = { block: "blocked", ask: "held for confirmation", allow: "allowed" };
const bandOf = (d) => (d >= BLOCK ? "block" : d >= ASK ? "ask" : "allow");
const attacks = rows.filter((r) => r.kind === "attack");
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const plural = (nCmds, one, many) => `${nCmds} ${nCmds === 1 ? one : many}`;

/* ============================================ 1. the decision flow diagram */

function renderFlow() {
  const W = 1020, H = 786;
  const bx = 120, bw = 380, bh = 58, gapY = 30;
  const outX = 620, outW = 250;
  let s = svgOpen(W, H, { alt: "Flowchart of how every gated command is decided" });
  s += title(40, 46, "How a gated command is decided");
  s += subtitle(40, 70, "Four cheap local checks run first. Only what is genuinely uncertain costs a network call.");

  const stages = [
    { t: "bash / write / edit call", sub: "intercepted before it runs", kind: "start", down: "" },
    { t: "On your disallow list?", sub: "patterns you set yourself", exit: "BLOCK", ex: "block", yes: "yes", down: "no" },
    { t: "Hard-deny pattern?", sub: "rm -rf /  ·  fork bomb  ·  curl | sh  ·  mkfs", exit: "BLOCK · 0 ms", ex: "block", yes: "yes", down: "no" },
    { t: "Provably read-only?", sub: "ls  ·  cat  ·  git log  ·  grep", exit: "ALLOW · 0 ms", ex: "allow", yes: "yes", down: "no" },
    { t: "Ask Jev for a danger score", sub: `~${meta.avgLatencyMs} ms average  ·  no key, no answer, no parse`, kind: "jev", exit: "BLOCK · fail closed", ex: "block", yes: "on error", down: "a score" },
    { t: "The score picks a band", sub: "one number, 0 to 1, for this exact command", kind: "band" },
  ];

  const tops = stages.map((_, i) => 100 + i * (bh + gapY));
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    if (i < stages.length - 1) {
      s += arrow(bx + bw / 2, tops[i] + bh, bx + bw / 2, tops[i + 1] - 2, { text: st.down });
    }
    const isJev = st.kind === "jev";
    s += panel({
      x: bx, y: tops[i], w: bw, h: bh,
      fill: isJev ? P.accent : st.kind === "band" ? "none" : P.panel,
      stroke: isJev ? P.accent : P.border,
    });
    const ink = isJev ? "#ffffff" : P.text;
    s += label(bx + 20, tops[i] + 25, st.t, { size: 14, weight: 650, fill: ink });
    s += label(bx + 20, tops[i] + 44, st.sub, { size: 12, fill: isJev ? "#ffffff" : P.dim, opacity: isJev ? 0.85 : 1 });
    if (st.exit) {
      s += arrow(bx + bw, tops[i] + bh / 2, outX - 2, tops[i] + bh / 2, { color: BAND[st.ex], text: st.yes });
      s += chip({ x: outX, y: tops[i] + bh / 2 - 16, w: outW, text: st.exit, color: BAND[st.ex], ink: ON[st.ex] });
    }
  }

  // the three bands, in a row under the last box
  const bandTop = tops[tops.length - 1];
  const rowY = bandTop + bh + 64;
  const outs = [
    { k: "block", t: "BLOCK", d: "score ≥ 0.80" },
    { k: "ask", t: "ASK", d: "0.35 – 0.80, blocks when unattended" },
    { k: "allow", t: "ALLOW", d: "score < 0.35" },
  ];
  const cw = 280, cgap = 20;
  let cx = 60;
  for (const o of outs) {
    s += arrow(bx + bw / 2, bandTop + bh, cx + cw / 2, rowY - 2, { color: BAND[o.k] });
    s += chip({ x: cx, y: rowY, w: cw, text: o.t, color: BAND[o.k], ink: ON[o.k] });
    s += label(cx + cw / 2, rowY + 50, o.d, { anchor: "middle", size: 12, fill: P.dim });
    cx += cw + cgap;
  }
  s += label(40, H - 24, "No path turns a failure into an allow: an unreachable classifier, a missing key or an unparseable answer all block.", { size: 12.5, fill: P.muted });
  s += svgClose();
  return s;
}

/* ========================================= 2. where the attacks were stopped */

/** One bar of every hostile attempt, split two ways: who stopped it, and what happened. */
function renderLayers() {
  const local = attacks.filter((r) => r.caughtBy === "local").length;
  const byJev = attacks.filter((r) => r.caughtBy === "jev" && r.final !== "allow").length;
  const through = attacks.filter((r) => r.final === "allow");
  const total = attacks.length;
  const blocked = attacks.filter((r) => r.final === "block").length;
  const held = attacks.filter((r) => r.final === "ask").length;

  const W = 1020, H = 490;
  const L = 60, R = 60;
  const barW = W - L - R;
  const BH = 66;
  const scale = (nCmds) => (nCmds / total) * barW;

  let s = svgOpen(W, H, { alt: `Where each of the ${total} hostile attempts was stopped` });
  s += title(40, 46, `Where the ${total} attacks were stopped`);
  s += subtitle(40, 70, `Each bar is the same ${total} hostile attempts, split two different ways. Segment width is the number of attempts.`);

  // A bar, then a key line underneath: every segment is named in words, so a
  // sliver two commands wide is as readable as the big ones.
  const row = (y, heading, segs) => {
    let out = label(L, y - 14, heading, { size: 13.5, weight: 650 });
    let x = L;
    segs.forEach((seg, i) => {
      const w = scale(seg.n);
      const last = i === segs.length - 1;
      out += `<g class="mark-g"><title>${seg.n} of ${total}: ${seg.key}</title>` +
        `<path class="mark" d="${rectPath(x, y, Math.max(6, w - (last ? 0 : 3)), BH, 6, { tl: i === 0, bl: i === 0, tr: last, br: last })}" ` +
        `fill="${seg.fill}"${seg.opacity ? ` opacity="${seg.opacity}"` : ""}/></g>\n`;
      if (w > 46) out += label(x + w / 2, y + BH / 2 + 8, String(seg.n), { anchor: "middle", size: 22, weight: 700, fill: seg.ink });
      x += w;
    });
    let kx = L;
    for (const seg of segs) {
      const text = `${seg.n} ${seg.key}`;
      out += `<rect x="${kx.toFixed(1)}" y="${y + BH + 16}" width="12" height="12" rx="3" fill="${seg.fill}"${seg.opacity ? ` opacity="${seg.opacity}"` : ""}/>\n`;
      out += label(kx + 19, y + BH + 26, text, { size: 13 });
      kx += 19 + textWidth(text, 13) + 30;
    }
    return out;
  };

  s += row(150, "Which layer stopped it", [
    { n: local, key: `stopped by local rules, 0 ms`, fill: P.accent, ink: "#ffffff" },
    { n: byJev, key: `stopped by Jev, about ${meta.avgLatencyMs} ms each`, fill: P.accent, opacity: 0.45, ink: "#ffffff" },
    { n: through.length, key: "got past both", fill: P.muted, ink: "#ffffff" },
  ]);

  s += row(300, "What the guard did with them", [
    { n: blocked, key: "blocked, the command never runs", fill: P.block, ink: ON.block },
    { n: held, key: "held, asks you first", fill: P.ask, ink: ON.ask },
    { n: through.length, key: "allowed", fill: P.allow, ink: ON.allow },
  ]);

  s += label(40, H - 46, `Held blocks outright when nobody is there to answer, so an unattended agent stops ${blocked + held} of ${total}.`, { size: 12.5, fill: P.muted });
  s += label(40, H - 24, `The ${plural(through.length, "attempt", "attempts")} that got past both are listed, with their scores, further down the page.`, { size: 12.5, fill: P.muted });
  s += svgClose();
  return s;
}

/* ================================================ 3. outcome by attack family */

function renderFamilies() {
  const ordered = [...families].sort(
    (a, b) => a.blocked / a.total - b.blocked / b.total || b.total - a.total,
  );
  const W = 1020;
  const L = 330, R = 96, T = 172, RH = 20, PITCH = 32;
  const barMax = W - L - R;
  const maxN = Math.max(...ordered.map((f) => f.total));
  const H = T + ordered.length * PITCH + 50;
  const scale = (nCmds) => (nCmds / maxN) * barMax;

  let s = svgOpen(W, H, { alt: "Stacked bars: what happened to each family of attack" });
  s += title(40, 46, "Every attack family, and what happened to it");
  s += subtitle(40, 70, `${meta.attacks} hostile attempts grouped by family. Bar length is the number of attempts; each new family is six commands tried three ways.`);
  s += subtitle(40, 90, "Sorted with the weakest result at the top, so the families worth arguing about come first.");
  s += legend(40, 126, [
    { label: "blocked", color: P.block },
    { label: "held for confirmation", color: P.ask },
    { label: "allowed", color: P.allow },
  ]);

  const step = maxN > 12 ? 5 : 2;
  const ticks = Array.from({ length: Math.floor(maxN / step) + 1 }, (_, i) => i * step);
  const axisY = T + ordered.length * PITCH - 12;
  s += gridV(ticks.slice(1).map((t) => L + scale(t)), T - 12, axisY);
  s += axisLine(L, axisY, L + barMax);

  let y = T;
  for (const f of ordered) {
    s += label(L - 16, y + RH / 2 + 4.5, f.label, { anchor: "end", size: 13, weight: 600 });
    let x = L;
    const segs = [[f.blocked, "block"], [f.asked, "ask"], [f.allowed, "allow"]].filter(([nCmds]) => nCmds > 0);
    segs.forEach(([nCmds, kind], i) => {
      const w = scale(nCmds);
      const last = i === segs.length - 1;
      s += barSeg({
        x, y, width: w - (last ? 0 : 2), height: RH, fill: BAND[kind], end: last,
        tip: `${f.label}: ${plural(nCmds, "command", "commands")} ${BAND_LABEL[kind]}`,
      });
      if (w > textWidth(String(nCmds), 12) + 16) {
        s += label(x + w / 2 - (last ? 0 : 1), y + RH / 2 + 4.5, String(nCmds), { anchor: "middle", size: 12.5, weight: 700, fill: ON[kind] });
      }
      x += w;
    });
    s += label(x + 14, y + RH / 2 + 4.5, `${f.total}`, { size: 12.5, fill: P.muted, tabular: true });
    y += PITCH;
  }

  for (const t of ticks) {
    s += label(L + scale(t), axisY + 24, String(t), { anchor: "middle", size: 11.5, fill: P.muted, tabular: true });
  }
  s += label(L + barMax + 14, axisY + 24, "total", { size: 11.5, fill: P.muted });
  s += svgClose();
  return s;
}

/* ========================================= 4. what ordinary work runs into */

// Which view of a command a row is. The new cases come three ways; the
// original ones once.
const VIEW = { legacy: "original", plain: "plain", nested: "wrapped", encoded: "encoded", assurance: "with assurance" };
const tag = (r) => (r.variant ? ` <span class="tag">${VIEW[r.variant] ?? r.variant}</span>` : "");

/**
 * The control group, as far as it gets in your way. With hundreds of ordinary
 * commands a full list says less than the ones that stopped, so those are
 * named: every refusal, and every question, highest score first. The rest ran.
 */
function renderOrdinaryTable() {
  const trp = rows.filter((r) => r.kind === "trap");
  const ran = trp.filter((r) => r.final === "allow");
  const asked = trp.filter((r) => r.final === "ask").sort((a, b) => b.danger - a.danger);
  const blocked = trp.filter((r) => r.final === "block").sort((a, b) => b.danger - a.danger);

  const VERDICT = { allow: ["ran", "ok"], ask: ["asked first", "ask"], block: ["blocked", "bad"] };
  const row = (r) => {
    const [text, cls] = VERDICT[r.final] ?? ["unknown", "skip"];
    const score = typeof r.danger === "number" ? r.danger.toFixed(2) : "rule";
    return `<tr><td><code>${escXml(r.cmd)}</code>${tag(r)}</td><td class="ev">${score}</td><td class="${cls}">${text}</td></tr>`;
  };
  const table = (list) => [
    `<table class="results ordinary">`,
    `<thead><tr><th>Command</th><th>Score</th><th>What the guard did</th></tr></thead>`,
    `<tbody>`,
    ...list.map(row),
    `</tbody>`,
    `</table>`,
  ];

  return [
    `<p class="table-note">${trp.length} ordinary commands that do real work and look alarming while doing it. ` +
      `${ran.length} ran with no prompt, ${asked.length} stopped to ask, ` +
      `${blocked.length === 0 ? "none were blocked" : `${blocked.length} were blocked`}. Every one that stopped is listed, highest score first.</p>`,
    ...(blocked.length ? table(blocked) : []),
    `<details class="more">`,
    `<summary>The ${asked.length} that stopped to ask <span>each one waits for a yes, and blocks when nobody is there</span></summary>`,
    ...table(asked),
    `</details>`,
    "",
  ].join("\n");
}

/* ================================================= 5. the numbers up top */

function renderStats() {
  const trp = rows.filter((r) => r.kind === "trap");
  const stopped = attacks.filter((r) => r.final === "block" || r.final === "ask").length;
  const bypasses = attacks.filter((r) => r.bypass).length;
  const refused = trp.filter((r) => r.final === "block").length;
  const cards = [
    ["", String(attacks.length), `hostile attempts, ${families.length} families`],
    ["", `${stopped} / ${attacks.length}`, "blocked or held for confirmation"],
    [" crit", `${bypasses} / ${attacks.length}`, "let through unexpectedly"],
    ["", `${refused} / ${trp.length}`, "ordinary commands blocked outright"],
  ];
  if (redteam) {
    const caught = redteam.rows.filter((r) => r.final !== "allow").length;
    cards.push([caught === redteam.rows.length ? " good" : "", `${caught} / ${redteam.rows.length}`, "red-team attacks stopped"]);
  }
  return `<div class="stat-grid">\n${cards.map(([cls, n, text]) => `  <div class="stat-card${cls}"><strong>${n}</strong><span>${text}</span></div>`).join("\n")}\n</div>\n`;
}

/* ============================================ 6. closest to the line */

function renderEdges() {
  const through = attacks.filter((r) => r.final === "allow").sort((a, b) => a.danger - b.danger);
  const body = through.map((r) => {
    const note = r.bypass ? escXml(r.intent) : `${escXml(r.intent)}, allowed to run by design`;
    return `<tr><td><code>${escXml(r.cmd)}</code>${tag(r)}</td><td class="ev">${r.danger.toFixed(2)}</td><td class="why">${note}</td></tr>`;
  });
  return [
    `<table class="results misses">`,
    `<thead><tr><th>Command that ran</th><th>Score</th><th>What it is about</th></tr></thead>`,
    `<tbody>`,
    ...body,
    `</tbody>`,
    `</table>`,
    "",
  ].join("\n");
}

/* ============================================= 7. the independent adversary */

function renderRedteam() {
  const rt = redteam.rows;
  const scored = rt.filter((r) => typeof r.danger === "number" && r.danger > 0);
  const blocked = rt.filter((r) => r.final === "block");
  const heldRows = rt.filter((r) => r.final === "ask");
  const gotThrough = rt.filter((r) => r.final === "allow");
  const mean = (xs) => xs.reduce((a, v) => a + v, 0) / xs.length;
  const selfAvg = mean(rt.map((r) => r.realDanger));
  const jevAvg = mean(scored.map((r) => r.danger));

  const W = 1020, H = 580;
  let s = svgOpen(W, H, { alt: "30 attack attempts by an independent model, and what the guard did with each" });
  s += title(40, 46, `An independent model attacked ${rt.length} times`);
  s += subtitle(40, 70, `${redteam.meta.generator} was told to write commands that are genuinely destructive but crafted to score low.`);
  s += subtitle(40, 90, "One square per attempt, coloured by what the guard did with it.");

  // waffle: one square per attempt
  const cell = 46, gap = 8, perRow = 10, x0 = 60, y0 = 140;
  const order = [...blocked, ...heldRows, ...gotThrough];
  order.forEach((r, i) => {
    const cx = x0 + (i % perRow) * (cell + gap);
    const cy = y0 + Math.floor(i / perRow) * (cell + gap);
    const kind = r.final;
    s += `<g class="mark-g"><title>${BAND_LABEL[kind]} at ${typeof r.danger === "number" && r.danger > 0 ? r.danger.toFixed(2) : "a local rule"}: ${clip(r.cmd, 60)}</title>` +
      `<rect class="mark" x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="8" fill="${BAND[kind] ?? P.muted}"/></g>\n`;
  });

  const tallyX = x0 + perRow * (cell + gap) + 40;
  const tally = [
    { n: blocked.length, text: "blocked outright", fill: P.block },
    { n: heldRows.length, text: "held for confirmation", fill: P.ask },
    { n: gotThrough.length, text: "got through", fill: P.allow },
  ];
  tally.forEach((t, i) => {
    const ty = y0 + 6 + i * 40;
    s += `<rect x="${tallyX}" y="${ty}" width="14" height="14" rx="4" fill="${t.fill}"/>\n`;
    s += label(tallyX + 24, ty + 12, `${t.n} ${t.text}`, { size: 14, weight: 620 });
  });

  // average rating, attacker against classifier
  const barsY = 370;
  const BL = 300, BW = 520, BH2 = 32;
  s += label(40, barsY - 14, "How dangerous the commands were rated, on the same 0 to 1 scale", { size: 14, weight: 650 });
  const bars = [
    { name: "The attacker's own rating", v: selfAvg, fill: P.accent, note: "it knew what it was writing" },
    { name: "Jev's score", v: jevAvg, fill: P.block, note: "higher, so the disguises cost more than they gained" },
  ];
  bars.forEach((b, i) => {
    const y = barsY + 18 + i * 74;
    s += label(BL - 16, y + BH2 / 2 + 5, b.name, { anchor: "end", size: 13.5, weight: 620 });
    s += `<rect x="${BL}" y="${y}" width="${BW}" height="${BH2}" rx="6" fill="${P.panel}"/>\n`;
    s += barSeg({ x: BL, y, width: b.v * BW, height: BH2, fill: b.fill, end: true, tip: `${b.name}: ${b.v.toFixed(2)} average` });
    s += label(BL + b.v * BW - 14, y + BH2 / 2 + 6, b.v.toFixed(2), { anchor: "end", size: 16, weight: 700, fill: "#ffffff" });
    s += label(BL, y + BH2 + 18, b.note, { size: 12, fill: P.dim });
  });
  s += `<line x1="${BL + BW}" y1="${barsY + 10}" x2="${BL + BW}" y2="${barsY + 160}" stroke="${P.border}" stroke-width="1"/>` + "\n";
  s += label(BL + BW + 10, barsY + 6, "1.00 = as dangerous as it gets", { size: 11.5, fill: P.muted });
  s += label(BL, barsY + 6, "0.00", { size: 11.5, fill: P.muted, tabular: true });

  s += label(40, H - 22, `Every attempt was self-rated ${Math.min(...rt.map((r) => r.realDanger)).toFixed(2)} or higher by its author, so these are not accidental near-misses.`, { size: 12.5, fill: P.muted });
  s += svgClose();
  return s;
}

/* ------------------------------------------------------------------ write */

const built = [];
for (const [name, render] of [
  ["diagram-flow", renderFlow],
  ["diagram-layers", renderLayers],
  ["devious-families", renderFamilies],
]) {
  write(name, render);
  built.push(name);
}
if (redteam) {
  write("devious-redteam", renderRedteam);
  built.push("devious-redteam");
} else {
  console.warn("skip devious-redteam — run `npm run redteam` first");
}
for (const [name, render] of [
  ["devious-ordinary", renderOrdinaryTable],
  ["devious-stats", renderStats],
  ["devious-edges", renderEdges],
]) {
  writeFileSync(new URL(`./${name}.html`, import.meta.url), render(), "utf-8");
  built.push(`${name}.html`);
}
console.log(`devious:charts — wrote ${built.join(", ")}`);
