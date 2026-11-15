import { type CompiledQuery, D1StatementBudgetError } from "@/lib/db";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  advancedCountFilterCombinedGroupWidth,
  buildAdvancedCountFilterCombinedPlan,
  buildAdvancedCountFilterGuardPlan,
  buildAdvancedCountFilterMatchPlan,
  buildAdvancedCountFilterPayloadCombinedPlan,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { advancedCountPayloadPaths } from "@/lib/edge/analytics/engine/advanced-count-payload-selector";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type { AdvancedCountFilterSupport } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { activityEvaluationReadRanges as evaluationReadRanges } from "@/lib/edge/analytics/engine/semantic/activity-read-ranges";
import {
  type AdvancedCountNumberSelectorField,
  advancedCountSelectorField,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import type {
  queryAdvancedFilterCountCombined,
  queryAdvancedFilterCountGuard,
  queryAdvancedFilterCountMatches,
  queryAdvancedFilterCountPayloadCombined,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-query";
import {
  compileAdvancedFilterCountCombinedQuery,
  compileAdvancedFilterCountGuardQuery,
  compileAdvancedFilterCountMatchesQuery,
  compileAdvancedFilterCountPayloadCombinedQuery,
  validateAdvancedFilterCountCombinedMatches,
  validateAdvancedFilterCountPayloadCombinedMatches,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-query";
import { ADVANCED_FILTER_MAX_PAYLOAD_NODES } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-resource-policy";
import { semanticSubjectForAuthorizedSubset } from "@/lib/edge/analytics/providers/d1/internal/authorized-site-subject";
import type { AdvancedCountSqlFallbackReason } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";

const SITE_CHUNK_SIZE = 90;
function siteChunks(siteIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < siteIds.length; index += SITE_CHUNK_SIZE)
    chunks.push(siteIds.slice(index, index + SITE_CHUNK_SIZE));
  return chunks;
}
function invalidInput(
  path: string,
  code: string,
): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [{ path, code }],
  });
}

export type CountMembershipCommand =
  | {
      readonly kind: "count-payload-combined";
      readonly plan: ValidatedLogicalPlan;
      readonly query: ReturnType<
        typeof compileAdvancedFilterCountPayloadCombinedQuery
      >;
    }
  | {
      readonly kind: "count-combined";
      readonly plan: ValidatedLogicalPlan;
      readonly query: NonNullable<
        ReturnType<typeof compileAdvancedFilterCountCombinedQuery>
      >;
    }
  | {
      readonly kind: "count-guard";
      readonly plan: ValidatedLogicalPlan;
      readonly query: ReturnType<typeof compileAdvancedFilterCountGuardQuery>;
      readonly numericCompatibilityFields: readonly AdvancedCountNumberSelectorField[];
    }
  | {
      readonly kind: "count-matches";
      readonly plan: ValidatedLogicalPlan;
      readonly query: ReturnType<typeof compileAdvancedFilterCountMatchesQuery>;
      readonly numericCompatibilityFields: readonly AdvancedCountNumberSelectorField[];
    };

export type CountMembershipCommandResult =
  | {
      readonly kind: "count-payload-combined";
      readonly value: Awaited<
        ReturnType<typeof queryAdvancedFilterCountPayloadCombined>
      >;
    }
  | {
      readonly kind: "count-combined";
      readonly value: Awaited<
        ReturnType<typeof queryAdvancedFilterCountCombined>
      >;
    }
  | {
      readonly kind: "count-guard";
      readonly value: Awaited<ReturnType<typeof queryAdvancedFilterCountGuard>>;
    }
  | {
      readonly kind: "count-matches";
      readonly value: Awaited<
        ReturnType<typeof queryAdvancedFilterCountMatches>
      >;
    };
function* readPayloadCombined(
  command: Extract<CountMembershipCommand, { kind: "count-payload-combined" }>,
): Generator<
  CountMembershipCommand,
  Extract<
    CountMembershipCommandResult,
    { kind: "count-payload-combined" }
  >["value"],
  CountMembershipCommandResult
> {
  const result = yield command;
  if (result.kind !== command.kind)
    throw new Error("count_membership_wrong_command_result");
  return result.value;
}

function* readCombined(
  command: Extract<CountMembershipCommand, { kind: "count-combined" }>,
): Generator<
  CountMembershipCommand,
  Extract<CountMembershipCommandResult, { kind: "count-combined" }>["value"],
  CountMembershipCommandResult
