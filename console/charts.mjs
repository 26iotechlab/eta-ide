// charts.mjs — dependency-free chart images as SVG (bar / line / pie).
// SVG is a real image format that opens anywhere, embeds in HTML reports, and
// renders inside create_pdf. No charting library, no browser needed.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const PALETTE = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#af7aa1", "#76b7b2", "#edc948", "#ff9da7", "#9c755f", "#bab0ac"];

// spec: { type:"bar"|"line"|"pie", title?, labels:[...], values:[...] }
export function buildChartSvg(spec) {
  const type = (spec.type || "bar").toLowerCase();
  const labels = (spec.labels || []).map(String);
  const values = (spec.values || []).map(Number).map((v) => (isFinite(v) ? v : 0));
  if (!values.length) throw new Error("chart needs at least one value");
  const W = 720, H = 440, title = spec.title || "";
  if (type === "pie") return pie(labels, values, W, H, title);
  return barLine(type, labels, values, W, H, title);
}

function frame(W, H, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="#ffffff"/>
${title ? `<text x="${W / 2}" y="28" text-anchor="middle" font-size="18" font-weight="600" fill="#222">${esc(title)}</text>` : ""}
${body}
</svg>`;
}

function barLine(type, labels, values, W, H, title) {
  const padL = 54, padR = 20, padT = title ? 48 : 24, padB = 54;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...values, 0), min = Math.min(...values, 0);
  const span = max - min || 1;
  const y = (v) => padT + ih - ((v - min) / span) * ih;
  const n = values.length;
  // gridlines + y labels (5 ticks)
  let grid = "";
  for (let t = 0; t <= 4; t++) {
    const val = min + (span * t) / 4, yy = y(val);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#eee"/>`;
    grid += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#888">${(+val.toFixed(2))}</text>`;
  }
  const axis = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + ih}" stroke="#ccc"/><line x1="${padL}" y1="${padT + ih}" x2="${W - padR}" y2="${padT + ih}" stroke="#ccc"/>`;
  let marks = "";
  const step = iw / n;
  const xLabels = labels.map((l, i) => `<text x="${padL + step * (i + 0.5)}" y="${padT + ih + 18}" text-anchor="middle" font-size="11" fill="#555">${esc(l || i + 1)}</text>`).join("");
  if (type === "line") {
    const pts = values.map((v, i) => `${padL + step * (i + 0.5)},${y(v)}`).join(" ");
    marks += `<polyline points="${pts}" fill="none" stroke="${PALETTE[0]}" stroke-width="2.5"/>`;
    marks += values.map((v, i) => `<circle cx="${padL + step * (i + 0.5)}" cy="${y(v)}" r="3.5" fill="${PALETTE[0]}"/>`).join("");
  } else {
    const bw = step * 0.62;
    marks += values.map((v, i) => {
      const yy = y(Math.max(v, 0)), h = Math.abs(y(v) - y(0));
      return `<rect x="${padL + step * (i + 0.5) - bw / 2}" y="${yy}" width="${bw}" height="${Math.max(1, h)}" fill="${PALETTE[i % PALETTE.length]}" rx="2"/>`;
    }).join("");
  }
  return frame(W, H, title, grid + axis + marks + xLabels);
}

function pie(labels, values, W, H, title) {
  const cx = W / 2, cy = (title ? 48 : 24) + (H - (title ? 48 : 24)) / 2 - 10, r = Math.min(W, H) / 3.2;
  const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  let a0 = -Math.PI / 2, slices = "", legend = "";
  values.forEach((v, i) => {
    const frac = Math.max(0, v) / total, a1 = a0 + frac * 2 * Math.PI;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = frac > 0.5 ? 1 : 0;
    slices += `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff" stroke-width="1.5"/>`;
    legend += `<rect x="${W - 150}" y="${(title ? 56 : 32) + i * 22}" width="12" height="12" fill="${PALETTE[i % PALETTE.length]}"/><text x="${W - 132}" y="${(title ? 66 : 42) + i * 22}" font-size="12" fill="#444">${esc(labels[i] || i + 1)} (${Math.round(frac * 100)}%)</text>`;
    a0 = a1;
  });
  return frame(W, H, title, slices + legend);
}
