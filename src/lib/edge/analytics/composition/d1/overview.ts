import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import type {
  CanonicalQuery,
  FilterDocument,
  OverviewMetrics,
  OverviewReader,
  QueryTime,
  TrendPoint,
} from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  independentOverviewMembershipDependencyFromQuery,
  prepareDeferredOverviewMembershipRecipe,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  deferredOverviewTrendQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  buildTimeBuckets,
  type QueryWindow,
  timeBucketTimestamp,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { EventMembershipFallback } from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import { prepareEventMembershipFallback } from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import { executeOverviewPreviousQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/overview-previous-qualification-program";
import { executeOverviewTrendQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/overview-trend-qualification-program";
import {
  bindPageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import {
  finishWholeOriginalOverview,
  hasWholeOriginalCompletion,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";

interface D1OverviewTrendQualificationOptions {
  readonly env: Env;
  readonly siteId: string;
  readonly diagnostics?: D1ReadDiagnostics;
}

function queryWindowFromTime(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function overviewMetricsFromRow(row: Record<string, unknown>): OverviewMetrics {
  return {
    views: row.views as number,
    sessions: row.sessions as number,
    visitors: row.visitors as number,
    bounces: row.bounces as number,
    totalDurationMs: row.totalDuration as number,
    durationViews: row.durationViews as number,
  };
}

function trendPointsFromRows(
  rows: readonly Record<string, unknown>[],
  time: QueryTime,
  interval: "minute" | "hour" | "day" | "week" | "month",
): readonly TrendPoint[] {
  const buckets = buildTimeBuckets(queryWindowFromTime(time), interval);
  return rows.map((row) => ({
    bucket: row.bucket as number,
    timestampMs: timeBucketTimestamp(
      buckets,
      row.bucket as number,
    ) as TrendPoint["timestampMs"],
    views: row.views as number,
    visitors: row.visitors as number,
    sessions: row.sessions as number,
    bounces: row.bounces as number,
    totalDurationMs: row.totalDuration as number,
    durationViews: row.durationViews as number,
  }));
}

function trendRowsFor(
  rows: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return rows.filter((row) => row.outputId === "overview-trend");
}

function aggregateRowFor(
  rows: readonly Record<string, unknown>[],
  outputId = "overview-aggregate",
): Record<string, unknown> {
  const row = rows.find((candidate) => candidate.outputId === outputId);
  if (!row) throw new Error("overview_trend_qualification_aggregate_missing");
  return row;
}

async function legacyOverview(
  reader: OverviewReader,
  query: CanonicalQuery<"overview">,
  filters: FilterDocument,
) {
  try {
    const current = await reader.readOverview({ time: query.time, filters });
    const previous = query.previousTime
      ? await reader.readOverview({ time: query.previousTime, filters })
      : undefined;
    const detailInterval = query.detailInterval;
    const detail = detailInterval
      ? await reader.readTrend({
          time: query.time,
          filters,
          interval: detailInterval,
        })
      : undefined;
    return {
      value: {
        current: current.value,
        ...(previous ? { previous: previous.value } : {}),
        ...(detail && detailInterval
          ? { detail: { interval: detailInterval, points: detail.value } }
          : {}),
      },
      source:
        previous && previous.source !== current.source
          ? "mixed"
          : current.source,
      approximateVisitors:
        current.approximateVisitors || Boolean(previous?.approximateVisitors),
    };
  } finally {
    finishWholeOriginalOverview(query);
  }
}

async function legacyTrend(
  reader: OverviewReader,
  query: CanonicalQuery<"trend">,
  filters: FilterDocument,
) {
  try {
    const result = await reader.readTrend({
      time: query.time,
      filters,
      interval: query.interval,
    });
    return {
      value: { interval: query.interval, points: result.value },
      source: result.source,
      approximateVisitors: result.approximateVisitors,
    };
  } finally {
    finishWholeOriginalOverview(query);
  }
}

/**
 * Session and visitor filters read one request-private entity membership for
 * every read of an Overview/Trend request, including a previous-period read
 * of a different window. Anything else keeps the legacy ID bridge.
 */
async function prepareOverviewMembershipFallback(
  d1: D1OverviewTrendQualificationOptions,
  deferred: {
    readonly qualification: Parameters<
      typeof prepareDeferredEventQualificationFallback
    >[0] & { readonly filters: FilterDocument };
    readonly operation: "overview" | "trend";
    readonly configuration: unknown;
  },
): Promise<
  | { readonly reader: OverviewReader; readonly filters: FilterDocument }
  | undefined
> {
  const qualification = deferred.qualification;
  if (
    !("metadata" in qualification) ||
    qualification.metadata.plan.mode !== "entity"
  )
    return undefined;
  const recipe = await prepareDeferredOverviewMembershipRecipe(
    deferred as never,
  );
  if (recipe) {
    return overviewMembershipRecipeReader(d1, recipe);
  }
  const membership = await prepareEventMembershipFallback({
    deferred: qualification as never,
    operation: deferred.operation,
    operations: [deferred.operation],
    configuration: deferred.configuration,
    // current, previous-period and detail reads; each Page and Event Source
    // of a read shares the one entity membership.
    maxPlans: 3,
    maxSourcesPerRole: 2,
  });
  return membership
    ? {
        reader: createOverviewReader(
          d1.env,
          d1.siteId,
          d1.diagnostics,
          membership,
        ),
        filters: qualification.filters,
      }
    : undefined;
}

function overviewMembershipRecipeReader(
  d1: D1OverviewTrendQualificationOptions,
  recipe: NonNullable<
    Awaited<ReturnType<typeof prepareDeferredOverviewMembershipRecipe>>
  >,
): { readonly reader: OverviewReader; readonly filters: FilterDocument } {
  let childIndex = 1;
  const membership: EventMembershipFallback = {
    bindPlan(buildPlan, readerQueryTime) {
      const child = recipe.enginePlan.steps[childIndex];
      if (
        !child ||
        child.kind !== "read-report" ||
        !readerQueryTime ||
        JSON.stringify(
          semanticTemporalDomainsFromQueryTime(readerQueryTime),
        ) !==
          JSON.stringify(semanticTemporalDomainsFromQueryTime(child.queryTime))
      )
        throw new Error("overview_membership_reader_step_mismatch");
      const plan = snapshotPageVisitQualificationPlan(
        buildPlan({
          queryTime: recipe.queryTime,
          scopePlan: recipe.scopePlan,
          qualificationDependencyRefs: [
            EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
          ],
          pageVisitDependencyRefs: [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY],
        }),
      );
      const sources = plan.nodes.filter((node) => node.kind === "source");
      if (
        plan.outputs.length !== 1 ||
        plan.outputs[0]?.id !== child.localOutputId ||
        sources.length !== child.maxSources ||
        child.sourceRoles.some(
          (role) => sources.filter((node) => node.entity === role).length !== 1,
        )
      )
        throw new Error("overview_membership_reader_shape_mismatch");
      const executionInputs = bindPageVisitQualificationPreparation({
        preparation: recipe.preparation,
        siteId: recipe.siteId,
        filters: recipe.filters,
        queryTime: recipe.queryTime,
        scopePlan: recipe.scopePlan,
        consumerKey: recipe.consumerKey,
        plan,
        readerQueryTime,
      });
      childIndex += 1;
      return { plan, executionInputs };
    },
  };
  return {
    reader: createOverviewReader(d1.env, d1.siteId, d1.diagnostics, membership),
    filters: recipe.filters,
  };
}

export function overviewProvider(
  reader: OverviewReader,
  d1?: D1OverviewTrendQualificationOptions,
) {
  return typedQueryProviderFor("overview", async (query) => {
    const deferred = d1
      ? deferredOverviewTrendQualificationFromQuery(query, "overview")
      : undefined;
    if (deferred && d1) {
      if (
        deferred.configuration.kind === "overview-with-previous" ||
        deferred.configuration.kind === "overview-with-previous-and-detail"
      ) {
        const execution = await executeOverviewPreviousQualificationProgram({
          env: d1.env,
          query,
          deferred,
          configuration: deferred.configuration,
          ...(d1.diagnostics ? { diagnostics: d1.diagnostics } : {}),
        });
        if (execution.kind === "executed") {
          const current = overviewMetricsFromRow(
            aggregateRowFor(execution.rows, "overview-current-aggregate"),
          );
          const previous = overviewMetricsFromRow(
            aggregateRowFor(execution.rows, "overview-previous-aggregate"),
          );
          const detail =
            deferred.configuration.kind === "overview-with-previous-and-detail"
              ? {
                  interval: deferred.configuration.interval,
                  points: trendPointsFromRows(
                    trendRowsFor(execution.rows),
                    deferred.qualification.requestTime,
                    deferred.configuration.interval,
                  ),
                }
              : undefined;
          return {
            value: {
              current,
              previous,
              ...(detail ? { detail } : {}),
            },
            source: "raw" as const,
            approximateVisitors: false,
          };
        }
        const membership = await prepareOverviewMembershipFallback(
          d1,
          deferred,
        );
        if (membership)
          return legacyOverview(membership.reader, query, membership.filters);
        const filters = await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        );
        return legacyOverview(reader, query, filters);
      }
      const execution = await executeOverviewTrendQualificationProgram({
        env: d1.env,
        deferred,
        configuration: deferred.configuration,
        ...(d1.diagnostics ? { diagnostics: d1.diagnostics } : {}),
      });
      if (execution.kind === "executed") {
        const current = overviewMetricsFromRow(aggregateRowFor(execution.rows));
        const detail =
          deferred.configuration.kind === "overview-with-detail"
            ? {
                interval: deferred.configuration.interval,
                points: trendPointsFromRows(
                  trendRowsFor(execution.rows),
                  deferred.qualification.requestTime,
                  deferred.configuration.interval,
                ),
              }
            : undefined;
        return {
          value: { current, ...(detail ? { detail } : {}) },
          source: "raw" as const,
          approximateVisitors: false,
        };
      }
      const membership = await prepareOverviewMembershipFallback(d1, deferred);
      if (membership)
        return legacyOverview(membership.reader, query, membership.filters);
      const filters = await prepareDeferredEventQualificationFallback(
        deferred.qualification,
      );
      return legacyOverview(reader, query, filters);
    }
    const dependency = d1
      ? independentOverviewMembershipDependencyFromQuery(query, "overview")
      : undefined;
    if (dependency && d1) {
      const membership = overviewMembershipRecipeReader(d1, dependency);
      return legacyOverview(membership.reader, query, membership.filters);
    }
    const filters = query.filters ?? EMPTY_FILTER_DOCUMENT;
    if (d1 && hasWholeOriginalCompletion(query, "overview"))
      return legacyOverview(
        createOverviewReader(d1.env, d1.siteId, d1.diagnostics, {
          kind: "whole-original-overview",
          owner: query,
        }),
        query,
        filters,
      );
    return legacyOverview(reader, query, filters);
  });
}

export function trendProvider(
  reader: OverviewReader,
  d1?: D1OverviewTrendQualificationOptions,
) {
  return typedQueryProviderFor("trend", async (query) => {
    const deferred = d1
      ? deferredOverviewTrendQualificationFromQuery(query, "trend")
      : undefined;
    if (deferred && d1) {
      if (deferred.configuration.kind !== "trend")
        throw new Error("overview_trend_qualification_configuration_invalid");
      const execution = await executeOverviewTrendQualificationProgram({
        env: d1.env,
        deferred,
        configuration: deferred.configuration,
        ...(d1.diagnostics ? { diagnostics: d1.diagnostics } : {}),
      });
      if (execution.kind === "executed")
        return {
          value: {
            interval: deferred.configuration.interval,
            points: trendPointsFromRows(
              trendRowsFor(execution.rows),
              deferred.qualification.requestTime,
              deferred.configuration.interval,
            ),
          },
          source: "raw" as const,
          approximateVisitors: false,
        };
      const membership = await prepareOverviewMembershipFallback(d1, deferred);
      if (membership)
        return legacyTrend(membership.reader, query, membership.filters);
      const filters = await prepareDeferredEventQualificationFallback(
        deferred.qualification,
      );
      return legacyTrend(reader, query, filters);
    }
    const dependency = d1
      ? independentOverviewMembershipDependencyFromQuery(query, "trend")
      : undefined;
    if (dependency && d1) {
      const membership = overviewMembershipRecipeReader(d1, dependency);
      return legacyTrend(membership.reader, query, membership.filters);
    }
    const filters = query.filters ?? EMPTY_FILTER_DOCUMENT;
    if (d1 && hasWholeOriginalCompletion(query, "trend"))
      return legacyTrend(
        createOverviewReader(d1.env, d1.siteId, d1.diagnostics, {
          kind: "whole-original-overview",
          owner: query,
        }),
        query,
        filters,
      );
    return legacyTrend(reader, query, filters);
  });
}
