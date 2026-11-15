import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import {
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import { buildEventRecordDetailPlan } from "@/lib/edge/analytics/engine/event-record-detail-plan";
import type { EventRecordPageOptions } from "@/lib/edge/analytics/engine/event-record-page-plan";
import {
  buildEventRecordPagePlan,
  type EventRecordPageCursor,
} from "@/lib/edge/analytics/engine/event-record-page-plan";
import type { DeferredEventRecordsQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { readCustomEventDetail } from "@/lib/edge/analytics/providers/d1/internal/custom-event-read";
import type { Env } from "@/lib/edge/types";

import {
  type EventRecordsQualificationCompilationEvidence,
  executeEventRecordsQualificationProgram,
} from "./analytics-event-record-qualification-program";
import type {
  EventRecordRow,
  EventRecordSortKey,
  FilterDocument,
  ListSort,
  QueryWindow,
} from "./core";
import { mapEventRecord } from "./core";
import { mapVisitPerformanceMetrics } from "./core-performance";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import { prepareEventMembershipFallbackPlan } from "./event-membership-fallback";
import {
  type EventRecordDetailOutputRow,
  type EventRecordDetailRow,
  queryEventRecordDetailOutputRowsFromD1,
} from "./event-record-detail-output";
import {
  EVENT_RECORD_PAGE_OUTPUT_TYPES,
  type EventRecordPageCursorRow,
  type EventRecordPageOutputRow,
  queryEventRecordPageOutputRowsFromD1,
} from "./event-record-page-output";
import { bindWholeOriginalReader } from "./whole-filter-reader-preparation";

export type EventRecordCursor = EventRecordPageCursor;

export interface EventRecordPage {
  rows: EventRecordRow[];
  nextCursor: EventRecordCursor | null;
}

function eventRecordCursorFromRow(
  row: EventRecordPageCursorRow,
  sort: ListSort<EventRecordSortKey>,
): EventRecordCursor {
  return sort.key === "occurredAt"
    ? {
        occurredAt: row.occurredAt,
        eventId: row.eventId,
        eventPk: row.eventPk,
      }
    : {
        sortValue: sort.key === "eventName" ? row.eventName : row.pathname,
        occurredAt: row.occurredAt,
        eventId: row.eventId,
        eventPk: row.eventPk,
      };
}

function withoutEventPk(row: EventRecordPageCursorRow): EventRecordRow {
  const { eventPk: _eventPk, ...event } = row;
  return event;
}

function preserveEventRecordPageOutput(
  row: EventRecordPageOutputRow,
): EventRecordPageCursorRow {
  // The output adapter verified aliases and Semantic slot types before the
  // query ran. Keep SQLite's raw runtime values for the existing DTO mapper.
  return row as unknown as EventRecordPageCursorRow;
}

function eventRecordPageFromOutputRows(
  rawRows: readonly EventRecordPageOutputRow[],
  options: Pick<EventRecordPageOptions, "limit" | "sort">,
): EventRecordPage {
  const rows = rawRows.map(preserveEventRecordPageOutput);
  const hasMore = rows.length > options.limit;
  const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
  const lastRow = pageRows.at(-1);
  return {
    rows: pageRows.map(withoutEventPk),
    nextCursor:
      hasMore && lastRow
        ? eventRecordCursorFromRow(lastRow, options.sort)
        : null,
  };
}

export async function queryEventRecordPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  options: {
    limit: number;
    sort: ListSort<EventRecordSortKey>;
    search?: string;
    eventName?: string;
    cursor?: EventRecordCursor | null;
    scopePlan?: ScopedFilterPlan;
    queryTime?: QueryTime;
    wholeOriginalOwner?: object;
  },
): Promise<EventRecordPage> {
  const preparedMetadata = scopedFilterMetadata(filters);
  const scopePlan = options.scopePlan ?? preparedMetadata?.plan;
  const preparedTime = preparedMetadata?.time;
  const queryTime =
    options.queryTime ??
    preparedTime ??
    createQueryTime(
      window.startMs,
      window.endExclusiveMs,
      window.timeZone,
      window.nowMs,
    );
  const wholeOriginal = options.wholeOriginalOwner
    ? bindWholeOriginalReader({
        owner: options.wholeOriginalOwner,
        consumer: {
          kind: "event-records",
          configuration: {
            limit: options.limit,
            sort: options.sort,
            ...(options.search !== undefined ? { search: options.search } : {}),
            ...(options.eventName !== undefined
              ? { eventName: options.eventName }
              : {}),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          },
        },
        siteId,
        filters,
        queryTime: preparedTime ?? queryTime,
        readerQueryTime: queryTime,
        scopePlan,
      })
    : undefined;
  const plan =
    wholeOriginal?.plan ??
    buildEventRecordPagePlan({
      siteId,
      queryTime,
      filters,
      ...(scopePlan ? { scopePlan } : {}),
      options,
    });
  const rawRows = await queryEventRecordPageOutputRowsFromD1(
    env,
    plan,
    ...(wholeOriginal
      ? ([wholeOriginal.executionInputs] as const)
      : ([] as const)),
  );
  return eventRecordPageFromOutputRows(rawRows, options);
}

/**
 * Runs the private single-site numeric fallback of the Event records page
 * through a request-private Event membership. Returns undefined, before any
 * Core evaluation, when the request is outside that slice.
 */
export async function queryEventRecordPageWithMembershipFromD1(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly deferred: DeferredEventRecordsQualification;
  readonly options: EventRecordPageOptions;
  readonly cursorToken: string | null;
  readonly audience: string;
}): Promise<EventRecordPage | undefined> {
  const { deferred, options } = input;
  const membership = await prepareEventMembershipFallbackPlan({
    deferred,
    operation: "event-records",
    operations: ["event-records"],
    configuration: {
      limit: options.limit,
      sort: options.sort,
      search: options.search ?? null,
      eventName: options.eventName ?? null,
      cursor: input.cursorToken,
      audience: input.audience,
    },
    buildPlan: (context) =>
      buildEventRecordPagePlan({
        siteId: input.siteId,
        queryTime: context.queryTime,
        filters: deferred.filters,
        scopePlan: context.scopePlan,
        qualificationDependencyRefs: context.qualificationDependencyRefs,
        options,
      }),
  });
  if (!membership) return undefined;
  const rawRows = await queryEventRecordPageOutputRowsFromD1(
    input.env,
    membership.plan,
    membership.executionInputs,
  );
  return eventRecordPageFromOutputRows(rawRows, options);
}

