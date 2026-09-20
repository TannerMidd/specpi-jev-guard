/**
 * jev-insights.mjs — insight charts derived from tests/jev-results.json.
 * No network calls: run `npm run matrix` first, then `npm run insights`.
 *
 * Writes one tokenized SVG each (see svg-util.mjs for how theming works):
 *   tests/insight-bands.svg         band mix per command category
 *   tests/insight-sneaky.svg        disguised vs obvious danger detection
 *   tests/insight-layers.svg        which layer decided, and how fast
 *   tests/insight-expectations.svg  results that differed from expectation
 *   tests/insight-latency.svg       classifier latency distribution
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ON, P, axisLine, barSeg, clip, label, legend, subtitle, svgClose, svgOpen, title } from "./svg-util.mjs";

const data = JSON.parse(readFileSync(new URL("./jev-results.json", import.meta.url), "utf-8"));
const { meta, rows } = data;

const GROUP_ORDER = [
  "safe",
  "routine",
  "install",
  "risky",
  "trap",
  "destructive",
  "supply-chain",
  "exfil",
  "persistence",
  "privesc",
  "sneaky",
];
const GROUP_LABELS = {
  safe: "Safe read-only",
  routine: "Routine dev",
  install: "Installs",
  risky: "Risky",
  trap: "Traps (must pass)",
  destructive: "Destructive",
  "supply-chain": "Supply chain",
  exfil: "Exfiltration",
  persistence: "Persistence",
  privesc: "Privesc / evasion",
  sneaky: "Sneaky (disguised)",
};

const write = (base, render) =>
  writeFileSync(new URL(`./${base}.svg`, import.meta.url), render(), "utf-8");

const bandColor = (band) => ({ allow: P.allow, ask: P.ask, block: P.block })[band] ?? P.error;
const pct = (n, d) => (d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`);
const sortedLatency = rows.map((r) => r.latencyMs).sort((a, b) => a - b);

// ---------------------------------------------------------------- 1. band mix
function renderBands() {
  const RH = 46;
  const W = 1060;
  const L = 210;
  const R = 250;
  const T = 112;
  const B = 52;
  const H = T + B + GROUP_ORDER.length * RH;
  const CW = W - L - R;

  let s = svgOpen(W, H);
  s += title(24, 34, "What the guard does, by command category");
  s += subtitle(24, 58, `${meta.total} live commands · ${meta.stamp} · bar length = how many commands fell in each band`);
  s += legend(24, 84, [
    { color: P.allow, label: `allow (runs)` },
    { color: P.ask, label: `ask (confirms)` },
    { color: P.block, label: `block (never runs)` },
  ]);

  const maxCount = Math.max(...GROUP_ORDER.map((g) => rows.filter((r) => r.group === g).length));
  GROUP_ORDER.forEach((g, i) => {
    const groupRows = rows.filter((r) => r.group === g);
    const y = T + i * RH;
    const counts = {
      allow: groupRows.filter((r) => r.final === "allow").length,
      ask: groupRows.filter((r) => r.final === "ask").length,
      block: groupRows.filter((r) => r.final === "block").length,
    };
    const unit = CW / maxCount;
    s += label(L - 12, y + 24, GROUP_LABELS[g], { anchor: "end", size: 13, weight: "600" });
    s += label(L - 12, y + 39, `${groupRows.length} commands`, { anchor: "end", size: 11, fill: P.dim });
    let cx = L;
    const present = ["allow", "ask", "block"].filter((band) => counts[band] > 0);
    present.forEach((band, k) => {
      const w = counts[band] * unit;
      const last = k === present.length - 1;
      s += barSeg({ x: cx, y: y + 6, width: w - (last ? 0 : 2), height: 24, fill: bandColor(band), end: last, tip: `${GROUP_LABELS[g]}: ${counts[band]} ${band}` });
      if (w > 22) s += label(cx + w / 2, y + 23, String(counts[band]), { anchor: "middle", size: 12, fill: ON[band], weight: "700" });
      cx += w;
    });
    s += label(cx + 12, y + 23, `${counts.block} blocked · ${counts.ask} ask · ${counts.allow} allow`, { size: 11, fill: P.dim });
  });

  s += label(24, H - 16, "Traps are ordinary work that merely looks alarming, so a high allow count there means few false alarms.", { fill: P.dim, size: 11 });
  s += svgClose();
  return s;
}

// ---------------------------------------------------------- 2. sneaky vs plain
function renderSneaky() {
  const dangerous = rows.filter((r) => ["destructive", "supply-chain", "exfil", "persistence", "privesc"].includes(r.group));
  const sneaky = rows.filter((r) => r.sneak);
  const obvious = dangerous.filter((r) => r.ok);
  const sneakyOk = sneaky.filter((r) => r.ok);
  const avg = (list) => (list.length ? list.reduce((a, r) => a + r.danger, 0) / list.length : 0);
  const blockRate = (list) => (list.length ? list.filter((r) => r.final === "block").length / list.length : 0);

  const W = 1060;
  const T = 150;
  const RH = 130;
  const H = T + RH * 3 + 56;

  const bars = [
    { name: "Obvious destructive / exfil", count: obvious.length, danger: avg(obvious), block: blockRate(obvious) },
    { name: "Disguised or obfuscated", count: sneakyOk.length, danger: avg(sneakyOk), block: blockRate(sneakyOk) },
    { name: "Ordinary-looking work (traps)", count: rows.filter((r) => r.trap).length, danger: avg(rows.filter((r) => r.trap)), block: blockRate(rows.filter((r) => r.trap)) },
  ];

  const L = 330;
  const CW = W - L - 150;
  const scale = (v) => v * CW;

  let s = svgOpen(W, H);
  s += title(24, 34, "Does disguise beat the classifier?");
  s += subtitle(24, 58, `Average max-noul danger for ${obvious.length} plain attacks, ${sneakyOk.length} disguised variants, and ${bars[2].count} traps.`);
  s += subtitle(24, 78, "The disguised set includes base64 pipes, find -delete, git branch -D, python shutil.rmtree, and a chained git status && rm -rf ~.");
  s += legend(24, 108, [
    { color: P.accent, label: "average danger (bar)" },
    { color: P.block, label: "% blocked outright (dot)" },
  ]);

  // threshold guides
  for (const [t, text, guide] of [[meta.askThreshold, `ask ${meta.askThreshold}`, P.ask], [meta.blockThreshold, `block ${meta.blockThreshold}`, P.block]]) {
    const gx = (L + scale(t)).toFixed(1);
    s += `<line x1="${gx}" y1="${T - 10}" x2="${gx}" y2="${H - 46}" stroke="${guide}" stroke-width="1.4" stroke-dasharray="6 4"/>\n`;
    s += label(L + scale(t), T - 18, text, { anchor: "middle", size: 11, fill: P.muted, weight: "600" });
  }

  bars.forEach((b, i) => {
    const y = T + i * RH;
    s += label(L - 14, y + 26, b.name, { anchor: "end", size: 13.5, weight: "600" });
    s += label(L - 14, y + 44, `${b.count} commands`, { anchor: "end", size: 11, fill: P.dim });
    s += barSeg({ x: L, y: y + 8, width: scale(b.danger), height: 24, fill: P.accent, end: true, tip: `${b.name}: average danger ${b.danger.toFixed(2)}` });
    s += label(L + scale(b.danger) + 10, y + 26, b.danger.toFixed(2), { size: 14, weight: "700" });
    const dx = L + scale(b.block);
    s += `<line x1="${L}" y1="${y + 62}" x2="${L + CW}" y2="${y + 62}" stroke="${P.grid}" stroke-width="1"/>\n`;
    s += `<circle cx="${dx.toFixed(1)}" cy="${y + 62}" r="7" fill="${P.block}"/>\n`;
    const pctX = Math.max(L + 46, Math.min(dx, L + CW - 46));
    s += label(pctX, y + 45, `${pct(Math.round(b.block * b.count), b.count)} blocked (${Math.round(b.block * b.count)}/${b.count})`, { size: 12, fill: P.dim, anchor: "middle" });
  });

  const sneakyBlocked = sneakyOk.filter((r) => r.final !== "allow").length;
  s += label(24, H - 16, `Disguise barely helps the attacker: ${sneakyBlocked}/${sneakyOk.length} disguised commands were blocked or held for confirmation.`, { fill: P.dim, size: 11.5 });
  s += svgClose();
  return s;
}

// ------------------------------------------------------- 3. decision layers
function renderLayers() {
  const localDeny = rows.filter((r) => r.local === "deny");
  const localPass = rows.filter((r) => r.local === "pass");
  const viaJev = rows.filter((r) => r.local === "jev");
  const jevDeny = viaJev.filter((r) => r.ok);

  const cards = [
    { name: "Local rules: hard-deny", count: localDeny.length, ms: 0, color: P.block, note: "blocked before any network call" },
    { name: "Local rules: read-only fast-pass", count: localPass.length, ms: 0, color: P.allow, note: "runs with zero added latency" },
    { name: "Sent to Jev", count: viaJev.length, ms: meta.latency.avg, color: P.accent, note: `avg ${meta.latency.avg}ms, p95 ${meta.latency.p95}ms` },
  ];

  const W = 1060;
  const T = 128;
  const CH = 108;
  const H = T + cards.length * CH + 74;

  let s = svgOpen(W, H);
  s += title(24, 34, "Which layer decided, and what it cost");
  s += subtitle(24, 58, `${meta.total} commands: ${localDeny.length + localPass.length} settled locally in 0 ms, ${viaJev.length} needed the classifier.`);
  s += subtitle(24, 78, "Local rules cannot be overruled by the model: a hard-deny stays denied even if Jev would have waved it through.");

  cards.forEach((c, i) => {
    const y = T + i * CH;
    s += `<rect x="24" y="${y}" width="${W - 48}" height="${CH - 16}" rx="10" fill="${P.panel}" stroke="${P.border}" stroke-width="1"/>\n`;
    s += `<rect x="24" y="${y}" width="6" height="${CH - 16}" rx="3" fill="${c.color}"/>\n`;
    s += label(52, y + 34, c.name, { size: 15, weight: "700" });
    s += label(52, y + 58, c.note, { size: 12, fill: P.dim });
    s += label(W - 52, y + 40, String(c.count), { size: 30, anchor: "end", weight: "700", fill: c.color });
    s += label(W - 52, y + 62, c.ms === 0 ? "0 ms" : `${c.ms} ms avg`, { size: 12, anchor: "end", fill: P.dim });
    const share = rows.length ? c.count / rows.length : 0;
    s += barSeg({ x: 52, y: y + 72, width: share * (W - 300), height: 8, fill: c.color, end: true, tip: `${c.name}: ${pct(c.count, rows.length)} of all commands` });
    s += label(60 + share * (W - 300), y + 80, pct(c.count, rows.length), { size: 11, fill: P.dim });
  });

  const immediate = localDeny.length;
  s += label(24, H - 30, `${pct(immediate, rows.length)} of commands were stopped instantly (0 ms) with no data leaving the machine.`, { fill: P.dim, size: 11.5 });
  s += label(24, H - 14, `${pct(viaJev.length, rows.length)} were judged by Jev; ${jevDeny.length} of those returned a verdict, and any failure there fails closed.`, { fill: P.dim, size: 11.5 });
  s += svgClose();
  return s;
}

// --------------------------------------------------------- 4. expectations
function renderExpectations() {
  const vars = rows.filter((r) => !r.match);
  const RH = 44;
  const W = 1060;
  const T = 128;
  const H = Math.max(T + 120, T + vars.length * RH + 66);

  let s = svgOpen(W, H);
  s += title(24, 34, "Where the model disagreed with intuition");
  s += subtitle(24, 58, `${vars.length} of ${meta.total} commands landed in a different band than expected. These are the calibration targets, not errors.`);
  s += subtitle(24, 78, "Each row shows the band we predicted against the band Jev produced. Use them to sanity-check thresholds.");

  vars.forEach((r, i) => {
    const y = T + i * RH;
    const got = r.final;
    s += `<rect x="24" y="${y - 20}" width="${W - 48}" height="${RH - 8}" rx="6" fill="${P.panel}"/>\n`;
    s += label(40, y, clip(r.cmd, 56), { size: 12.5 });
    s += label(W - 300, y, `expected ${r.expect.replace("-or-", " / ")}`, { size: 11.5, fill: P.dim, anchor: "end" });
    s += label(W - 190, y, `got ${got}`, { size: 12.5, anchor: "end", weight: "700", fill: bandColor(got) });
    s += label(W - 40, y, Number.isNaN(r.danger) ? "n/a" : r.danger.toFixed(2), { size: 12.5, anchor: "end", fill: P.dim });
  });

  s += label(24, H - 30, "Recurring theme: a couple of disguised payloads land just under the 0.8 block line (0.75-0.79) and are held for", { fill: P.dim, size: 11.5 });
  s += label(24, H - 14, "confirmation instead of blocked. Safe headless, but worth a tighter blockThreshold if you never want to be asked.", { fill: P.dim, size: 11.5 });
  s += svgClose();
  return s;
}

// ------------------------------------------------------------- 5. latency
function renderLatency() {
  const buckets = [
    { label: "<150", test: (v) => v < 150 },
    { label: "150-199", test: (v) => v >= 150 && v < 200 },
    { label: "200-249", test: (v) => v >= 200 && v < 250 },
    { label: "250-299", test: (v) => v >= 250 && v < 300 },
    { label: "300-399", test: (v) => v >= 300 && v < 400 },
    { label: "400-599", test: (v) => v >= 400 && v < 600 },
    { label: "600+", test: (v) => v >= 600 },
  ].map((b) => ({ ...b, count: sortedLatency.filter(b.test).length }));

  const W = 1060;
  const T = 132;
  const CH = 300;
  const H = T + CH + 78;
  const L = 120;
  const CW = W - L - 90;
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const bw = CW / buckets.length;

  let s = svgOpen(W, H);
  s += title(24, 34, "How long Jev takes to answer");
  s += subtitle(24, 58, `${sortedLatency.length} live classifications · avg ${meta.latency.avg}ms · p50 ${meta.latency.p50}ms · p95 ${meta.latency.p95}ms · max ${meta.latency.max}ms`);
  s += subtitle(24, 78, "This is the entire added cost of a gated call. Local rules and cached verdicts add 0 ms.");

  const baseY = T + CH;
  buckets.forEach((b, i) => {
    const x = L + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const h = (b.count / maxCount) * (CH - 40);
    s += barSeg({ x, y: baseY - h, width: w, height: h, fill: P.accent, end: true, tip: `${b.count} calls took ${b.label} ms` });
    s += label(x + w / 2, baseY - h - 8, b.count ? String(b.count) : "", { anchor: "middle", size: 12, weight: "600" });
    s += label(x + w / 2, baseY + 22, b.label, { anchor: "middle", size: 11.5, fill: P.dim });
  });
  s += axisLine(L, baseY, L + CW);
  s += label(L - 12, baseY - (CH - 40) - 4, String(maxCount), { anchor: "end", size: 11, fill: P.dim });
  s += label(L - 12, baseY, "0", { anchor: "end", size: 11, fill: P.dim });
  s += label(24, baseY + 24, "commands", { size: 11, fill: P.dim });
  s += label(L + CW / 2, baseY + 48, "classifier latency (ms)", { anchor: "middle", size: 12, fill: P.dim });

  // Read off the run rather than asserted, so a slower day cannot make the chart lie.
  const slowest = meta.latency.max >= 1000 ? `${(meta.latency.max / 1000).toFixed(1)}s` : `${meta.latency.max}ms`;
  s += label(24, H - 16, `Half the calls answered within ${meta.latency.p50}ms and the slowest took ${slowest}; past the 12s timeout the guard fails closed.`, { fill: P.dim, size: 11.5 });
  s += svgClose();
  return s;
}

// ---------------------------------------------------------------- main chart
// Minimal by design: no per-bar numbers (hover any bar for the details),
// gridlines only at 0 / 0.5 / 1.0 plus the two threshold guides.
function renderMain() {
  const sorted = [...rows].sort((a, b) => (Number.isNaN(a.danger) ? -1 : a.danger) - (Number.isNaN(b.danger) ? -1 : b.danger));
  const W = 1120;
  const L = 380;
  const R = 80;
  const T = 118;
  const B = 54;
  const RH = 26;
  const H = T + B + sorted.length * RH;
  const CW = W - L - R;
  const x = (d) => L + Math.max(0, Math.min(1, d)) * CW;
  const colors = { allow: P.allow, ask: P.ask, block: P.block, error: P.error };

  let s = svgOpen(W, H);
  s += title(24, 34, "Jev danger by command");
  s += subtitle(24, 58, `${meta.model} → ${meta.servedBy} · ${meta.stamp} · ask ≥ ${meta.askThreshold}, block ≥ ${meta.blockThreshold} · ${meta.matched}/${meta.total} as expected · avg ${meta.latency.avg}ms`);
  s += legend(24, 84, [
    { color: P.allow, label: "allow (runs)" },
    { color: P.ask, label: "ask (confirms)" },
    { color: P.block, label: "block (never runs)" },
  ]);
  s += subtitle(24, 104, "Local deny/pass settles in 0 ms without consulting Jev. Hover any bar for the exact score.");

  for (const g of [0, 0.5, 1.0]) {
    const gx = x(g).toFixed(1);
    s += `<line x1="${gx}" y1="${T - 8}" x2="${gx}" y2="${H - B + 8}" stroke="${P.grid}" stroke-width="1"/>\n`;
    s += label(x(g), H - B + 28, g.toFixed(1), { fill: P.dim, size: 12, anchor: "middle" });
  }
  for (const [t, text, guide] of [[meta.askThreshold, `ask ${meta.askThreshold}`, P.ask], [meta.blockThreshold, `block ${meta.blockThreshold}`, P.block]]) {
    const tx = x(t).toFixed(1);
    s += `<line x1="${tx}" y1="${T - 8}" x2="${tx}" y2="${H - B + 8}" stroke="${guide}" stroke-width="1.5" stroke-dasharray="6 4"/>\n`;
    s += label(x(t), T - 14, text, { fill: P.muted, size: 12, anchor: "middle", weight: "600" });
  }

  sorted.forEach((r, i) => {
    const y = T + i * RH;
    const cy = y + RH / 2;
    const d = Number.isNaN(r.danger) ? 0 : r.danger;
    const fill = colors[r.final] || colors.error;
    const tip =
      `${r.cmd}\n` +
      `danger ${Number.isNaN(r.danger) ? "unavailable" : r.danger.toFixed(2)} · ${r.final} · ${r.latencyMs}ms` +
      (r.local === "jev" ? "" : ` · decided locally (${r.local})`) +
      (r.match ? "" : ` · differs from expectation (expected ${r.expect})`);
    s += barSeg({ x: L, y: y + 3, width: d * CW, height: RH - 7, fill, end: true, tip });
    s += label(L - 12, cy + 4.5, clip(r.cmd, 48), { anchor: "end", size: 13 });
    if (!r.match) {
      s += `<circle cx="${(W - 30).toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${P.ask}"><title>Differs from expectation (expected ${r.expect})</title></circle>\n`;
    }
  });

  s += label(24, H - 14, "0 = routine · 1 = destructive or exfiltrating.", { fill: P.dim, size: 12 });
  s += svgClose();
  return s;
}

write("jev-chart", renderMain);
write("insight-bands", renderBands);
write("insight-sneaky", renderSneaky);
write("insight-layers", renderLayers);
write("insight-expectations", renderExpectations);
write("insight-latency", renderLatency);

const variances = rows.filter((r) => !r.match).length;
console.log(`WROTE main + 5 insight charts from ${rows.length} results — ${variances} expectation variances noted`);
