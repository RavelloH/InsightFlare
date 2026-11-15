// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import type { QueryTime } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { snapshotLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  buildChannelsMembershipStage,
  buildWholeMembershipCoreStage,
} from "@/lib/edge/analytics/engine/whole-membership-stage-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { evaluateWholeFilterMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import { createWholeOriginalCompletionMembershipInvocation } from "@/lib/edge/analytics/providers/d1/internal/whole-membership-stage-program";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
import { FILTER_EVALUATOR_LIMITS } from "@/lib/filter-contract/filter-evaluator";

const payload = 'first(event.payload("/amount")) gt 0';
const rawProfile = "whole-original-completion-single-site-entity-v1";
function context(timeOverride?: QueryTime) {
  const time =
    timeOverride ??
    createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
    );
  const queryContext = siteQueryContext(SEED_SITE_ID, "api-v1");
  const request = prepareScopedQuery("event-summary", {
    context: queryContext,
    time,
    scopePreference: "event",
    filters: parseFilterDsl(payload, analyticsFilterRegistry),
  });
  const metadata = scopedFilterMetadata(request.filters);
  if (!metadata || !request.filters) throw new Error("expected-scoped-fixture");
  return {
    time,
    filters: request.filters,
    subject: semanticSubjectFromQuerySubject(queryContext.subject),
    plan: metadata.plan,
  };
}
function stage() {
  const input = context();
  return buildChannelsMembershipStage({
    subject: input.subject,
    filters: input.filters,
    queryTime: input.time,
    scope: "event",
    profile: rawProfile,
    coverageSource: "read",
  });
}
function fixture(time?: QueryTime) {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const input = context(time);
  const env = { DB: createSqliteD1Database(database) } as Env;
  const invocation = () =>
    createWholeOriginalCompletionMembershipInvocation({
      env,
      subject: input.subject,
      queryTime: input.time,
      filters: input.filters,
      scope: "event",
      originalScopePlan: input.plan,
    });
  const old = () =>
    evaluateWholeFilterMembership({
      env,
      subject: input.subject,
      siteIds: [SEED_SITE_ID],
      filters: input.filters,
      plan: input.plan,
      time: input.time,
    });
  return { database, input, env, invocation, old };
}
it("declares event identities as the complete site/kind/id tuple", () => {
  const plan = stage();
  expect(plan.outputs[0]?.fields.map((field) => field.name)).toEqual([
    "site_id",
    "match_kind",
    "match_id",
  ]);
  expect(plan.outputs[0]?.fields.map((field) => field.slot)).toEqual(
    plan.nodes[0]?.output,
  );
  expect(plan.slots).toHaveLength(3);
  expect(
    plan.slots.every(
      (slot) =>
        !slot.nullable &&
        slot.type.kind === "scalar" &&
        slot.type.scalar === "string",
    ),
  ).toBe(true);
});
it("keeps initial event scope outside the ordinary Channels and Page profiles", () => {
  const input = context();
  for (const profile of [
    "channels-single-site-entity-v1",
    "page-role-single-site-entity-v1",
  ] as const)
    expect(() =>
      buildChannelsMembershipStage({
        subject: input.subject,
        filters: input.filters,
        queryTime: input.time,
        scope: "event",
        profile,
        coverageSource: "read",
      }),
    ).toThrow();
});
it("rejects malformed observation identities and altered original Core caps", () => {
  const plan = stage();
  const output = plan.outputs[0]!;
  for (const fields of [
    output.fields.filter((field) => field.name !== "match_kind"),
    [output.fields[0]!, output.fields[2]!, output.fields[1]!],
    [...output.fields, output.fields[0]!],
  ])
    expect(() =>
      validateLogicalPlan(
        snapshotLogicalPlan({ ...plan, outputs: [{ ...output, fields }] }),
      ),
    ).toThrow();
  const input = context();
  expect(() =>
    buildWholeMembershipCoreStage({
      stage: plan,
      filters: input.filters,
      queryTime: input.time,
      readRange: input.time.range,
      fullHistoryAtEntry: false,
      lateExecutionScope: "event",
      bounds: {
        maxActivities: ADVANCED_FILTER_MAX_ACTIVITIES + 1,
        maxSequenceMatches: FILTER_EVALUATOR_LIMITS.maxSequenceMatches,
        maxSequenceWork: FILTER_EVALUATOR_LIMITS.maxSequenceWork,
      },
    }),
  ).toThrow();
});
it("preserves colliding Page and Event IDs and the late Core identity schema", async () => {
  const f = fixture();
  try {
    const row = f.database
      .prepare(
        "SELECT event_id AS eventId, visit_id AS visitId FROM custom_events WHERE event_name_id=1 AND visit_id IS NOT NULL ORDER BY event_id LIMIT 1",
      )
      .get();
    if (typeof row?.eventId !== "string" || typeof row.visitId !== "string")
      throw new Error("expected-event-owner");
    f.database
      .prepare("UPDATE custom_events SET event_id=? WHERE event_id=?")
      .run(row.visitId, row.eventId);
    const expected = await f.old();
    const invocation = f.invocation();
    const actual = await invocation.executeRawAtOriginalEvaluatorCheckpoint();
    expect(actual).toEqual(expected);
    expect(actual).toContainEqual({
      siteId: SEED_SITE_ID,
      kind: "visit",
      id: row.visitId,
    });
    expect(actual).toContainEqual({
      siteId: SEED_SITE_ID,
      kind: "event",
      id: row.visitId,
    });
    const coreStage = invocation
      .observedSemanticStages()
      .find((plan) =>
        plan.nodes.some((node) => node.kind === "whole-filter-core"),
      );
    expect(coreStage?.outputs[0]?.fields.map((field) => field.name)).toEqual([
      "site_id",
      "match_kind",
      "match_id",
    ]);
  } finally {
    f.database.close();
  }
});
for (const disjoint of [false, true])
  it(`preserves explicit ${disjoint ? "disjoint" : "overlapping"} expression window results`, async () => {
    const initial = context().time;
    const filterRange = createQueryTime(
      disjoint ? initial.range.endExclusiveMs : initial.range.startMs,
      disjoint
        ? initial.range.endExclusiveMs + SEED_DAY_MS
        : initial.range.startMs + 2 * SEED_DAY_MS,
      "UTC",
      initial.capturedAtMs,
    ).range;
    const f = fixture({
      ...initial,
      filterRange,
      readRange: {
        startMs: initial.range.startMs,
        endExclusiveMs:
          filterRange.endExclusiveMs > initial.range.endExclusiveMs
            ? filterRange.endExclusiveMs
            : initial.range.endExclusiveMs,
      },
    });
    try {
      expect(
        await f.invocation().executeRawAtOriginalEvaluatorCheckpoint(),
      ).toEqual(await f.old());
    } finally {
      f.database.close();
    }
  });
