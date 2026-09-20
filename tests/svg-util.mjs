/**
 * svg-util.mjs — shared SVG chart primitives.
 *
 * Every chart renders once, tokenized: colors come out as
 * `var(--jv-role, <light hex>)`. Inlined into the docs site the page's CSS
 * variables drive them, so one file follows the theme toggle instantly and
 * native <title> tooltips survive. Opened on their own (GitHub, a direct
 * link) the fallback hex renders the light theme.
 *
 * resolveTokens() bakes a theme back in when a static raster is needed.
 *
 * Palette: status roles (allow/ask/block) are the fixed good/warning/critical
 * steps, identical in both themes; ink, grid and accent are themed. Status
 * color never carries meaning alone — every mark is direct-labelled or named
 * in a legend.
 */

export const THEMES = {
  light: {
    bg: "#fcfcfb",
    panel: "#f2f1ee",
    text: "#0b0b0b",
    dim: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    border: "#c3c2b7",
    allow: "#0ca30c",
    ask: "#fab219",
    block: "#d03b3b",
    accent: "#2a78d6",
    error: "#898781",
  },
  dark: {
    bg: "#1a1a19",
    panel: "#242422",
    text: "#ffffff",
    dim: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    border: "#383835",
    allow: "#0ca30c",
    ask: "#fab219",
    block: "#d03b3b",
    accent: "#3987e5",
    error: "#898781",
  },
};

/** The palette generators draw with: role -> `var(--jv-role, lightHex)`. */
export const P = Object.fromEntries(
  Object.entries(THEMES.light).map(([role, hex]) => [role, `var(--jv-${role}, ${hex})`]),
);

/** Ink to set on top of a filled status mark, picked for contrast. */
export const ON = { allow: "#ffffff", ask: "#1a1a19", block: "#ffffff", accent: "#ffffff" };

