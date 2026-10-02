import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/lib/edge/analytics/providers/d1/internal/event-record-page-output",
  () => ({
    queryEventRecordPageOutputRowsFromD1: vi.fn(),
  }),
);

import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
} from "@/lib/edge/analytics/contract";
import { queryEventRecordPageOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/event-record-page-output";
import { queryEventRecordPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-records";
import type { Env } from "@/lib/edge/types";

describe("event record page typed query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryEventRecordPageOutputRowsFromD1).mockResolvedValue([]);
  });

  it("passes the D1 output adapter a validated Event Logical plan", async () => {
    const env = {} as Env;
    const queryTime = createQueryTime(0, 100, "UTC", 100);

    await queryEventRecordPageFromD1(
      env,
      "site-event-records",
      {
        startMs: 0,
        endExclusiveMs: 100,
        nowMs: 100,
        timeZone: "UTC",
      },
      EMPTY_FILTER_DOCUMENT,
      {
        limit: 20,
        sort: { key: "occurredAt", direction: "desc" },
        search: "checkout",
        eventName: " signup ",
        cursor: { occurredAt: 10, eventId: "evt-1", eventPk: 4 },
        queryTime,
      },
    );

    const [receivedEnv, plan] = vi.mocked(queryEventRecordPageOutputRowsFromD1)
      .mock.calls[0]!;
    expect(receivedEnv).toBe(env);
    expect(plan.context.originOperation).toBe("event-records");
    expect(plan.context.time).toEqual(
      expect.objectContaining({
        candidate: expect.objectContaining({ startMs: 0, endExclusiveMs: 100 }),
      }),
    );

    const source = plan.nodes.find((node) => node.kind === "source");
    expect(source).toMatchObject({
      entity: "event",
      selection: {
        profile: "direct-event-records-v1",
        eventNameGate: {
          value: "signup",
          semantics: "direct-subject-local-exact-name-v1",
        },
      },
    });
    expect(source?.values).toContainEqual(
      expect.objectContaining({
        kind: "attribute",
        attribute: "event.report.internalPk",
      }),
    );

    expect(plan.nodes.some((node) => node.kind === "filter")).toBe(true);
    expect(plan.nodes.some((node) => node.kind === "sort")).toBe(true);
    expect(plan.nodes).toContainEqual(
      expect.objectContaining({ kind: "limit", count: 21 }),
    );
    expect(plan.outputs).toContainEqual(
      expect.objectContaining({
        id: "event-record-page",
        fields: expect.arrayContaining([
          expect.objectContaining({ name: "eventPk" }),
          expect.objectContaining({ name: "eventId" }),
          expect.objectContaining({ name: "eventName" }),
        ]),
      }),
    );
  });
});
