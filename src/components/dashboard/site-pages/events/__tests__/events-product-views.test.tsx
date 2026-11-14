import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createEventMetricItems,
  eventMetricsContract,
  EventMetricsView,
  type EventMetricsViewProps,
  EventTrendCard,
  eventTrendCardContract,
  type EventTrendCardProps,
} from "@insightflare/product-ui/events";
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
    root.render(element);
    await Promise.resolve();
  });
}

function metricsProps(id: string): EventMetricsViewProps {
  const fixture = eventMetricsContract.fixtures.find((item) => item.id === id);
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.props;
}

function trendProps(id: string): EventTrendCardProps {
  const fixture = eventTrendCardContract.fixtures.find(
    (item) => item.id === id,
  );
  if (!fixture) throw new Error(`Missing fixture ${id}`);
  return fixture.props;
}

const zhMetricLabels = {
  totalEvents: "事件总数",
  shareOfAllEvents: "占全部事件",
  detailSubtitle: "所选时段的自定义事件",
  eventTypes: "事件类型",
  breakdownTitle: "事件类型分布",
  sessions: "会话数",
  avgEventsPerSession: "每会话事件数",
  visitors: "访客数",
  recordsTitle: "事件记录",
};
const zhTrendLabels = {
  title: "事件趋势",
  other: "其他",
  empty: "该时段暂无事件",
  totalEvents: "事件总数",
  cumulative: "累计事件",
  currentPeriod: "当前时段",
};

const metricsReady = metricsProps("event-metrics.state.ready");
const metricsComparison = metricsProps("event-metrics.state.comparison");
const trendReady = trendProps("event-trend-card.state.ready");
const trendEmpty = trendProps("event-trend-card.state.empty");
const trendComparison = trendProps("event-trend-card.state.comparison");

describe("events product views", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  describe("createEventMetricItems", () => {
    it("falls back to descriptive details without a comparison", () => {
      const items = createEventMetricItems(metricsReady);
      expect(items.map((item) => item.id)).toEqual([
        "events",
        "event-types",
        "sessions",
        "visitors",
      ]);
      expect(items[0]?.value).toBe("18,420");
      expect(items[0]?.detail).toBe(metricsReady.labels.detailSubtitle);
      expect(items[1]?.detail).toBe(metricsReady.labels.breakdownTitle);
      expect(items[2]?.detail).toBe(
        `${metricsReady.labels.avgEventsPerSession}: 2.92`,
      );
      expect(items[3]?.detail).toBe(metricsReady.labels.recordsTitle);
      expect(items.every((item) => item.change === undefined)).toBe(true);
    });

    it("shows the event share when requested", () => {
      const items = createEventMetricItems({
        ...metricsReady,
        includeShare: true,
      });
      expect(items[0]?.detail).toBe(
        `${metricsReady.labels.shareOfAllEvents}: 18.4%`,
      );
    });

    it("omits the share when the summary has none", () => {
      const items = createEventMetricItems({
        ...metricsReady,
        includeShare: true,
        summary: { ...metricsReady.summary, shareOfAllEvents: undefined },
      });
      expect(items[0]?.detail).toBe(metricsReady.labels.detailSubtitle);
    });

    it("reports signed changes against the comparison period", () => {
      const items = createEventMetricItems(metricsComparison);
      expect(items[0]?.detail).toBe("Previous period: 16,105");
      expect(items[0]?.change).toEqual({
        value: "+14.4%",
        direction: "up",
        tone: "positive",
      });
    });

    it("marks decreases as negative", () => {
      const items = createEventMetricItems({
        ...metricsComparison,
        comparisonSummary: {
          ...metricsComparison.comparisonSummary!,
          events: 40000,
        },
      });
      expect(items[0]?.change).toEqual({
        value: "-53.9%",
        direction: "down",
        tone: "negative",
      });
    });

    it("skips the change when the comparison value is zero", () => {
      const items = createEventMetricItems({
        ...metricsComparison,
        comparisonSummary: {
          ...metricsComparison.comparisonSummary!,
          events: 0,
        },
      });
      expect(items[0]?.change).toBeUndefined();
    });

    it("uses a generic comparison label by default", () => {
      const items = createEventMetricItems({
        ...metricsComparison,
        comparisonLabel: undefined,
      });
      expect(items[0]?.detail).toBe("Comparison: 16,105");
    });

    it("propagates the loading flag", () => {
      const items = createEventMetricItems({ ...metricsReady, loading: true });
      expect(items.every((item) => item.loading)).toBe(true);
    });
  });

  describe("EventMetricsView", () => {
    it("renders the metric labels, values and changes", async () => {
      await render(<EventMetricsView {...metricsComparison} />);
      const text = container.textContent ?? "";
      expect(text).toContain(metricsComparison.labels.totalEvents);
      expect(text).toContain("18,420");
      expect(text).toContain("+14.4%");
    });

    it("renders localized labels supplied by the host", async () => {
      await render(
        <EventMetricsView {...metricsReady} labels={zhMetricLabels} />,
      );
      expect(container.textContent).toContain(zhMetricLabels.totalEvents);
    });
  });

  describe("EventTrendCard", () => {
    it("renders the title", async () => {
      await render(<EventTrendCard {...trendReady} />);
      expect(container.textContent).toContain(trendReady.labels.title);
    });

    it("renders the empty state label", async () => {
      await render(<EventTrendCard {...trendEmpty} />);
      expect(container.textContent).toContain(trendEmpty.labels.empty);
    });

    it("renders with a comparison period", async () => {
      await render(<EventTrendCard {...trendComparison} />);
      expect(container.textContent).toContain(trendComparison.labels.title);
    });

    it("renders localized labels supplied by the host", async () => {
      await render(<EventTrendCard {...trendReady} labels={zhTrendLabels} />);
      expect(container.textContent).toContain(zhTrendLabels.title);
    });
  });

  describe("contracts", () => {
    it("renders every contract fixture", () => {
      for (const contract of [eventMetricsContract, eventTrendCardContract]) {
        for (const fixture of contract.fixtures) {
          expect(contract.renderFixture(fixture.id)).not.toBeNull();
        }
      }
    });

    it("includes a showcase fixture for each view", () => {
      for (const contract of [eventMetricsContract, eventTrendCardContract]) {
        expect(
          contract.fixtures.some((fixture) => fixture.id.endsWith(".showcase")),
        ).toBe(true);
      }
    });
  });
});
