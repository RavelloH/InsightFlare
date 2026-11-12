import { scopedFilterMetadata } from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import {
  buildEventContextReportPlan,
  EVENT_CONTEXT_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/event-context-report-plan";
import {
  EVENT_CONTEXT_CARD_KEYS,
  EVENT_CONTEXT_CARDS,
  type EventContextCardKey,
} from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import type { Env } from "@/lib/edge/types";

import type { DeferredEventContextQualification } from "./advanced-filter-execution";
import { prepareDeferredEventQualificationFallback } from "./advanced-filter-execution";
import {
  type EventContextQualificationQuery,
  executeEventContextQualificationProgram,
} from "./analytics-qualification-program";
import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import type {
  DimensionRow,
  EventAnalyticsContextCards,
  FilterDocument,
  GeoTabRow,
  QueryWindow,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  type EventMembershipFallback,
  type EventMembershipFallbackPlan,
  prepareEventMembershipFallbackPlan,
} from "./event-membership-fallback";

export { EVENT_CONTEXT_CARD_KEYS };
export type { EventContextCardKey };

export interface EventContextQueryOptions {
  readonly deferredQualification?: DeferredEventContextQualification;
  /** Request-private Event membership shared with the other type-detail reports. */
  readonly membership?: EventMembershipFallback;
  readonly diagnostics?: D1ReadDiagnostics;
}

function emptyCards(): EventAnalyticsContextCards {
  return {
    page: {
      path: [],
      query: [],
      title: [],
      hostname: [],
      entry: [],
      exit: [],
    },
    source: { domain: [], link: [] },
    client: {
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    },
    geo: {
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    },
  };
}

export function mapContextCardRows(
  rows: readonly Record<string, unknown>[],
): EventAnalyticsContextCards {
  const cards = emptyCards();
  for (const row of rows) {
    const key = String(row.cardType ?? "") as EventContextCardKey;
    if (!Object.hasOwn(EVENT_CONTEXT_CARDS, key)) continue;
    const dimension: DimensionRow = {
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    };
    const geo: GeoTabRow = {
      ...dimension,
      label: String(row.label ?? row.value ?? ""),
    };
    switch (key) {
      case "path":
      case "query":
      case "title":
      case "hostname":
      case "entry":
      case "exit":
        cards.page[key] = [...cards.page[key], dimension];
        break;
      case "sourceDomain":
        cards.source.domain.push(dimension);
        break;
      case "sourceLink":
        cards.source.link.push(dimension);
        break;
      case "browser":
      case "osVersion":
      case "deviceType":
      case "language":
      case "screenSize":
        cards.client[key].push(dimension);
        break;
      case "country":
      case "region":
      case "city":
      case "continent":
      case "timezone":
      case "organization":
        cards.geo[key].push(geo);
        break;
    }
  }
  return cards;
}

function canonicalSelectedKeys(
  selectedKeys: readonly EventContextCardKey[],
): EventContextCardKey[] {
  const selected = new Set(selectedKeys);
  return EVENT_CONTEXT_CARD_KEYS.filter((key) => selected.has(key));
}

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

async function queryLegacyEventContextRowsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  eventName: string | undefined,
  selectedKeys: readonly EventContextCardKey[],
  diagnostics?: D1ReadDiagnostics,
): Promise<Record<string, unknown>[]> {
  const metadata = scopedFilterMetadata(filters);
  const plan = buildEventContextReportPlan({
    siteId,
    queryTime: queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    ...(eventName !== undefined ? { eventName } : {}),
    limit,
    selectedKeys,
  });
  return queryAnalyticsReportOutputRowsFromD1(
    env,
    plan,
    EVENT_CONTEXT_REPORT_OUTPUT,
    undefined,
    diagnostics,
  );
}

