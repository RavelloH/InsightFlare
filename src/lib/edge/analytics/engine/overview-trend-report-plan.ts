import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  CalendarGranularity,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import {
  type LogicalExpressionHandle,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { createOverviewReportSource } from "@/lib/edge/analytics/engine/overview-report-source";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER = { kind: "scalar", scalar: "number" } as const;
const NUMBER_MS = { kind: "scalar", scalar: "number", unit: "ms" } as const;

const TREND_METRIC_FIELDS = [
  "bucket",
  "views",
  "visitors",
  "sessions",
  "bounces",
  "totalDuration",
  "durationViews",
] as const;

function attribute(
  builder: LogicalPlanBuilder,
  source: LogicalRelationHandle,
  entity: "page" | "event",
  name: string,
): LogicalExpressionHandle {
  return builder.slot(source, `attribute:${entity}.report.${name}`);
}

function bucketIndex(
  builder: LogicalPlanBuilder,
  time: LogicalExpressionHandle,
  interval: CalendarGranularity,
): LogicalExpressionHandle {
  return builder.bucketIndex(builder.timeBucket(time, interval));
}

function nonEmptyRawValue(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
): LogicalExpressionHandle {
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", value, builder.literal("", STRING)),
        then: value,
      },
    ],
    builder.literal(null, STRING),
  );
}

function pageBucketRollup(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  interval: CalendarGranularity,
  scoped: boolean,
): LogicalRelationHandle {
  const bucket = bucketIndex(
    builder,
    attribute(builder, pages, "page", "startedAt"),
    interval,
  );
  const duration = attribute(builder, pages, "page", "durationMs");
  if (
    duration.type.kind !== "scalar" ||
    duration.type.scalar !== "number" ||
    duration.type.unit !== "ms"
  )
    throw new Error("overview_trend_duration_attribute_type_mismatch");
  const zeroDuration = builder.literal(0, NUMBER_MS);
  const validDuration = builder.compare("gte", duration, zeroDuration);
  const sumDuration = builder.caseWhen(
    [{ when: validDuration, then: duration }],
    zeroDuration,
  );
  const durationCount = builder.caseWhen(
    [{ when: validDuration, then: builder.literal(1, NUMBER) }],
    builder.literal(0, NUMBER),
  );
  const measures = [
    { name: "views", kind: "count-rows" as const },
    { name: "totalDurationRaw", kind: "sum" as const, expression: sumDuration },
    {
      name: "durationViewsRaw",
      kind: "sum" as const,
      expression: durationCount,
    },
    ...(scoped
      ? []
      : [
          {
            name: "visitorsRaw",
            kind: "count-distinct" as const,
            expression: nonEmptyRawValue(
              builder,
              attribute(builder, pages, "page", "visitorId"),
            ),
          },
        ]),
  ];
  const grouped = builder.aggregate(pages, { bucket }, measures);
  return builder.project(grouped, {
    bucket: builder.slot(grouped, "bucket"),
    views: builder.slot(grouped, "views"),
    visitors: scoped
      ? builder.literal(0, NUMBER)
      : builder.slot(grouped, "visitorsRaw"),
    totalDuration: builder.coalesce(
      builder.slot(grouped, "totalDurationRaw"),
      zeroDuration,
    ),
    durationViews: builder.coalesce(
      builder.slot(grouped, "durationViewsRaw"),
      builder.literal(0, NUMBER),
    ),
  });
}

function scopedObservations(
  builder: LogicalPlanBuilder,
  pages: LogicalRelationHandle,
  events: LogicalRelationHandle,
): LogicalRelationHandle {
  const pageRows = builder.project(pages, {
    visitorId: attribute(builder, pages, "page", "visitorId"),
    sessionId: attribute(builder, pages, "page", "sessionId"),
    observedAt: attribute(builder, pages, "page", "startedAt"),
    isVisit: builder.literal(1, NUMBER),
  });
  const eventRows = builder.project(events, {
    visitorId: attribute(builder, events, "event", "ownerVisitorId"),
    sessionId: attribute(builder, events, "event", "ownerSessionId"),
    observedAt: attribute(builder, events, "event", "occurredAt"),
    isVisit: builder.literal(0, NUMBER),
  });
  return builder.appendRows(
    [pageRows, eventRows],
    ["visitorId", "sessionId", "observedAt", "isVisit"],
  );
}

