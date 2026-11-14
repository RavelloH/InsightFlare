import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  formatRelativeTime,
  type RealtimeConnectionState,
  realtimeLogStreamContract,
  RealtimeLogStreamView,
  type RealtimeLogStreamViewProps,
  RealtimeStatusDot,
  realtimeStatusDotContract,
  realtimeStatusLabel,
  realtimeTrafficTrendContract,
} from "@insightflare/product-ui/realtime";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { TooltipProvider } from "@insightflare/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom cannot cancel native animations; motion falls back to JS animations without WAAPI.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

async function render(element: ReactElement) {
  await act(async () => {
    root.render(
      <LayerManagerProvider>
        <TooltipProvider>{element}</TooltipProvider>
      </LayerManagerProvider>,
    );
    await Promise.resolve();
  });
}

function fixtureProps(id: string): RealtimeLogStreamViewProps {
  const fixture = realtimeLogStreamContract.fixtures.find(
    (candidate) => candidate.id === id,
  );
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.props;
}

const ready = fixtureProps("realtime-log-stream.state.ready");
const loading = fixtureProps("realtime-log-stream.state.loading");
const empty = fixtureProps("realtime-log-stream.state.empty");

const zhLogStreamLabels = {
  title: "最近事件",
  loading: "加载中",
  empty: "暂无数据",
  direct: "直接访问",
};
const enStatusLabels = {
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  failed: "Failed",
};

