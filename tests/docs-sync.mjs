/**
 * docs-sync.mjs — copy generated charts into docs/ for GitHub Pages.
 * Run after `npm run matrix` and `npm run insights`.
 */
import { copyFileSync, existsSync } from "node:fs";

const CHARTS = [
  "jev-chart",
  "insight-bands",
  "insight-sneaky",
  "insight-layers",
  "insight-expectations",
  "insight-latency",
];

let copied = 0;
for (const name of CHARTS) {
  for (const variant of ["", "-dark"]) {
    const file = `${name}${variant}.svg`;
    if (!existsSync(new URL(`./${file}`, import.meta.url))) {
      console.warn(`skip missing ${file}`);
      continue;
    }
    copyFileSync(new URL(`./${file}`, import.meta.url), new URL(`../docs/${file}`, import.meta.url));
    copied++;
  }
}
console.log(`docs:sync — copied ${copied} chart files into docs/`);
