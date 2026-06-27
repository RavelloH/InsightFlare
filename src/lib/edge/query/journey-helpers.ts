import { zonedParts } from "@/lib/dashboard/time-zone";

import type {
  GeoPointRow,
  JourneyEventCountRow,
  JourneyEventRow,
  JourneyPageCountRow,
  JourneyPerformanceSummaryRow,
  ListSort,
  PerformanceMetricKey,
  SessionListSortKey,
  SessionRow,
  SortDirection,
  VisitorActivityRow,
  VisitorListSortKey,
  VisitorRow,
} from "./core";
import {
  emptyVisitPerformanceMetrics,
  mapVisitPerformanceMetrics,
  PERFORMANCE_METRIC_KEYS,
  roundPerformanceValue,
} from "./core";

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function nullableCoordinate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function sessionDurationMs(
  startedAt: number,
  endedAt: number,
  totalDurationMs: number,
  hasDurationAggregate: boolean,
): number {
  if (hasDurationAggregate && Number.isFinite(totalDurationMs)) {
    return Math.max(0, Math.round(totalDurationMs));
  }
  if (
    Number.isFinite(startedAt) &&
    Number.isFinite(endedAt) &&
    endedAt > startedAt
  ) {
    return Math.max(0, Math.round(endedAt - startedAt));
  }
  return Math.max(0, Math.round(totalDurationMs || 0));
}

export function whereClauseWithTarget(
  filterClause: string,
  target?: { column: string; value: string },
): string {
  if (!target) return filterClause;
  const filterAndClause = filterClause
    ? filterClause.replace(/^WHERE\s+/i, "AND ")
    : "";
  return `WHERE ${target.column} = ? ${filterAndClause}`;
}

export function escapeLikeSearch(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function buildJourneySearchSql(
  search: string | undefined,
  alias = "",
): { condition: string; bindings: string[] } | null {
  const normalized = search?.trim();
  if (!normalized) return null;
  const prefix = alias ? `${alias}.` : "";
  const pattern = `%${escapeLikeSearch(normalized.toLowerCase())}%`;
  const expressions = [
    `${prefix}visitor_id`,
    `${prefix}session_id`,
    `${prefix}pathname`,
    `${prefix}query_string`,
    `${prefix}hash_fragment`,
    `${prefix}hostname`,
    `${prefix}title`,
    `${prefix}referrer_host`,
    `${prefix}referrer_url`,
    `CASE WHEN TRIM(COALESCE(${prefix}referrer_host, '')) = '' THEN 'direct' ELSE ${prefix}referrer_host END`,
    `${prefix}country`,
    `${prefix}region`,
    `${prefix}region_code`,
    `${prefix}city`,
    `${prefix}browser`,
    `${prefix}browser_version`,
    `TRIM(COALESCE(${prefix}browser, '') || ' ' || COALESCE(${prefix}browser_version, ''))`,
    `${prefix}os`,
    `${prefix}os_version`,
    `TRIM(COALESCE(${prefix}os, '') || ' ' || COALESCE(${prefix}os_version, ''))`,
    `${prefix}device_type`,
  ].map(
    (expression) =>
      `LOWER(TRIM(COALESCE(${expression}, ''))) LIKE ? ESCAPE '\\'`,
  );

  return {
    condition: `(${expressions.join(" OR ")})`,
    bindings: Array.from({ length: expressions.length }, () => pattern),
  };
}

export function directionSql(direction: SortDirection): "ASC" | "DESC" {
  return direction === "asc" ? "ASC" : "DESC";
}

export function visitorListOrderBy(sort: ListSort<VisitorListSortKey>): string {
  const column: Record<VisitorListSortKey, string> = {
    firstSeenAt: "firstSeenAt",
    lastSeenAt: "lastSeenAt",
    sessions: "sessions",
    views: "views",
  };
  return `${column[sort.key]} ${directionSql(sort.direction)}, lastSeenAt DESC, visitorId ASC`;
}

export function sessionListOrderBy(sort: ListSort<SessionListSortKey>): string {
  const column: Record<SessionListSortKey, string> = {
    startedAt: "startedAt",
    durationMs: "totalDurationMs",
    views: "views",
  };
  return `${column[sort.key]} ${directionSql(sort.direction)}, startedAt DESC, sessionId ASC`;
}

export function mapVisitorRow(row: Record<string, unknown>): VisitorRow {
  return {
    visitorId: String(row.visitorId ?? ""),
    sessionId: String(row.sessionId ?? ""),
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? 0),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    events: Number(row.events ?? 0),
    country: String(row.country ?? ""),
    region: String(row.region ?? ""),
    regionCode: String(row.regionCode ?? ""),
    city: String(row.city ?? ""),
    referrerHost: String(row.referrerHost ?? ""),
    referrerUrl: String(row.referrerUrl ?? ""),
    browser: String(row.browser ?? ""),
    browserVersion: String(row.browserVersion ?? ""),
    os: String(row.os ?? ""),
    osVersion: String(row.osVersion ?? ""),
    deviceType: String(row.deviceType ?? ""),
    screenWidth:
      row.screenWidth === null ? null : Number(row.screenWidth ?? 0) || null,
    screenHeight:
      row.screenHeight === null ? null : Number(row.screenHeight ?? 0) || null,
  };
}

