import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/analytics/providers/d1/internal/events-summary", () => ({
  queryEventsSummaryFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/providers/d1/internal/events-trend", () => ({
  queryEventsTrendFromD1: vi.fn(),
}));

import type { FilterFieldId } from "@/lib/edge/analytics/contract";
import { queryEventsSummaryFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { queryEventsTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import {
  type ReadSiteEventsInput,
  readSiteEventsSummary,
  readSiteEventsTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-events";

const input = {
  env: {} as never,
  siteId: "site-1",
  window: { startMs: 0, endExclusiveMs: 1, nowMs: 1, timeZone: "UTC" },
  filters: {
    version: 1 as const,
    root: {
      kind: "condition" as const,
      target: { kind: "field" as const, field: "page.path" as FilterFieldId },
      operator: "eq" as const,
      value: "/pricing",
    },
  },
} satisfies ReadSiteEventsInput;

describe("site events runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("executes typed event summary and timeseries providers", async () => {
    vi.mocked(queryEventsSummaryFromD1).mockResolvedValue({
      summary: { events: 4, eventTypes: 2, sessions: 2, visitors: 2 },
      cards: {
        event: {
          name: [{ value: "signup", views: 3, sessions: 2, visitors: 2 }],
        },
        page: { path: [], title: [], hostname: [] },
      },
    });
    await expect(readSiteEventsSummary(input)).resolves.toMatchObject({
      summary: { events: 4, avgEventsPerSession: 2 },
      cards: { event: { name: [{ label: "signup" }] } },
    });
    expect(queryEventsSummaryFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
    );

    vi.mocked(queryEventsTrendFromD1).mockResolvedValue({
      series: [
        {
          key: "event:signup",
          eventName: "signup",
          label: "signup",
          events: 3,
          sessions: 2,
          visitors: 2,
        },
      ],
      data: [
        {
          bucket: 0,
          timestampMs: 0,
          totalEvents: 3,
          eventsBySeries: { "event:signup": 3 },
        },
      ],
    });
    await expect(
      readSiteEventsTimeseries({ ...input, interval: "day", limit: 8 }),
    ).resolves.toMatchObject({
      interval: "day",
      points: [{ timestamp: "1970-01-01T00:00:00.000Z" }],
    });
    expect(queryEventsTrendFromD1).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      "day",
      input.filters,
      8,
    );
  });

  it("passes canonical filters through without audience policy", async () => {
    await expect(
      readSiteEventsSummary({
        ...input,
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "unknown.field" as FilterFieldId },
            operator: "eq",
            value: "x",
          },
        },
      }),
    ).resolves.toBeDefined();
    expect(queryEventsSummaryFromD1).toHaveBeenCalled();
  });

  it("normalizes sparse provider summaries without dividing by zero", async () => {
    vi.mocked(queryEventsSummaryFromD1).mockResolvedValue({
      summary: {} as never,
      cards: {
        event: { name: [] },
        page: { path: [], title: [], hostname: [] },
      },
    });
    await expect(readSiteEventsSummary(input)).resolves.toMatchObject({
      summary: {
        events: 0,
        eventTypes: 0,
        sessions: 0,
        visitors: 0,
        avgEventsPerSession: 0,
      },
    });
  });

  it("preserves provider failures for the application boundary", async () => {
    vi.mocked(queryEventsSummaryFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(readSiteEventsSummary(input)).rejects.toThrow("down");
    vi.mocked(queryEventsTrendFromD1).mockRejectedValueOnce(new Error("down"));
    await expect(
      readSiteEventsTimeseries({ ...input, interval: "day", limit: 8 }),
    ).rejects.toThrow("down");
  });
});
