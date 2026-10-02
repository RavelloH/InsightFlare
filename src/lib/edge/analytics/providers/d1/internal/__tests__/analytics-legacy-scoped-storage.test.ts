import { describe, expect, it } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { buildEventRecordPagePlan } from "@/lib/edge/analytics/engine/event-record-page-plan";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { AnalyticsLegacyScopedStorage } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scoped-storage";
import type {
  AnalyticsRelationalStorageContext,
  LoweredAnalyticsSource,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

const plan = buildEventRecordPagePlan({
  siteId: "legacy-scoped-storage-site",
  queryTime: createQueryTime(0, 100, "UTC", 100),
  filters: EMPTY_FILTER_DOCUMENT,
  options: {
    limit: 10,
    sort: { key: "occurredAt", direction: "desc" },
  },
});
const eventSource = plan.nodes.find(
  (node): node is SourceNode => node.kind === "source",
)!;
const storage = new AnalyticsLegacyScopedStorage(
  {} as AnalyticsRelationalStorageContext,
);
const source = {
  relation: {} as LoweredAnalyticsSource["relation"],
  values: new Map(),
} satisfies LoweredAnalyticsSource;

describe("legacy scoped Event storage guards", () => {
  it("leaves sources without a selection untouched", () => {
    const node = { ...eventSource, selection: undefined };
    expect(storage.lowerEventReportSource(node, "source", source)).toBe(source);
  });

  it("rejects unsupported entities and sources missing the hidden key", () => {
    expect(() =>
      storage.lowerEventReportSource(
        { ...eventSource, entity: "page" } as unknown as SourceNode,
        "source",
        source,
      ),
    ).toThrow(
      "source.selection: Scoped selection is currently supported only on Event report Sources.",
    );

    expect(() =>
      storage.lowerEventReportSource(
        {
          ...eventSource,
          values: eventSource.values.filter(
            (binding) =>
              binding.kind !== "attribute" ||
              binding.attribute !== "event.report.internalPk",
          ),
        },
        "source",
        source,
      ),
    ).toThrow(
      "source.selection: Scoped Event report Sources require the hidden internal primary key.",
    );
  });
});