export function mapSessionRow(row: Record<string, unknown>): SessionRow {
  const startedAt = Number(row.startedAt ?? 0);
  const endedAt = Number(row.endedAt ?? startedAt);
  const views = Number(row.views ?? 0);
  return {
    sessionId: String(row.sessionId ?? ""),
    visitorId: String(row.visitorId ?? ""),
    startedAt,
    endedAt,
    durationMs: sessionDurationMs(
      startedAt,
      endedAt,
      Number(row.totalDurationMs ?? row.durationMs ?? 0),
      Object.prototype.hasOwnProperty.call(row, "totalDurationMs"),
    ),
    active: Boolean(Number(row.active ?? 0)),
    views,
    events: Number(row.events ?? 0),
    bounce: Boolean(Number(row.bounce ?? (views <= 1 ? 1 : 0))),
    entryPath: String(row.entryPath ?? ""),
    exitPath: String(row.exitPath ?? ""),
    referrerHost: String(row.referrerHost ?? ""),
    referrerUrl: String(row.referrerUrl ?? ""),
    country: String(row.country ?? ""),
    region: String(row.region ?? ""),
    regionCode: String(row.regionCode ?? ""),
    city: String(row.city ?? ""),
    latitude: nullableCoordinate(row.latitude),
    longitude: nullableCoordinate(row.longitude),
    browser: String(row.browser ?? ""),
    browserVersion: String(row.browserVersion ?? ""),
    os: String(row.os ?? ""),
    osVersion: String(row.osVersion ?? ""),
    deviceType: String(row.deviceType ?? ""),
    screenWidth: nullableNumber(row.screenWidth),
    screenHeight: nullableNumber(row.screenHeight),
    performance: mapVisitPerformanceMetrics(row),
  };
}

export function mapGeoPointRow(row: Record<string, unknown>): GeoPointRow {
  return {
    latitude: Number(row.latitude ?? 0),
    longitude: Number(row.longitude ?? 0),
    timestampMs: Number(row.timestampMs ?? 0),
    country: String(row.country ?? ""),
    region: String(row.region ?? ""),
    regionCode: String(row.regionCode ?? ""),
    city: String(row.city ?? ""),
    pointCount: Math.max(1, Number(row.pointCount ?? 1)),
  };
}

export function mapJourneyEventRow(
  row: Record<string, unknown>,
): JourneyEventRow {
  const kind = String(row.kind ?? "pageview");
  return {
    id: String(row.id ?? ""),
    kind:
      kind === "custom"
        ? "custom"
        : kind === "session_start"
          ? "session_start"
          : kind === "leave"
            ? "leave"
            : "pageview",
    eventType: String(row.eventType ?? ""),
    occurredAt: Number(row.occurredAt ?? 0),
    visitId: String(row.visitId ?? ""),
    sessionId: String(row.sessionId ?? ""),
    visitorId: String(row.visitorId ?? ""),
    pathname: String(row.pathname ?? ""),
    hash: String(row.hash ?? ""),
    title: String(row.title ?? ""),
    hostname: String(row.hostname ?? ""),
    referrerHost: String(row.referrerHost ?? ""),
    referrerUrl: String(row.referrerUrl ?? ""),
    country: String(row.country ?? ""),
    region: String(row.region ?? ""),
    city: String(row.city ?? ""),
    browser: String(row.browser ?? ""),
    browserVersion: String(row.browserVersion ?? ""),
    os: String(row.os ?? ""),
    osVersion: String(row.osVersion ?? ""),
    deviceType: String(row.deviceType ?? ""),
    screenWidth: nullableNumber(row.screenWidth),
    screenHeight: nullableNumber(row.screenHeight),
    durationMs: Math.max(0, Number(row.durationMs ?? 0)),
    performance: mapVisitPerformanceMetrics(row),
  };
}

export function sessionStartEvent(session: SessionRow): JourneyEventRow {
  return {
    id: `session-start:${session.sessionId}`,
    kind: "session_start",
    eventType: "session start",
    occurredAt: session.startedAt,
    visitId: "",
    sessionId: session.sessionId,
    visitorId: session.visitorId,
    pathname: session.entryPath,
    hash: "",
    title: "",
    hostname: "",
    referrerHost: session.referrerHost,
    referrerUrl: session.referrerUrl,
    country: session.country,
    region: session.region,
    city: session.city,
    browser: session.browser,
    browserVersion: session.browserVersion,
    os: session.os,
    osVersion: session.osVersion,
    deviceType: session.deviceType,
    screenWidth: session.screenWidth,
    screenHeight: session.screenHeight,
    durationMs: 0,
    performance: emptyVisitPerformanceMetrics(),
  };
}

