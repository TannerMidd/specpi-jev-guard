/**
 * readme-figures.mjs — the images the README shows: the logo, and a terminal
 * card of three calls going three different ways.
 *
 * The text in the card is the extension's own output, copied from a live run,
 * not invented for the picture. Both themes are written, because the README
 * picks one with <picture> and prefers-color-scheme.
 *
 *   npm run readme:figures     (needs ImageMagick's `magick` on PATH)
 *
 * Writes docs/assets/logo.png, docs/assets/terminal.png, terminal-dark.png.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THEMES, escXml } from "./svg-util.mjs";

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
 * One block: what the agent asked to run, and what the guard did with it.
 * `lines` are [text, role] pairs; role picks the colour.
 */
const BLOCKS = [
  {
    command: "rm -rf /",
    note: "settled by a local rule, 0 ms, no network call",
    accent: "block",
    lines: [
      ["jev-guard: blocked. hard-deny pattern: recursive forced", "block"],
      ["deletion aimed at a filesystem root or home directory.", "block"],
    ],
  },
  {
    command: "rm -rf dist build",
    note: "not obviously wrong, so it gets a score",
    accent: "ask",
    lines: [
      ["jev-guard: bash call scored danger 0.51 (destructive-action)", "ask"],
      ["Recursively deletes build output. Recoverable by rebuilding.", "dim"],
      ["Allow this call?", "text"],
    ],
    choice: ["Yes, run it", "No, block it"],
  },
  {
    command: "npm test",
    note: "read-only work, nothing to decide",
    accent: "allow",
    lines: [["runs, no prompt, no network call", "dim"]],
  },
];

function terminalCard(mode) {
  const t = THEMES[mode];
  const W = 1000;
  const padX = 34;
  const lineH = 26;
  const blockGap = 30;

  // measure first so the frame fits the content exactly
  let y = 92;
  const laid = BLOCKS.map((b) => {
    const top = y;
    y += 34; // the command line
    y += b.lines.length * lineH;
    if (b.choice) y += 44; // the two answers
    y += 22; // the note
    y += blockGap;
    return { ...b, top };
  });
  const H = y + 10;

  const ink = { block: t.block, ask: t.ask, allow: t.allow, dim: t.muted, text: t.text };
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Three calls and what the guard did with each">\n`;
  s += `<rect width="${W}" height="${H}" rx="16" fill="${t.bg}" stroke="${t.border}"/>\n`;
  // window chrome
  s += `<path d="M0 16A16 16 0 0 1 16 0H${W - 16}A16 16 0 0 1 ${W} 16V56H0Z" fill="${t.panel}"/>\n`;
  s += `<line x1="0" y1="56" x2="${W}" y2="56" stroke="${t.border}"/>\n`;
  for (let i = 0; i < 3; i++) {
    s += `<circle cx="${padX + i * 22}" cy="28" r="6" fill="${t.border}"/>\n`;
  }
  s += `<text x="${W / 2}" y="33" font-family="${SANS}" font-size="13.5" fill="${t.muted}" text-anchor="middle">pi, with specpi-jev-guard</text>\n`;

  for (const b of laid) {
    // the left rule says at a glance which way it went
    const lastY = b.top + 34 + b.lines.length * lineH + (b.choice ? 44 : 0) - 8;
    s += `<rect x="${padX - 14}" y="${b.top - 16}" width="3" height="${lastY - b.top + 18}" rx="1.5" fill="${ink[b.accent]}"/>\n`;
    s += `<text x="${padX}" y="${b.top}" font-family="${MONO}" font-size="16">` +
      `<tspan fill="${t.muted}">$ </tspan><tspan fill="${t.text}" font-weight="600">${escXml(b.command)}</tspan></text>\n`;
    b.lines.forEach(([text, role], i) => {
      s += `<text x="${padX}" y="${b.top + 30 + i * lineH}" font-family="${MONO}" font-size="15" fill="${ink[role]}">${escXml(text)}</text>\n`;
    });
    let after = b.top + 34 + b.lines.length * lineH;
    if (b.choice) {
      // the confirmation, drawn the way it is answered rather than as text
      let bx = padX;
      b.choice.forEach((label, i) => {
        const w = 22 + label.length * 9.2;
        const picked = i === 0;
        s += `<rect x="${bx}" y="${after - 14}" width="${w}" height="32" rx="8" fill="${picked ? ink[b.accent] : "none"}" stroke="${picked ? "none" : t.border}"/>\n`;
        s += `<text x="${bx + w / 2}" y="${after + 7}" font-family="${SANS}" font-size="14" font-weight="${picked ? 650 : 500}" text-anchor="middle" fill="${picked ? "#1a1a19" : t.dim}">${escXml(label)}</text>\n`;
        bx += w + 12;
      });
      after += 44;
    }
    s += `<text x="${padX}" y="${after}" font-family="${SANS}" font-size="13" fill="${t.muted}">${escXml(b.note)}</text>\n`;
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
