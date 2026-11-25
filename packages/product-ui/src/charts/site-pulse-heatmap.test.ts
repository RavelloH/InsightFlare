import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import * as chartFormat from "./chart-format";
import {
  pulseBaseline,
  pulseLevel,
  SitePulseHeatmap,
} from "./site-pulse-heatmap";

describe("site pulse statistical fading", () => {
  it("includes zero days in sparse site baselines", () => {
    const values = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 1 : 0));
    expect(pulseBaseline(values)).toBeCloseTo(0.2);
    expect(pulseLevel(0, pulseBaseline(values))).toBe(0);
    expect(pulseLevel(1, pulseBaseline(values))).toBe(0);
    expect(pulseLevel(2, pulseBaseline(values))).toBeGreaterThan(0);
  });

  it("retains a robust median for busy sites", () => {
    expect(pulseBaseline([100, 100, 90, 0, 2000])).toBe(100);
    expect(pulseLevel(0, 100)).toBe(-4);
    expect(pulseLevel(100, 100)).toBe(0);
    expect(pulseLevel(200, 100)).toBeGreaterThan(0);
  });

  it("makes low-volume zero days neutral and increases fading with evidence", () => {
    expect([0.1, 0.5, 1, 2].map((mean) => pulseLevel(0, mean))).toEqual([
      0, 0, 0, 0,
    ]);
    expect([3, 5, 10].map((mean) => pulseLevel(0, mean))).toEqual([-2, -3, -4]);
    expect(pulseBaseline([0, 0, 0])).toBe(0);
    expect(pulseLevel(0, 0)).toBe(0);
    expect(pulseLevel(0, Number.NaN)).toBe(0);
  });
});

describe("site pulse interaction", () => {
  it("keeps cell formatting stable while moving the tooltip between rows", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const format = vi.spyOn(chartFormat, "numberFormat");
    const onRowSelect = vi.fn();
    const starts = Array.from({ length: 24 }, (_, index) =>
      Date.UTC(2026, 10, 1, index),
    );
    const rows = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      label: "Site " + index,
      values: starts.map((_, column) => index + column),
    }));
    try {
      await act(async () => {
        root.render(
          createElement(SitePulseHeatmap, {
            rows,
            bucketStarts: starts,
            locale: "en",
            timeZone: "UTC",
            interval: "hour",
            labels: {
              value: "Visitors",
              usual: "Usual",
              above: "Above",
              below: "Below",
              versusUsual: "{percent} vs usual",
            },
            onRowSelect,
          }),
        );
      });
      const cells = host.querySelectorAll<HTMLElement>('[role="gridcell"]');
      expect(cells).toHaveLength(240);
      const label = cells[25]!.getAttribute("aria-label");
      format.mockClear();
      await act(async () => {
        cells[0]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      expect(cells[0]!.classList.contains("outline-foreground")).toBe(true);
      expect(
        host.querySelector("[data-chart-tooltip-active]")?.textContent,
      ).toContain("Site 0");
      expect(format.mock.calls.length).toBeLessThan(10);
      format.mockClear();
      await act(async () => {
        cells[0]!.dispatchEvent(
          new MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: cells[25],
          }),
        );
        cells[25]!.dispatchEvent(
          new MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: cells[0],
          }),
        );
      });
      expect(cells[0]!.classList.contains("outline-foreground")).toBe(false);
      expect(cells[25]!.classList.contains("outline-foreground")).toBe(true);
      expect(cells[25]!.getAttribute("aria-label")).toBe(label);
      expect(
        host.querySelector("[data-chart-tooltip-active]")?.textContent,
      ).toContain("Site 1");
      expect(format.mock.calls.length).toBeLessThan(10);
      await act(async () => cells[25]!.click());
      expect(onRowSelect).toHaveBeenCalledWith("1");
      await act(async () => {
        cells[25]!.dispatchEvent(
          new MouseEvent("mouseout", {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(host.querySelector("[data-chart-tooltip-active]")).toBeNull();
      expect(cells[25]!.classList.contains("outline-foreground")).toBe(false);
    } finally {
      await act(async () => root.unmount());
      format.mockRestore();
      host.remove();
    }
  });
});