function visitorBucketRollup(
  builder: LogicalPlanBuilder,
  observations: LogicalRelationHandle,
  interval: CalendarGranularity,
): LogicalRelationHandle {
  const bucket = bucketIndex(
    builder,
    builder.slot(observations, "observedAt"),
    interval,
  );
  return builder.aggregate(observations, { bucket }, [
    {
      name: "visitors",
      kind: "count-distinct",
      expression: nonEmptyRawValue(
        builder,
        builder.slot(observations, "visitorId"),
      ),
    },
  ]);
}

function sessionBucketRollup(
  builder: LogicalPlanBuilder,
  observations: LogicalRelationHandle,
  interval: CalendarGranularity,
  scoped: boolean,
): LogicalRelationHandle {
  const sessionId = builder.slot(observations, "sessionId");
  const selected = builder.filter(
    observations,
    builder.compare("neq", sessionId, builder.literal("", STRING)),
  );
  const grouped = scoped
    ? builder.aggregate(selected, { sessionId }, [
        {
          name: "firstObservedAt",
          kind: "min",
          expression: builder.slot(selected, "observedAt"),
        },
        {
          name: "visitCountRaw",
          kind: "sum",
          expression: builder.slot(selected, "isVisit"),
        },
      ])
    : builder.aggregate(selected, { sessionId }, [
        {
          name: "firstObservedAt",
          kind: "min",
          expression: builder.slot(selected, "observedAt"),
        },
        { name: "visitCountRaw", kind: "count-rows" },
      ]);
  const count = scoped
    ? builder.coalesce(
        builder.slot(grouped, "visitCountRaw"),
        builder.literal(0, NUMBER),
      )
    : builder.slot(grouped, "visitCountRaw");
  const bucket = bucketIndex(
    builder,
    builder.slot(grouped, "firstObservedAt"),
    interval,
  );
  const sessionRows = builder.project(grouped, {
    bucket,
    bounce: builder.caseWhen(
      [
        {
          when: builder.compare("eq", count, builder.literal(1, NUMBER)),
          then: builder.literal(1, NUMBER),
        },
      ],
      builder.literal(0, NUMBER),
    ),
  });
  return builder.aggregate(
    sessionRows,
    { bucket: builder.slot(sessionRows, "bucket") },
    [
      { name: "sessions", kind: "count-rows" },
      {
        name: "bounces",
        kind: "sum",
        expression: builder.slot(sessionRows, "bounce"),
      },
    ],
  );
}

function metricRows(
  builder: LogicalPlanBuilder,
  pageRows: LogicalRelationHandle,
  sessionRows: LogicalRelationHandle,
  visitorRows: LogicalRelationHandle | undefined,
): LogicalRelationHandle {
  const pageMetricRows = builder.project(pageRows, {
    bucket: builder.slot(pageRows, "bucket"),
    views: builder.slot(pageRows, "views"),
    visitors: builder.slot(pageRows, "visitors"),
    sessions: builder.literal(0, NUMBER),
    bounces: builder.literal(0, NUMBER),
    totalDuration: builder.slot(pageRows, "totalDuration"),
    durationViews: builder.slot(pageRows, "durationViews"),
  });
  const sessionMetricRows = builder.project(sessionRows, {
    bucket: builder.slot(sessionRows, "bucket"),
    views: builder.literal(0, NUMBER),
    visitors: builder.literal(0, NUMBER),
    sessions: builder.slot(sessionRows, "sessions"),
    bounces: builder.slot(sessionRows, "bounces"),
    totalDuration: builder.literal(0, NUMBER_MS),
    durationViews: builder.literal(0, NUMBER),
  });
  const rows = [pageMetricRows, sessionMetricRows];
  if (visitorRows) {
    rows.push(
      builder.project(visitorRows, {
        bucket: builder.slot(visitorRows, "bucket"),
        views: builder.literal(0, NUMBER),
        visitors: builder.slot(visitorRows, "visitors"),
        sessions: builder.literal(0, NUMBER),
        bounces: builder.literal(0, NUMBER),
        totalDuration: builder.literal(0, NUMBER_MS),
        durationViews: builder.literal(0, NUMBER),
      }),
    );
  }
  return builder.appendRows(rows, TREND_METRIC_FIELDS);
}

