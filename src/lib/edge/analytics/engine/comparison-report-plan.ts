import type {
  OverviewTableMetric,
  OverviewTableSortBy,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  dimensionRollup,
  selectedPageDimension,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const RATIO = { kind: "scalar", scalar: "number", unit: "ratio" } as const;

export const COMPARISON_PAGE_OUTPUT_ID = "comparison-page";
export const COMPARISON_DIMENSION_ROLLUP_OUTPUT = "comparison-dimension-rollup";
export const COMPARISON_PAGE_CURRENT_CONTROLS_OUTPUT =
  "comparison-page-current-controls";
export const COMPARISON_PAGE_REFERENCE_CONTROLS_OUTPUT =
  "comparison-page-reference-controls";
export const COMPARISON_PAGE_CURRENT_ROLLUP_OUTPUT =
  "comparison-page-current-rollup";
export const COMPARISON_PAGE_REFERENCE_ROLLUP_OUTPUT =
  "comparison-page-reference-rollup";
export const COMPARISON_PAGE_CURRENT_CHILD_CONTROLS_OUTPUT =
  "comparison-page-current-qualification-controls";
export const COMPARISON_PAGE_REFERENCE_CHILD_CONTROLS_OUTPUT =
  "comparison-page-reference-qualification-controls";
export interface ComparisonDimensionCursor {
  readonly sortClass: number;
  readonly primary: number;
  readonly secondary: number;
  readonly key: string;
}

/** Identifies the semantic child report used by a tab comparison. */
export type ComparisonReportFamily =
  | {
      readonly kind: "page-dimension";
      readonly selection: PageDimensionSelection;
    }
  | {
      readonly kind: "session-boundary";
      readonly pathKind: "entry" | "exit";
    };

export function appendComparisonDimensionRollup(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  selection: PageDimensionSelection,
): LogicalRelationHandle {
  return dimensionRollup(
    builder,
    pages,
    selectedPageDimension(builder, pages, selection),
  );
}

function metricField(
  metric: OverviewTableMetric,
  side: "current" | "reference",
) {
  return `${side}${metric[0]!.toUpperCase()}${metric.slice(1)}`;
}

function comparisonRelative(
  builder: LogicalPlanBuilder,
  current: ReturnType<LogicalPlanBuilder["slot"]>,
  reference: ReturnType<LogicalPlanBuilder["slot"]>,
) {
  const zero = builder.literal(0, NUMBER);
  const noReference = builder.compare("eq", reference, zero);
  const noCurrent = builder.compare("eq", current, zero);
  const zeroChange = builder.literal(0, RATIO);
  const nullChange = builder.literal(null, RATIO);
  const denominatorNonzero = builder.arithmetic("subtract", current, reference);
  return builder.caseWhen(
    [
      {
        when: noReference,
        then: builder.caseWhen(
          [{ when: noCurrent, then: zeroChange }],
          nullChange,
        ),
      },
    ],
    builder.arithmetic("divide", denominatorNonzero, reference),
  );
}

export interface ComparisonPagePlanInput {
  readonly current: ValidatedLogicalPlan;
  readonly reference: ValidatedLogicalPlan;
  readonly metric: OverviewTableMetric;
  readonly sortBy: OverviewTableSortBy;
  readonly direction: SortDirection;
  readonly search?: string;
  readonly cursor: ComparisonDimensionCursor | null;
  readonly limit: number;
  readonly childOutputId: string;
  readonly currentChildOutputId?: string;
  readonly referenceChildOutputId?: string;
}

function appendComparisonPageCompositionFromImports(
  builder: LogicalPlanBuilder,
  input: ComparisonPagePlanInput,
  current: LogicalRelationHandle,
  reference: LogicalRelationHandle,
): LogicalRelationHandle {
  const currentKey = builder.project(current, {
    key: builder.slot(current, "key"),
  });
  const referenceKey = builder.project(reference, {
    key: builder.slot(reference, "key"),
  });
  const keyRows = builder.appendRows([currentKey, referenceKey], ["key"]);
  const keys = builder.aggregate(
    keyRows,
    { key: builder.slot(keyRows, "key") },
    [],
  );
  const currentJoin = builder.join(
    keys,
    current,
    [{ left: "key", right: "key" }],
    "left",
  );
  const zero = builder.literal(0, NUMBER);
  const currentMeasures = builder.project(currentJoin, {
    key: builder.slot(currentJoin, "key"),
    currentViews: builder.coalesce(
      builder.slot(currentJoin, "right.views"),
      zero,
    ),
    currentSessions: builder.coalesce(
      builder.slot(currentJoin, "right.sessions"),
      zero,
    ),
    currentVisitors: builder.coalesce(
      builder.slot(currentJoin, "right.visitors"),
      zero,
    ),
  });
  const referenceJoin = builder.join(
    currentMeasures,
    reference,
    [{ left: "key", right: "key" }],
    "left",
  );
  const measures = builder.project(referenceJoin, {
    key: builder.slot(referenceJoin, "key"),
    currentViews: builder.slot(referenceJoin, "currentViews"),
    currentSessions: builder.slot(referenceJoin, "currentSessions"),
    currentVisitors: builder.slot(referenceJoin, "currentVisitors"),
    referenceViews: builder.coalesce(
      builder.slot(referenceJoin, "right.views"),
      zero,
    ),
    referenceSessions: builder.coalesce(
      builder.slot(referenceJoin, "right.sessions"),
      zero,
    ),
    referenceVisitors: builder.coalesce(
      builder.slot(referenceJoin, "right.visitors"),
      zero,
    ),
  });
  const currentMetric = builder.slot(
    measures,
    metricField(input.metric, "current"),
  );
  const referenceMetric = builder.slot(
    measures,
    metricField(input.metric, "reference"),
  );
  const noReference = builder.compare("eq", referenceMetric, zero);
  const positiveCurrent = builder.compare("gt", currentMetric, zero);
  const changeClass = builder.caseWhen(
    [
      {
        when: builder.and(noReference, positiveCurrent),
        then: builder.literal(1, NUMBER),
      },
    ],
    builder.literal(0, NUMBER),
  );
  let result = builder.project(measures, {
    key: builder.slot(measures, "key"),
    currentViews: builder.slot(measures, "currentViews"),
    currentSessions: builder.slot(measures, "currentSessions"),
    currentVisitors: builder.slot(measures, "currentVisitors"),
    referenceViews: builder.slot(measures, "referenceViews"),
    referenceSessions: builder.slot(measures, "referenceSessions"),
    referenceVisitors: builder.slot(measures, "referenceVisitors"),
    changeRelative: comparisonRelative(builder, currentMetric, referenceMetric),
    changeClass,
  });
  result = builder.filter(
    result,
    builder.compare(
      "neq",
      builder.slot(result, "key"),
      builder.literal("", STRING),
    ),
  );
  const search = input.search?.trim();
  if (search) {
    result = builder.filter(
      result,
      builder.stringMatch(
        "contains",
        builder.slot(result, "key"),
        search.toLowerCase(),
        false,
        undefined,
        "legacy-report-search-v1",
      ),
    );
  }
  if (input.cursor) {
    const cursor = input.cursor;
    const key = builder.slot(result, "key");
    if (input.sortBy === "change") {
      const classValue = builder.slot(result, "changeClass");
      const relative = builder.slot(result, "changeRelative");
      const operator = input.direction === "asc" ? "gt" : "lt";
      result = builder.filter(
        result,
        builder.or(
          builder.compare(
            operator,
            classValue,
            builder.literal(cursor.sortClass, NUMBER),
          ),
          builder.and(
            builder.compare(
              "eq",
              classValue,
              builder.literal(cursor.sortClass, NUMBER),
            ),
            builder.or(
              builder.compare(
                operator,
                relative,
                builder.literal(cursor.primary, RATIO),
              ),
              builder.and(
                builder.compare(
                  "eq",
                  relative,
                  builder.literal(cursor.primary, RATIO),
                ),
                builder.compare("gt", key, builder.literal(cursor.key, STRING)),
              ),
            ),
          ),
        ),
      );
    } else {
      const primaryField = metricField(
        input.metric,
        input.sortBy === "reference" ? "reference" : "current",
      );
      const secondaryField = metricField(
        input.metric,
        input.sortBy === "reference" ? "current" : "reference",
      );
      const primary = builder.slot(result, primaryField);
      const secondary = builder.slot(result, secondaryField);
      const operator = input.direction === "asc" ? "gt" : "lt";
      result = builder.filter(
        result,
        builder.or(
          builder.compare(
            operator,
            primary,
            builder.literal(cursor.primary, NUMBER),
          ),
          builder.and(
            builder.compare(
              "eq",
              primary,
              builder.literal(cursor.primary, NUMBER),
            ),
            builder.compare(
              operator,
              secondary,
              builder.literal(cursor.secondary, NUMBER),
            ),
          ),
          builder.and(
            builder.compare(
              "eq",
              primary,
              builder.literal(cursor.primary, NUMBER),
            ),
            builder.compare(
              "eq",
              secondary,
              builder.literal(cursor.secondary, NUMBER),
            ),
            builder.compare("gt", key, builder.literal(cursor.key, STRING)),
          ),
        ),
      );
    }
  }
  const order =
    input.sortBy === "change"
      ? [
          {
            slot: "changeClass",
            direction: input.direction,
            nulls: "last" as const,
          },
          {
            slot: "changeRelative",
            direction: input.direction,
            nulls:
              input.direction === "asc"
                ? ("first" as const)
                : ("last" as const),
          },
          { slot: "key", direction: "asc" as const, nulls: "first" as const },
        ]
      : [
          {
            slot: metricField(input.metric, input.sortBy),
            direction: input.direction,
            nulls: "last" as const,
          },
          {
            slot: metricField(
              input.metric,
              input.sortBy === "reference" ? "current" : "reference",
            ),
            direction: input.direction,
            nulls: "last" as const,
          },
          { slot: "key", direction: "asc" as const, nulls: "first" as const },
        ];
  result = builder.sort(result, order);
  result = builder.limit(result, input.limit + 1);
  return result;
}

export function appendComparisonPageComposition(
  builder: LogicalPlanBuilder,
  input: ComparisonPagePlanInput,
): LogicalRelationHandle {
  const importSide = (plan: ValidatedLogicalPlan, outputId: string) =>
    builder.importAnalysisResult(plan, outputId, [
      { field: "value", as: "key" },
      { field: "views" },
      { field: "sessions" },
      { field: "visitors" },
    ]);
  return appendComparisonPageCompositionFromImports(
    builder,
    input,
    importSide(
      input.current,
      input.currentChildOutputId ?? input.childOutputId,
    ),
    importSide(
      input.reference,
      input.referenceChildOutputId ?? input.childOutputId,
    ),
  );
}

export interface QualifiedComparisonPagePlanInput extends Omit<
  ComparisonPagePlanInput,
  "childOutputId"
> {
  readonly currentReportOutputId: string;
  readonly referenceReportOutputId: string;
  readonly currentControlsOutputId?: string;
  readonly referenceControlsOutputId?: string;
}

/** Imports both unpaginated reports and controls for qualified sides only. */
export function buildQualifiedComparisonPagePlan(
  input: QualifiedComparisonPagePlanInput,
): ValidatedLogicalPlan {
  if (!input.currentControlsOutputId && !input.referenceControlsOutputId)
    throw new Error("comparison_page_qualification_controls_missing");
  const builder = new LogicalPlanBuilder(
    input.currentControlsOutputId
      ? input.current.context
      : input.reference.context,
  );
  const importReport = (plan: ValidatedLogicalPlan, outputId: string) =>
    builder.importAnalysisResult(plan, outputId, [
      { field: "value", as: "key" },
      { field: "views" },
      { field: "sessions" },
      { field: "visitors" },
    ]);
  const importControls = (
    plan: ValidatedLogicalPlan,
    outputId: string,
    prefix: "current" | "reference",
  ) => {
    const output = plan.outputs.find((candidate) => candidate.id === outputId);
    if (!output)
      throw new Error(`comparison_page_controls_output_missing:${outputId}`);
    return builder.importAnalysisResult(
      plan,
      outputId,
      output.fields.map(({ name }) => ({
        field: name,
        as: `${prefix}__${name}`,
      })),
    );
  };
  const current = importReport(input.current, input.currentReportOutputId);
  const reference = importReport(
    input.reference,
    input.referenceReportOutputId,
  );
  const currentControls = input.currentControlsOutputId
    ? importControls(input.current, input.currentControlsOutputId, "current")
    : undefined;
  const referenceControls = input.referenceControlsOutputId
    ? importControls(
        input.reference,
        input.referenceControlsOutputId,
        "reference",
      )
    : undefined;
  const page = appendComparisonPageCompositionFromImports(
    builder,
    {
      ...input,
      childOutputId: input.currentReportOutputId,
    },
    current,
    reference,
  );
  builder.output(COMPARISON_PAGE_OUTPUT_ID, page, [
    { name: "key", slot: "key" },
    { name: "currentViews", slot: "currentViews" },
    { name: "currentSessions", slot: "currentSessions" },
    { name: "currentVisitors", slot: "currentVisitors" },
    { name: "referenceViews", slot: "referenceViews" },
    { name: "referenceSessions", slot: "referenceSessions" },
    { name: "referenceVisitors", slot: "referenceVisitors" },
    {
      name: "sortClass",
      slot: "changeClass",
    },
    {
      name: "sortPrimary",
      slot:
        input.sortBy === "change"
          ? "changeRelative"
          : metricField(
              input.metric,
              input.sortBy === "reference" ? "reference" : "current",
            ),
    },
    {
      name: "sortSecondary",
      slot:
        input.sortBy === "change"
          ? "changeClass"
          : metricField(
              input.metric,
              input.sortBy === "reference" ? "current" : "reference",
            ),
    },
  ]);
  if (currentControls)
    builder.output(
      COMPARISON_PAGE_CURRENT_CONTROLS_OUTPUT,
      currentControls,
      Object.keys(currentControls.slots).map((name) => ({
        name: name.replace(/^current__/u, ""),
        slot: name,
      })),
    );
  if (referenceControls)
    builder.output(
      COMPARISON_PAGE_REFERENCE_CONTROLS_OUTPUT,
      referenceControls,
      Object.keys(referenceControls.slots).map((name) => ({
        name: name.replace(/^reference__/u, ""),
        slot: name,
      })),
    );
  return builder.finish();
}

export function buildComparisonPagePlan(
  input: ComparisonPagePlanInput,
): ValidatedLogicalPlan {
  const builder = new LogicalPlanBuilder(input.current.context);
  const result = appendComparisonPageComposition(builder, input);
  builder.output(COMPARISON_PAGE_OUTPUT_ID, result, [
    { name: "key", slot: "key" },
    { name: "currentViews", slot: "currentViews" },
    { name: "currentSessions", slot: "currentSessions" },
    { name: "currentVisitors", slot: "currentVisitors" },
    { name: "referenceViews", slot: "referenceViews" },
    { name: "referenceSessions", slot: "referenceSessions" },
    { name: "referenceVisitors", slot: "referenceVisitors" },
  ]);
  return builder.finish();
}
