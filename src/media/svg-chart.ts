// Pure SVG chart generator (bar / line / donut) for Slack PNG uploads.
// No dependencies; the SVG is rasterized with sharp by the render_chart tool.
//
// Palette and mark rules follow a validated, colorblind-safe reference palette:
// fixed categorical hue order (never cycled), y-axis from zero for bars, one
// axis only, thin marks, legend for >= 2 series, text always in ink colors.

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title?: string;
  labels: string[];
  series: ChartSeries[];
  width?: number;
  height?: number;
}

// Fixed categorical order — validated for adjacent-pair CVD separation.
const SERIES_COLORS = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
];
export const MAX_SERIES = SERIES_COLORS.length;

const SURFACE = "#fcfcfb";
const INK = "#0b0b0b";
const MUTED = "#898781";
const GRID = "#e1e0d9";
const BASELINE = "#c3c2b7";
const FONT = "font-family=\"Helvetica, Arial, sans-serif\"";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Round a max value up to a "nice" tick ceiling and return ~5 tick values. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? mag * 10;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step * 0.999; t += step) ticks.push(Number(t.toFixed(10)));
  return ticks;
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return `${+n.toFixed(2)}`;
}

interface Layout {
  width: number;
  height: number;
  plotX: number;
  plotY: number;
  plotW: number;
  plotH: number;
  parts: string[];
}

/** Shared frame: surface, title, legend (>= 2 series), plot area coords. */
function frame(spec: ChartSpec, showAxes: boolean): Layout {
  const width = spec.width ?? 800;
  const height = spec.height ?? 450;
  const parts: string[] = [`<rect width="${width}" height="${height}" fill="${SURFACE}"/>`];
  let top = 20;
  if (spec.title) {
    top = 44;
    parts.push(`<text x="24" y="30" ${FONT} font-size="17" font-weight="bold" fill="${INK}">${esc(spec.title)}</text>`);
  }
  if (spec.series.length >= 2) {
    let lx = 24;
    for (let i = 0; i < Math.min(spec.series.length, MAX_SERIES); i++) {
      const name = esc(spec.series[i].name);
      parts.push(`<rect x="${lx}" y="${top + 2}" width="10" height="10" rx="2" fill="${SERIES_COLORS[i]}"/>`);
      parts.push(`<text x="${lx + 15}" y="${top + 11}" ${FONT} font-size="12" fill="${INK}">${name}</text>`);
      lx += 25 + name.length * 6.6;
    }
    top += 28;
  }
  const plotX = showAxes ? 60 : 24;
  const plotY = top;
  const plotW = width - plotX - 24;
  const plotH = height - plotY - (showAxes ? 40 : 24);
  return { width, height, plotX, plotY, plotW, plotH, parts };
}

function axes(l: Layout, ticks: number[], labels: string[], xCenters: number[]): string[] {
  const out: string[] = [];
  const max = ticks[ticks.length - 1];
  for (const t of ticks) {
    const y = l.plotY + l.plotH - (t / max) * l.plotH;
    const stroke = t === 0 ? BASELINE : GRID;
    out.push(`<line x1="${l.plotX}" y1="${y}" x2="${l.plotX + l.plotW}" y2="${y}" stroke="${stroke}" stroke-width="1"/>`);
    out.push(`<text x="${l.plotX - 8}" y="${y + 4}" ${FONT} font-size="11" fill="${MUTED}" text-anchor="end">${fmtNum(t)}</text>`);
  }
  // Thin x labels when they would collide.
  const every = Math.max(1, Math.ceil(labels.length / Math.floor(l.plotW / 70)));
  labels.forEach((label, i) => {
    if (i % every !== 0) return;
    out.push(
      `<text x="${xCenters[i]}" y="${l.plotY + l.plotH + 18}" ${FONT} font-size="11" fill="${MUTED}" text-anchor="middle">${esc(label.slice(0, 14))}</text>`,
    );
  });
  return out;
}

/** Bar with a 4px-rounded top and square baseline end. */
function barPath(x: number, y: number, w: number, h: number, color: string): string {
  const r = Math.min(4, w / 2, h);
  const bottom = y + h;
  return (
    `<path d="M${x} ${bottom} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} ` +
    `Q${x + w} ${y} ${x + w} ${y + r} V${bottom} Z" fill="${color}"/>`
  );
}