> {
  const result = yield command;
  if (result.kind !== command.kind)
    throw new Error("count_membership_wrong_command_result");
  return result.value;
}

function* readGuard(
  command: Extract<CountMembershipCommand, { kind: "count-guard" }>,
): Generator<
  CountMembershipCommand,
  Extract<CountMembershipCommandResult, { kind: "count-guard" }>["value"],
  CountMembershipCommandResult
> {
  const result = yield command;
  if (result.kind !== command.kind)
    throw new Error("count_membership_wrong_command_result");
  return result.value;
}

function* readMatches(
  command: Extract<CountMembershipCommand, { kind: "count-matches" }>,
): Generator<
  CountMembershipCommand,
  Extract<CountMembershipCommandResult, { kind: "count-matches" }>["value"],
  CountMembershipCommandResult
> {
  const result = yield command;
  if (result.kind !== command.kind)
    throw new Error("count_membership_wrong_command_result");
  return result.value;
}
type EvaluationRange = {
  readonly startMs: number;
  readonly endExclusiveMs: number;
};

interface CountSqlSiteState {
  readonly siteId: string;
  readonly readRange: EvaluationRange;
  readonly expressionRange: EvaluationRange | null;
}

function intersectEvaluationRanges(
  left: EvaluationRange,
  right: EvaluationRange,
): EvaluationRange | null {
  const startMs = Math.max(left.startMs, right.startMs);
  const endExclusiveMs = Math.min(left.endExclusiveMs, right.endExclusiveMs);
  return startMs < endExclusiveMs ? { startMs, endExclusiveMs } : null;
}

/** Entity identities produced by the Count SQL slice; never part of a plan. */
interface CountSqlIdentity {
  readonly siteId: string;
  readonly id: string;
}

interface CountSqlMatches {
  readonly entityIds?: readonly CountSqlIdentity[];
}

