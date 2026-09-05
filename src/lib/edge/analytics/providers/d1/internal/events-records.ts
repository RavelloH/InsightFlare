import {
  EMPTY_FILTER_DOCUMENT,
  type ScopedDatasetSql,
} from "@/lib/edge/analytics/contract";
import { readCustomEventDetail } from "@/lib/edge/custom-event-read";
import { SITE_PK_FROM_SITE_ID_SQL } from "@/lib/edge/site-identity-sql";
import type { Env } from "@/lib/edge/types";

import type {
  EventRecordRow,
  EventRecordSortKey,
  FilterDocument,
  ListSort,
  QueryWindow,
} from "./core";
import {
  buildEventAnalyticsSourceCte,
  buildEventFilterSql,
  buildVisitSourceCte,
  eventRecordOrderBy,
  eventSourceBindings,
  mapEventRecord,
  queryD1All,
  visitSourceBindings,
} from "./core";
import { mapVisitPerformanceMetrics } from "./core-performance";
import { scopedDatasetFor } from "./scoped-dataset";

// Event-record lists only need this projection for their output, filters, and
// cursor predicates. Keeping it explicit prevents the shared analytics source
// from carrying unrelated visit columns through every page query.
const EVENT_RECORD_BASE_SOURCE_COLUMNS = [
  "ce.event_pk",
  "ce.event_id",
  "ce.site_pk",
  "ce.visit_id",
  "cen.name AS event_name",
  "ce.occurred_at",
  "ce.received_at",
  "ce.sequence",
  "ce.node_count",
  "ce.value_count",
  "v.visitor_id",
  "v.session_id",
  "v.pathname",
  "v.hostname",
  "v.title",
  "v.referrer_host",
  "v.country",
  "v.region",
  "v.city",
  "v.browser",
  "v.browser_version",
  "v.os",
  "v.os_version",
  "v.device_type",
] as const;

const EVENT_RECORD_FILTER_SOURCE_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  "page.query": ["v.query_string"],
  "page.hash": ["v.hash_fragment"],
  "referrer.url": ["v.referrer_url"],
  "utm.source": ["v.utm_source"],
  "utm.medium": ["v.utm_medium"],
  "utm.campaign": ["v.utm_campaign"],
  "utm.term": ["v.utm_term"],
  "utm.content": ["v.utm_content"],
  "traffic.channel": [
    "v.utm_source",
    "v.utm_medium",
    "v.utm_campaign",
    "v.utm_term",
    "v.utm_content",
  ],
  "client.language": ["v.language"],
  "client.screenSize": ["v.screen_width", "v.screen_height"],
  "geo.city": ["v.city"],
  "geo.continent": ["v.continent"],
  "geo.timeZone": ["v.timezone"],
  "geo.organization": ["v.as_organization"],
};

function eventRecordSourceColumns(filters: FilterDocument): string {
  const columns = new Set<string>(EVENT_RECORD_BASE_SOURCE_COLUMNS);
  const collect = (expression: FilterDocument["root"]): void => {
    if (!expression) return;
    if (expression.kind === "condition") {
      if (expression.target.kind === "field") {
        for (const column of EVENT_RECORD_FILTER_SOURCE_COLUMNS[
          expression.target.field
        ] ?? []) {
          columns.add(column);
        }
      }
      return;
    }
    if (expression.kind === "not") {
      collect(expression.child);
      return;
    }
    for (const child of expression.children) collect(child);
  };
  collect(filters.root);
  return [...columns].join(",\n    ");
}

export interface EventRecordCursor {
  readonly sortValue?: string | number;
  occurredAt: number;
  eventId: string;
  eventPk: number;
}

interface EventRecordCursorRow extends EventRecordRow {
  eventPk: number;
}

interface EventRecordDetailRow extends EventRecordRow {
  userId: string;
  userName: string;
  queryString: string;
  hash: string;
  referrerUrl: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  isEU: number | boolean | string | null;
  regionCode: string;
  city: string;
  continent: string;
  latitude: number | null;
  longitude: number | null;
  postalCode: string;
  metroCode: string;
  timezone: string;
  organization: string;
  language: string;
  userAgent: string;
  screenWidth: number | null;
  screenHeight: number | null;
  status: string;
  startedAt: number;
  previousVisitId: string;
  previousVisitStartedAt: number | null;
  lastActivityAt: number;
  endedAt: number | null;
  finalizedAt: number | null;
  durationMs: number | null;
  durationSource: string;
  exitReason: string;
  perfTtfbMs: number | null;
  perfFcpMs: number | null;
  perfLcpMs: number | null;
  perfCls: number | null;
  perfInpMs: number | null;
}

export interface EventRecordPage {
  rows: EventRecordRow[];
  nextCursor: EventRecordCursor | null;
}

