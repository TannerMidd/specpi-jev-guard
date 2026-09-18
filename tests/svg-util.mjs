/**
 * svg-util.mjs — shared SVG helpers. Charts are rendered twice (light + dark)
 * from the same drawing code so the site can switch themes.
 */

export const PALETTES = {
  light: {
    bg: "#ffffff",
    panel: "#f8fafc",
    text: "#111827",
    dim: "#6b7280",
    grid: "#e5e7eb",
    border: "#d1d5db",
    allow: "#22c55e",
    ask: "#eab308",
    block: "#ef4444",
    accent: "#3b82f6",
    error: "#9ca3af",
  },
  dark: {
    bg: "#0f172a",
    panel: "#1e293b",
    text: "#f1f5f9",
    dim: "#94a3b8",
    grid: "#1e293b",
    border: "#334155",
    allow: "#4ade80",
    ask: "#fbbf24",
    block: "#f87171",
    accent: "#60a5fa",
    error: "#64748b",
  },
};

export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export function escXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function svgOpen(p, width, height) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" font-family="${FONT}">\n` +
    `<rect width="${width}" height="${height}" fill="${p.bg}"/>\n`
  );
}

export function svgClose() {
  return `</svg>\n`;
}

export function title(p, x, y, text) {
  return `<text x="${x}" y="${y}" font-size="20" font-weight="700" fill="${p.text}">${escXml(text)}</text>\n`;
}

export function subtitle(p, x, y, text) {
  return `<text x="${x}" y="${y}" font-size="13" fill="${p.dim}">${escXml(text)}</text>\n`;
}

/** A labelled horizontal bar. */
export function hBar(p, { x, y, width, height, fill, opacity = 0.9 }) {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2, width).toFixed(1)}" height="${height}" rx="4" fill="${fill}" opacity="${opacity}"/>\n`;
}

export function label(p, { x, y, text, fill, size = 12, anchor = "start", weight }) {
  const w = weight ? ` font-weight="${weight}"` : "";
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" fill="${fill ?? p.text}" text-anchor="${anchor}"${w}>${escXml(text)}</text>\n`;
}

/** Truncate to a max character count with an ellipsis. */
export function clip(text, max) {
  return text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
}

export function legend(p, { x, y, items }) {
  let out = "";
  let cx = x;
  for (const item of items) {
    out += `<rect x="${cx}" y="${y - 9}" width="12" height="12" rx="3" fill="${item.color}"/>\n`;
    out += `<text x="${cx + 18}" y="${y + 1}" font-size="12" fill="${p.dim}">${escXml(item.label)}</text>\n`;
    cx += 18 + item.label.length * 6.6;
  }
  return out;
}