export type QualifiedEventRecordPageExecution =
  | {
      readonly kind: "executed";
      readonly page: EventRecordPage;
      readonly evidence: EventRecordsQualificationCompilationEvidence;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

export async function queryQualifiedEventRecordPageFromD1(input: {
  readonly env: Env;
  readonly deferred: DeferredEventRecordsQualification;
  readonly options: EventRecordPageOptions;
  readonly cursorToken: string | null;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<QualifiedEventRecordPageExecution> {
  const result = await executeEventRecordsQualificationProgram(input);
  if (result.kind !== "executed") return result;
  const fields = Object.keys(EVENT_RECORD_PAGE_OUTPUT_TYPES);
  const outputRows = result.rows.map((row) =>
    Object.fromEntries(fields.map((field) => [field, row[field]])),
  ) as unknown as EventRecordPageOutputRow[];
  return {
    kind: "executed",
    page: eventRecordPageFromOutputRows(outputRows, input.options),
    evidence: result.evidence,
  };
}
export async function queryEventRecordDetailFromD1(
  env: Env,
  siteId: string,
  eventId: string,
  window?: QueryWindow,
) {
  const rows = await queryEventRecordDetailOutputRowsFromD1(
    env,
    buildEventRecordDetailPlan({ siteId, eventId, window }),
  );
  const rawRecord = rows[0];
  if (!rawRecord) return null;
  const record = preserveEventRecordDetailOutput(rawRecord);
  const detail = await readCustomEventDetail(env, siteId, eventId);
  return {
    event: { ...mapEventRecord(record), eventKind: "custom_event" as const },
    context: {
      visitId: record.visitId,
      sessionId: record.sessionId,
      visitorId: record.visitorId,
      userId: record.userId,
      userName: record.userName,
      pathname: record.pathname,
      queryString: record.queryString,
      hash: record.hash,
      title: record.title,
      hostname: record.hostname,
      referrerUrl: record.referrerUrl,
      referrerHost: record.referrerHost,
      utmSource: record.utmSource,
      utmMedium: record.utmMedium,
      utmCampaign: record.utmCampaign,
      utmTerm: record.utmTerm,
      utmContent: record.utmContent,
      isEU: record.isEU === true || record.isEU === 1 || record.isEU === "1",
      country: record.country,
      region: record.region,
      regionCode: record.regionCode,
      city: record.city,
      continent: record.continent,
      latitude: record.latitude,
      longitude: record.longitude,
      postalCode: record.postalCode,
      metroCode: record.metroCode,
      timezone: record.timezone,
      organization: record.organization,
      browser: record.browser,
      browserVersion: record.browserVersion,
      os: record.os,
      osVersion: record.osVersion,
      deviceType: record.deviceType,
      userAgent: record.userAgent,
      language: record.language,
      screenWidth: record.screenWidth,
      screenHeight: record.screenHeight,
      status: record.status,
      startedAt: record.startedAt,
      previousVisitId: record.previousVisitId,
      previousVisitStartedAt: record.previousVisitStartedAt,
      lastActivityAt: record.lastActivityAt,
      endedAt: record.endedAt,
      finalizedAt: record.finalizedAt,
      durationMs: record.durationMs,
      durationSource: record.durationSource,
      exitReason: record.exitReason,
      performance: mapVisitPerformanceMetrics({
        perfTtfbMs: record.perfTtfbMs,
        perfFcpMs: record.perfFcpMs,
        perfLcpMs: record.perfLcpMs,
        perfCls: record.perfCls,
        perfInpMs: record.perfInpMs,
      }),
    },
    eventData: detail?.eventData ?? {},
  };
}

function preserveEventDetailOutputColumn<K extends keyof EventRecordDetailRow>(
  row: EventRecordDetailOutputRow,
  key: K,
): EventRecordDetailRow[K] {
  // The selected output aliases and logical slot metadata were checked before
  // execution. This bridge preserves raw SQLite values for the legacy mapper;
  // it does not decode, validate storage classes, default, or coerce values.
  return row[key] as EventRecordDetailRow[K];
}

function preserveEventRecordDetailOutput(
  row: EventRecordDetailOutputRow,
): EventRecordDetailRow {
  return {
    eventId: preserveEventDetailOutputColumn(row, "eventId"),
    eventName: preserveEventDetailOutputColumn(row, "eventName"),
    occurredAt: preserveEventDetailOutputColumn(row, "occurredAt"),
    receivedAt: preserveEventDetailOutputColumn(row, "receivedAt"),
    sequence: preserveEventDetailOutputColumn(row, "sequence"),
    visitId: preserveEventDetailOutputColumn(row, "visitId"),
    sessionId: preserveEventDetailOutputColumn(row, "sessionId"),
    visitorId: preserveEventDetailOutputColumn(row, "visitorId"),
    userId: preserveEventDetailOutputColumn(row, "userId"),
    userName: preserveEventDetailOutputColumn(row, "userName"),
    status: preserveEventDetailOutputColumn(row, "status"),
    startedAt: preserveEventDetailOutputColumn(row, "startedAt"),
    previousVisitId: preserveEventDetailOutputColumn(row, "previousVisitId"),
    previousVisitStartedAt: preserveEventDetailOutputColumn(
      row,
      "previousVisitStartedAt",
    ),
    lastActivityAt: preserveEventDetailOutputColumn(row, "lastActivityAt"),
    endedAt: preserveEventDetailOutputColumn(row, "endedAt"),
    finalizedAt: preserveEventDetailOutputColumn(row, "finalizedAt"),
    durationMs: preserveEventDetailOutputColumn(row, "durationMs"),
    durationSource: preserveEventDetailOutputColumn(row, "durationSource"),
    exitReason: preserveEventDetailOutputColumn(row, "exitReason"),
    pathname: preserveEventDetailOutputColumn(row, "pathname"),
    queryString: preserveEventDetailOutputColumn(row, "queryString"),
    hash: preserveEventDetailOutputColumn(row, "hash"),
    title: preserveEventDetailOutputColumn(row, "title"),
    hostname: preserveEventDetailOutputColumn(row, "hostname"),
    referrerUrl: preserveEventDetailOutputColumn(row, "referrerUrl"),
    referrerHost: preserveEventDetailOutputColumn(row, "referrerHost"),
    utmSource: preserveEventDetailOutputColumn(row, "utmSource"),
    utmMedium: preserveEventDetailOutputColumn(row, "utmMedium"),
    utmCampaign: preserveEventDetailOutputColumn(row, "utmCampaign"),
    utmTerm: preserveEventDetailOutputColumn(row, "utmTerm"),
    utmContent: preserveEventDetailOutputColumn(row, "utmContent"),
    isEU: preserveEventDetailOutputColumn(row, "isEU"),
    country: preserveEventDetailOutputColumn(row, "country"),
    region: preserveEventDetailOutputColumn(row, "region"),
    regionCode: preserveEventDetailOutputColumn(row, "regionCode"),
    city: preserveEventDetailOutputColumn(row, "city"),
    continent: preserveEventDetailOutputColumn(row, "continent"),
    latitude: preserveEventDetailOutputColumn(row, "latitude"),
    longitude: preserveEventDetailOutputColumn(row, "longitude"),
    postalCode: preserveEventDetailOutputColumn(row, "postalCode"),
    metroCode: preserveEventDetailOutputColumn(row, "metroCode"),
    timezone: preserveEventDetailOutputColumn(row, "timezone"),
    organization: preserveEventDetailOutputColumn(row, "organization"),
    browser: preserveEventDetailOutputColumn(row, "browser"),
    browserVersion: preserveEventDetailOutputColumn(row, "browserVersion"),
    os: preserveEventDetailOutputColumn(row, "os"),
    osVersion: preserveEventDetailOutputColumn(row, "osVersion"),
    deviceType: preserveEventDetailOutputColumn(row, "deviceType"),
    userAgent: preserveEventDetailOutputColumn(row, "userAgent"),
    language: preserveEventDetailOutputColumn(row, "language"),
    screenWidth: preserveEventDetailOutputColumn(row, "screenWidth"),
    screenHeight: preserveEventDetailOutputColumn(row, "screenHeight"),
    perfTtfbMs: preserveEventDetailOutputColumn(row, "perfTtfbMs"),
    perfFcpMs: preserveEventDetailOutputColumn(row, "perfFcpMs"),
    perfLcpMs: preserveEventDetailOutputColumn(row, "perfLcpMs"),
    perfCls: preserveEventDetailOutputColumn(row, "perfCls"),
    perfInpMs: preserveEventDetailOutputColumn(row, "perfInpMs"),
    nodeCount: preserveEventDetailOutputColumn(row, "nodeCount"),
    valueCount: preserveEventDetailOutputColumn(row, "valueCount"),
  };
}
