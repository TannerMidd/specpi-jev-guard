/**
 * jev-dark.mjs — derive a dark-mode SVG from tests/jev-chart.svg (no network).
 *
 * Usage:
 *   node tests/jev-dark.mjs
 *
 * Reads tests/jev-chart.svg, applies a dark palette, writes
 * tests/jev-chart-dark.svg. Re-run after `npm run matrix`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const src = new URL("./jev-chart.svg", import.meta.url);
const dst = new URL("./jev-chart-dark.svg", import.meta.url);

let s = readFileSync(src, "utf-8");

const swaps = [
  ['fill="#ffffff"', 'fill="#0f172a"'], // background: slate-900
  ['fill="#111827"', 'fill="#f1f5f9"'], // title, labels, values: slate-100
  ['fill="#6b7280"', 'fill="#94a3b8"'], // secondary text: slate-400
  ['stroke="#e5e7eb"', 'stroke="#1e293b"'], // gridlines: slate-800
  ['stroke="#b45309"', 'stroke="#f59e0b"'], // ask threshold: amber-500
  ['fill="#b45309"', 'fill="#f59e0b"'],
  ['stroke="#b91c1c"', 'stroke="#f87171"'], // block threshold: red-400
  ['fill="#b91c1c"', 'fill="#f87171"'],
];

for (const [a, b] of swaps) {
  const n = s.split(a).length - 1;
  s = s.split(a).join(b);
  console.log(`${a} → ${b} (${n})`);
}

writeFileSync(dst, s, "utf-8");
console.log("WROTE tests/jev-chart-dark.svg");
