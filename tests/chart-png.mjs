/**
 * chart-png.mjs — rasterize every generated SVG to PNG via ImageMagick.
 * Usage: npm run chart:png   (requires `magick` on PATH)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const CHARTS = [
  "jev-chart",
  "insight-bands",
  "insight-sneaky",
  "insight-layers",
  "insight-expectations",
  "insight-latency",
];

const magick = process.platform === "win32" ? "magick" : "magick";
let done = 0;
for (const name of CHARTS) {
  for (const variant of ["", "-dark"]) {
    const svg = new URL(`./${name}${variant}.svg`, import.meta.url);
    if (!existsSync(svg)) {
      console.warn(`skip missing ${name}${variant}.svg`);
      continue;
    }
    const png = new URL(`./${name}${variant}.png`, import.meta.url);
    execFileSync(magick, ["-density", "130", svg.pathname.replace(/^\//, ""), png.pathname.replace(/^\//, "")], {
      stdio: "inherit",
    });
    done++;
  }
}
console.log(`chart:png — wrote ${done} PNG files`);