function eventRecordCursorFromRow(
  row: EventRecordCursorRow,
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

function eventRecordCursorFilter(
  cursor: EventRecordCursor,
  sort: ListSort<EventRecordSortKey>,
): { clause: string; bindings: Array<string | number> } {
  if (sort.key === "occurredAt") {
    const operator = sort.direction === "asc" ? ">" : "<";
    return {
      clause: `
        AND (
          occurred_at ${operator} ?
          OR (
            occurred_at = ? AND (
              event_id ${operator} ?
              OR (event_id = ? AND event_pk ${operator} ?)
            )
          )
        )`,
      bindings: [
        cursor.occurredAt,
        cursor.occurredAt,
        cursor.eventId,
        cursor.eventId,
        cursor.eventPk,
      ],
    };
  }

  const primaryColumn = sort.key === "eventName" ? "event_name" : "pathname";
  const primaryOperator = sort.direction === "asc" ? ">" : "<";
  return {
    clause: `
      AND (
        ${primaryColumn} ${primaryOperator} ?
        OR (
          ${primaryColumn} = ? AND (
            occurred_at < ?
            OR (
              occurred_at = ? AND (
                event_id < ?
                OR (event_id = ? AND event_pk < ?)
              )
            )
          )
        )
      )`,
    bindings: [
      cursor.sortValue!,
      cursor.sortValue!,
      cursor.occurredAt,
      cursor.occurredAt,
      cursor.eventId,
      cursor.eventId,
      cursor.eventPk,
    ],
  };
}

function eventRecordsSql(
  filterClause: string,
  cursorClause: string,
  sort: ListSort<EventRecordSortKey>,
  sourceColumns: string,
  eventName?: string,
  scopedDataset?: ScopedDatasetSql | null,
): string {
  return `
WITH
${
  scopedDataset
    ? scopedDataset.ctes
    : `${buildVisitSourceCte()},
${buildEventAnalyticsSourceCte({
  eventName,
  selectColumns: sourceColumns,
})}`
}
SELECT
  event_pk AS eventPk,
  event_id AS eventId,
  event_name AS eventName,
  occurred_at AS occurredAt,
  received_at AS receivedAt,
  sequence,
  visit_id AS visitId,
  session_id AS sessionId,
  visitor_id AS visitorId,
  pathname,
  title,
  hostname,
  referrer_host AS referrerHost,
  country,
  region,
  city,
  browser,
  browser_version AS browserVersion,
  os,
  os_version AS osVersion,
  device_type AS deviceType,
  node_count AS nodeCount,
  value_count AS valueCount
FROM ${scopedDataset?.eventRelation ?? "event_source"} es
${filterClause || "WHERE 1 = 1"}
${cursorClause}
ORDER BY ${eventRecordOrderBy(sort)}
LIMIT ?
`;
}

function withoutEventPk(row: EventRecordCursorRow): EventRecordRow {
  const { eventPk: _eventPk, ...event } = row;
  return event;
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
  },
): Promise<EventRecordPage> {
  const eventName = options.eventName?.trim() || undefined;
  const scopedDataset = scopedDatasetFor(siteId, window, filters);
  const filter = buildEventFilterSql(
    scopedDataset ? EMPTY_FILTER_DOCUMENT : filters,
    "es",
    {
      search: options.search,
    },
  );
  const eventNameClause =
    scopedDataset && eventName
      ? `${filter.clause ? " AND" : "WHERE"} TRIM(COALESCE(es.event_name, '')) = ?`
      : "";
  const cursor = options.cursor
    ? eventRecordCursorFilter(options.cursor, options.sort)
    : { clause: "", bindings: [] };
  const rows = await queryD1All<EventRecordCursorRow>(
    env,
    eventRecordsSql(
      `${filter.clause}${eventNameClause}`,
      cursor.clause,
      options.sort,
      eventRecordSourceColumns(filters),
      eventName,
      scopedDataset,
    ),
    [
      ...(scopedDataset
        ? scopedDataset.bindings.map((binding) => binding.value)
        : [
            ...visitSourceBindings(siteId, window),
            ...eventSourceBindings(siteId, window, eventName),
          ]),
      ...filter.bindings,
      ...(scopedDataset && eventName ? [eventName] : []),
      ...cursor.bindings,
      options.limit + 1,
    ],
  );
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

export async function queryEventRecordDetailFromD1(
  env: Env,
  siteId: string,
  eventId: string,
  window?: QueryWindow,
) {
  const rows = await queryD1All<EventRecordDetailRow>(
    env,
    `
WITH
    event_source AS (
  SELECT
    ce.event_id,
    ce.site_id,
    ce.visit_id,
    cen.name AS event_name,
    ce.occurred_at,
    ce.received_at,
    ce.sequence,
    ce.node_count,
    ce.value_count,
    v.visitor_id,
    v.session_id,
    COALESCE(ce.user_id, v.user_id, '') AS user_id,
    COALESCE(v.user_name, '') AS user_name,
    v.status,
    v.started_at,
    COALESCE(
      (
        SELECT pv.visit_id
        FROM visits pv
        WHERE pv.site_pk = v.site_pk
          AND pv.session_id = v.session_id
          AND pv.started_at < v.started_at
        ORDER BY pv.started_at DESC, pv.visit_id DESC
        LIMIT 1
      ),
      ''
    ) AS previous_visit_id,
    (
      SELECT pv.started_at
      FROM visits pv
      WHERE pv.site_pk = v.site_pk
        AND pv.session_id = v.session_id
        AND pv.started_at < v.started_at
      ORDER BY pv.started_at DESC, pv.visit_id DESC
      LIMIT 1
    ) AS previous_visit_started_at,
    v.last_activity_at,
    v.ended_at,
    v.finalized_at,
    v.duration_ms,
    COALESCE(v.duration_source, '') AS duration_source,
    COALESCE(v.exit_reason, '') AS exit_reason,
    v.pathname,
    v.query_string,
    v.hash_fragment AS hash,
    v.hostname,
    v.title,
    v.referrer_url,
    v.referrer_host,
    v.utm_source,
    v.utm_medium,
    v.utm_campaign,
    v.utm_term,
    v.utm_content,
    v.is_eu,
    v.country,
    v.region,
    v.region_code,
    v.city,
    v.continent,
    v.latitude,
    v.longitude,
    v.postal_code,
    v.metro_code,
    v.timezone,
    v.as_organization,
    v.browser,
    v.browser_version,
    v.os,
    v.os_version,
    v.device_type,
    v.ua_raw AS user_agent,
    v.language,
    v.screen_width,
    v.screen_height,
    v.perf_ttfb_ms,
    v.perf_fcp_ms,
    v.perf_lcp_ms,
    v.perf_cls,
    v.perf_inp_ms
  FROM custom_events ce
  INNER JOIN custom_event_names cen
    ON cen.id = ce.event_name_id
  INNER JOIN visits v
    ON v.site_pk = ce.site_pk
   AND v.visit_id = ce.visit_id
  WHERE ce.site_pk = ${SITE_PK_FROM_SITE_ID_SQL} AND ce.event_id = ?
  ${window ? "AND ce.occurred_at >= ? AND ce.occurred_at < ?" : ""}
)
SELECT
  event_id AS eventId,
  event_name AS eventName,
  occurred_at AS occurredAt,
  received_at AS receivedAt,
  sequence,
  visit_id AS visitId,
  session_id AS sessionId,
  visitor_id AS visitorId,
  user_id AS userId,
  user_name AS userName,
  status,
  started_at AS startedAt,
  previous_visit_id AS previousVisitId,
  previous_visit_started_at AS previousVisitStartedAt,
  last_activity_at AS lastActivityAt,
  ended_at AS endedAt,
  finalized_at AS finalizedAt,
  duration_ms AS durationMs,
  duration_source AS durationSource,
  exit_reason AS exitReason,
  pathname,
  query_string AS queryString,
  hash,
  title,
  hostname,
  referrer_url AS referrerUrl,
  referrer_host AS referrerHost,
  utm_source AS utmSource,
  utm_medium AS utmMedium,
  utm_campaign AS utmCampaign,
  utm_term AS utmTerm,
  utm_content AS utmContent,
  is_eu AS isEU,
  country,
  region,
  region_code AS regionCode,
  city,
  continent,
  latitude,
  longitude,
  postal_code AS postalCode,
  metro_code AS metroCode,
  timezone,
  as_organization AS organization,
  browser,
  browser_version AS browserVersion,
  os,
  os_version AS osVersion,
  device_type AS deviceType,
  user_agent AS userAgent,
  language,
  screen_width AS screenWidth,
  screen_height AS screenHeight,
  perf_ttfb_ms AS perfTtfbMs,
  perf_fcp_ms AS perfFcpMs,
  perf_lcp_ms AS perfLcpMs,
  perf_cls AS perfCls,
  perf_inp_ms AS perfInpMs,
  node_count AS nodeCount,
  value_count AS valueCount
FROM event_source
LIMIT 1
`,
    window
      ? [siteId, eventId, window.startMs, window.endExclusiveMs]
      : [siteId, eventId],
  );
  const record = rows[0];
  if (!record) return null;
  const detail = await readCustomEventDetail(env, siteId, eventId);
  return {
    event: { ...mapEventRecord(record), eventKind: "custom_event" },
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