describe("realtime product views", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  describe("RealtimeLogStreamView", () => {
    it("renders the title and every item", async () => {
      await render(<RealtimeLogStreamView {...ready} />);
      const text = container.textContent ?? "";
      expect(text).toContain(ready.labels.title);
      for (const item of ready.items) {
        expect(text).toContain(item.title);
        expect(text).toContain(item.eventDateTime);
      }
      expect(container.querySelectorAll("li")).toHaveLength(ready.items.length);
    });

    it("reports the selected item id", async () => {
      const onSelect = vi.fn();
      await render(<RealtimeLogStreamView {...ready} onSelect={onSelect} />);
      const target = ready.items[1]!;
      const button = container.querySelector<HTMLElement>(
        `[aria-label="${target.title}"]`,
      );
      expect(button).not.toBeNull();
      await act(async () => {
        button?.click();
      });
      expect(onSelect).toHaveBeenCalledWith(target.id);
    });

    it("shows the loading label without items", async () => {
      await render(<RealtimeLogStreamView {...loading} />);
      expect(container.textContent).toContain(loading.labels.loading);
      expect(container.querySelectorAll("li")).toHaveLength(0);
    });

    it("shows the empty label without items", async () => {
      await render(<RealtimeLogStreamView {...empty} />);
      expect(container.textContent).toContain(empty.labels.empty);
      expect(container.querySelectorAll("li")).toHaveLength(0);
    });

    it("falls back to a globe icon without a country flag", async () => {
      const item = ready.items[0]!;
      await render(
        <RealtimeLogStreamView
          {...ready}
          items={[{ ...item, countryFlagCode: null }]}
        />,
      );
      expect(container.textContent).toContain(item.countryLabel);
    });

    it("uses the direct label as the unknown source", async () => {
      const item = ready.items[0]!;
      await render(
        <RealtimeLogStreamView
          {...ready}
          items={[{ ...item, sourceLabel: ready.labels.direct }]}
        />,
      );
      expect(container.textContent).toContain(ready.labels.direct);
    });

    it("renders localized labels supplied by the host", async () => {
      await render(
        <RealtimeLogStreamView {...ready} labels={zhLogStreamLabels} />,
      );
      expect(container.textContent).toContain(zhLogStreamLabels.title);
    });

    describe("density and avatar options", () => {
      const avatarSelector = 'svg[viewBox="0 0 90 90"]';

      it("keeps the dashboard look by default", async () => {
        await render(<RealtimeLogStreamView {...ready} />);
        expect(container.querySelectorAll(avatarSelector)).toHaveLength(
          ready.items.length,
        );
        expect(container.textContent).toContain(ready.items[0]!.eventDateTime);
      });

      it("omits the avatar ring when showAvatar is false", async () => {
        await render(<RealtimeLogStreamView {...ready} showAvatar={false} />);
        expect(container.querySelectorAll(avatarSelector)).toHaveLength(0);
        expect(container.querySelectorAll("li")).toHaveLength(
          ready.items.length,
        );
      });

      it("renders slim rows in compact density", async () => {
        await render(<RealtimeLogStreamView {...ready} density="compact" />);
        const text = container.textContent ?? "";
        for (const item of ready.items) expect(text).toContain(item.title);
        expect(text).not.toContain(ready.items[0]!.eventDateTime);
        expect(container.querySelectorAll(avatarSelector)).toHaveLength(
          ready.items.length,
        );
      });

      it("supports compact rows without avatars", async () => {
        const compact = fixtureProps("realtime-log-stream.compact");
        await render(<RealtimeLogStreamView {...compact} />);
        expect(container.querySelectorAll(avatarSelector)).toHaveLength(0);
        expect(container.textContent).toContain(compact.items[0]!.title);
      });
    });
  });

  describe("RealtimeStatusDot", () => {
    const expectations: ReadonlyArray<[RealtimeConnectionState, string]> = [
      ["connected", "bg-emerald-500"],
      ["connecting", "bg-neutral-500"],
      ["disconnected", "bg-amber-500"],
      ["failed", "bg-rose-500"],
    ];

    for (const [status, colorClass] of expectations) {
      it(`renders the ${status} state`, async () => {
        await render(<RealtimeStatusDot status={status} />);
        expect(container.innerHTML).toContain(colorClass);
      });
    }

    it("maps statuses to localized labels", () => {
      expect(realtimeStatusLabel(enStatusLabels, "connected")).toBe(
        "Connected",
      );
      expect(realtimeStatusLabel(enStatusLabels, "connecting")).toBe(
        "Connecting",
      );
      expect(realtimeStatusLabel(enStatusLabels, "disconnected")).toBe(
        "Reconnecting",
      );
      expect(realtimeStatusLabel(enStatusLabels, "failed")).toBe("Failed");
    });
  });

  describe("formatRelativeTime", () => {
    const now = 1_700_000_000_000;

    it("uses the largest fitting unit", () => {
      expect(formatRelativeTime("en-US", now - 30_000, now)).toBe(
        "30 seconds ago",
      );
      expect(formatRelativeTime("en-US", now - 5 * 60_000, now)).toBe(
        "5 minutes ago",
      );
      expect(formatRelativeTime("en-US", now - 3 * 3_600_000, now)).toBe(
        "3 hours ago",
      );
      expect(formatRelativeTime("en-US", now - 2 * 86_400_000, now)).toBe(
        "2 days ago",
      );
    });

    it("localizes through the supplied Intl locale", () => {
      const zh = formatRelativeTime("zh-CN", now - 5 * 60_000, now);
      expect(zh).toContain("5");
      expect(zh).not.toBe(formatRelativeTime("en-US", now - 5 * 60_000, now));
    });
  });

  describe("contracts", () => {
    it("renders every realtime contract fixture", () => {
      for (const contract of [
        realtimeLogStreamContract,
        realtimeStatusDotContract,
        realtimeTrafficTrendContract,
      ]) {
        for (const fixture of contract.fixtures) {
          expect(contract.renderFixture(fixture.id)).not.toBeNull();
        }
      }
    });

    it("includes a showcase fixture for the live views", () => {
      for (const contract of [
        realtimeLogStreamContract,
        realtimeTrafficTrendContract,
      ]) {
        expect(
          contract.fixtures.some((fixture) => fixture.id.endsWith(".showcase")),
        ).toBe(true);
      }
    });
  });
});
