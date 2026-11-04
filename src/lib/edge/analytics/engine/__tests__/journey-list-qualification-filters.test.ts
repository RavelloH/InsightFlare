import { describe, expect, it } from "vitest";

import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FunnelConfigV2,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  type ScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  assertJourneyListWholeFilterCountDocument,
  resolveJourneyListQualificationFilters,
} from "@/lib/edge/analytics/engine/journey-list-qualification-filters";
import type { JourneySessionListQualificationInput } from "@/lib/edge/analytics/engine/journey-session-list-qualification-plan";
import {
  buildJourneySessionFunnelListQualificationPlan,
  buildJourneySessionGoalListQualificationPlan,
  buildJourneySessionListQualificationPlan,
} from "@/lib/edge/analytics/engine/journey-session-list-qualification-plan";
import type { JourneyVisitorListQualificationInput } from "@/lib/edge/analytics/engine/journey-visitor-list-qualification-plan";
import {
  buildJourneyVisitorFunnelListQualificationPlan,
  buildJourneyVisitorGoalListQualificationPlan,
  buildJourneyVisitorListQualificationPlan,
} from "@/lib/edge/analytics/engine/journey-visitor-list-qualification-plan";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { analyzeFilterDocument } from "@/lib/filter-contract/filter-semantics";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "journey-list-whole-filter-contract";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const MIXED_OR_FILTER =
  'page.path eq "/native" or count(event { event.name eq "count-hit" }) gte 1';
const MIXED_NOT_FILTER =
  'not (page.path eq "/blocked" or count(event { event.name eq "reject" }) gte 1)';

function preparedInput(
  operation: "visitors",
): JourneyVisitorListQualificationInput;
function preparedInput(
  operation: "sessions",
): JourneySessionListQualificationInput;
function preparedInput(
  operation: "visitors" | "sessions",
): JourneyVisitorListQualificationInput | JourneySessionListQualificationInput {
  const prepared = prepareScopedQuery(operation, {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
    filters: parseFilterDsl(MIXED_OR_FILTER, analyticsFilterRegistry),
    scopePreference: "visitor",
  } as never) as QueryInput & {
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
    readonly time: QueryTime;
  };
  const readRange = prepared.time.readRange ?? prepared.time.range;
  const count: AdvancedCountFilterMatchPlanInput = {
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as never],
    }),
    candidateRange: { ...prepared.time.range },
    readRange: { ...readRange },
    expressionRange: { ...prepared.time.range },
    expressionUsesExplicitRange: false,
    lowerBounds: [{ siteId: SITE_ID, startMs: readRange.startMs }],
    scope: "visitor",
    reportingTimeZone: prepared.time.reportingTimeZone,
    capturedAtMs: prepared.time.capturedAtMs,
    analysis: analyzeFilterDocument(prepared.filters, analyticsFilterRegistry),
  };
  const common = {
    siteId: SITE_ID,
    queryTime: prepared.time,
    filters: prepared.filters,
    scopePlan: prepared.scopePlan,
    count,
    limit: 20,
  };
  return operation === "visitors"
    ? {
        ...common,
        sort: { key: "lastSeenAt", direction: "desc" },
      }
    : {
        ...common,
        sort: { key: "startedAt", direction: "desc" },
      };
}