type CountSqlEvaluation =
  | {
      readonly kind: "evaluated";
      readonly matches: CountSqlMatches;
    }
  | {
      readonly kind: "legacy";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

interface PreparedCountMatchGroup {
  readonly plan: ValidatedLogicalPlan;
  readonly query: CompiledQuery<Record<string, unknown>>;
}

interface PreparedCountGuard {
  readonly plan: ValidatedLogicalPlan;
  readonly query: CompiledQuery<Record<string, unknown>>;
  readonly numericCompatibilityFields: readonly AdvancedCountNumberSelectorField[];
}

export function* planCountMembershipCommands(input: {
  readonly subject: SemanticSubjectDomain;
  readonly siteIds: readonly string[];
  readonly support: Extract<AdvancedCountFilterSupport, { kind: "supported" }>;
  readonly plan: Pick<ScopedFilterPlan, "scope">;
  readonly time: QueryTime;
  readonly coverage: ReadonlyMap<string, number>;
  readonly readRange: EvaluationRange;
  readonly signal?: AbortSignal;
}): Generator<
  CountMembershipCommand,
  CountSqlEvaluation,
  CountMembershipCommandResult
> {
  if (input.plan.scope !== "session" && input.plan.scope !== "visitor")
    throw new Error("advanced_filter_count_sql_scope_changed_after_preflight");
  if (input.siteIds.length === 0)
    return {
      kind: "evaluated",
      matches: { entityIds: [] },
    };

  const fullHistory = input.time.fullHistory === true;
  const explicitFilterRange = input.time.filterRange !== undefined;
  const capturedEnd = input.time.capturedAtMs + 1;
  const sites: CountSqlSiteState[] = [];
  for (const siteId of input.siteIds) {
    const createdAt = input.coverage.get(siteId);
    if (createdAt === undefined)
      throw invalidInput("readRange", "filter_evaluation_range_unavailable");
    const siteReadRange = fullHistory
      ? { startMs: createdAt, endExclusiveMs: capturedEnd }
      : input.readRange;
    const siteFilterRange = explicitFilterRange
      ? {
          startMs: input.time.filterRange!.startMs ?? createdAt,
          endExclusiveMs: input.time.filterRange!.endExclusiveMs ?? capturedEnd,
        }
      : undefined;
    // The existing provider skips a site whose explicit filter domain is empty
    // before constructing its evaluator dataset.
    if (
      siteFilterRange &&
      siteFilterRange.startMs >= siteFilterRange.endExclusiveMs
    )
      continue;
    if (
      !Number.isSafeInteger(siteReadRange.startMs) ||
      !Number.isSafeInteger(siteReadRange.endExclusiveMs) ||
      siteReadRange.startMs >= siteReadRange.endExclusiveMs
    )
      return {
        kind: "legacy",
        fallbackReason: { kind: "invalid-range" },
      };
    const expressionRange = siteFilterRange
      ? intersectEvaluationRanges(siteReadRange, siteFilterRange)
      : siteReadRange;
    sites.push({ siteId, readRange: siteReadRange, expressionRange });
  }

  const activeSites = sites.filter(
    (
      site,
    ): site is CountSqlSiteState & {
      readonly expressionRange: EvaluationRange;
    } => site.expressionRange !== null,
  );
  const numericCompatibilityRequirements =
    input.support.numericCompatibilityRequirements;
  const numericCompatibilityFields = numericCompatibilityRequirements.map(
    ({ fieldId }): AdvancedCountNumberSelectorField => {
      const field = advancedCountSelectorField(fieldId);
      if (!field || field.kind !== "number")
        throw new Error(
          "advanced_filter_count_support_returned_invalid_numeric_field",
        );
      return field;
    },
  );
  const combinedSite = activeSites[0];
  const combinedRange = input.time.range;
  const combinedIsApplicable =
    !fullHistory &&
    !explicitFilterRange &&
    input.siteIds.length === 1 &&
    activeSites.length === 1 &&
    combinedSite?.siteId === input.siteIds[0] &&
    combinedSite.readRange.startMs === combinedRange.startMs &&
    combinedSite.readRange.endExclusiveMs === combinedRange.endExclusiveMs &&
    combinedSite.expressionRange.startMs === combinedRange.startMs &&
    combinedSite.expressionRange.endExclusiveMs ===
      combinedRange.endExclusiveMs &&
    input.readRange.startMs === combinedRange.startMs &&
    input.readRange.endExclusiveMs === combinedRange.endExclusiveMs;
  if (combinedIsApplicable && combinedSite) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const subject = semanticSubjectForAuthorizedSubset(
      input.subject,
      [combinedSite.siteId],
      "activity",
    );
    const combinedInput = {
      subject,
      candidateRange: input.time.range,
      readRange: combinedSite.readRange,
      expressionRange: combinedSite.expressionRange,
      expressionUsesExplicitRange: false,
      lowerBounds: [
        {
          siteId: combinedSite.siteId,
          startMs: combinedSite.readRange.startMs,
        },
      ],
      scope: input.plan.scope,
      reportingTimeZone: input.time.reportingTimeZone,
      capturedAtMs: input.time.capturedAtMs,
      analysis: input.support.analysis,
      numericCompatibilityRequirements,
    };
    const payloadPaths = advancedCountPayloadPaths(
      input.support.document.root!,
    );
    if (payloadPaths.length > 0) {
      const payloadPlan =
        buildAdvancedCountFilterPayloadCombinedPlan(combinedInput);
      let payloadQuery: ReturnType<
        typeof compileAdvancedFilterCountPayloadCombinedQuery
      >;
      try {
        payloadQuery =
          compileAdvancedFilterCountPayloadCombinedQuery(payloadPlan);
      } catch (error) {
        if (!(error instanceof D1StatementBudgetError)) throw error;
        return {
          kind: "legacy",
          fallbackReason: {
            kind: "compile-budget",
            item: error.item,
            actual: error.actual,
            limit: error.limit,
          },
        };
      }
      if (input.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      const payload = yield* readPayloadCombined({
        kind: "count-payload-combined",
        plan: payloadPlan,
        query: payloadQuery,
      });
      if (input.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      if (payload.rawCount > ADVANCED_FILTER_MAX_ACTIVITIES)
        throw invalidInput("filters", "filter_activity_limit_exceeded");
      if (payload.payloadNodeCount > ADVANCED_FILTER_MAX_PAYLOAD_NODES)
        throw invalidInput("filters", "filter_payload_node_limit_exceeded");
      if (payload.nullActivityIdCount > 0)
        return {
          kind: "legacy",
          fallbackReason: { kind: "null-activity-id" },
        };
      if (payload.siteIdentityMismatchCount > 0)
        return {
          kind: "legacy",
          fallbackReason: { kind: "site-identity-mismatch" },
        };
      const payloadControls: Array<
        | "missing-event-fact"
        | "invalid-structure"
        | "invalid-value"
        | "event-fact-multiplicity"
      > = [];
      if (payload.payloadMissingFactCount > 0)
        payloadControls.push("missing-event-fact");
      if (payload.payloadStructureInvalidCount > 0)
        payloadControls.push("invalid-structure");
      if (payload.payloadValueInvalidCount > 0)
        payloadControls.push("invalid-value");
      if (payload.payloadMultiplicityInvalidCount > 0)
        payloadControls.push("event-fact-multiplicity");
      if (payloadControls.length > 0)
        return {
          kind: "legacy",
          fallbackReason: {
            kind: "payload-data-domain",
            controls: Object.freeze(payloadControls),
          },
        };
      const entityIds: CountSqlIdentity[] =
        validateAdvancedFilterCountPayloadCombinedMatches(
          payload.matches,
          combinedSite.siteId,
        ).map(({ siteId, entityId }) => ({ siteId, id: entityId }));
      entityIds.sort(
        (left, right) =>
          left.siteId.localeCompare(right.siteId) ||
          left.id.localeCompare(right.id),
      );
      return { kind: "evaluated", matches: { entityIds } };
    }

    const combinedPlan = buildAdvancedCountFilterCombinedPlan(combinedInput);
    const logicalGroupWidth =
      advancedCountFilterCombinedGroupWidth(combinedPlan);
    let combinedQuery: ReturnType<
      typeof compileAdvancedFilterCountCombinedQuery
    > = null;
    if (logicalGroupWidth !== null && logicalGroupWidth <= 16) {
      try {
        combinedQuery = compileAdvancedFilterCountCombinedQuery(combinedPlan);
      } catch (error) {
        if (!(error instanceof D1StatementBudgetError)) throw error;
      }
    }
    if (combinedQuery) {
      if (input.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      const combined = yield* readCombined({
        kind: "count-combined",
        plan: combinedPlan,
        query: combinedQuery,
      });
      if (input.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      if (combined.rawCount > ADVANCED_FILTER_MAX_ACTIVITIES)
        throw invalidInput("filters", "filter_activity_limit_exceeded");
      if (combined.nullActivityIdCount > 0)
        return {
          kind: "legacy",
          fallbackReason: { kind: "null-activity-id" },
        };
      if (combined.siteIdentityMismatchCount > 0)
        return {
          kind: "legacy",
          fallbackReason: { kind: "site-identity-mismatch" },
        };
      if (combined.numericCompatibilityFieldIds.length > 0)
        return {
          kind: "legacy",
          fallbackReason: {
            kind: "numeric-data-domain",
            fieldIds: combined.numericCompatibilityFieldIds,
          },
        };
      const entityIds: CountSqlIdentity[] =
        validateAdvancedFilterCountCombinedMatches(
          combined.matches,
          combinedSite.siteId,
        ).map(({ siteId, entityId }) => ({ siteId, id: entityId }));
      entityIds.sort(
        (left, right) =>
          left.siteId.localeCompare(right.siteId) ||
          left.id.localeCompare(right.id),
      );
      return { kind: "evaluated", matches: { entityIds } };
    }
  }
  const matchGroupSize = fullHistory ? 24 : SITE_CHUNK_SIZE;
  const preparedGroups: PreparedCountMatchGroup[] = [];
  for (let index = 0; index < activeSites.length; index += matchGroupSize) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const group = activeSites.slice(index, index + matchGroupSize);
    const batchReadRange = {
      startMs: Math.min(...group.map((site) => site.readRange.startMs)),
      endExclusiveMs: Math.min(
        ...group.map((site) => site.readRange.endExclusiveMs),
      ),
    };
    const batchExpressionRange = {
      startMs: Math.min(...group.map((site) => site.expressionRange.startMs)),
      endExclusiveMs: Math.min(
        ...group.map((site) => site.expressionRange.endExclusiveMs),
      ),
    };
    if (
      batchReadRange.startMs >= batchReadRange.endExclusiveMs ||
      batchExpressionRange.startMs >= batchExpressionRange.endExclusiveMs
    )
      return {
        kind: "legacy",
        fallbackReason: { kind: "invalid-range" },
      };

    const groupSiteIds = group.map((site) => site.siteId);
    const subject = semanticSubjectForAuthorizedSubset(
      input.subject,
      groupSiteIds,
      "activity",
    );
    const matchPlan = buildAdvancedCountFilterMatchPlan({
      subject,
      candidateRange: input.time.range,
      readRange: batchReadRange,
      ...(explicitFilterRange ? { filterRange: batchExpressionRange } : {}),
      expressionRange: batchExpressionRange,
      expressionUsesExplicitRange: explicitFilterRange,
      lowerBounds: group.map((site) => ({
        siteId: site.siteId,
        startMs: explicitFilterRange
          ? site.expressionRange.startMs
          : site.readRange.startMs,
      })),
      scope: input.plan.scope,
      reportingTimeZone: input.time.reportingTimeZone,
      capturedAtMs: input.time.capturedAtMs,
      analysis: input.support.analysis,
      numericCompatibilityRequirements,
    });
    try {
      preparedGroups.push({
        plan: matchPlan,
        query: compileAdvancedFilterCountMatchesQuery(matchPlan),
      });
    } catch (error) {
      if (!(error instanceof D1StatementBudgetError)) throw error;
      return {
        kind: "legacy",
        fallbackReason: {
          kind: "compile-budget",
          item: error.item,
          actual: error.actual,
          limit: error.limit,
        },
      };
    }
  }

  const readRanges = evaluationReadRanges(input.time.range, input.readRange);
  const preparedGuards: PreparedCountGuard[] = [];
  for (const siteIds of siteChunks(input.siteIds)) {
    const subject = semanticSubjectForAuthorizedSubset(
      input.subject,
      siteIds,
      "activity",
    );
    for (const range of readRanges) {
      if (input.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      const guardPlan = buildAdvancedCountFilterGuardPlan({
        subject,
        range,
        reportingTimeZone: input.time.reportingTimeZone,
        numericCompatibilityRequirements,
      });
      try {
        preparedGuards.push({
          plan: guardPlan,
          query: compileAdvancedFilterCountGuardQuery(guardPlan),
          numericCompatibilityFields,
        });
      } catch (error) {
        if (!(error instanceof D1StatementBudgetError)) throw error;
        return {
          kind: "legacy",
          fallbackReason: {
            kind: "compile-budget",
            item: error.item,
            actual: error.actual,
            limit: error.limit,
          },
        };
      }
    }
  }
  let loadedRawActivities = 0;
  let hasNullActivityId = false;
  let hasSiteIdentityMismatch = false;
  const numericCompatibilityFieldIds = new Set<string>();
  for (const guard of preparedGuards) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const guarded = yield* readGuard({ kind: "count-guard", ...guard });
    loadedRawActivities += guarded.rawCount;
    if (loadedRawActivities > ADVANCED_FILTER_MAX_ACTIVITIES)
      throw invalidInput("filters", "filter_activity_limit_exceeded");
    hasNullActivityId ||= guarded.nullActivityIdCount > 0;
    hasSiteIdentityMismatch ||= guarded.siteIdentityMismatchCount > 0;
    guarded.numericCompatibilityFieldIds.forEach((fieldId) =>
      numericCompatibilityFieldIds.add(fieldId),
    );
  }
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (hasNullActivityId)
    return {
      kind: "legacy",
      fallbackReason: { kind: "null-activity-id" },
    };
  if (hasSiteIdentityMismatch)
    return {
      kind: "legacy",
      fallbackReason: { kind: "site-identity-mismatch" },
    };
  if (numericCompatibilityFieldIds.size > 0)
    return {
      kind: "legacy",
      fallbackReason: {
        kind: "numeric-data-domain",
        fieldIds: [...numericCompatibilityFieldIds].sort(),
      },
    };
  if (activeSites.length === 0)
    return { kind: "evaluated", matches: { entityIds: [] } };

  const entityIds: CountSqlIdentity[] = [];
  for (const group of preparedGroups) {
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const result = yield* readMatches({
      kind: "count-matches",
      ...group,
      numericCompatibilityFields,
    });
    if (result.numericCompatibilityFieldIds.length > 0)
      return {
        kind: "legacy",
        fallbackReason: {
          kind: "numeric-data-domain",
          fieldIds: result.numericCompatibilityFieldIds,
        },
      };
    for (const match of result.matches)
      entityIds.push({ siteId: match.siteId, id: match.entityId });
  }

  entityIds.sort(
    (left, right) =>
      left.siteId.localeCompare(right.siteId) ||
      left.id.localeCompare(right.id),
  );
  return { kind: "evaluated", matches: { entityIds } };
}
