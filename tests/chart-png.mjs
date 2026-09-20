/**
 * chart-png.mjs — rasterize every generated chart to PNG via ImageMagick.
 * Usage: npm run chart:png   (requires `magick` on PATH)
 *
 * The SVGs are tokenized (`var(--jv-role, …)`), which a rasterizer will not
 * resolve, so each theme's hex values are baked in first and written to a
 * temporary file next to the source.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { THEMES, resolveTokens } from "./svg-util.mjs";

const CHARTS = [
  "jev-chart",
  "insight-bands",
  "insight-sneaky",
  "insight-layers",
  "insight-expectations",
  "insight-latency",
  "diagram-flow",
  "diagram-layers",
  "devious-families",
  "devious-redteam",
  "compare-guards",
  "e2e-batches",
  "e2e-decisions",
];

const fsPath = (url) => decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");

let done = 0;
for (const name of CHARTS) {
  const svg = new URL(`./${name}.svg`, import.meta.url);
  if (!existsSync(svg)) {
    console.warn(`skip missing ${name}.svg`);
    continue;
  }
  const source = readFileSync(svg, "utf-8");
  for (const mode of Object.keys(THEMES)) {
    const suffix = mode === "light" ? "" : `-${mode}`;
    const baked = new URL(`./.${name}${suffix}.baked.svg`, import.meta.url);
    writeFileSync(baked, resolveTokens(source, mode), "utf-8");
    try {
      execFileSync("magick", ["-density", "130", "-background", THEMES[mode].bg, fsPath(baked), fsPath(new URL(`./${name}${suffix}.png`, import.meta.url))], {
        stdio: "inherit",
      });
      done++;
    } finally {
      rmSync(baked, { force: true });
    }
  }
}
// The README shows one figure, in both themes. It is the flow diagram rather
// than a result chart, because that is the thing a new reader needs first.
const HERO = "diagram-flow";
for (const [from, to] of [
  [`./${HERO}.png`, "../docs/assets/hero.png"],
  [`./${HERO}-dark.png`, "../docs/assets/hero-dark.png"],
]) {
  const src = new URL(from, import.meta.url);
  if (existsSync(src)) copyFileSync(src, new URL(to, import.meta.url));
}

console.log(`chart:png — wrote ${done} PNGs, and the README hero`);