function barChart(spec: ChartSpec): string {
  const l = frame(spec, true);
  const series = spec.series.slice(0, MAX_SERIES);
  const max = Math.max(1e-9, ...series.flatMap((s) => s.values.map((v) => Math.max(0, v))));
  const ticks = niceTicks(max);
  const tickMax = ticks[ticks.length - 1];
  const n = spec.labels.length;
  const groupW = l.plotW / Math.max(1, n);
  const gap = 2;
  const barW = Math.max(2, Math.min(48, (groupW - 12) / series.length - gap));
  const xCenters = spec.labels.map((_, i) => l.plotX + groupW * i + groupW / 2);
  l.parts.push(...axes(l, ticks, spec.labels, xCenters));
  series.forEach((s, si) => {
    s.values.slice(0, n).forEach((v, i) => {
      const h = (Math.max(0, v) / tickMax) * l.plotH;
      if (h <= 0) return;
      const groupLeft = xCenters[i] - ((barW + gap) * series.length - gap) / 2;
      const x = groupLeft + si * (barW + gap);
      l.parts.push(barPath(x, l.plotY + l.plotH - h, barW, h, SERIES_COLORS[si]));
    });
  });
  return svg(l);
}

function lineChart(spec: ChartSpec): string {
  const l = frame(spec, true);
  const series = spec.series.slice(0, MAX_SERIES);
  const max = Math.max(1e-9, ...series.flatMap((s) => s.values.map((v) => Math.max(0, v))));
  const ticks = niceTicks(max);
  const tickMax = ticks[ticks.length - 1];
  const n = spec.labels.length;
  const xAt = (i: number) => (n <= 1 ? l.plotX + l.plotW / 2 : l.plotX + (i / (n - 1)) * l.plotW);
  const yAt = (v: number) => l.plotY + l.plotH - (Math.max(0, v) / tickMax) * l.plotH;
  const xCenters = spec.labels.map((_, i) => xAt(i));
  l.parts.push(...axes(l, ticks, spec.labels, xCenters));
  series.forEach((s, si) => {
    const pts = s.values.slice(0, n).map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ");
    l.parts.push(
      `<polyline points="${pts}" fill="none" stroke="${SERIES_COLORS[si]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    // >= 8px markers with a 2px surface ring so overlapping series stay separable.
    s.values.slice(0, n).forEach((v, i) => {
      l.parts.push(
        `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="4" fill="${SERIES_COLORS[si]}" stroke="${SURFACE}" stroke-width="2"/>`,
      );
    });
  });
  return svg(l);
}

function pieChart(spec: ChartSpec): string {
  // A pie reads labels against one series; use the first.
  const values = (spec.series[0]?.values ?? []).map((v) => Math.max(0, v));
  const legendSpec: ChartSpec = {
    ...spec,
    // Legend entries are the slice labels.
    series: spec.labels.slice(0, MAX_SERIES).map((name, i) => ({ name, values: [values[i] ?? 0] })),
  };
  const l = frame(legendSpec, false);
  const total = values.slice(0, MAX_SERIES).reduce((a, b) => a + b, 0) || 1;
  const cx = l.plotX + l.plotW / 2;
  const cy = l.plotY + l.plotH / 2;
  const r = Math.min(l.plotW, l.plotH) / 2 - 10;
  const rInner = r * 0.55; // donut: lighter than a solid pie
  let angle = -Math.PI / 2;
  values.slice(0, MAX_SERIES).forEach((v, i) => {
    if (v <= 0) return;
    const sweep = (v / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`;
    l.parts.push(
      `<path d="M${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, rInner)} ` +
        `A${rInner} ${rInner} 0 ${large} 0 ${p(a0, rInner)} Z" fill="${SERIES_COLORS[i]}" stroke="${SURFACE}" stroke-width="2"/>`,
    );
    // Direct percentage label on slices big enough to hold one.
    if (sweep > 0.35) {
      const mid = (a0 + a1) / 2;
      const lr = (r + rInner) / 2;
      const pct = Math.round((v / total) * 100);
      l.parts.push(
        `<text x="${cx + lr * Math.cos(mid)}" y="${cy + lr * Math.sin(mid) + 4}" ${FONT} font-size="12" font-weight="bold" fill="${SURFACE}" text-anchor="middle">${pct}%</text>`,
      );
    }
  });
  return svg(l);
}

function svg(l: Layout): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}" viewBox="0 0 ${l.width} ${l.height}">` +
    l.parts.join("") +
    "</svg>"
  );
}

/** Render a chart spec to an SVG string. Throws on empty/invalid specs. */
export function chartToSvg(spec: ChartSpec): string {
  if (!spec.labels?.length) throw new Error("chart needs at least one label");
  if (!spec.series?.length || !spec.series.some((s) => s.values?.length)) {
    throw new Error("chart needs at least one series with values");
  }
  switch (spec.type) {
    case "bar":
      return barChart(spec);
    case "line":
      return lineChart(spec);
    case "pie":
      return pieChart(spec);
    default:
      throw new Error(`unknown chart type: ${(spec as ChartSpec).type}`);
  }
}
