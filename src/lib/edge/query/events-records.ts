import { readCustomEventDetail } from "@/lib/edge/custom-event-read";
import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
  EventRecordRow,
  EventRecordSortKey,
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

const EVENT_RECORD_CURSOR_MAX_LENGTH = 12_288;

export interface EventRecordCursor {
  sortKey: EventRecordSortKey;
  sortDirection: "asc" | "desc";
  sortValue: string | number;
  occurredAt: number;
  eventId: string;
  eventPk: number;
}

interface EventRecordCursorRow extends EventRecordRow {
  eventPk: number;
}

export interface EventRecordPage {
  rows: EventRecordRow[];
  nextCursor: EventRecordCursor | null;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function serializeEventRecordCursor(cursor: EventRecordCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

export function parseEventRecordCursor(
  raw: string,
  sort: ListSort<EventRecordSortKey>,
): EventRecordCursor | null {
  if (raw.length === 0 || raw.length > EVENT_RECORD_CURSOR_MAX_LENGTH) {
    return null;
  }
  const decoded = fromBase64Url(raw);
  if (!decoded) return null;

  try {
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const cursor = value as Record<string, unknown>;
    const sortKey = cursor.sortKey;
    const sortDirection = cursor.sortDirection;
    const sortValue = cursor.sortValue;
    const occurredAt = cursor.occurredAt;
    const eventId = cursor.eventId;
    const eventPk = cursor.eventPk;
    if (
      sortKey !== sort.key ||
      sortDirection !== sort.direction ||
      (typeof sortValue !== "string" && typeof sortValue !== "number") ||
      typeof occurredAt !== "number" ||
      !Number.isFinite(occurredAt) ||
      typeof eventId !== "string" ||
      typeof eventPk !== "number" ||
      !Number.isSafeInteger(eventPk) ||
      eventPk < 0
    ) {
      return null;
    }
    if (
      (sort.key === "occurredAt" &&
        (typeof sortValue !== "number" || sortValue !== occurredAt)) ||
      ((sort.key === "eventName" || sort.key === "pathname") &&
        typeof sortValue !== "string")
    ) {
      return null;
    }
    return {
      sortKey: sort.key,
      sortDirection: sort.direction,
      sortValue,
      occurredAt,
      eventId,
      eventPk,
    };
  } catch {
    return null;
  }
}

function eventRecordCursorFromRow(
  row: EventRecordCursorRow,
  sort: ListSort<EventRecordSortKey>,
): EventRecordCursor {
  return {
    sortKey: sort.key,
    sortDirection: sort.direction,
    sortValue:
      sort.key === "eventName"
        ? row.eventName
        : sort.key === "pathname"
          ? row.pathname
          : row.occurredAt,
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
      cursor.sortValue,
      cursor.sortValue,
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
  paginationClause: string,
  eventName?: string,
): string {
  return `
WITH
${buildVisitSourceCte()},
${buildEventAnalyticsSourceCte({ eventName })},
filtered_events AS (
  SELECT *
  FROM event_source es
  ${filterClause}
)
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
  browser,
  browser_version AS browserVersion,
  os,
  os_version AS osVersion,
  device_type AS deviceType,
  node_count AS nodeCount,
  value_count AS valueCount
FROM filtered_events
WHERE 1 = 1
${cursorClause}
ORDER BY ${eventRecordOrderBy(sort)}
${paginationClause}
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
  filters: DashboardFilters,
  options: {
    pageSize: number;
    sort: ListSort<EventRecordSortKey>;
    search?: string;
    eventName?: string;
    cursor?: EventRecordCursor | null;
  },
): Promise<EventRecordPage> {
  const filter = buildEventFilterSql(filters, "es", {
    search: options.search,
  });
  const cursor = options.cursor
    ? eventRecordCursorFilter(options.cursor, options.sort)
    : { clause: "", bindings: [] };
  const rows = await queryD1All<EventRecordCursorRow>(
    env,
    eventRecordsSql(
      filter.clause,
      cursor.clause,
      options.sort,
      "LIMIT ?",
      options.eventName,
    ),
    [
      ...visitSourceBindings(siteId, window),
      ...eventSourceBindings(siteId, window, options.eventName),
      ...filter.bindings,
      ...cursor.bindings,
      options.pageSize + 1,
    ],
  );
  const hasMore = rows.length > options.pageSize;
  const pageRows = hasMore ? rows.slice(0, options.pageSize) : rows;
  const lastRow = pageRows.at(-1);
  return {
    rows: pageRows.map(withoutEventPk),
    nextCursor:
      hasMore && lastRow
        ? eventRecordCursorFromRow(lastRow, options.sort)
        : null,
  };
}

export async function queryEventRecordsFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  options: {
    limit: number;
    offset: number;
    sort: ListSort<EventRecordSortKey>;
    search?: string;
    eventName?: string;
  },
): Promise<EventRecordRow[]> {
  const filter = buildEventFilterSql(filters, "es", {
    search: options.search,
  });
  const rows = await queryD1All<EventRecordCursorRow>(
    env,
    eventRecordsSql(
      filter.clause,
      "",
      options.sort,
      "LIMIT ?\nOFFSET ?",
      options.eventName,
    ),
    [
      ...visitSourceBindings(siteId, window),
      ...eventSourceBindings(siteId, window, options.eventName),
      ...filter.bindings,
      options.limit,
      options.offset,
    ],
  );
  return rows.map(withoutEventPk);
}

export async function queryEventRecordDetailFromD1(
  env: Env,
  siteId: string,
  eventId: string,
) {
  const rows = await queryD1All<EventRecordRow>(
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
    v.pathname,
    v.hostname,
    v.title,
    v.referrer_host,
    v.country,
    v.region,
    v.browser,
    v.browser_version,
    v.os,
    v.os_version,
    v.device_type
  FROM custom_events ce
  INNER JOIN custom_event_names cen
    ON cen.id = ce.event_name_id
  INNER JOIN visits v
    ON v.site_id = ce.site_id
   AND v.visit_id = ce.visit_id
  WHERE ce.site_id = ? AND ce.event_id = ?
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
  pathname,
  title,
  hostname,
  referrer_host AS referrerHost,
  country,
  region,
  browser,
  browser_version AS browserVersion,
  os,
  os_version AS osVersion,
  device_type AS deviceType,
  node_count AS nodeCount,
  value_count AS valueCount
FROM event_source
LIMIT 1
`,
    [siteId, eventId],
  );
  const record = rows[0];
  if (!record) return null;
  const detail = await readCustomEventDetail(env, siteId, eventId);
  return {
    event: mapEventRecord(record),
    context: {
      visitId: record.visitId,
      sessionId: record.sessionId,
      visitorId: record.visitorId,
      pathname: record.pathname,
      title: record.title,
      hostname: record.hostname,
      referrerHost: record.referrerHost,
      country: record.country,
      region: record.region,
      browser: record.browser,
      browserVersion: record.browserVersion,
      os: record.os,
      osVersion: record.osVersion,
      deviceType: record.deviceType,
    },
    eventData: detail?.eventData ?? {},
  };
}
