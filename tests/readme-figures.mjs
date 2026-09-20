/**
 * readme-figures.mjs — the images the README shows: the logo, and a terminal
 * card of three calls going three different ways.
 *
 * The text in the card is derived: the deny wording from the shipped rule, the
 * score and the model's sentence from the recorded devious run. Nothing in it
 * is typed out by hand, so it cannot drift from what the guard actually says. Both themes are written, because the README
 * picks one with <picture> and prefers-color-scheme.
 *
 *   npm run readme:figures     (needs ImageMagick's `magick` on PATH)
 *
 * Writes docs/assets/logo.png, docs/assets/terminal.png, terminal-dark.png.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THEMES, escXml } from "./svg-util.mjs";
import { DEFAULT_SETTINGS, classifyCommandLocal } from "../extensions/risk-rules.ts";

const ASSETS = new URL("../docs/assets/", import.meta.url);
const fsPath = (url) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(fsPath(ASSETS), { recursive: true });

const MONO = "Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/* ------------------------------------------------------------------ logo */

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M16 2.6 26.4 6.3Q27 6.5 27 7.1V16.2C27 22.5 22.5 27.3 16.5 29.2Q16 29.4 15.5 29.2C9.5 27.3 5 22.5 5 16.2V7.1Q5 6.5 5.6 6.3Z" fill="#2a78d6"/>
  <path d="M12 11.9 16 15.7 12 19.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M18.3 19.5h3.1" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
