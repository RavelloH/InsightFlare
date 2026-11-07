import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import { EVENT_CONTEXT_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/event-context-report-plan";
import { EVENT_TREND_OUTPUTS } from "@/lib/edge/analytics/engine/event-trend-plan";
import { EVENT_TYPE_OVERVIEW_OUTPUTS } from "@/lib/edge/analytics/engine/event-type-overview-plan";
import type { Env } from "@/lib/edge/types";

import type { DeferredEventTypeDetailQualification } from "./advanced-filter-execution";
import {
  type EventTypeDetailQualificationQuery,
  executeEventTypeDetailQualificationProgram,
} from "./analytics-qualification-program";
import type {
  DimensionRow,
  EventAnalyticsContextCards,
  FilterDocument,
  Interval,
  QueryWindow,
} from "./core";
import { buildTimeBuckets } from "./core-time";
import type { D1ReadDiagnostics } from "./diagnostics";
import { EVENT_CONTEXT_CARD_KEYS, mapContextCardRows } from "./events-context";

const EVENT_TYPE_DETAIL_CONTEXT_LIMIT = 100;

export interface EventTypeDetailQualifiedReports {
  readonly summary: {
    readonly events: number;
    readonly eventTypes: number;
    readonly sessions: number;
    readonly visitors: number;
    readonly avgEventsPerSession: number;
    readonly shareOfAllEvents: number;
  };
  readonly trend: {
    readonly data: readonly {
      readonly bucket: number;
      readonly timestampMs: number;
      readonly events: number;
      readonly visitors: number;
    }[];
  };
  readonly breakdowns: {
    readonly pages: readonly DimensionRow[];
    readonly countries: readonly DimensionRow[];
    readonly devices: readonly DimensionRow[];
    readonly browsers: readonly DimensionRow[];
  };
  readonly cards: EventAnalyticsContextCards;
}

export type EventTypeDetailQualificationResult =
  | {
      readonly kind: "executed";
      readonly reports: EventTypeDetailQualifiedReports;
    }
  | {
      readonly kind: "fallback";
      readonly fallbackReason: NonNullable<
        D1ReadDiagnostics["advancedCountSqlFallbackReason"]
      >;
    };

function contextQueryTimeMatchesWindow(
  time: QueryTime,
  window: QueryWindow,
): boolean {
  return (
    time.range.startMs === window.startMs &&
    time.range.endExclusiveMs === window.endExclusiveMs &&
    time.capturedAtMs === window.nowMs &&
    time.reportingTimeZone === window.timeZone
  );
}

function assertDeferredRequestMatches(input: {
  readonly deferred: DeferredEventTypeDetailQualification;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly window: QueryWindow;
  readonly query: EventTypeDetailQualificationQuery;
}): void {
  const { deferred, siteId, filters, window, query } = input;
  const prepared = deferred.eventTypeDetailRequest;
  const deferredTime = deferred.time;
  if (
    deferred.operation !== "event-type-detail" ||
    deferred.siteId !== siteId ||
    deferred.filters !== filters ||
    !prepared ||
    prepared.eventName !== query.eventName ||
    prepared.interval !== query.interval ||
    prepared.includeBreakdowns !== query.includeBreakdowns ||
    prepared.includeContext !== query.includeContext ||
    prepared.contextLimit !==
      (query.contextLimit ?? EVENT_TYPE_DETAIL_CONTEXT_LIMIT) ||
    prepared.selectedKeys.length !==
      (query.selectedKeys ?? EVENT_CONTEXT_CARD_KEYS).length ||
    prepared.selectedKeys.some(
      (key, index) =>
        key !== (query.selectedKeys ?? EVENT_CONTEXT_CARD_KEYS)[index],
    ) ||
    !contextQueryTimeMatchesWindow(deferredTime, window) ||
    deferred.metadata.plan.scope !== deferred.countInput.scope ||
    deferred.metadata.siteIds.length !== 1 ||
    deferred.metadata.siteIds[0] !== siteId ||
    deferred.countInput.subject.siteIds.length !== 1 ||
    deferred.countInput.subject.siteIds[0] !== siteId ||
    deferred.countInput.candidateRange.startMs !== deferredTime.range.startMs ||
    deferred.countInput.candidateRange.endExclusiveMs !==
      deferredTime.range.endExclusiveMs ||
    deferred.countInput.readRange.startMs !== deferredTime.range.startMs ||
    deferred.countInput.readRange.endExclusiveMs !==
      deferredTime.range.endExclusiveMs ||
    deferred.countInput.capturedAtMs !== deferredTime.capturedAtMs ||
    deferred.countInput.reportingTimeZone !== deferredTime.reportingTimeZone
  )
    throw new Error("event_type_detail_qualification_request_mismatch");
}

function readDimensionRows(
  rows: readonly Record<string, unknown>[],
  outputId: string,
): DimensionRow[] {
  return rows
    .filter((row) => row.outputId === outputId)
    .map((row) => ({
      value: String(row.value ?? ""),
      views: Number(row.events ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    }));
}

function mapReports(
  rows: readonly Record<string, unknown>[],
  window: QueryWindow,
  interval: Interval,
  includeContext: boolean,
): EventTypeDetailQualifiedReports {
  const summary = rows.find(
    (row) => row.outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
  );
  if (!summary)
    throw new Error("event_type_detail_qualification_summary_missing");
  const events = Number(summary.events ?? 0);
  const sessions = Number(summary.sessions ?? 0);
  const scopedEvents = Number(summary.scopedEvents ?? 0);
  const buckets = buildTimeBuckets(window, interval);
  const trendData = buckets.map((bucket) => ({
    bucket: bucket.index,
    timestampMs: bucket.timestampMs,
    events: 0,
    visitors: 0,
  }));
  for (const row of rows) {
    if (row.outputId !== EVENT_TREND_OUTPUTS.typePoints) continue;
    const bucketIndex = Number(row.bucket ?? -1);
    const point = trendData[bucketIndex];
    if (!point) continue;
    point.events = Number(row.events ?? 0);
    point.visitors = Number(row.visitors ?? 0);
  }
  const contextRows = includeContext
    ? rows.filter((row) => row.outputId === EVENT_CONTEXT_REPORT_OUTPUT)
    : [];
  return {
    summary: {
      events,
      eventTypes: Number(summary.eventTypes ?? 0),
      sessions,
      visitors: Number(summary.visitors ?? 0),
      avgEventsPerSession: sessions > 0 ? events / sessions : 0,
      shareOfAllEvents: scopedEvents > 0 ? events / scopedEvents : 0,
    },
    trend: { data: trendData },
    breakdowns: {
      pages: readDimensionRows(rows, EVENT_TYPE_OVERVIEW_OUTPUTS.page),
      countries: readDimensionRows(rows, EVENT_TYPE_OVERVIEW_OUTPUTS.country),
      devices: readDimensionRows(rows, EVENT_TYPE_OVERVIEW_OUTPUTS.device),
      browsers: readDimensionRows(rows, EVENT_TYPE_OVERVIEW_OUTPUTS.browser),
    },
    cards: mapContextCardRows(contextRows),
  };
}

/** Runs all event-type detail reports under one validated qualification query. */
export async function queryEventTypeDetailQualificationFromD1(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly eventName: string;
  readonly interval: Interval;
  readonly includeBreakdowns: boolean;
  readonly includeContext: boolean;
  readonly deferred: DeferredEventTypeDetailQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<EventTypeDetailQualificationResult> {
  const query: EventTypeDetailQualificationQuery = {
    eventName: input.eventName,
    interval: input.interval,
    includeBreakdowns: input.includeBreakdowns,
    includeContext: input.includeContext,
    contextLimit: EVENT_TYPE_DETAIL_CONTEXT_LIMIT,
    selectedKeys: EVENT_CONTEXT_CARD_KEYS,
  };
  assertDeferredRequestMatches({
    deferred: input.deferred,
    siteId: input.siteId,
    filters: input.filters,
    window: input.window,
    query,
  });
  const result = await executeEventTypeDetailQualificationProgram({
    env: input.env,
    deferred: input.deferred,
    query,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  if (result.kind === "executed")
    return {
      kind: "executed",
      reports: mapReports(
        result.rows,
        input.window,
        input.interval,
        input.includeContext,
      ),
    };
  if (input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = result.fallbackReason;
  return { kind: "fallback", fallbackReason: result.fallbackReason };
}
