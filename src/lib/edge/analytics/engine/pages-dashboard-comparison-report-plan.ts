import type {
  PagesDashboardMetric,
  PagesDashboardSortBy,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import type { LogicalExpressionHandle } from "@/lib/edge/analytics/engine/logical/builder";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildPageCardMetricsRollupPlan,
  PAGE_CARD_METRICS_ROLLUP_OUTPUT_FIELDS,
  PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID,
  type PageCardMetricsSourceInput,
} from "@/lib/edge/analytics/engine/page-card-metrics-report-plan";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const RATIO = { kind: "scalar", scalar: "number", unit: "ratio" } as const;

const BASE_METRICS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;
type BaseMetric = (typeof BASE_METRICS)[number];

export const PAGES_DASHBOARD_COMPARISON_OUTPUT_ID =
  "pages-dashboard-comparison";

export interface PagesDashboardComparisonCursor {
  readonly sortClass: number;
  readonly primary: number;
  readonly secondary: number;
  readonly pathname: string;
}

function metricColumn(
  metric: PagesDashboardMetric,
  side: "current" | "reference",
): string {
  const name =
    metric === "bounceRate"
      ? "bounce_rate"
      : metric === "pagesPerSession"
        ? "pages_per_session"
        : metric === "avgDurationMs"
          ? "avg_duration_ms"
          : metric;
  return `${side}_${name}`;
}

function literalLike(
  builder: LogicalPlanBuilder,
  value: number | null,
  expression: LogicalExpressionHandle,
): LogicalExpressionHandle {
  if (expression.type.kind !== "scalar")
    throw new Error("pages_dashboard_comparison_requires_scalar_metric");
  return builder.literal(value, expression.type);
}

function rawColumn(metric: BaseMetric, side: "current" | "reference") {
  const name =
    metric === "totalDuration"
      ? "total_duration"
      : metric === "durationViews"
        ? "duration_views"
        : metric;
  return `${side}_${name}`;
}

function metricExpression(
  builder: LogicalPlanBuilder,
  rows: ReturnType<LogicalPlanBuilder["aggregate"]>,
  metric: PagesDashboardMetric,
  side: "current" | "reference",
): LogicalExpressionHandle {
  if (metric === "bounceRate")
    return safeDivision(
      builder,
      builder.slot(rows, rawColumn("bounces", side)),
      builder.slot(rows, rawColumn("sessions", side)),
      RATIO,
    );
  if (metric === "pagesPerSession")
    return safeDivision(
      builder,
      builder.slot(rows, rawColumn("views", side)),
      builder.slot(rows, rawColumn("sessions", side)),
      RATIO,
    );
  if (metric === "avgDurationMs")
    return safeDivision(
      builder,
      builder.slot(rows, rawColumn("totalDuration", side)),
      builder.slot(rows, rawColumn("sessions", side)),
      { kind: "scalar", scalar: "number", unit: "ms" },
    );
  return builder.slot(rows, metricColumn(metric, side));
}

function safeDivision(
  builder: LogicalPlanBuilder,
  numerator: LogicalExpressionHandle,
  denominator: LogicalExpressionHandle,
  zero:
    | typeof RATIO
    | {
        readonly kind: "scalar";
        readonly scalar: "number";
        readonly unit: "ms";
      },
) {
  const quotient = builder.arithmetic("divide", numerator, denominator);
  return builder.caseWhen(
    [
      {
        when: builder.compare("lte", denominator, builder.literal(0, NUMBER)),
        then: builder.literal(0, zero),
      },
    ],
    quotient,
  );
}

function projectSideRows(
  builder: LogicalPlanBuilder,
  sideRows: ReturnType<LogicalPlanBuilder["importAnalysisResult"]>,
  contributingSide: "current" | "reference",
) {
  const projections: Record<string, LogicalExpressionHandle> = {
    pathname: builder.slot(sideRows, "pathname"),
  };
  for (const metric of BASE_METRICS) {
    const source = builder.slot(sideRows, metric);
    const currentValue =
      contributingSide === "current" ? source : literalLike(builder, 0, source);
    const referenceValue =
      contributingSide === "reference"
        ? source
        : literalLike(builder, 0, source);
    projections[rawColumn(metric, "current")] = currentValue;
    projections[rawColumn(metric, "reference")] = referenceValue;
  }
  return builder.project(sideRows, projections);
}

