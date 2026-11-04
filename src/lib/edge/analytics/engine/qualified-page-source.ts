import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  appendAdvancedCountQualification,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { appendPageDimensionReportSource } from "@/lib/edge/analytics/engine/dimension-report-plan";
import type { EventQualificationReportSource } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import {
  isSemanticPageReportAttribute,
  type SemanticAttributeId,
} from "@/lib/edge/analytics/engine/semantic/attributes";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";
import type {
  FilterDocument,
  FilterExpression,
} from "@/lib/filter-contract/filters";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;

export type QualifiedObservationOwnerAttribute =
  | "page.report.sessionId"
  | "page.report.visitorId"
  | "event.report.ownerSessionId"
  | "event.report.ownerVisitorId";

/** Adds a same-site owner key and applies the shared Count membership relation. */
export function appendQualifiedObservationMembership(input: {
  readonly builder: LogicalPlanBuilder;
  readonly observations: LogicalRelationHandle;
  readonly matches: LogicalRelationHandle;
  readonly siteId: string;
  readonly ownerAttribute: QualifiedObservationOwnerAttribute;
}): LogicalRelationHandle {
  const projection = Object.fromEntries(
    Object.keys(input.observations.slots).map((name) => [
      name,
      input.builder.slot(input.observations, name),
    ]),
  );
  const keyedObservations = input.builder.project(input.observations, {
    ...projection,
    qualificationSiteId: input.builder.literal(input.siteId, STRING),
  });
  const matchesForSite = input.builder.filter(
    input.matches,
    input.builder.compare(
      "eq",
      input.builder.slot(input.matches, "siteId"),
      input.builder.literal(input.siteId, STRING),
    ),
  );
  return input.builder.semiJoin(keyedObservations, matchesForSite, [
    { left: "qualificationSiteId", right: "siteId" },
    {
      left: `attribute:${input.ownerAttribute}`,
      right: "entityId",
    },
  ]);
}

type NativeFilterSplit =
  | {
      readonly kind: "supported";
      readonly filters: FilterDocument;
      readonly advancedFilters: FilterDocument;
    }
  | { readonly kind: "unsupported" };

export type QualifiedSourceFilterMode = "split-only" | "allow-whole-filter";

export type QualifiedSourceFilterResolution =
  | {
      readonly kind: "supported";
      readonly mode: "split" | "whole-filter";
      readonly nativeFilters: FilterDocument;
      readonly countFilters: FilterDocument;
    }
  | { readonly kind: "unsupported" };

type FilterExpressionSplit =
  | {
      readonly kind: "supported";
      readonly nativeExpression: FilterExpression | null;
      readonly advancedExpression: FilterExpression | null;
    }
  | { readonly kind: "unsupported" };

export type QualifiedPageSemanticOperation =
  | "dimension"
  | "filter-values"
  | "channels"
  | "pages"
  | "pages-dashboard"
  | "referrers"
  | "share-trend"
  | "radar"
  | "cross-dimension"
  | "performance"
  | "geo-points"
  | "retention";

function expressionHasAdvancedTargets(expression: FilterExpression): boolean {
  return filterDocumentUsesAdvancedExpressions({
    version: 1,
    root: expression,
  });
}

function expressionHasNativeConditions(expression: FilterExpression): boolean {
  if (expression.kind === "condition")
    return !expressionHasAdvancedTargets(expression);
  if (expression.kind === "not")
    return expressionHasNativeConditions(expression.child);
  return expression.children.some(expressionHasNativeConditions);
}

/** Resolve report-side predicates and the complete Count qualification tree. */
export function resolveQualifiedSourceFilters(
  filters: FilterDocument,
  mode: QualifiedSourceFilterMode = "split-only",
): QualifiedSourceFilterResolution {
  const split = splitPageDimensionNativeFilters(filters);
  if (split.kind === "supported")
    return {
      kind: "supported",
      mode: "split",
      nativeFilters: split.filters,
      countFilters: split.advancedFilters,
    };

  if (
    mode !== "allow-whole-filter" ||
    !filters.root ||
    !filterDocumentUsesAdvancedExpressions(filters) ||
    !expressionHasNativeConditions(filters.root)
  )
    return { kind: "unsupported" };

  return {
    kind: "supported",
    mode: "whole-filter",
    nativeFilters: EMPTY_FILTER_DOCUMENT,
    countFilters: filters,
  };
}

