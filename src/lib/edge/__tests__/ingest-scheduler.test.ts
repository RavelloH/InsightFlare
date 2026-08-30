import { describe, expect, it } from "vitest";

import {
  effectiveNextDueAt,
  getEarliestDueWork,
  lifecycleDueAt,
} from "@/lib/edge/ingest-scheduler";

describe("ingest scheduler", () => {
  it("computes lifecycle deadlines for open and hidden visits", () => {
    expect(lifecycleDueAt("open", 1_000, null)).toBe(
      1_000 + 12 * 60 * 60 * 1000,
    );
    expect(lifecycleDueAt("hidden_pending", 1_000, 2_000)).toBe(
      2_000 + 30 * 60 * 1000,
    );
    expect(lifecycleDueAt("hidden_pending", 1_000, null)).toBe(
      1_000 + 12 * 60 * 60 * 1000,
    );
    expect(lifecycleDueAt("hidden_pending", null, null)).toBe(
      12 * 60 * 60 * 1000,
    );
    expect(lifecycleDueAt("open", null, null)).toBeNull();
    expect(lifecycleDueAt("complete", 1_000, null)).toBeNull();
  });

  it("uses the earliest flush or lifecycle deadline and gives flush ties priority", () => {
    expect(effectiveNextDueAt(100, 200)).toBe(100);
    expect(effectiveNextDueAt(null, 200)).toBe(200);
    expect(effectiveNextDueAt(100, null)).toBe(100);

    const result = getEarliestDueWork({
      sqlOne: <T>(query: string): T | null => {
        if (query.includes("buffered_visits")) {
          return {
            nextDueAt: 100,
            flushDueAt: 100,
            dirty: 1,
            status: "open",
            lastActivityAt: 0,
            hiddenAt: null,
            visitId: "visit-1",
          } as T;
        }
        return {
          nextDueAt: 100,
          flushDueAt: 100,
          eventId: "event-1",
        } as T;
      },
    });

    expect(result).toEqual({
      nextDueAt: 100,
      reason: "flush",
      entity: "visit",
    });
  });

  it("selects the earliest entity across both buffer tables", () => {
    const result = getEarliestDueWork({
      sqlOne: <T>(query: string): T | null => {
        if (query.includes("buffered_visits")) {
          return {
            nextDueAt: 300,
            flushDueAt: null,
            dirty: 0,
            status: "hidden_pending",
            lastActivityAt: 0,
            hiddenAt: 0,
            visitId: "visit-1",
          } as T;
        }
        return {
          nextDueAt: 200,
          flushDueAt: 200,
          eventId: "event-1",
        } as T;
      },
    });

    expect(result).toEqual({
      nextDueAt: 200,
      reason: "flush",
      entity: "custom_event",
    });
  });

  it("handles empty and single-table queues", () => {
    expect(getEarliestDueWork({ sqlOne: () => null })).toEqual({
      nextDueAt: null,
      reason: null,
      entity: null,
    });

    expect(
      getEarliestDueWork({
        sqlOne: <T>(query: string): T | null =>
          query.includes("buffered_visits")
            ? null
            : ({
                nextDueAt: 200,
                flushDueAt: 200,
                eventId: "event-1",
              } as T),
      }),
    ).toEqual({
      nextDueAt: 200,
      reason: "flush",
      entity: "custom_event",
    });

    expect(
      getEarliestDueWork({
        sqlOne: <T>(query: string): T | null =>
          query.includes("buffered_visits")
            ? ({
                nextDueAt: 300,
                flushDueAt: 400,
                dirty: 0,
                status: "open",
                lastActivityAt: 0,
                hiddenAt: null,
                visitId: "visit-1",
              } as T)
            : null,
      }),
    ).toEqual({
      nextDueAt: 300,
      reason: "visit_timeout",
      entity: "visit",
    });
  });

  it("classifies hidden fallback and finalized flush work", () => {
    const hidden = getEarliestDueWork({
      sqlOne: <T>(query: string): T | null =>
        query.includes("buffered_visits")
          ? ({
              nextDueAt: 300,
              flushDueAt: null,
              dirty: 0,
              status: "hidden_pending",
              lastActivityAt: 0,
              hiddenAt: 0,
              visitId: "hidden-visit",
            } as T)
          : null,
    });
    expect(hidden.reason).toBe("hidden_fallback");

    const finalized = getEarliestDueWork({
      sqlOne: <T>(query: string): T | null =>
        query.includes("buffered_visits")
          ? ({
              nextDueAt: 300,
              flushDueAt: 400,
              dirty: 1,
              status: "complete",
              lastActivityAt: 0,
              hiddenAt: null,
              visitId: "complete-visit",
            } as T)
          : null,
    });
    expect(finalized.reason).toBe("flush");
  });

  it("normalizes nullable due values from legacy rows", () => {
    const visit = getEarliestDueWork({
      sqlOne: <T>(query: string): T | null =>
        query.includes("buffered_visits")
          ? ({
              nextDueAt: null,
              flushDueAt: null,
              dirty: 0,
              status: "complete",
              lastActivityAt: 0,
              hiddenAt: null,
              visitId: "legacy-visit",
            } as T)
          : null,
    });
    expect(visit).toEqual({
      nextDueAt: null,
      reason: "flush",
      entity: "visit",
    });

    const event = getEarliestDueWork({
      sqlOne: <T>(query: string): T | null =>
        query.includes("buffered_visits")
          ? null
          : ({
              nextDueAt: null,
              flushDueAt: null,
              eventId: "legacy-event",
            } as T),
    });
    expect(event).toEqual({
      nextDueAt: null,
      reason: "flush",
      entity: "custom_event",
    });

    const nullableVisitDue = getEarliestDueWork({
      sqlOne: <T>(query: string): T | null =>
        query.includes("buffered_visits")
          ? ({
              nextDueAt: null,
              flushDueAt: null,
              dirty: 0,
              status: "complete",
              lastActivityAt: 0,
              hiddenAt: null,
              visitId: "nullable-visit",
            } as T)
          : ({
              nextDueAt: 500,
              flushDueAt: 500,
              eventId: "event-1",
            } as T),
    });
    expect(nullableVisitDue.entity).toBe("custom_event");
  });
});