/** Bake one theme's hex values into a tokenized SVG (for rasterizing). */
export function resolveTokens(svg, mode = "light") {
  const theme = THEMES[mode] ?? THEMES.light;
  return svg.replace(/var\(--jv-([a-z]+),\s*(#[0-9a-f]{6})\)/gi, (_, role, fallback) => theme[role] ?? fallback);
}

export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export function escXml(value) {
  // docs/.nojekyll keeps Pages from templating the site, but these SVGs get
  // embedded elsewhere too, and a literal "{{" or "{%" in command text is
  // Liquid to anything that does. Breaking the pair with a character reference
  // renders identically and costs nothing.
  return String(value)
    .replace(/\{(?=[{%])/g, "&#123;")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const n = (v) => (Math.round(v * 10) / 10).toString();

export function svgOpen(width, height, { bg = true, alt } = {}) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" role="img" font-family="${FONT}">\n` +
    (alt ? `<title>${escXml(alt)}</title>\n` : "") +
    (bg ? `<rect width="${width}" height="${height}" fill="${P.bg}"/>\n` : "")
  );
}

export const svgClose = () => `</svg>\n`;

/* ------------------------------------------------------------------ type */

export function title(x, y, text) {
  return `<text x="${n(x)}" y="${n(y)}" font-size="19" font-weight="650" fill="${P.text}" letter-spacing="-0.01em">${escXml(text)}</text>\n`;
}

export function subtitle(x, y, text) {
  return `<text x="${n(x)}" y="${n(y)}" font-size="13" fill="${P.dim}">${escXml(text)}</text>\n`;
}

export function label(x, y, text, { fill = P.text, size = 12, anchor = "start", weight, opacity, tabular } = {}) {
  const w = weight ? ` font-weight="${weight}"` : "";
  const o = opacity ? ` opacity="${opacity}"` : "";
  const t = tabular ? ` font-variant-numeric="tabular-nums"` : "";
  return `<text x="${n(x)}" y="${n(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${w}${o}${t}>${escXml(text)}</text>\n`;
}

/** Truncate to a max character count with an ellipsis. */
export function clip(text, max) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Rough advance width, good enough to decide whether a label fits a mark. */
export const textWidth = (text, size) => String(text).length * size * 0.58;

/* ----------------------------------------------------------------- chrome */

/** Solid hairline gridlines, one step off the surface. */
export function gridV(xs, y0, y1) {
  return xs
    .map((x) => `<line x1="${n(x)}" y1="${n(y0)}" x2="${n(x)}" y2="${n(y1)}" stroke="${P.grid}" stroke-width="1"/>\n`)
    .join("");
}

export function axisLine(x0, y, x1) {
  return `<line x1="${n(x0)}" y1="${n(y)}" x2="${n(x1)}" y2="${n(y)}" stroke="${P.border}" stroke-width="1"/>\n`;
}

/** A dashed reference line marks a threshold — never the grid. */
export function threshold(x, y0, y1, text) {
  let s = `<line x1="${n(x)}" y1="${n(y0)}" x2="${n(x)}" y2="${n(y1)}" stroke="${P.border}" stroke-width="1.5" stroke-dasharray="5 4"/>\n`;
  if (text) s += label(x, y0 - 8, text, { anchor: "middle", size: 11.5, fill: P.muted, weight: 600 });
  return s;
}

export function legend(x, y, items) {
  let out = "";
  let cx = x;
  for (const item of items) {
    out += `<rect x="${n(cx)}" y="${n(y - 9)}" width="11" height="11" rx="3" fill="${item.color}"/>\n`;
    out += `<text x="${n(cx + 17)}" y="${n(y)}" font-size="12" fill="${P.dim}">${escXml(item.label)}</text>\n`;
    cx += 17 + textWidth(item.label, 12) + 20;
  }
  return out;
}

/* ------------------------------------------------------------------ marks */

/**
 * Rounded-rect path with per-corner control, so a bar can be rounded at the
 * data end and square where it meets the baseline or a neighbour.
 */
export function rectPath(x, y, w, h, r, { tl = false, tr = false, br = false, bl = false } = {}) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const a = tl ? rr : 0, b = tr ? rr : 0, c = br ? rr : 0, d = bl ? rr : 0;
  return (
    `M${n(x + a)},${n(y)}` +
    `H${n(x + w - b)}${b ? `A${n(b)},${n(b)} 0 0 1 ${n(x + w)},${n(y + b)}` : ""}` +
    `V${n(y + h - c)}${c ? `A${n(c)},${n(c)} 0 0 1 ${n(x + w - c)},${n(y + h)}` : ""}` +
    `H${n(x + d)}${d ? `A${n(d)},${n(d)} 0 0 1 ${n(x)},${n(y + h - d)}` : ""}` +
    `V${n(y + a)}${a ? `A${n(a)},${n(a)} 0 0 1 ${n(x + a)},${n(y)}` : ""}Z`
  );
}

/** One horizontal bar segment. `end` rounds the data end; `tip` adds a tooltip. */
export function barSeg({ x, y, width, height, fill, end = false, tip }) {
  const w = Math.max(1.5, width);
  const path = rectPath(x, y, w, height, 4, { tr: end, br: end });
  const rect = `<path class="mark" d="${path}" fill="${fill}"/>\n`;
  return tip === undefined ? rect : `<g class="mark-g"><title>${escXml(tip)}</title>${rect}</g>\n`;
}

/** A dot with a 2px surface ring so overlapping marks stay legible. */
export function dot({ cx, cy, r = 5, fill, tip }) {
  const c =
    `<circle class="mark" cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}" ` +
    `stroke="${P.bg}" stroke-width="2"/>\n`;
  return tip === undefined ? c : `<g class="mark-g"><title>${escXml(tip)}</title>${c}</g>\n`;
}

/* --------------------------------------------------------------- diagrams */

export function panel({ x, y, w, h, r = 12, fill = P.panel, stroke = P.border, width = 1 }) {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${width}"/>\n`;
}

/** A pill chip with its label — used for terminal outcomes in diagrams. */
export function chip({ x, y, w, h = 32, text, color, ink = "#ffffff" }) {
  return (
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" fill="${color}"/>\n` +
    label(x + w / 2, y + h / 2 + 4.5, text, { anchor: "middle", size: 12.5, weight: 700, fill: ink })
  );
}

export function arrow(x1, y1, x2, y2, { color = P.border, text, textFill } = {}) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const head = 8;
  const hx = x2 - head * Math.cos(a);
  const hy = y2 - head * Math.sin(a);
  const w = 4.2;
  const p1 = `${n(hx - w * Math.sin(a))},${n(hy + w * Math.cos(a))}`;
  const p2 = `${n(hx + w * Math.sin(a))},${n(hy - w * Math.cos(a))}`;
  let s = `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(hx)}" y2="${n(hy)}" stroke="${color}" stroke-width="1.5"/>\n`;
  s += `<polygon points="${n(x2)},${n(y2)} ${p1} ${p2}" fill="${color}"/>\n`;
  if (text) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const vertical = Math.abs(y2 - y1) > Math.abs(x2 - x1);
    s += label(vertical ? mx + 8 : mx, vertical ? my + 4 : my - 7, text, {
      anchor: vertical ? "start" : "middle",
      size: 11,
      weight: 600,
      fill: textFill ?? P.muted,
    });
  }
  return s;
}
