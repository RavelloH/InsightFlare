import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { TooltipProvider } from "@insightflare/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AnalyticsTimeTooltipProvider,
  AnalyticsTimeTooltipTarget,
} from "@/components/dashboard/analytics-time-tooltip";
import {
  formatRelativeTime,
  RelativeTimeValue,
  useRelativeTimeSelection,
} from "@/components/dashboard/journeys/journey-display";
import { TimeZoneProvider } from "@/components/time-zone-provider";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

async function render(element: ReactNode) {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
}

describe("AnalyticsTimeTooltipProvider", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("mounts its fixed anchor in the page floating host", async () => {
    await render(
      <LayerManagerProvider>
        <TimeZoneProvider>
          <TooltipProvider>
            <AnalyticsTimeTooltipProvider>
              <AnalyticsTimeTooltipTarget locale="en" timestamp={0}>
                <span>Timestamp</span>
              </AnalyticsTimeTooltipTarget>
            </AnalyticsTimeTooltipProvider>
          </TooltipProvider>
        </TimeZoneProvider>
      </LayerManagerProvider>,
    );

    const trigger = document.querySelector<HTMLElement>(
      '[data-slot="tooltip-trigger"]',
    );
    const host = document.querySelector<HTMLElement>(
      "[data-layer-page-floating-host]",
    );

    expect(trigger).not.toBeNull();
    expect(trigger?.closest("[data-layer-page-floating-host]")).toBe(host);
  });
  it("merges same-target pointer moves into one geometry read and switches targets immediately", async () => {
    await render(
      <LayerManagerProvider>
        <TimeZoneProvider>
          <AnalyticsTimeTooltipProvider retentionMode="target">
            <AnalyticsTimeTooltipTarget
              locale="en"
              timestamp={Date.UTC(2026, 0, 1)}
            >
              First
            </AnalyticsTimeTooltipTarget>
            <AnalyticsTimeTooltipTarget
              locale="en"
              timestamp={Date.UTC(2026, 0, 2)}
            >
              Second
            </AnalyticsTimeTooltipTarget>
          </AnalyticsTimeTooltipProvider>
        </TimeZoneProvider>
      </LayerManagerProvider>,
    );
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-analytics-tooltip-group]"),
    );
    const rect = new DOMRect(10, 20, 80, 20);
    const firstMeasure = vi
      .spyOn(first!, "getBoundingClientRect")
      .mockReturnValue(rect);
    const secondMeasure = vi
      .spyOn(second!, "getBoundingClientRect")
      .mockReturnValue(rect);
    try {
      await act(async () => {
        first!.dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, clientX: 20 }),
        );
      });
      expect(firstMeasure).toHaveBeenCalled();
      firstMeasure.mockClear();
      await act(async () => {
        for (let i = 0; i < 100; i++) {
          first!.dispatchEvent(
            new MouseEvent("mousemove", { bubbles: true, clientX: 20 + i }),
          );
        }
        expect(firstMeasure).not.toHaveBeenCalled();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(firstMeasure).toHaveBeenCalledTimes(1);
      firstMeasure.mockClear();
      await act(async () => {
        first!.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true, clientX: 30 }),
        );
        first!.dispatchEvent(
          new MouseEvent("mouseout", { bubbles: true, relatedTarget: second }),
        );
        second!.dispatchEvent(
          new MouseEvent("mouseover", {
            bubbles: true,
            relatedTarget: first,
            clientX: 40,
          }),
        );
        expect(secondMeasure).toHaveBeenCalledTimes(1);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      });
      expect(firstMeasure).not.toHaveBeenCalled();
      expect(secondMeasure).toHaveBeenCalledTimes(1);
    } finally {
      firstMeasure.mockRestore();
      secondMeasure.mockRestore();
    }
  });
  it("updates only changed time snapshots with one timer and cleans up when all cells unmount", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const start = Date.UTC(2026, 10, 25, 12);
    vi.setSystemTime(start);
    const parentRender = vi.fn();
    const staticRender = vi.fn();
    const timeRender = vi.fn();
    const activeRender = vi.fn();
    const oldTime = start - 7 * 86400_000;
    const endedAt = start - 4.75 * 60_000;
    function Time({ id, timestamp }: { id: string; timestamp: number }) {
      const value = useRelativeTimeSelection((now) =>
        formatRelativeTime("en", timestamp, now),
      );
      timeRender(id);
      return <span id={id}>{value}</span>;
    }
    function Active() {
      const active = useRelativeTimeSelection(
        (now) => endedAt > now - 5 * 60_000,
      );
      activeRender();
      return <span id="active">{String(active)}</span>;
    }
    function StaticCell() {
      staticRender();
      return <span>Static</span>;
    }
    function Table() {
      parentRender();
      return (
        <table>
          <tbody>
            {Array.from({ length: 100 }, (_, i) => (
              <tr key={i}>
                <td>
                  <StaticCell />
                </td>
                <td>
                  <Time
                    id={"time-" + i}
                    timestamp={i === 0 ? start : oldTime}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    try {
      await render(
        <>
          <Table />
          <Active />
          <span id="public-value">
            <RelativeTimeValue locale="en" timestamp={start} />
          </span>
        </>,
      );
      expect(vi.getTimerCount()).toBe(1);
      expect(parentRender).toHaveBeenCalledTimes(1);
      expect(staticRender).toHaveBeenCalledTimes(100);
      expect(timeRender).toHaveBeenCalledTimes(100);
      expect(container.querySelector("#active")?.textContent).toBe("true");
      const rows = Array.from(container.querySelectorAll("tr"));
      timeRender.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(parentRender).toHaveBeenCalledTimes(1);
      expect(staticRender).toHaveBeenCalledTimes(100);
      expect(timeRender.mock.calls).toEqual([["time-0"]]);
      expect(activeRender).toHaveBeenCalledTimes(2);
      expect(container.querySelector("#active")?.textContent).toBe("false");
      expect(container.querySelector("#public-value")?.textContent).toBe(
        formatRelativeTime("en", start, start + 30_000),
      );
      expect(Array.from(container.querySelectorAll("tr"))).toEqual(rows);
      await render(null);
      expect(vi.getTimerCount()).toBe(0);
      vi.setSystemTime(start + 120_000);
      await render(<RelativeTimeValue locale="en" timestamp={start} />);
      expect(container.textContent).toBe(
        formatRelativeTime("en", start, start + 120_000),
      );
      expect(vi.getTimerCount()).toBe(1);
      await render(null);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await render(null);
      vi.useRealTimers();
    }
  });
});
