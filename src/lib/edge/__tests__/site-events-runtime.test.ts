import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/query/events-summary", () => ({
  queryEventsSummaryFromD1: vi.fn(),
}));
vi.mock("@/lib/edge/query/events-trend", () => ({
  queryEventsTrendFromD1: vi.fn(),
}));

import { queryEventsSummaryFromD1 } from "@/lib/edge/query/events-summary";
import { queryEventsTrendFromD1 } from "@/lib/edge/query/events-trend";
import type { FilterFieldId } from "@/lib/edge/query-contract";
import {
  type ReadSiteEventsInput,
  readSiteEventsSummary,
  readSiteEventsTimeseries,
} from "@/lib/edge/query-runtime/site-events";

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

  it("fails closed before a provider for invalid filters", async () => {
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
    ).rejects.toThrow("invalid-input");
    expect(queryEventsSummaryFromD1).not.toHaveBeenCalled();
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

  it("maps provider failures to typed internal errors", async () => {
    vi.mocked(queryEventsSummaryFromD1).mockRejectedValueOnce(
      new Error("down"),
    );
    await expect(readSiteEventsSummary(input)).rejects.toThrow("internal");
    vi.mocked(queryEventsTrendFromD1).mockRejectedValueOnce(new Error("down"));
    await expect(
      readSiteEventsTimeseries({ ...input, interval: "day", limit: 8 }),
    ).rejects.toThrow("internal");
  });
});