export function buildPagesDashboardComparisonPlan(input: {
  readonly current: PageCardMetricsSourceInput;
  readonly reference: PageCardMetricsSourceInput;
  readonly metric: PagesDashboardMetric;
  readonly sortBy: PagesDashboardSortBy;
  readonly direction: SortDirection;
  readonly limit: number;
  readonly search?: string;
  readonly cursor?: PagesDashboardComparisonCursor | null;
}): ValidatedLogicalPlan {
  const currentPlan = buildPageCardMetricsRollupPlan(input.current);
  const referencePlan = buildPageCardMetricsRollupPlan(input.reference);
  const builder = new LogicalPlanBuilder(currentPlan.context);
  const imports = PAGE_CARD_METRICS_ROLLUP_OUTPUT_FIELDS.map((field) => ({
    field,
  }));
  const currentRows = builder.importAnalysisResult(
    currentPlan,
    PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID,
    imports,
  );
  const referenceRows = builder.importAnalysisResult(
    referencePlan,
    PAGE_CARD_METRICS_ROLLUP_OUTPUT_ID,
    imports,
  );
  const concatenated = builder.appendRows(
    [
      projectSideRows(builder, currentRows, "current"),
      projectSideRows(builder, referenceRows, "reference"),
    ],
    [
      "pathname",
      ...BASE_METRICS.map((metric) => rawColumn(metric, "current")),
      ...BASE_METRICS.map((metric) => rawColumn(metric, "reference")),
    ],
  );
  const measures = [
    ...BASE_METRICS.map((metric) => ({
      name: rawColumn(metric, "current"),
      kind: "sum" as const,
      expression: builder.slot(concatenated, rawColumn(metric, "current")),
    })),
    ...BASE_METRICS.map((metric) => ({
      name: rawColumn(metric, "reference"),
      kind: "sum" as const,
      expression: builder.slot(concatenated, rawColumn(metric, "reference")),
    })),
  ];
  const aggregate = builder.aggregate(
    concatenated,
    { pathname: builder.slot(concatenated, "pathname") },
    measures,
  );
  const completedValues = Object.fromEntries(
    [
      ...BASE_METRICS.map((metric) => rawColumn(metric, "current")),
      ...BASE_METRICS.map((metric) => rawColumn(metric, "reference")),
    ].map((name) => {
      const value = builder.slot(aggregate, name);
      return [name, builder.coalesce(value, literalLike(builder, 0, value))];
    }),
  ) as Record<string, LogicalExpressionHandle>;
  const completed = builder.project(aggregate, {
    pathname: builder.slot(aggregate, "pathname"),
    ...completedValues,
  });
  const projectedValues = Object.fromEntries(
    [
      ...BASE_METRICS.map((metric) => rawColumn(metric, "current")),
      ...BASE_METRICS.map((metric) => rawColumn(metric, "reference")),
    ].map((name) => [name, builder.slot(completed, name)]),
  ) as Record<string, LogicalExpressionHandle>;

  const currentMetric = metricExpression(
    builder,
    completed,
    input.metric,
    "current",
  );
  const referenceMetric = metricExpression(
    builder,
    completed,
    input.metric,
    "reference",
  );
  const changeRelative = builder.caseWhen(
    [
      {
        when: builder.compare(
          "eq",
          referenceMetric,
          literalLike(builder, 0, referenceMetric),
        ),
        then: builder.caseWhen(
          [
            {
              when: builder.compare(
                "eq",
                currentMetric,
                literalLike(builder, 0, currentMetric),
              ),
              then: builder.literal(0, RATIO),
            },
          ],
          builder.literal(null, RATIO),
        ),
      },
    ],
    builder.arithmetic(
      "divide",
      builder.arithmetic("subtract", currentMetric, referenceMetric),
      referenceMetric,
    ),
  );
  const changeClass = builder.caseWhen(
    [
      {
        when: builder.and(
          builder.compare(
            "eq",
            referenceMetric,
            literalLike(builder, 0, referenceMetric),
          ),
          builder.compare(
            "gt",
            currentMetric,
            literalLike(builder, 0, currentMetric),
          ),
        ),
        then: builder.literal(1, NUMBER),
      },
    ],
    builder.literal(0, NUMBER),
  );
  const projected = builder.project(completed, {
    pathname: builder.slot(completed, "pathname"),
    ...projectedValues,
    current_bounce_rate: metricExpression(
      builder,
      completed,
      "bounceRate",
      "current",
    ),
    current_pages_per_session: metricExpression(
      builder,
      completed,
      "pagesPerSession",
      "current",
    ),
    current_avg_duration_ms: metricExpression(
      builder,
      completed,
      "avgDurationMs",
      "current",
    ),
    reference_bounce_rate: metricExpression(
      builder,
      completed,
      "bounceRate",
      "reference",
    ),
    reference_pages_per_session: metricExpression(
      builder,
      completed,
      "pagesPerSession",
      "reference",
    ),
    reference_avg_duration_ms: metricExpression(
      builder,
      completed,
      "avgDurationMs",
      "reference",
    ),
    change_relative: changeRelative,
    change_class: changeClass,
  });

  let rows = projected;
  if (input.search?.trim())
    rows = builder.filter(
      rows,
      builder.stringMatch(
        "contains",
        builder.slot(rows, "pathname"),
        input.search.trim().toLowerCase(),
        false,
        undefined,
        "legacy-report-search-v1",
      ),
    );

  const primaryName =
    input.sortBy === "change"
      ? "change_relative"
      : metricColumn(
          input.metric,
          input.sortBy === "reference" ? "reference" : "current",
        );
  const secondaryName =
    input.sortBy === "change"
      ? "pathname"
      : metricColumn(
          input.metric,
          input.sortBy === "reference" ? "current" : "reference",
        );
  if (input.cursor) {
    const pathname = builder.slot(rows, "pathname");
    if (input.sortBy === "change") {
      const changeClass = builder.slot(rows, "change_class");
      const changeRelative = builder.slot(rows, "change_relative");
      const classCursor = builder.literal(input.cursor.sortClass, NUMBER);
      const relativeCursor = literalLike(
        builder,
        input.cursor.primary,
        changeRelative,
      );
      const after = input.direction === "asc" ? "gt" : "lt";
      rows = builder.filter(
        rows,
        builder.or(
          builder.compare(after, changeClass, classCursor),
          builder.and(
            builder.compare("eq", changeClass, classCursor),
            builder.or(
              builder.compare(after, changeRelative, relativeCursor),
              builder.and(
                builder.compare("eq", changeRelative, relativeCursor),
                builder.compare(
                  "gt",
                  pathname,
                  builder.literal(input.cursor.pathname, STRING),
                ),
              ),
            ),
          ),
        ),
      );
    } else {
      const primary = builder.slot(rows, primaryName);
      const secondary = builder.slot(rows, secondaryName);
      const primaryCursor = literalLike(builder, input.cursor.primary, primary);
      const secondaryCursor = literalLike(
        builder,
        input.cursor.secondary,
        secondary,
      );
      const after = input.direction === "asc" ? "gt" : "lt";
      rows = builder.filter(
        rows,
        builder.or(
          builder.compare(after, primary, primaryCursor),
          builder.and(
            builder.compare("eq", primary, primaryCursor),
            builder.compare(after, secondary, secondaryCursor),
          ),
          builder.and(
            builder.compare("eq", primary, primaryCursor),
            builder.compare("eq", secondary, secondaryCursor),
            builder.compare(
              "gt",
              pathname,
              builder.literal(input.cursor.pathname, STRING),
            ),
          ),
        ),
      );
    }
  }

  const sortKeys =
    input.sortBy === "change"
      ? [
          {
            slot: "change_class",
            direction: input.direction,
            nulls: "last" as const,
          },
          {
            slot: "change_relative",
            direction: input.direction,
            nulls:
              input.direction === "asc"
                ? ("first" as const)
                : ("last" as const),
          },
          {
            slot: "pathname",
            direction: "asc" as const,
            nulls: "first" as const,
          },
        ]
      : [
          {
            slot: primaryName,
            direction: input.direction,
            nulls: "last" as const,
          },
          {
            slot: secondaryName,
            direction: input.direction,
            nulls: "last" as const,
          },
          {
            slot: "pathname",
            direction: "asc" as const,
            nulls: "first" as const,
          },
        ];
  rows = builder.sort(rows, sortKeys);
  if (!Number.isInteger(input.limit) || input.limit < 0)
    throw new Error("logical_builder_invalid_limit");
  rows = builder.limit(rows, input.limit + 1);
  builder.output(PAGES_DASHBOARD_COMPARISON_OUTPUT_ID, rows, [
    { name: "pathname", slot: "pathname" },
    ...BASE_METRICS.flatMap((metric) => [
      {
        name: rawColumn(metric, "current"),
        slot: rawColumn(metric, "current"),
      },
      {
        name: rawColumn(metric, "reference"),
        slot: rawColumn(metric, "reference"),
      },
    ]),
  ]);
  return builder.finish();
}