/** Keep an empty report predicate coupled to the full Count predicate. */
export function assertWholeFilterCountDocument(
  filters: FilterDocument,
  countDocument: FilterDocument,
  errorCode: string,
): void {
  const expected = normalizeFilterDocument(filters, analyticsFilterRegistry);
  const actual = normalizeFilterDocument(
    countDocument,
    analyticsFilterRegistry,
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(errorCode);
}

function filterParts(expression: FilterExpression): FilterExpressionSplit {
  const advanced = expressionHasAdvancedTargets(expression);
  if (!advanced)
    return {
      kind: "supported",
      nativeExpression: expression,
      advancedExpression: null,
    };
  if (!expressionHasNativeConditions(expression))
    return {
      kind: "supported",
      nativeExpression: null,
      advancedExpression: expression,
    };
  if (expression.kind !== "and") return { kind: "unsupported" };

  const nativeChildren: FilterExpression[] = [];
  const advancedChildren: FilterExpression[] = [];
  for (const child of expression.children) {
    const result = filterParts(child);
    if (result.kind === "unsupported") return result;
    if (result.nativeExpression) nativeChildren.push(result.nativeExpression);
    if (result.advancedExpression)
      advancedChildren.push(result.advancedExpression);
  }
  const combine = (children: FilterExpression[]) =>
    children.length === 0
      ? null
      : children.length === 1
        ? children[0]!
        : ({ kind: "and", children } satisfies FilterExpression);
  return {
    kind: "supported",
    nativeExpression: combine(nativeChildren),
    advancedExpression: combine(advancedChildren),
  };
}

/** Splits conjunctions; mixed OR/NOT trees stay on the old path. */
export function splitPageDimensionNativeFilters(
  filters: FilterDocument,
): NativeFilterSplit {
  if (!filters.root)
    return {
      kind: "supported",
      filters,
      advancedFilters: filters,
    };
  const result = filterParts(filters.root);
  return result.kind === "supported"
    ? {
        kind: "supported",
        filters: { version: 1, root: result.nativeExpression },
        advancedFilters: {
          version: 1,
          root: result.advancedExpression,
        },
      }
    : result;
}

/**
 * Builds one bounded Count qualification and the matching Page source. Report
 * families can append any Page projections to `qualifiedPages` while sharing
 * the same Count and source admission checks.
 */
export function appendQualifiedPageSource(input: {
  readonly semanticOperation?: QualifiedPageSemanticOperation;
  readonly preparedTimePolicy?: "reader-window-v1";
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly selections: readonly PageDimensionSelection[];
  readonly additionalAttributes?: readonly SemanticAttributeId[];
}): {
  readonly builder: ReturnType<typeof createAdvancedCountQualificationBuilder>;
  readonly qualification: ReturnType<typeof appendAdvancedCountQualification>;
  readonly pageSource: ReturnType<typeof appendPageDimensionReportSource>;
  readonly qualifiedPages: LogicalRelationHandle;
  readonly reportSourceRelations: readonly EventQualificationReportSource[];
} {
  const queryReadRange = input.queryTime.readRange ?? input.queryTime.range;
  if (
    input.count.subject.siteIds.length !== 1 ||
    input.count.subject.siteIds[0] !== input.siteId ||
    input.queryTime.range.startMs !== input.count.candidateRange.startMs ||
    input.queryTime.range.endExclusiveMs !==
      input.count.candidateRange.endExclusiveMs ||
    queryReadRange.startMs !== input.count.readRange.startMs ||
    queryReadRange.endExclusiveMs !== input.count.readRange.endExclusiveMs ||
    input.queryTime.filterRange !== undefined ||
    input.queryTime.filterRangeEmpty === true ||
    input.queryTime.fullHistory === true ||
    input.queryTime.reportingTimeZone !== input.count.reportingTimeZone ||
    input.queryTime.capturedAtMs !== input.count.capturedAtMs ||
    input.scopePlan.scope !== input.count.scope
  )
    throw new Error("page_dimension_qualification_request_context_mismatch");

  for (const attribute of input.additionalAttributes ?? [])
    if (!isSemanticPageReportAttribute(attribute))
      throw new Error(
        `page_dimension_qualification_attribute_invalid:${attribute}`,
      );

  const filterResolution = resolveQualifiedSourceFilters(
    input.filters,
    input.filterMode ?? "split-only",
  );
  if (filterResolution.kind === "unsupported")
    throw new Error(
      "page_dimension_qualification_native_filter_split_unsupported",
    );
  if (filterResolution.mode === "whole-filter")
    assertWholeFilterCountDocument(
      input.filters,
      input.count.analysis.document,
      "page_dimension_qualification_whole_filter_count_document_mismatch",
    );
  const sourceMetadata = scopedFilterMetadata(input.filters);
  if (
    !sourceMetadata ||
    sourceMetadata.resolvedScope !== input.scopePlan.scope ||
    sourceMetadata.siteIds.length !== 1 ||
    sourceMetadata.siteIds[0] !== input.siteId
  )
    throw new Error("page_dimension_qualification_source_metadata_mismatch");
  const semanticOperation = input.semanticOperation ?? "dimension";
  if (
    input.preparedTimePolicy !== undefined &&
    (input.preparedTimePolicy !== "reader-window-v1" ||
      (semanticOperation !== "share-trend" &&
        semanticOperation !== "radar" &&
        semanticOperation !== "cross-dimension" &&
        semanticOperation !== "performance" &&
        semanticOperation !== "pages-dashboard" &&
        semanticOperation !== "retention"))
  )
    throw new Error("page_dimension_qualification_time_policy_invalid");
  const nativeScopePlan = createScopedFilterPlan(
    semanticOperation,
    filterResolution.nativeFilters,
    input.scopePlan.scope,
  );
  if (!nativeScopePlan || nativeScopePlan.scope !== input.scopePlan.scope)
    throw new Error("page_dimension_qualification_native_scope_plan_missing");

  const builder = createAdvancedCountQualificationBuilder(input.count);
  const qualification = appendAdvancedCountQualification(builder, input.count);
  const nativeScopedFilters = attachScopedFilterMetadata(
    filterResolution.nativeFilters,
    {
      requestedScope: input.scopePlan.scope,
      resolvedScope: nativeScopePlan.scope,
      plan: nativeScopePlan,
      time: sourceMetadata.time,
      siteIds: sourceMetadata.siteIds,
    },
  );
  const pageSelection = createSemanticScopedSourceSelection({
    profile: input.preparedTimePolicy
      ? "prepared-page-reader-window-v1"
      : "prepared-scoped-v1",
    filters: nativeScopedFilters,
    subject: builder.context.subject,
    time: builder.context.time,
    expectedPlan: nativeScopePlan,
    preparedPlanOperation: semanticOperation,
  });
  const pageSource = appendPageDimensionReportSource(builder, {
    selections: input.selections,
    sourceSelection: pageSelection,
    ...(input.additionalAttributes
      ? { additionalAttributes: input.additionalAttributes }
      : {}),
  });
  const matchesForSite = builder.filter(
    qualification.matches,
    builder.compare(
      "eq",
      builder.slot(qualification.matches, "siteId"),
      builder.literal(input.siteId, STRING),
    ),
  );
  const ownerAttribute =
    input.count.scope === "session"
      ? "page.report.sessionId"
      : "page.report.visitorId";
  const qualifiedPages = builder.semiJoin(pageSource.pages, matchesForSite, [
    { left: `attribute:${ownerAttribute}`, right: "entityId" },
  ]);

  return {
    builder,
    qualification,
    pageSource,
    qualifiedPages,
    reportSourceRelations: [
      { relationId: pageSource.pages.id, entity: "page" },
    ],
  };
}
