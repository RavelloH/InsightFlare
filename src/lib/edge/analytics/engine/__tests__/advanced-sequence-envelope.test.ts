import { describe, expect, it } from "vitest";

import { createTimeRange } from "@/lib/edge/analytics/contract";
import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import { classifyTwoStepSequence } from "@/lib/edge/analytics/engine/advanced-filter-sequence-support";
import {
  acceptSequenceAggregate,
  SEQUENCE_LIMITS,
} from "@/lib/edge/analytics/engine/advanced-sequence-envelope";
import {
  buildSequenceAggregateEnvelope,
  type SequencePlanInput,
} from "@/lib/edge/analytics/engine/advanced-sequence-filter-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

function input(pageFirst = false): SequencePlanInput {
  const range = createTimeRange(0, 1000);
  const support = classifyTwoStepSequence(
    parseFilterDsl(
      `sequence([${pageFirst ? "page" : 'event { event.name eq "a" }'},event { event.name eq "b" }]) exists`,
      analyticsFilterRegistry,
    ),
    "session",
    { range },
  );
  if (support.kind !== "supported") throw new Error(support.code);
  return {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: ["site-a" as SiteId],
    }),
    support,
    range,
    reportingTimeZone: "UTC" as ReportingTimeZone,
    capturedAtMs: 1000 as EpochMs,
  };
}
const row = () => ({
  siteId: "site-a",
  entityId: "s",
  rawCount: 3,
  canonical: 1,
  firstCount: 1,
  secondCount: 1,
  firstTimes: 1,
  secondTimes: 1,
  participatingTimes: 2,
  matches: 1,
});

describe("whole-statement Seq envelope acceptance", () => {
  it("accepts an empty complete bag and checked membership", () => {
    expect(acceptSequenceAggregate(input(), [])).toEqual({
      kind: "evaluated",
      matches: [],
    });
    expect(acceptSequenceAggregate(input(), [row()])).toEqual({
      kind: "evaluated",
      matches: [{ siteId: "site-a", entityId: "s" }],
    });
    expect(
      acceptSequenceAggregate(input(), [{ ...row(), matches: 0 }]),
    ).toEqual({ kind: "evaluated", matches: [] });
  });
  it.each([NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed counts %s",
    (rawCount) => {
      expect(
        acceptSequenceAggregate(input(), [{ ...row(), rawCount }]),
      ).toMatchObject({
        kind: "fallback",
        reason: "sequence_envelope_invalid",
      });
    },
  );
  it("preserves request activity priority before incompatible storage or Seq caps", () => {
    expect(
      acceptSequenceAggregate(input(), [
        { ...row(), rawCount: 20001, canonical: 0, firstCount: 100000 },
      ]),
    ).toMatchObject({ reason: "sequence_activity_cap" });
    expect(
      acceptSequenceAggregate(input(), [{ ...row(), canonical: 0 }], {
        maxActivities: 3,
        maxMatches: 0,
        maxWork: 0,
      }),
    ).toMatchObject({ reason: "sequence_storage_compatibility" });
  });
  it.each(["siteId", "entityId"])(
    "rejects incompatible %s identities",
    (field) => {
      expect(
        acceptSequenceAggregate(input(), [
          { ...row(), [field]: new Uint8Array([1]) },
        ]),
      ).toMatchObject({ reason: "sequence_storage_compatibility" });
    },
  );
  it("rejects unauthorized and duplicate group identities", () => {
    expect(
      acceptSequenceAggregate(input(), [{ ...row(), siteId: "other" }]),
    ).toMatchObject({ reason: "sequence_storage_compatibility" });
    expect(acceptSequenceAggregate(input(), [row(), row()])).toMatchObject({
      reason: "sequence_envelope_invalid",
    });
  });
  it.each([
    "firstCount",
    "secondCount",
    "firstTimes",
    "secondTimes",
    "participatingTimes",
  ])("rejects impossible %s controls", (field) => {
    expect(
      acceptSequenceAggregate(input(), [{ ...row(), [field]: 4 }]),
    ).toMatchObject({ reason: "sequence_envelope_invalid" });
    expect(
      acceptSequenceAggregate(input(), [{ ...row(), [field]: null }]),
    ).toMatchObject({ reason: "sequence_envelope_invalid" });
  });
  it("rejects malformed or impossible membership flags", () => {
    expect(
      acceptSequenceAggregate(input(), [{ ...row(), matches: 2 }]),
    ).toMatchObject({ reason: "sequence_envelope_invalid" });
    for (const change of [
      { entityId: "" },
      { firstCount: 0 },
      { secondCount: 0 },
    ])
      expect(
        acceptSequenceAggregate(input(), [{ ...row(), ...change }]),
      ).toMatchObject({ reason: "sequence_membership_invalid" });
  });
  it("retains same-kind overlap and both different-kind tie guards", () => {
    expect(
      acceptSequenceAggregate(input(), [{ ...row(), participatingTimes: 1 }]),
    ).toMatchObject({ reason: "sequence_locale_tie" });
    for (const change of [{ firstTimes: 0 }, { secondTimes: 0 }])
      expect(
        acceptSequenceAggregate(input(true), [{ ...row(), ...change }]),
      ).toMatchObject({ reason: "sequence_locale_tie" });
    expect(acceptSequenceAggregate(input(true), [row()])).toMatchObject({
      kind: "evaluated",
    });
  });
  it("does not choose a new error when a sufficient per-site budget cannot be proved", () => {
    const limits = { maxActivities: 3, maxMatches: 1, maxWork: 2 };
    expect(acceptSequenceAggregate(input(), [row()], limits).kind).toBe(
      "evaluated",
    );
    expect(
      acceptSequenceAggregate(input(), [row()], { ...limits, maxWork: 1 }),
    ).toMatchObject({ reason: "sequence_budget_unproven" });
    expect(
      acceptSequenceAggregate(input(), [row()], { ...limits, maxMatches: 0 }),
    ).toMatchObject({ reason: "sequence_budget_unproven" });
  });
  it("charges all entity groups to their shared site budget and keeps empty steps free", () => {
    expect(
      acceptSequenceAggregate(input(), [row(), { ...row(), entityId: "s2" }], {
        maxActivities: 6,
        maxMatches: 1,
        maxWork: 100,
      }),
    ).toMatchObject({ reason: "sequence_budget_unproven" });
    expect(
      acceptSequenceAggregate(
        input(),
        [{ ...row(), firstCount: 0, matches: 0 }],
        { maxActivities: 3, maxMatches: 0, maxWork: 0 },
      ),
    ).toMatchObject({ kind: "evaluated" });
  });
  it.each([NaN, -1, 0.5, 20001])(
    "cannot enlarge or corrupt original activity limits: %s",
    (maxActivities) => {
      expect(
        acceptSequenceAggregate(input(), [], {
          ...SEQUENCE_LIMITS,
          maxActivities,
        }),
      ).toMatchObject({ reason: "sequence_invalid_bounds" });
    },
  );
  it("rejects forged or changed whole-tree support at both plan and acceptance boundaries", () => {
    const original = input();
    const forged = { ...original, support: { ...original.support } };
    expect(() => buildSequenceAggregateEnvelope(forged)).toThrow(
      "sequence_sql_support_proof_invalid",
    );
    expect(() => acceptSequenceAggregate(forged, [])).toThrow(
      "sequence_sql_support_proof_invalid",
    );
  });
});