</svg>`;

/* -------------------------------------------------------- terminal card */

/**
 * The three blocks are derived, not typed out. The deny wording comes from the
 * shipped rule, the score and the model's own sentence come from the recorded
 * devious run, and the message shapes match the strings in jev-guard.ts. A
 * hand-written card goes stale the first time a rule is reworded, which is
 * what happened to the one this replaces: it still showed a deny reason that
 * had been rewritten and a score that had moved.
 */
const devious = JSON.parse(readFileSync(new URL("./jev-devious.json", import.meta.url), "utf-8"));
const recorded = (cmd) => {
  const row = devious.rows.find((r) => r.cmd === cmd);
  if (!row) throw new Error(`readme-figures: no recorded row for ${JSON.stringify(cmd)}`);
  return row;
};

/** Wrap on spaces at `width` characters, the way the terminal would. */
function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    if (line && (line + " " + word).length > width) {
      out.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  if (line) out.push(line);
  return out;
}

const HARD_DENY = "rm -rf /";
const MIDDLE = "rm -rf dist build";
const denied = classifyCommandLocal(HARD_DENY, { ...DEFAULT_SETTINGS });
const scored = recorded(MIDDLE);

const BLOCKS = [
  {
    command: HARD_DENY,
    accent: "block",
    outcome: "blocked",
    source: "local rule, 0 ms",
    // jev-guard.ts: `jev-guard: blocked. ${local.reason}. Call: ${short}`
    lines: wrap(`jev-guard: blocked. ${denied.reason}. Call: ${HARD_DENY}`, 62).map((l) => [l, "block"]),
  },
  {
    command: MIDDLE,
    accent: "ask",
    outcome: "asks you",
    source: `Jev, ${scored.latencyMs} ms`,
    lines: [
      ...wrap(`jev-guard: bash call scored danger ${scored.danger.toFixed(2)} (${scored.category})`, 62).map((l) => [l, "ask"]),
      [scored.reason, "dim"],
      ["Allow this call?", "text"],
    ],
    choice: ["Yes, run it", "No, block it"],
  },
  {
    command: "npm test",
    accent: "allow",
    outcome: "runs",
    source: "read-only, 0 ms",
    lines: [["runs, no prompt, no network call", "dim"]],
  },
];

function terminalCard(mode) {
  const t = THEMES[mode];
  const padX = 34;
  const lineH = 26;
  const blockGap = 34;
  const gutterW = 176;
  // Fit the frame to the longest line rather than a round number, so the card
  // has no dead stretch between the output and the verdict.
  const mono = (text, size) => text.length * size * 0.6;
  const widest = Math.max(
    ...BLOCKS.map((b) => mono("$ " + b.command, 16)),
    ...BLOCKS.flatMap((b) => b.lines.map(([text]) => mono(text, 15))),
  );
  const W = Math.round(padX + widest + 56 + gutterW + padX);
  const gutterX = W - padX - gutterW;

  let y = 96;
  const laid = BLOCKS.map((b) => {
    const top = y;
    y += 34 + b.lines.length * lineH + (b.choice ? 44 : 0) + blockGap;
    return { ...b, top, bottom: y - blockGap };
  });
  const H = y + 6;

  const ink = { block: t.block, ask: t.ask, allow: t.allow, dim: t.muted, text: t.text };
  const onBand = { block: "#ffffff", ask: "#1a1a19", allow: "#ffffff" };

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Three calls and what the guard did with each: one blocked by a local rule, one held for confirmation, one run without a prompt">\n`;
  s += `<rect width="${W}" height="${H}" rx="16" fill="${t.bg}" stroke="${t.border}"/>\n`;
  s += `<path d="M0 16A16 16 0 0 1 16 0H${W - 16}A16 16 0 0 1 ${W} 16V56H0Z" fill="${t.panel}"/>\n`;
  s += `<line x1="0" y1="56" x2="${W}" y2="56" stroke="${t.border}"/>\n`;
  for (let i = 0; i < 3; i++) s += `<circle cx="${padX + i * 22}" cy="28" r="6" fill="${t.border}"/>\n`;
  s += `<text x="${W / 2}" y="33" font-family="${SANS}" font-size="13.5" fill="${t.muted}" text-anchor="middle">pi, with specpi-jev-guard</text>\n`;

  for (const b of laid) {
    // A thicker left rule, so which way it went is legible before any reading.
    s += `<rect x="${padX - 16}" y="${b.top - 19}" width="4" height="${b.bottom - b.top + 20}" rx="2" fill="${ink[b.accent]}"/>\n`;
    s += `<text x="${padX}" y="${b.top}" font-family="${MONO}" font-size="16">` +
      `<tspan fill="${t.muted}">$ </tspan><tspan fill="${t.text}" font-weight="600">${escXml(b.command)}</tspan></text>\n`;
    b.lines.forEach(([text, role], i) => {
      s += `<text x="${padX}" y="${b.top + 30 + i * lineH}" font-family="${MONO}" font-size="15" fill="${ink[role]}">${escXml(text)}</text>\n`;
    });

    if (b.choice) {
      let bx = padX;
      const after = b.top + 34 + b.lines.length * lineH;
      b.choice.forEach((label, i) => {
        const w = 22 + label.length * 9.2;
        const picked = i === 0;
        s += `<rect x="${bx}" y="${after - 14}" width="${w}" height="32" rx="8" fill="${picked ? ink[b.accent] : "none"}" stroke="${picked ? "none" : t.border}"/>\n`;
        s += `<text x="${bx + w / 2}" y="${after + 7}" font-family="${SANS}" font-size="14" font-weight="${picked ? 650 : 500}" text-anchor="middle" fill="${picked ? onBand[b.accent] : t.muted}">${escXml(label)}</text>\n`;
        bx += w + 12;
      });
    }

    // The right gutter carries the verdict and where it came from, which is
    // the part worth seeing without reading the output.
    const chipW = 15 + b.outcome.length * 8.6;
    s += `<rect x="${gutterX + gutterW - chipW}" y="${b.top - 17}" width="${chipW}" height="25" rx="7" fill="${ink[b.accent]}"/>\n`;
    s += `<text x="${gutterX + gutterW - chipW / 2}" y="${b.top}" font-family="${SANS}" font-size="13" font-weight="650" text-anchor="middle" fill="${onBand[b.accent]}">${escXml(b.outcome)}</text>\n`;
    s += `<text x="${gutterX + gutterW}" y="${b.top + 25}" font-family="${SANS}" font-size="12.5" text-anchor="end" fill="${t.muted}">${escXml(b.source)}</text>\n`;
  }
  s += `</svg>\n`;
  return s;
}

/* ------------------------------------------------------------- rasterize */

function png(svg, out, { density = 260, width } = {}) {
  const tmp = new URL(`./.${out.replace(/\W/g, "")}.svg`, import.meta.url);
  writeFileSync(tmp, svg, "utf-8");
  try {
    const args = ["-background", "none", "-density", String(density), fsPath(tmp)];
    if (width) args.push("-resize", `${width}x`);
    args.push(fsPath(new URL(out, ASSETS)));
    execFileSync("magick", args, { stdio: "inherit" });
  } finally {
    rmSync(tmp, { force: true });
  }
}

png(LOGO, "logo.png", { density: 1200, width: 512 });
png(terminalCard("light"), "terminal.png", { density: 200, width: 1600 });
png(terminalCard("dark"), "terminal-dark.png", { density: 200, width: 1600 });
console.log("readme:figures — wrote logo.png, terminal.png, terminal-dark.png");
