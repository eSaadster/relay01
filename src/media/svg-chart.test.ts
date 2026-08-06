import { describe, expect, it } from "vitest";
import { chartToSvg, niceTicks, MAX_SERIES } from "./svg-chart.js";

describe("niceTicks", () => {
  it("returns rounded steps covering the max", () => {
    const ticks = niceTicks(87);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(87);
    // Steps are uniform
    const step = ticks[1] - ticks[0];
    for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step);
  });

  it("handles zero/negative max", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("chartToSvg", () => {
  const base = { labels: ["Jan", "Feb", "Mar"], series: [{ name: "Revenue", values: [10, 20, 15] }] };

  it("renders a bar chart with a title and no legend for a single series", () => {
    const svg = chartToSvg({ type: "bar", title: "Sales", ...base });
    expect(svg).toContain("<svg");
    expect(svg).toContain("Sales");
    expect(svg).toContain("<path"); // bars
    expect(svg).not.toContain('width="10" height="10" rx="2"'); // no legend swatch
  });

  it("renders a legend for two series in fixed color order", () => {
    const svg = chartToSvg({
      type: "line",
      labels: ["a", "b"],
      series: [
        { name: "S1", values: [1, 2] },
        { name: "S2", values: [2, 1] },
      ],
    });
    expect(svg).toContain("#2a78d6"); // slot 1 blue
    expect(svg).toContain("#eb6834"); // slot 2 orange
    expect(svg).toContain("S1");
    expect(svg).toContain("<polyline");
  });

  it("caps series at MAX_SERIES", () => {
    const series = Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, values: [1] }));
    const svg = chartToSvg({ type: "bar", labels: ["x"], series });
    expect(svg).not.toContain("S9"); // series beyond the cap are dropped
    expect(MAX_SERIES).toBe(8);
  });

  it("renders a donut pie with percentage labels", () => {
    const svg = chartToSvg({
      type: "pie",
      labels: ["A", "B"],
      series: [{ name: "share", values: [75, 25] }],
    });
    expect(svg).toContain("75%");
    expect(svg).toContain("25%");
  });

  it("escapes markup in labels and titles", () => {
    const svg = chartToSvg({ type: "bar", title: "<b>&x", labels: ["<i>"], series: [{ name: "s", values: [1] }] });
    expect(svg).toContain("&lt;b&gt;&amp;x");
    expect(svg).not.toContain("<b>");
  });

  it("throws on empty spec", () => {
    expect(() => chartToSvg({ type: "bar", labels: [], series: [] })).toThrow();
  });
});
