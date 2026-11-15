import type {
  FilterDocument,
  OverviewTableMetric,
  OverviewTableSortBy,
  QueryAudience,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import { COMPARISON_MEMBERSHIP_CHILD_OUTPUTS } from "@/lib/edge/analytics/engine/comparison-membership-dependency-plan";
import { comparisonPageReaderContract } from "@/lib/edge/analytics/engine/comparison-page-reader-contract";
import {
  buildComparisonPagePlan,
  type ComparisonDimensionCursor,
} from "@/lib/edge/analytics/engine/comparison-report-plan";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";

import type { ComparisonMembershipDependencies } from "./advanced-filter-execution";
import {
  bindPageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "./page-visit-qualification-execution";
import { createAnalysisResultQualificationExecutionInputsForTrustedPlan } from "./qualification-execution-inputs";
import {
  bindWholeOriginalComparisonChild,
  type WholeOriginalComparisonMembership,
  wholeOriginalComparisonReaderTab,
} from "./whole-filter-reader-preparation";
export type { ComparisonDimensionCursor } from "@/lib/edge/analytics/engine/comparison-report-plan";
import type { Env } from "@/lib/edge/types";

import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import { buildComparisonDimensionRollupPlan } from "./comparison-dimension-source";
import {
  comparisonCursorBinding,
  type ComparisonDimensionPage,
  comparisonPageFromRows,
} from "./comparison-page-result";
import { comparisonSessionPathCursorExpression } from "./comparison-report-family";
import { buildComparisonSessionPathPlan } from "./comparison-session-path-source";
import type { QueryWindow } from "./core-types";
import type { D1ReadDiagnostics } from "./diagnostics";
import { decodePageCursor, hasExactKeys } from "./pagination";

function decodeComparisonCursor(
  value: unknown,
): ComparisonDimensionCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, [
    "sortClass",
    "primary",
    "secondary",
    "key",
  ]) &&
    typeof candidate.sortClass === "number" &&
    Number.isFinite(candidate.sortClass) &&
    typeof candidate.primary === "number" &&
    Number.isFinite(candidate.primary) &&
    typeof candidate.secondary === "number" &&
    Number.isFinite(candidate.secondary) &&
    typeof candidate.key === "string"
    ? (candidate as unknown as ComparisonDimensionCursor)
    : null;
}

export async function decodeComparisonDimensionCursor(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  selectExpr: string,
  search: string | undefined,
  cursor: string | null | undefined,
  audience: QueryAudience,
  metric: OverviewTableMetric,
  sortBy: OverviewTableSortBy,
  direction: SortDirection,
): Promise<ComparisonDimensionCursor | null> {
  return decodePageCursor(
    env,
    await comparisonCursorBinding(
      siteId,
      current,
      currentFilters,
      reference,
      referenceFilters,
      selectExpr,
      search,
      audience,
      metric,
      sortBy,
      direction,
    ),
    cursor,
    "overview-table-comparison",
    decodeComparisonCursor,
  );
}