export function appendOverviewTrendReport(
  builder: LogicalPlanBuilder,
  input: {
    readonly pages: LogicalRelationHandle;
    readonly events?: LogicalRelationHandle;
    readonly scoped: boolean;
    readonly interval: CalendarGranularity;
  },
): void {
  const { pages, events, scoped, interval } = input;
  const pageRows = pageBucketRollup(builder, pages, interval, scoped);
  const observations =
    scoped && events
      ? scopedObservations(builder, pages, events)
      : builder.project(pages, {
          visitorId: attribute(builder, pages, "page", "visitorId"),
          sessionId: attribute(builder, pages, "page", "sessionId"),
          observedAt: attribute(builder, pages, "page", "startedAt"),
          isVisit: builder.literal(1, NUMBER),
        });
  const sessionRows = sessionBucketRollup(
    builder,
    observations,
    interval,
    scoped,
  );
  const visitorRows = scoped
    ? visitorBucketRollup(builder, observations, interval)
    : undefined;
  const combinedRows = metricRows(builder, pageRows, sessionRows, visitorRows);
  const finalRows = builder.aggregate(
    combinedRows,
    { bucket: builder.slot(combinedRows, "bucket") },
    [
      {
        name: "views",
        kind: "sum",
        expression: builder.slot(combinedRows, "views"),
      },
      {
        name: "visitors",
        kind: "sum",
        expression: builder.slot(combinedRows, "visitors"),
      },
      {
        name: "sessions",
        kind: "sum",
        expression: builder.slot(combinedRows, "sessions"),
      },
      {
        name: "bounces",
        kind: "sum",
        expression: builder.slot(combinedRows, "bounces"),
      },
      {
        name: "totalDuration",
        kind: "sum",
        expression: builder.slot(combinedRows, "totalDuration"),
      },
      {
        name: "durationViews",
        kind: "sum",
        expression: builder.slot(combinedRows, "durationViews"),
      },
    ],
  );
  const sorted = builder.sort(finalRows, [
    { slot: "bucket", direction: "asc", nulls: "first" },
  ]);
  builder.output(
    "overview-trend",
    sorted,
    TREND_METRIC_FIELDS.map((name) => ({ name, slot: name })),
  );
}

export function buildOverviewTrendPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly pageVisitDependencyRefs?: readonly QualificationDependencyRef[];
  readonly qualificationSemantics?: "whole-original";
  readonly interval: CalendarGranularity;
}): ValidatedLogicalPlan {
  const source = createOverviewReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.qualificationDependencyRefs
      ? { qualificationDependencyRefs: input.qualificationDependencyRefs }
      : {}),
    ...(input.pageVisitDependencyRefs
      ? { pageVisitDependencyRefs: input.pageVisitDependencyRefs }
      : {}),
    ...(input.qualificationSemantics
      ? { qualificationSemantics: input.qualificationSemantics }
      : {}),
    pageAttributes: [
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.startedAt",
      "page.report.durationMs",
    ],
    eventAttributes: [
      "event.report.ownerSessionId",
      "event.report.ownerVisitorId",
      "event.report.occurredAt",
    ],
  });
  appendOverviewTrendReport(source.builder, {
    ...source,
    interval: input.interval,
  });
  return source.builder.finish();
}
