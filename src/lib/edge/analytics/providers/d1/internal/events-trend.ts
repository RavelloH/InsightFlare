import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { EventTrendReaderStage } from "@/lib/edge/analytics/engine/event-membership-reader-contract";
import {
  buildEventTrendOtherPlan,
  buildEventTrendPointsPlan,
  buildEventTrendSeriesPlan,
  buildEventTypeTrendPlan,
  EVENT_TREND_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-trend-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { DeferredEventTrendQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { Env } from "@/lib/edge/types";

import { prepareDeferredEventQualificationFallback } from "./advanced-filter-execution";
import {
  type EventTrendQualificationQuery,
  executeEventTrendQualificationProgram,
} from "./analytics-qualification-program";
import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import {
  buildTimeBuckets,
  type EventTrendPointRow,
  type EventTrendSeriesRow,
  type EventTypeTrendPointRow,
  type FilterDocument,
  type Interval,
  type QueryWindow,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
  shareTrendSeriesKey,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  type EventMembershipFallback,
  prepareEventMembershipFallback,
} from "./event-membership-fallback";
import {
  advanceWholeOriginalEventTrend,
  bindWholeOriginalReader,
} from "./whole-filter-reader-preparation";

function trendPlanInput(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
) {
  const metadata = scopedFilterMetadata(filters);
  return {
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
  };
}

function seriesRow(row: Record<string, unknown>): EventTrendSeriesRow {
  return {
    // Event names are non-NULL in the deployed schema. Keep an anomalous NULL
    // as-is at runtime so the existing series-label path retains its failure
    // behavior instead of silently inventing an empty name.
    eventName: row.eventName as string,
    events: Number(row.events ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  };
}

type MappedEventTrendSeries = {
  readonly seriesKeyByName: Map<string, string>;
  readonly series: Array<{
    key: string;
    eventName: string;
    label: string;
    events: number;
    sessions: number;
    visitors: number;
    isOther?: boolean;
  }>;
};

function mapEventTrendSeries(
  seriesRows: readonly EventTrendSeriesRow[],
): MappedEventTrendSeries {
  const seriesKeyByName = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const row of seriesRows) {
    seriesKeyByName.set(
      row.eventName,
      shareTrendSeriesKey(row.eventName, usedKeys, "event"),
    );
  }
  return {
    seriesKeyByName,
    series: seriesRows.map((row) => ({
      key: seriesKeyByName.get(row.eventName)!,
      eventName: row.eventName,
      label: row.eventName,
      events: row.events,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
  };
}

export async function queryEventsTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  eventName?: string,
  options?: {
    readonly deferredQualification?: DeferredEventTrendQualification;
    readonly wholeOriginalOwner?: object;
    readonly diagnostics?: D1ReadDiagnostics;
  },
) {
  const deferred = options?.deferredQualification;
  if (deferred) {
    if (
      deferred.operation !== "event-trend" ||
      deferred.siteId !== siteId ||
      deferred.filters !== filters
    )
      throw new Error("event_trend_qualification_request_mismatch");
    const query: EventTrendQualificationQuery = {
      interval,
      limit,
      otherToken: SHARE_TREND_OTHER_TOKEN,
      otherLabel: SHARE_TREND_OTHER_LABEL,
      ...(eventName !== undefined ? { eventName } : {}),
    };
    const result = await executeEventTrendQualificationProgram({
      env,
      deferred,
      query,
      ...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
    });
    if (result.kind === "executed") {
      const seriesRows = result.rows
        .filter((row) => row.outputId === EVENT_TREND_OUTPUTS.series)
        .map(seriesRow);
      const mappedSeries = mapEventTrendSeries(seriesRows);
      const trendRows = result.rows
        .filter((row) => row.outputId === EVENT_TREND_OUTPUTS.points)
        .map((row): EventTrendPointRow => ({
          bucket: Number(row.bucket ?? -1),
          seriesKey: String(row.seriesName ?? ""),
          events: Number(row.events ?? 0),
        }));
      const [otherRow] = result.rows
        .filter((row) => row.outputId === EVENT_TREND_OUTPUTS.other)
        .map(seriesRow);
      return mapEventTrendResult(
        mappedSeries,
        trendRows,
        otherRow,
        window,
        interval,
      );
    }
    if (options?.diagnostics)
      options.diagnostics.advancedCountSqlFallbackReason =
        result.fallbackReason;
    const membership = await prepareEventMembershipFallback({
      deferred,
      operation: "event-trend",
      operations: ["event-trend"],
      configuration: {
        interval,
        limit,
        eventName: eventName ?? null,
      },
      // series, points and the optional other-series read are dependent
      // reports over the same Core evaluation.
      maxPlans: 3,
    });
    if (membership)
      return queryLegacyEventsTrendFromD1(
        env,
        siteId,
        window,
        interval,
        filters,
        limit,
        eventName,
        options?.diagnostics,
        membership,
      );
    const reportFilters =
      await prepareDeferredEventQualificationFallback(deferred);
    return queryLegacyEventsTrendFromD1(
      env,
      siteId,
      window,
      interval,
      reportFilters,
      limit,
      eventName,
      options?.diagnostics,
    );
  }
  if (options?.wholeOriginalOwner)
    return queryLegacyEventsTrendFromD1(
      env,
      siteId,
      window,
      interval,
      filters,
      limit,
      eventName,
      options.diagnostics,
      undefined,
      options.wholeOriginalOwner,
    );
  return queryLegacyEventsTrendFromD1(
    env,
    siteId,
    window,
    interval,
    filters,
    limit,
    eventName,
    options?.diagnostics,
  );
}

async function queryLegacyEventsTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  eventName?: string,
  diagnostics?: D1ReadDiagnostics,
  membership?: EventMembershipFallback,
  wholeOriginalOwner?: object,
) {
  const baseSource = trendPlanInput(siteId, window, filters);
  const eventFilter = eventName !== undefined ? { eventName } : {};
  /** Build, freeze/bind (when membership-backed) and run one dependent report. */
  const runReport = async (
    outputId: string,
    build: (source: typeof baseSource) => ValidatedLogicalPlan,
    stage: EventTrendReaderStage,
  ) => {
    const wholeBound = wholeOriginalOwner
      ? bindWholeOriginalReader({
          owner: wholeOriginalOwner,
          consumer: {
            kind: "event-trend",
            configuration: { interval, limit, ...eventFilter },
            stage,
          },
          siteId,
          filters,
          queryTime: baseSource.queryTime,
          scopePlan: baseSource.scopePlan,
          readerQueryTime: baseSource.queryTime,
        })
      : undefined;
    if (wholeOriginalOwner && !wholeBound)
      throw new Error("whole_filter_reader_consumer_mismatch");
    const bound =
      wholeBound ??
      membership?.bindPlan((context) =>
        build({
          siteId,
          queryTime: context.queryTime,
          filters,
          scopePlan: context.scopePlan,
          qualificationDependencyRefs: context.qualificationDependencyRefs,
        } as typeof baseSource),
      );
    return queryAnalyticsReportOutputRowsFromD1(
      env,
      bound?.plan ?? build(baseSource),
      outputId,
      undefined,
      diagnostics,
      bound?.executionInputs,
    );
  };
  const seriesRows = (
    await runReport(
      EVENT_TREND_OUTPUTS.series,
      (source) =>
        buildEventTrendSeriesPlan({ ...source, ...eventFilter, limit }),
      { kind: "series" },
    )
  ).map(seriesRow);
  const mappedSeries = mapEventTrendSeries(seriesRows);
  const seriesNames = seriesRows.map((row) => row.eventName);
  if (wholeOriginalOwner)
    advanceWholeOriginalEventTrend(wholeOriginalOwner, {
      kind: "series",
      rows: seriesRows,
    });
  const trendRows = (
    await runReport(
      EVENT_TREND_OUTPUTS.points,
      (source) =>
        buildEventTrendPointsPlan({
          ...source,
          ...eventFilter,
          interval,
          seriesNames,
          otherToken: SHARE_TREND_OTHER_TOKEN,
        }),
      { kind: "points", seriesNames },
    )
  ).map((row): EventTrendPointRow => ({
    bucket: Number(row.bucket ?? -1),
    seriesKey: String(row.seriesName ?? ""),
    events: Number(row.events ?? 0),
  }));
  const hasOther = trendRows.some(
    (row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN,
  );
  if (wholeOriginalOwner)
    advanceWholeOriginalEventTrend(wholeOriginalOwner, {
      kind: "points",
      rows: trendRows,
    });
  const [otherRow] = hasOther
    ? (
        await runReport(
          EVENT_TREND_OUTPUTS.other,
          (source) =>
            buildEventTrendOtherPlan({
              ...source,
              ...eventFilter,
              seriesNames,
              otherLabel: SHARE_TREND_OTHER_LABEL,
            }),
          { kind: "other", seriesNames },
        )
      ).map(seriesRow)
    : [];
  return mapEventTrendResult(
    mappedSeries,
    trendRows,
    otherRow,
    window,
    interval,
  );
}

function mapEventTrendResult(
  mappedSeries: ReturnType<typeof mapEventTrendSeries>,
  trendRows: readonly EventTrendPointRow[],
  otherRow: EventTrendSeriesRow | undefined,
  window: QueryWindow,
  interval: Interval,
) {
  const buckets = buildTimeBuckets(window, interval);
  const { series, seriesKeyByName } = mappedSeries;
  const hasOther = trendRows.some(
    (row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN,
  );
  if (hasOther) {
    series.push({
      key: SHARE_TREND_OTHER_KEY,
      eventName: SHARE_TREND_OTHER_LABEL,
      label: SHARE_TREND_OTHER_LABEL,
      events:
        Number(otherRow?.events ?? 0) ||
        trendRows
          .filter((row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN)
          .reduce((sum, row) => sum + Number(row.events ?? 0), 0),
      sessions: Number(otherRow?.sessions ?? 0),
      visitors: Number(otherRow?.visitors ?? 0),
      isOther: true,
    });
  }
  const data = buckets.map((item) => ({
    bucket: item.index,
    timestampMs: item.timestampMs,
    totalEvents: 0,
    eventsBySeries: {} as Record<string, number>,
  }));
  for (const row of trendRows) {
    const bucketIndex = Number(row.bucket ?? -1);
    const point = data[bucketIndex];
    if (!point) continue;
    const rawSeries = String(row.seriesKey ?? "");
    const key =
      rawSeries === SHARE_TREND_OTHER_TOKEN
        ? SHARE_TREND_OTHER_KEY
        : (seriesKeyByName.get(rawSeries) ?? rawSeries);
    const events = Number(row.events ?? 0);
    point.eventsBySeries[key] = events;
    point.totalEvents += events;
  }
  return { series, data };
}

import {
  bindWholeOriginalEventDetailReader,
  type WholeOriginalEventDetailMembership,
} from "./whole-filter-reader-preparation";

export async function queryEventTypeTrendFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  eventName: string,
  membership?: EventMembershipFallback,
  wholeOriginalDetail?: WholeOriginalEventDetailMembership,
) {
  const source = trendPlanInput(siteId, window, filters);
  const bound = membership?.bindPlan((context) =>
    buildEventTypeTrendPlan({
      siteId,
      queryTime: context.queryTime,
      filters,
      scopePlan: context.scopePlan,
      qualificationDependencyRefs: context.qualificationDependencyRefs,
      eventName,
      interval,
    }),
  );
  const wholeDetail =
    !bound && wholeOriginalDetail
      ? bindWholeOriginalEventDetailReader({
          membership: wholeOriginalDetail,
          child: "trend",
          siteId,
          filters,
          queryTime: source.queryTime,
          readerQueryTime: source.queryTime,
          scopePlan: source.scopePlan,
        })
      : undefined;
  const rows = (
    await queryAnalyticsReportOutputRowsFromD1(
      env,
      bound?.plan ??
        wholeDetail?.plan ??
        buildEventTypeTrendPlan({ ...source, eventName, interval }),
      EVENT_TREND_OUTPUTS.typePoints,
      undefined,
      undefined,
      bound?.executionInputs ?? wholeDetail?.executionInputs,
    )
  ).map((row): EventTypeTrendPointRow => ({
    bucket: Number(row.bucket ?? -1),
    events: Number(row.events ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  const buckets = buildTimeBuckets(window, interval);
  const data = buckets.map((item) => ({
    bucket: item.index,
    timestampMs: item.timestampMs,
    events: 0,
    visitors: 0,
  }));
  for (const row of rows) {
    const bucketIndex = Number(row.bucket ?? -1);
    const point = data[bucketIndex];
    if (!point) continue;
    point.events = Number(row.events ?? 0);
    point.visitors = Number(row.visitors ?? 0);
  }
  return { data };
}