describe("journey list qualification filter resolution", () => {
  it("keeps conjunction splitting unchanged and whole-tree mode opt-in", () => {
    const conjunction = parseFilterDsl(
      'page.path eq "/native" and count(event { event.name eq "count-hit" }) gte 1',
      analyticsFilterRegistry,
    );
    const split = resolveJourneyListQualificationFilters(conjunction);
    expect(split.kind).toBe("supported");
    if (split.kind !== "supported")
      throw new Error("split_unexpectedly_denied");
    expect(split.mode).toBe("split");
    expect(split.nativeFilters.root).toEqual(
      parseFilterDsl('page.path eq "/native"', analyticsFilterRegistry).root,
    );
    expect(split.countFilters.root).toEqual(
      parseFilterDsl(
        'count(event { event.name eq "count-hit" }) gte 1',
        analyticsFilterRegistry,
      ).root,
    );

    const mixed = parseFilterDsl(MIXED_OR_FILTER, analyticsFilterRegistry);
    expect(resolveJourneyListQualificationFilters(mixed)).toEqual({
      kind: "unsupported",
    });
    const whole = resolveJourneyListQualificationFilters(
      mixed,
      "allow-whole-filter",
    );
    expect(whole.kind).toBe("supported");
    if (whole.kind !== "supported") throw new Error("whole_filter_denied");
    expect(whole.mode).toBe("whole-filter");
    expect(whole.nativeFilters).toEqual(EMPTY_FILTER_DOCUMENT);
    expect(whole.countFilters).toEqual(mixed);

    const mixedNot = parseFilterDsl(MIXED_NOT_FILTER, analyticsFilterRegistry);
    expect(
      resolveJourneyListQualificationFilters(mixedNot, "allow-whole-filter"),
    ).toMatchObject({
      kind: "supported",
      mode: "whole-filter",
      nativeFilters: EMPTY_FILTER_DOCUMENT,
      countFilters: mixedNot,
    });
  });

  it("requires a matching complete Count tree and opts supported list families into whole-tree mode", () => {
    const visitor = preparedInput("visitors");
    expect(() =>
      buildJourneyVisitorListQualificationPlan({
        ...visitor,
        count: {
          ...visitor.count,
          analysis: analyzeFilterDocument(
            parseFilterDsl(
              'count(event { event.name eq "count-hit" }) gte 1',
              analyticsFilterRegistry,
            ),
            analyticsFilterRegistry,
          ),
        },
      }),
    ).toThrow("journey_visitor_list_whole_filter_count_document_mismatch");

    const session = preparedInput("sessions");
    expect(() =>
      buildJourneyVisitorGoalListQualificationPlan({
        ...visitor,
        analysisFilter: EMPTY_FILTER_DOCUMENT,
      }),
    ).not.toThrow();
    const funnelConfig = (
      progressionScope: "visitor" | "session",
    ): FunnelConfigV2 => ({
      filterDslVersion: 1,
      progressionScope,
      conversionWindowMs: progressionScope === "visitor" ? 60_000 : null,
      steps: [
        { id: "start", filterDsl: 'page.path eq "/start"' },
        { id: "finish", filterDsl: 'event.name eq "finish"' },
      ],
    });
    expect(() =>
      buildJourneyVisitorFunnelListQualificationPlan({
        ...visitor,
        funnelAnalysis: {
          config: funnelConfig("visitor"),
          stepIndex: 0,
        },
      }),
    ).not.toThrow();

    expect(() =>
      buildJourneySessionGoalListQualificationPlan({
        ...session,
        analysisFilter: EMPTY_FILTER_DOCUMENT,
      }),
    ).not.toThrow();
    expect(() =>
      buildJourneySessionFunnelListQualificationPlan({
        ...session,
        funnelAnalysis: {
          config: funnelConfig("session"),
          stepIndex: 1,
          outcome: "converted",
        },
      }),
    ).not.toThrow();
    expect(() =>
      buildJourneySessionListQualificationPlan({
        ...session,
        preparedPlanOperation: "visitor-sessions",
        sessionTarget: { type: "visitor", value: "visitor-a" },
      }),
    ).not.toThrow();

    const mismatched = parseFilterDsl(
      'page.path eq "/native" or count(event { event.name eq "other" }) gte 1',
      analyticsFilterRegistry,
    );
    expect(() =>
      assertJourneyListWholeFilterCountDocument(
        visitor.filters,
        mismatched,
        "visitor",
      ),
    ).toThrow("journey_visitor_list_whole_filter_count_document_mismatch");
  });
});
