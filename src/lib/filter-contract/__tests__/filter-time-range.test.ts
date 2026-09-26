import { describe, expect, it } from "vitest";

import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
import { formatFilterDsl } from "@/lib/filter-contract/filter-dsl";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { prepareFilterTimeRange } from "@/lib/filter-contract/filter-time-range";

const candidateRange = { startMs: 70_000, endExclusiveMs: 80_000 };

describe("filter DSL time range", () => {
  it("uses top-level time bounds as the historical evaluation window", () => {
    const document = parseFilterDsl(
      'time gte @now-30s AND time lt @now AND count(event { event.name eq "purchase" }) gte 1',
      analyticsFilterRegistry,
    );
    const prepared = prepareFilterTimeRange(document, candidateRange, 100_000);

    expect(prepared.evaluationRange).toEqual({
      startMs: 70_000,
      endExclusiveMs: 100_000,
    });
    expect(formatFilterDsl(prepared.filters)).toBe(
      'count(event { event.name eq "purchase" }) gte 1',
    );
  });

  it("defaults a missing upper bound to the captured request clock", () => {
    const document = parseFilterDsl(
      "time gte @now-30s AND count(event) gte 1",
      analyticsFilterRegistry,
    );
    const prepared = prepareFilterTimeRange(document, candidateRange, 100_000);

    expect(prepared.evaluationRange).toEqual({
      startMs: 70_000,
      endExclusiveMs: 100_001,
    });
  });

  it("converts inclusive between bounds to a half-open interval", () => {
    const document = parseFilterDsl(
      'time between ["1970-01-01T00:01:10.000Z", "1970-01-01T00:01:19.999Z"] AND count(event) gte 1',
      analyticsFilterRegistry,
    );
    const prepared = prepareFilterTimeRange(document, candidateRange, 100_000);

    expect(prepared.evaluationRange).toEqual({
      startMs: 70_000,
      endExclusiveMs: 80_000,
    });
  });

  it("normalizes exact, strict, and inclusive time operators", () => {
    const timestamp = "1970-01-01T00:01:15.000Z";
    const expectedTimestamp = Date.parse(timestamp);
    const expectedEnd = Math.max(candidateRange.endExclusiveMs, 100_001);
    const cases = [
      [`time eq "${timestamp}"`, expectedTimestamp, expectedTimestamp + 1],
      [`time gt "${timestamp}"`, expectedTimestamp + 1, expectedEnd],
      [
        `time lte "${timestamp}"`,
        candidateRange.startMs,
        expectedTimestamp + 1,
      ],
    ] as const;

    for (const [timeCondition, startMs, endExclusiveMs] of cases) {
      const document = parseFilterDsl(
        `${timeCondition} AND count(event) gte 1`,
        analyticsFilterRegistry,
      );
      expect(
        prepareFilterTimeRange(document, candidateRange, 100_000)
          .evaluationRange,
      ).toEqual({ startMs, endExclusiveMs });
    }
  });

  it("uses candidate and range anchors, and allows a time-only filter", () => {
    const document = parseFilterDsl(
      "time gte @range.start AND time lte @range.end",
      analyticsFilterRegistry,
    );
    const prepared = prepareFilterTimeRange(document, candidateRange, 100_000);

    expect(prepared.evaluationRange).toEqual({
      startMs: candidateRange.startMs,
      endExclusiveMs: candidateRange.endExclusiveMs + 1,
    });
    expect(prepared.filters.root).toBeNull();
  });

  it("rejects elapsed-range forms that cannot be represented as milliseconds", () => {
    const document = parseFilterDsl(
      "time gte @now-1mo AND count(event) gte 1",
      analyticsFilterRegistry,
    );

    expect(() =>
      prepareFilterTimeRange(document, candidateRange, 100_000),
    ).toThrow("filter_time_range_invalid");
  });

  it("does not treat time predicates inside a Selector as query-level bounds", () => {
    const document = parseFilterDsl(
      "count(event { time gte @now-30s }) gte 1",
      analyticsFilterRegistry,
    );
    const prepared = prepareFilterTimeRange(document, candidateRange, 100_000);

    expect(prepared.evaluationRange).toBeUndefined();
    expect(prepared.filters).toEqual(document);
  });

  it("rejects query-level time bounds inside a boolean OR", () => {
    const document = parseFilterDsl(
      'time gte @now-30s OR page.path eq "/pricing"',
      analyticsFilterRegistry,
    );

    expect(() =>
      prepareFilterTimeRange(document, candidateRange, 100_000),
    ).toThrow("filter_time_range_must_be_unconditional");
  });

  it("rejects contradictory or unsupported top-level time bounds", () => {
    const contradictory = parseFilterDsl(
      "time gte @now-10s AND time lt @now-20s AND count(event) gte 1",
      analyticsFilterRegistry,
    );
    const unsupported = parseFilterDsl(
      "time neq @now-10s AND count(event) gte 1",
      analyticsFilterRegistry,
    );

    expect(() =>
      prepareFilterTimeRange(contradictory, candidateRange, 100_000),
    ).toThrow("filter_time_range_invalid");
    expect(() =>
      prepareFilterTimeRange(unsupported, candidateRange, 100_000),
    ).toThrow("filter_time_range_invalid");
  });

  it("keeps empty documents by identity and preserves symbol metadata when extracting bounds", () => {
    const empty = { version: 1, root: null } as const;
    expect(prepareFilterTimeRange(empty, candidateRange, 100_000).filters).toBe(
      empty,
    );

    const document = parseFilterDsl(
      "time lt @range.end AND count(event) gte 1",
      analyticsFilterRegistry,
    );
    const metadata = Symbol("saved-filter-scope");
    Object.defineProperty(document, metadata, { value: "visitor" });
    const prepared = prepareFilterTimeRange(document, candidateRange, 100_000);

    expect(prepared.evaluationRange).toEqual({
      startMs: candidateRange.startMs,
      endExclusiveMs: candidateRange.endExclusiveMs,
    });
    expect(prepared.filters[metadata as never]).toBe("visitor");
  });

  it("rejects bounds that cannot be represented as a safe half-open range", () => {
    const timeTarget = {
      kind: "member",
      object: { kind: "context-root", context: "current" },
      member: "time",
    } as const;
    const condition = (operator: string, value: unknown) => ({
      version: 1,
      root: { kind: "condition", target: timeTarget, operator, value },
    });

    expect(() =>
      prepareFilterTimeRange(
        condition("eq", Number.MAX_SAFE_INTEGER) as never,
        candidateRange,
        100_000,
      ),
    ).toThrow("filter_time_range_invalid");
    expect(() =>
      prepareFilterTimeRange(
        condition("between", [70_000]) as never,
        candidateRange,
        100_000,
      ),
    ).toThrow("filter_time_range_invalid");
  });
});
