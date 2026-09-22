/**
 * docs-sync.mjs — put the generated charts into the site.
 * Run after `npm run overview` and `npm run devious:charts`.
 *
 * docs/ is plain HTML, so each chart is inlined into the page between its
 * markers:
 *
 *   <div class="chart-scroll"><!--chart:devious-strip--><!--/chart--></div>
 *
 * Inline beats <img> here: the SVGs are written against CSS variables, so
 * inlined they follow the page's theme toggle instantly, and their per-mark
 * hover tooltips keep working. The prose around them stays hand-edited.
 *
 * Generated HTML fragments work the same way, for tables too long to hand-write:
 *
 *   <!--include:e2e-table--><!--/include-->
 */
import { readFileSync, writeFileSync } from "node:fs";

const PAGES = ["index.html", "devious.html", "testing.html"];

let injected = 0;
let missing = 0;

for (const page of PAGES) {
  const file = new URL(`../docs/${page}`, import.meta.url);
  const before = readFileSync(file, "utf-8");
  const after = before.replace(
    /<!--chart:([a-z0-9-]+)-->[\s\S]*?<!--\/chart-->/g,
    (whole, name) => {
      let svg;
      try {
        svg = readFileSync(new URL(`./${name}.svg`, import.meta.url), "utf-8").trim();
      } catch {
        console.warn(`${page}: no chart built for ${name} — leaving it as it was`);
        missing++;
        return whole;
      }
      injected++;
      return `<!--chart:${name}-->\n${svg}\n<!--/chart-->`;
    },
  );
  const withIncludes = after.replace(
    /<!--include:([a-z0-9-]+)-->[\s\S]*?<!--\/include-->/g,
    (whole, name) => {
      let html;
      try {
        html = readFileSync(new URL(`./${name}.html`, import.meta.url), "utf-8").trim();
      } catch {
        console.warn(`${page}: no fragment built for ${name} — leaving it as it was`);
        missing++;
        return whole;
      }
      injected++;
      return `<!--include:${name}-->
${html}
<!--/include-->`;
    },
  );
  if (withIncludes !== before) writeFileSync(file, withIncludes, "utf-8");
}

console.log(`docs:sync — inlined ${injected} charts and fragments into the pages${missing ? `, ${missing} missing` : ""}`);
