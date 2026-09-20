/**
 * compare-chart.mjs — the head-to-head figure, from tests/compare-results.json.
 * No network: run `npm run compare` first, then `npm run compare:chart`.
 *
 * Writes tests/compare-guards.svg (tokenized, see svg-util.mjs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  ON, P, axisLine, barSeg, gridV, label, legend, subtitle, svgClose, svgOpen, title,
} from "./svg-util.mjs";

const data = JSON.parse(readFileSync(new URL("./compare-results.json", import.meta.url), "utf-8"));
const { meta, results, jevGuard } = data;

const LABELS = {
  quickstart: ["pi-permission-system", "their README quick start"],
  hardened: ["pi-permission-system", "a hardened policy, written for this test"],
  permissive: ["pi-permission-system", "allow by default, deny list only"],
};

const rows = [
  ...results.map((r) => ({
    name: LABELS[r.id]?.[0] ?? r.id,
    note: LABELS[r.id]?.[1] ?? r.label,
    ran: r.attacks.allow,
    asked: r.traps.ask,
    refused: r.traps.deny,
    us: false,
  })),
  {
    name: "specpi-jev-guard",
    note: "defaults: block at 0.80, ask at 0.35",
    ran: jevGuard.attacks.allow,
    asked: jevGuard.traps.ask,
    refused: jevGuard.traps.deny,
    us: true,
  },
];

const W = 1020;
const L = 300, GAP = 56, RH = 26, PITCH = 62, T = 208;
const H = T + rows.length * PITCH + 92;
const panelW = (W - L - 60 - GAP) / 2;
const leftX = L;
const rightX = L + panelW + GAP;
const maxAttacks = meta.attacks;
const maxTraps = meta.traps;
const sxA = (n) => (n / maxAttacks) * panelW;
const sxT = (n) => (n / maxTraps) * panelW;

let s = svgOpen(W, H, { alt: "The same commands run through both guards" });
s += title(40, 46, `The same ${meta.commands} commands, through both guards`);
s += subtitle(40, 70, `${meta.attacks} hostile commands and ${meta.traps} ordinary ones, replayed against ${meta.them.package}@${meta.them.version} and against this extension.`);
s += subtitle(40, 90, "Shorter is better in both panels. Nothing here was executed: each guard was asked what it would have done.");

// panel headings and their own scales
s += label(leftX, T - 38, "Hostile commands that would have run", { size: 13.5, weight: 650 });
s += label(leftX, T - 20, `out of ${maxAttacks}`, { size: 11.5, fill: P.muted });
s += label(rightX, T - 38, "Ordinary commands that interrupted you", { size: 13.5, weight: 650 });
s += label(rightX, T - 20, `out of ${maxTraps}`, { size: 11.5, fill: P.muted });
// only the right panel stacks two things, so the key belongs over it
s += legend(rightX, 130, [
  { label: "asked you first", color: P.ask },
  { label: "refused outright", color: P.block },
]);

const ticksA = [0, 20, 40, 60, 80];
const ticksT = [0, 5, 10, 15, 20, 25];
const axisY = T + rows.length * PITCH - 16;
s += gridV(ticksA.slice(1).map((t) => leftX + sxA(t)), T - 10, axisY);
s += gridV(ticksT.slice(1).map((t) => rightX + sxT(t)), T - 10, axisY);
s += axisLine(leftX, axisY, leftX + panelW);
s += axisLine(rightX, axisY, rightX + panelW);

let y = T;
for (const r of rows) {
  s += label(L - 18, y + 12, r.name, { anchor: "end", size: 13.5, weight: r.us ? 700 : 600 });
  s += label(L - 18, y + 30, r.note, { anchor: "end", size: 11.5, fill: P.muted });

  // left: attacks that would have run
  const wa = sxA(r.ran);
  s += barSeg({ x: leftX, y, width: wa, height: RH, fill: P.block, end: true, tip: `${r.ran} of ${maxAttacks} hostile commands would have run` });
  const insideA = wa > 34;
  s += label(insideA ? leftX + wa - 10 : leftX + wa + 10, y + RH / 2 + 5, String(r.ran), {
    anchor: insideA ? "end" : "start", size: 13, weight: 700, fill: insideA ? ON.block : P.text,
  });

  // right: ordinary work interrupted, split by how
  let x = rightX;
  const parts = [[r.asked, "ask"], [r.refused, "block"]].filter(([n]) => n > 0);
  parts.forEach(([n, kind], i) => {
    const w = sxT(n);
    const last = i === parts.length - 1;
    s += barSeg({
      x, y, width: w - (last ? 0 : 2), height: RH, fill: kind === "ask" ? P.ask : P.block, end: last,
      tip: `${n} ordinary commands ${kind === "ask" ? "stopped to ask" : "were refused outright"}`,
    });
    if (w > 26) s += label(x + w / 2, y + RH / 2 + 5, String(n), { anchor: "middle", size: 12.5, weight: 700, fill: kind === "ask" ? ON.ask : ON.block });
    x += w;
  });
  const total = r.asked + r.refused;
  s += label(x + 10, y + RH / 2 + 5, total === 0 ? "0" : `${total} of ${maxTraps}`, { size: 12, fill: P.muted });
  y += PITCH;
}

for (const t of ticksA) s += label(leftX + sxA(t), axisY + 22, String(t), { anchor: "middle", size: 11.5, fill: P.muted, tabular: true });
for (const t of ticksT) s += label(rightX + sxT(t), axisY + 22, String(t), { anchor: "middle", size: 11.5, fill: P.muted, tabular: true });

s += label(40, H - 44, "A command held for confirmation counts as stopped when it is hostile, and as an interruption when it is ordinary work.", { size: 12.5, fill: P.muted });
s += label(40, H - 22, "Only the bash path is compared. The permission system also gates MCP, skills and tool-level paths, which this extension does not touch.", { size: 12.5, fill: P.muted });
s += svgClose();

writeFileSync(new URL("./compare-guards.svg", import.meta.url), s, "utf-8");
console.log("compare:chart — wrote compare-guards.svg");