export function sessionLeaveEvent(
  session: SessionRow,
  events: JourneyEventRow[],
): JourneyEventRow | null {
  if (session.active) return null;
  if (!Number.isFinite(session.endedAt) || session.endedAt <= 0) return null;
  if (
    Number.isFinite(session.startedAt) &&
    session.endedAt < session.startedAt
  ) {
    return null;
  }

  const latestPageEvent = events.reduce<JourneyEventRow | null>(
    (latest, event) =>
      event.kind === "pageview" &&
      (!latest || event.occurredAt > latest.occurredAt)
        ? event
        : latest,
    null,
  );
  const pathname =
    session.exitPath.trim() ||
    latestPageEvent?.pathname.trim() ||
    session.entryPath.trim();
  if (!pathname) return null;

  const base = latestPageEvent ?? sessionStartEvent(session);
  return {
    ...base,
    id: `session-leave:${session.sessionId}`,
    kind: "leave",
    eventType: "leave",
    occurredAt: Math.max(session.endedAt, session.startedAt),
    visitId: latestPageEvent?.visitId ?? "",
    sessionId: session.sessionId,
    visitorId: session.visitorId,
    pathname,
    durationMs: 0,
    performance: emptyVisitPerformanceMetrics(),
  };
}

export function summarizeVisitedPages(
  events: JourneyEventRow[],
): JourneyPageCountRow[] {
  const pages = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "pageview") continue;
    const pathname = event.pathname.trim() || "/";
    pages.set(pathname, (pages.get(pathname) ?? 0) + 1);
  }
  return Array.from(pages.entries())
    .map(([pathname, views]) => ({ pathname, views }))
    .sort(
      (left, right) =>
        right.views - left.views || left.pathname.localeCompare(right.pathname),
    )
    .slice(0, 50);
}

export function summarizeEventDistribution(
  events: JourneyEventRow[],
): JourneyEventCountRow[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const label = event.eventType.trim() || event.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([eventType, count]) => ({ eventType, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.eventType.localeCompare(right.eventType),
    )
    .slice(0, 50);
}

export function emptyJourneyPerformanceSummary(): JourneyPerformanceSummaryRow {
  return Object.fromEntries(
    PERFORMANCE_METRIC_KEYS.map((metric) => [
      metric,
      { avg: null, p75: null, min: null, max: null, samples: 0 },
    ]),
  ) as JourneyPerformanceSummaryRow;
}

export function summarizeJourneyPerformance(
  events: JourneyEventRow[],
): JourneyPerformanceSummaryRow {
  const valuesByMetric = new Map<PerformanceMetricKey, number[]>(
    PERFORMANCE_METRIC_KEYS.map((metric) => [metric, []]),
  );
  const seenVisits = new Set<string>();

  for (const event of events) {
    if (event.kind !== "pageview") continue;
    const visitId = event.visitId.trim();
    if (visitId && seenVisits.has(visitId)) continue;
    if (visitId) seenVisits.add(visitId);

    for (const metric of PERFORMANCE_METRIC_KEYS) {
      const value = event.performance[metric];
      if (value == null || !Number.isFinite(value)) continue;
      valuesByMetric.get(metric)?.push(value);
    }
  }

  const summary = emptyJourneyPerformanceSummary();
  for (const metric of PERFORMANCE_METRIC_KEYS) {
    const values = valuesByMetric.get(metric) ?? [];
    if (values.length === 0) continue;
    const total = values.reduce((sum, value) => sum + value, 0);
    summary[metric] = {
      avg: roundPerformanceValue(total / values.length),
      p75: roundPerformanceValue(percentile(values, 75)),
      min: roundPerformanceValue(Math.min(...values)),
      max: roundPerformanceValue(Math.max(...values)),
      samples: values.length,
    };
  }
  return summary;
}

export function reportingDateKey(
  timestampMs: number,
  timeZone: string,
): string {
  const parts = zonedParts(timestampMs, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

export function summarizeActivity(
  events: JourneyEventRow[],
  timeZone: string,
): VisitorActivityRow[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (!Number.isFinite(event.occurredAt) || event.occurredAt <= 0) continue;
    const date = reportingDateKey(event.occurredAt, timeZone);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function percentile(values: number[], percentileValue: number): number {
  const filtered = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (filtered.length === 0) return 0;
  const index = Math.min(
    filtered.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * filtered.length) - 1),
  );
  return filtered[index] ?? 0;
}

export function averageGapMs(values: number[]): number {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (sorted.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    total += sorted[index] - sorted[index - 1];
  }
  return Math.round(total / (sorted.length - 1));
}

export type DetailTarget = { type: "visitor" | "session"; value: string };

export function detailTargetColumn(
  target: DetailTarget,
): "visitor_id" | "session_id" {
  return target.type === "visitor" ? "visitor_id" : "session_id";
}
