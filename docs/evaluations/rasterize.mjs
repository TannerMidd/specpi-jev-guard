/** Re-render frozen share-card SVGs. No benchmark commands, model or network calls. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

for (const name of ["jev-vs-laya", "evaluation-follow-up"]) {
  const root = new URL(`../assets/social/${name}/`, import.meta.url);
  const sources = readdirSync(root).filter(f => /^0[1-4]-.*\.svg$/.test(f)).sort();
  assert.equal(sources.length, 4);
  for (const file of sources) {
    const png = new URL(file.replace(/\.svg$/, ".png"), root);
    execFileSync("magick", ["-density", "144", fileURLToPath(new URL(file, root)), "-resize", "1600x900!",
      "-colorspace", "sRGB", "-strip", "-define", "png:color-type=2", "-define", "png:compression-level=9", fileURLToPath(png)], { stdio: "inherit" });
    const bytes = readFileSync(png);
    assert.equal(bytes.readUInt32BE(16), 1600);
    assert.equal(bytes.readUInt32BE(20), 900);
    assert.equal(bytes[25], 2);
    assert.ok(bytes.length < 5_000_000);
  }
  execFileSync("magick", ["montage", ...sources.map(file => fileURLToPath(new URL(file.replace(/\.svg$/, ".png"), root))),
    "-tile", "2x2", "-geometry", "800x450+12+12", "-background", "#D8DFE3", fileURLToPath(new URL("preview.png", root))], { stdio: "inherit" });
  console.log(`Rendered ${name}: four light-theme cards and preview.`);
}