export async function queryComparisonDimensionPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  selectExpr: string,
  options: {
    metric: OverviewTableMetric;
    sortBy: OverviewTableSortBy;
    direction: SortDirection;
    search?: string;
    selection: PageDimensionSelection;
  },
  cursor: ComparisonDimensionCursor | null,
  audience: QueryAudience,
  diagnostics?: D1ReadDiagnostics,
  dependencies?: ComparisonMembershipDependencies,
  whole?: WholeOriginalComparisonMembership,
): Promise<ComparisonDimensionPage> {
  if (dependencies) {
    const c = dependencies.enginePlan.consumer as {
      siteId: string;
      tab: string;
      limit: number;
      cursorToken: string | null;
      search?: string;
      metric: string;
      sortBy: string;
      direction: string;
      audience: QueryAudience;
    };
    const reader = comparisonPageReaderContract(c.tab);
    if (
      c.siteId !== siteId ||
      reader?.route !== "membership-recipe" ||
      options.selection !== reader.selection ||
      c.limit !== limit ||
      c.search !== options.search ||
      c.metric !== options.metric ||
      c.sortBy !== options.sortBy ||
      c.direction !== options.direction ||
      c.audience !== audience
    )
      throw new Error("comparison_membership_consumer_mismatch");
    const decoded = c.cursorToken
      ? await decodeComparisonDimensionCursor(
          env,
          siteId,
          current,
          currentFilters,
          reference,
          referenceFilters,
          selectExpr,
          options.search,
          c.cursorToken,
          audience,
          options.metric,
          options.sortBy,
          options.direction,
        )
      : null;
    if (JSON.stringify(decoded) !== JSON.stringify(cursor))
      throw new Error("comparison_membership_cursor_mismatch");
  }
  const currentPlan = buildComparisonDimensionRollupPlan({
    siteId,
    window: current,
    filters: currentFilters,
    selection: options.selection,
    ...(dependencies || whole
      ? {
          ...(dependencies || whole?.current ? { entityDependency: true } : {}),
          ...(whole?.current
            ? { qualificationSemantics: "whole-original" as const }
            : {}),
          outputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS.current,
        }
      : {}),
  });
  const referencePlan = buildComparisonDimensionRollupPlan({
    siteId,
    window: reference,
    filters: referenceFilters,
    selection: options.selection,
    ...(dependencies || whole
      ? {
          ...(dependencies || whole?.reference
            ? { entityDependency: true }
            : {}),
          ...(whole?.reference
            ? { qualificationSemantics: "whole-original" as const }
            : {}),
          outputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS.reference,
        }
      : {}),
  });
  const rawPlan = buildComparisonPagePlan({
    current: currentPlan,
    reference: referencePlan,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
    search: options.search,
    cursor,
    limit,
    ...(dependencies || whole
      ? {
          currentChildOutputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS.current,
          referenceChildOutputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS.reference,
        }
      : {}),
    childOutputId: "comparison-dimension-rollup",
  });
  // Preserve all original canonical builders before transport validation.
  // A private completion cannot be replayed as a public/API reader or another tab.
  const wholeReader = whole
    ? comparisonPageReaderContract(whole.tab)
    : undefined;
  if (
    whole &&
    (Object.getOwnPropertyDescriptor(whole, "kind")?.value !==
      "whole-original-comparison-page" ||
      wholeOriginalComparisonReaderTab(whole.tab) === undefined ||
      dependencies !== undefined ||
      audience !== "private-dashboard" ||
      wholeReader?.route !== "membership-recipe" ||
      options.selection !== wholeReader.selection)
  )
    throw new Error("whole_filter_comparison_consumer_mismatch");
  const plan =
    dependencies || whole
      ? snapshotPageVisitQualificationPlan(rawPlan)
      : rawPlan;
  const inputs =
    dependencies || whole
      ? createAnalysisResultQualificationExecutionInputsForTrustedPlan(
          (["current", "reference"] as const).flatMap((side) => {
            if (!dependencies && !whole?.[side]) return [];
            const matches = plan.nodes.filter(
              (n) =>
                n.kind === "analysis-result" &&
                n.outputId === COMPARISON_MEMBERSHIP_CHILD_OUTPUTS[side],
            );
            const child = matches[0];
            if (matches.length !== 1 || child?.kind !== "analysis-result")
              throw new Error("comparison_membership_child_missing");
            const childPlan = validateLogicalPlan(child.childPlan);
            if (whole?.[side])
              return [
                {
                  childPlan,
                  executionInputs: bindWholeOriginalComparisonChild({
                    owner: whole[side],
                    side,
                    tab: whole.tab,
                    siteId,
                    window: side === "current" ? current : reference,
                    filters:
                      side === "current" ? currentFilters : referenceFilters,
                    plan: childPlan,
                  }),
                },
              ];
            const state = dependencies![side];
            return [
              {
                childPlan,
                executionInputs: bindPageVisitQualificationPreparation({
                  preparation: state.preparation,
                  siteId,
                  filters:
                    side === "current" ? currentFilters : referenceFilters,
                  queryTime: state.queryTime,
                  scopePlan: state.scopePlan,
                  consumerKey: state.consumerKey,
                  plan: childPlan,
                  readerQueryTime: state.readerQueryTime,
                }),
              },
            ];
          }),
          plan,
        )
      : undefined;
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "comparison-page",
    undefined,
    diagnostics,
    inputs,
  );
  return comparisonPageFromRows({
    env,
    rows,
    limit,
    siteId,
    current,
    currentFilters,
    reference,
    referenceFilters,
    selectExpr,
    search: options.search,
    audience,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
  });
}

export type { QualifiedComparisonDimensionExecution } from "./comparison-page-qualification-program";
export { tryQueryQualifiedComparisonDimensionPageFromD1 } from "./comparison-page-qualification-program";

/** Comparison variant for session entry/exit, where each session contributes
 * only its first/last page rather than every page view. */
export async function queryComparisonSessionPathPageFromD1(
  env: Env,
  siteId: string,
  current: QueryWindow,
  currentFilters: FilterDocument,
  reference: QueryWindow,
  referenceFilters: FilterDocument,
  limit: number,
  kind: "entry" | "exit",
  options: {
    metric: OverviewTableMetric;
    sortBy: OverviewTableSortBy;
    direction: SortDirection;
    search?: string;
  },
  cursor: ComparisonDimensionCursor | null,
  audience: QueryAudience,
  diagnostics?: D1ReadDiagnostics,
): Promise<ComparisonDimensionPage> {
  const currentPlan = buildComparisonSessionPathPlan({
    siteId,
    window: current,
    filters: currentFilters,
    kind,
  });
  const referencePlan = buildComparisonSessionPathPlan({
    siteId,
    window: reference,
    filters: referenceFilters,
    kind,
  });
  const plan = buildComparisonPagePlan({
    current: currentPlan,
    reference: referencePlan,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
    search: options.search,
    cursor,
    limit,
    childOutputId: "session-path-comparison-rollup",
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    "comparison-page",
    undefined,
    diagnostics,
  );
  return comparisonPageFromRows({
    env,
    rows,
    limit,
    siteId,
    current,
    currentFilters,
    reference,
    referenceFilters,
    selectExpr: comparisonSessionPathCursorExpression(kind),
    search: options.search,
    audience,
    metric: options.metric,
    sortBy: options.sortBy,
    direction: options.direction,
  });
}