/** Reads Event-owner context cards in one validated Logical D1 query. */
export async function queryEventAnalyticsContextCardsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  eventName?: string,
  selectedKeys: readonly EventContextCardKey[] = EVENT_CONTEXT_CARD_KEYS,
  options?: EventContextQueryOptions,
): Promise<EventAnalyticsContextCards> {
  const selected = canonicalSelectedKeys(selectedKeys);
  if (selected.length === 0) return emptyCards();
  let reportFilters = filters;
  let rows: Record<string, unknown>[] | undefined;
  let membership: EventMembershipFallbackPlan | undefined;
  const deferred = options?.deferredQualification;
  if (deferred) {
    const request: EventContextQualificationQuery = {
      limit,
      selectedKeys: selected,
      ...(eventName !== undefined ? { eventName } : {}),
    };
    const preparedRequest = deferred.eventContextRequest;
    const deferredTime = deferred.time;
    if (
      deferred.operation !== "event-context" ||
      deferred.siteId !== siteId ||
      deferred.filters !== filters ||
      !preparedRequest ||
      preparedRequest.eventName !== (eventName ?? "") ||
      preparedRequest.limit !== limit ||
      preparedRequest.selectedKeys.length !== selected.length ||
      preparedRequest.selectedKeys.some(
        (key, index) => key !== selected[index],
      ) ||
      !contextQueryTimeMatchesWindow(deferredTime, window) ||
      deferred.metadata.plan.scope !== deferred.countInput.scope ||
      deferred.metadata.siteIds.length !== 1 ||
      deferred.metadata.siteIds[0] !== siteId ||
      deferred.countInput.subject.siteIds.length !== 1 ||
      deferred.countInput.subject.siteIds[0] !== siteId ||
      deferred.countInput.candidateRange.startMs !==
        deferredTime.range.startMs ||
      deferred.countInput.candidateRange.endExclusiveMs !==
        deferredTime.range.endExclusiveMs ||
      deferred.countInput.readRange.startMs !== deferredTime.range.startMs ||
      deferred.countInput.readRange.endExclusiveMs !==
        deferredTime.range.endExclusiveMs ||
      deferred.countInput.capturedAtMs !== deferredTime.capturedAtMs ||
      deferred.countInput.reportingTimeZone !== deferredTime.reportingTimeZone
    )
      throw new Error("event_context_qualification_request_mismatch");
    const result = await executeEventContextQualificationProgram({
      env,
      deferred,
      query: request,
      ...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
    });
    if (result.kind === "executed") {
      rows = [...result.rows];
    } else {
      if (options?.diagnostics)
        options.diagnostics.advancedCountSqlFallbackReason =
          result.fallbackReason;
      membership = await prepareEventMembershipFallbackPlan({
        deferred,
        operation: "event-context",
        operations: ["event-context"],
        configuration: {
          limit,
          eventName: eventName ?? null,
          selectedKeys: selected,
        },
        withPageVisits: selected.some(
          (key) => EVENT_CONTEXT_CARDS[key].kind === "session-boundary",
        ),
        buildPlan: (context) =>
          buildEventContextReportPlan({
            siteId,
            queryTime: context.queryTime,
            filters,
            scopePlan: context.scopePlan,
            qualificationDependencyRefs: context.qualificationDependencyRefs,
            ...(context.pageVisitDependencyRefs.length > 0
              ? { pageVisitDependencyRefs: context.pageVisitDependencyRefs }
              : {}),
            ...(eventName !== undefined ? { eventName } : {}),
            limit,
            selectedKeys: selected,
          }),
      });
      if (!membership)
        reportFilters =
          await prepareDeferredEventQualificationFallback(deferred);
    }
  }
  if (!rows && options?.membership) {
    const bound = options.membership.bindPlan((context) =>
      buildEventContextReportPlan({
        siteId,
        queryTime: context.queryTime,
        filters,
        scopePlan: context.scopePlan,
        qualificationDependencyRefs: context.qualificationDependencyRefs,
        ...(context.pageVisitDependencyRefs.length > 0
          ? { pageVisitDependencyRefs: context.pageVisitDependencyRefs }
          : {}),
        ...(eventName !== undefined ? { eventName } : {}),
        limit,
        selectedKeys: selected,
      }),
    );
    rows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      bound.plan,
      EVENT_CONTEXT_REPORT_OUTPUT,
      undefined,
      options.diagnostics,
      bound.executionInputs,
    );
  }
  if (!rows && membership)
    rows = await queryAnalyticsReportOutputRowsFromD1(
      env,
      membership.plan,
      EVENT_CONTEXT_REPORT_OUTPUT,
      undefined,
      options?.diagnostics,
      membership.executionInputs,
    );
  if (!rows)
    rows = await queryLegacyEventContextRowsFromD1(
      env,
      siteId,
      window,
      reportFilters,
      limit,
      eventName,
      selected,
      options?.diagnostics,
    );
  return mapContextCardRows(rows);
}
