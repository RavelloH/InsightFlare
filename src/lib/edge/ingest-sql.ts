export type SqlBinding = string | number | null;

export interface VisitBindingRow {
  visitId: string;
  siteId: string;
  visitorId: string;
  sessionId: string;
  status: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  finalizedAt: number | null;
  durationMs: number | null;
  durationSource: string;
  exitReason: string;
  pathname: string;
  queryString: string;
  hashFragment: string;
  hostname: string;
  title: string;
  referrerUrl: string;
  referrerHost: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  isEU: number;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  latitude: number | null;
  longitude: number | null;
  postalCode: string;
  metroCode: string;
  timezone: string;
  asOrganization: string;
  uaRaw: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
  language: string;
  userId: string;
  userName: string;
  perfTtfbMs: number | null;
  perfFcpMs: number | null;
  perfLcpMs: number | null;
  perfCls: number | null;
  perfInpMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export const VISIT_D1_COLUMNS = [
  "visit_id",
  "site_id",
  "visitor_id",
  "session_id",
  "status",
  "started_at",
  "last_activity_at",
  "ended_at",
  "finalized_at",
  "duration_ms",
  "duration_source",
  "exit_reason",
  "pathname",
  "query_string",
  "hash_fragment",
  "hostname",
  "title",
  "referrer_url",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "is_eu",
  "country",
  "region",
  "region_code",
  "city",
  "continent",
  "latitude",
  "longitude",
  "postal_code",
  "metro_code",
  "timezone",
  "as_organization",
  "ua_raw",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device_type",
  "screen_width",
  "screen_height",
  "language",
  "user_id",
  "user_name",
  "perf_ttfb_ms",
  "perf_fcp_ms",
  "perf_lcp_ms",
  "perf_cls",
  "perf_inp_ms",
  "ae_synced_at",
  "created_at",
  "updated_at",
] as const;

const VISIT_D1_COLUMN_SQL = VISIT_D1_COLUMNS.join(", ");
const VISIT_D1_PLACEHOLDER_SQL = VISIT_D1_COLUMNS.map(() => "?").join(", ");
const VISIT_UPSERT_COLUMNS = VISIT_D1_COLUMNS.filter(
  (column) =>
    !["visit_id", "ae_synced_at", "created_at", "updated_at"].includes(column),
);
const VISIT_UPSERT_ASSIGNMENTS = VISIT_UPSERT_COLUMNS.map(
  (column) => `    ${column} = excluded.${column}`,
).join(",\n");
const VISIT_UPSERT_CHANGES = VISIT_UPSERT_COLUMNS.map(
  (column) => `    visits.${column} IS NOT excluded.${column}`,
).join("\n    OR ");

export const INSERT_VISIT_SQL = `
  INSERT OR IGNORE INTO visits (${VISIT_D1_COLUMN_SQL})
  VALUES (${VISIT_D1_PLACEHOLDER_SQL})
`;

export const UPSERT_VISIT_SQL = `
  INSERT INTO visits (${VISIT_D1_COLUMN_SQL})
  VALUES (${VISIT_D1_PLACEHOLDER_SQL})
  ON CONFLICT(visit_id) DO UPDATE SET
${VISIT_UPSERT_ASSIGNMENTS},
    updated_at = excluded.updated_at
  WHERE
${VISIT_UPSERT_CHANGES}
`;

export const CREATE_BUFFERED_CUSTOM_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS buffered_custom_events (
    event_id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    visit_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    event_name TEXT NOT NULL,
    event_data_json TEXT NOT NULL DEFAULT '{}',
    user_id TEXT NOT NULL DEFAULT '',
    dirty INTEGER NOT NULL DEFAULT 1,
    flush_attempts INTEGER NOT NULL DEFAULT 0,
    last_flush_error TEXT,
    created_at INTEGER NOT NULL
  )
`;

export function visitBindings(row: VisitBindingRow): SqlBinding[] {
  return [
    row.visitId,
    row.siteId,
    row.visitorId,
    row.sessionId,
    row.status,
    row.startedAt,
    row.lastActivityAt,
    row.endedAt,
    row.finalizedAt,
    row.durationMs,
    row.durationSource || null,
    row.exitReason || null,
    row.pathname,
    row.queryString,
    row.hashFragment,
    row.hostname,
    row.title,
    row.referrerUrl,
    row.referrerHost,
    row.utmSource,
    row.utmMedium,
    row.utmCampaign,
    row.utmTerm,
    row.utmContent,
    row.isEU,
    row.country,
    row.region,
    row.regionCode,
    row.city,
    row.continent,
    row.latitude,
    row.longitude,
    row.postalCode,
    row.metroCode,
    row.timezone,
    row.asOrganization,
    row.uaRaw,
    row.browser,
    row.browserVersion,
    row.os,
    row.osVersion,
    row.deviceType,
    row.screenWidth,
    row.screenHeight,
    row.language,
    row.userId || null,
    row.userName || null,
    row.perfTtfbMs,
    row.perfFcpMs,
    row.perfLcpMs,
    row.perfCls,
    row.perfInpMs,
    null,
    row.createdAt,
    row.updatedAt,
  ];
}