it("retains the empty-expression shortcut before an already aborted coverage read", async () => {
  const f = fixture({ ...context().time, filterRangeEmpty: true });
  const controller = new AbortController();
  controller.abort();
  const prepare = vi.spyOn(f.env.DB, "prepare");
  try {
    const input = {
      env: f.env,
      subject: f.input.subject,
      filters: f.input.filters,
      scope: "event" as const,
      queryTime: f.input.time,
      originalScopePlan: f.input.plan,
      signal: controller.signal,
    };
    expect(
      await createWholeOriginalCompletionMembershipInvocation(
        input,
      ).executeRawAtOriginalEvaluatorCheckpoint(),
    ).toEqual([]);
    expect(
      await evaluateWholeFilterMembership({
        env: f.env,
        subject: f.input.subject,
        siteIds: [SEED_SITE_ID],
        filters: f.input.filters,
        plan: f.input.plan,
        time: f.input.time,
        signal: controller.signal,
      }),
    ).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    f.database.close();
  }
});
it("propagates the original Core error object without replacing it after reads", async () => {
  const f = fixture();
  const sentinel = new Error("event-stage-original-Core-error");
  const evaluate = vi
    .spyOn(core, "evaluateFilterDocument")
    .mockImplementation(() => {
      throw sentinel;
    });
  try {
    await expect(f.old()).rejects.toBe(sentinel);
    await expect(
      f.invocation().executeRawAtOriginalEvaluatorCheckpoint(),
    ).rejects.toBe(sentinel);
    expect(evaluate).toHaveBeenCalledTimes(2);
  } finally {
    evaluate.mockRestore();
    f.database.close();
  }
});
