import { hashCustomEventStringValue } from "../../src/lib/edge/custom-event-json";
import {
  type SqlBinding,
  VISIT_D1_COLUMNS,
  type VisitBindingRow,
  visitBindings,
} from "../../src/lib/edge/ingest-sql";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GoalSeedInput {
  eventName: string;
  nowMs: number;
  runId: string;
  siteId: string;
}

function sqlLiteral(value: SqlBinding): string {
  if (value === null) return "NULL";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "NULL";
  return `'${value.replaceAll("'", "''")}'`;
}

function visitRow(
  input: GoalSeedInput,
  visitId: string,
  visitorId: string,
  sessionId: string,
  startedAt: number,
  pathname: string,
): VisitBindingRow {
  return {
    asOrganization: "InsightFlare E2E Network",
    browser: "Chrome",
    browserVersion: "1",
    city: "Shanghai",
    continent: "AS",
    country: "CN",
    createdAt: startedAt,
    deviceType: "desktop",
    durationMs: 5_000,
    durationSource: "client",
    endedAt: startedAt + 5_000,
    exitReason: "pagehide",
    finalizedAt: startedAt + 5_000,
    hashFragment: "",
    hostname: "goals.e2e.test",
    isEU: 0,
    language: "zh-CN",
    lastActivityAt: startedAt + 5_000,
    latitude: null,
    longitude: null,
    metroCode: "",
    os: "Windows",
    osVersion: "1",
    pathname,
    perfCls: null,
    perfFcpMs: null,
    perfInpMs: null,
    perfLcpMs: null,
    perfTtfbMs: null,
    postalCode: "",
    queryString: "",
    referrerHost: "",
    referrerUrl: "",
    region: "",
    regionCode: "",
    screenHeight: 900,
    screenWidth: 1440,
    sessionId,
    siteId: input.siteId,
    startedAt,
    status: "complete",
    timezone: "Asia/Shanghai",
    title: `E2E ${pathname}`,
    uaRaw: "E2E Chrome",
    updatedAt: startedAt,
    userId: "",
    userName: "",
    utmCampaign: "",
    utmContent: "",
    utmMedium: "",
    utmSource: "",
    utmTerm: "",
    visitorId,
    visitId,
  };
}

function visitSql(input: GoalSeedInput, row: VisitBindingRow): string {
  const sitePk = `(SELECT site_pk FROM site_identities WHERE site_id = ${sqlLiteral(row.siteId)})`;
  const bindings = visitBindings(row);
  const values = VISIT_D1_COLUMNS.map((column, index) =>
    column === "site_pk" ? sitePk : sqlLiteral(bindings[index] ?? null),
  );
  return `INSERT OR IGNORE INTO visits (${VISIT_D1_COLUMNS.join(", ")}) VALUES (${values.join(", ")});`;
}

function customEventSql(
  input: GoalSeedInput,
  eventId: string,
  visitId: string,
  occurredAt: number,
): string[] {
  const site = sqlLiteral(input.siteId);
  const event = sqlLiteral(eventId);
  const visit = sqlLiteral(visitId);
  const eventName = sqlLiteral(input.eventName);
  const sitePk = `(SELECT site_pk FROM site_identities WHERE site_id = ${site})`;
  const eventNameId = `(SELECT id FROM custom_event_names WHERE site_pk = ${sitePk} AND name = ${eventName})`;
  const eventPk = `(SELECT event_pk FROM custom_events WHERE event_id = ${event})`;
  const rootPathId = `(SELECT id FROM custom_event_json_paths WHERE site_pk = ${sitePk} AND path = '/')`;
  const planPathId = `(SELECT id FROM custom_event_json_paths WHERE site_pk = ${sitePk} AND path = '/plan')`;
  const planKeyId = `(SELECT id FROM custom_event_json_keys WHERE site_pk = ${sitePk} AND "key" = 'plan')`;
  const proHash = sqlLiteral(hashCustomEventStringValue("pro"));

  return [
    `INSERT INTO custom_events (event_id, site_id, site_pk, visit_id, event_name_id, occurred_at, received_at, sequence, node_count, value_count, user_id, created_at) SELECT ${event}, ${site}, ${sitePk}, ${visit}, ${eventNameId}, ${sqlLiteral(occurredAt)}, ${sqlLiteral(occurredAt)}, 0, 2, 1, NULL, ${sqlLiteral(occurredAt)} FROM visits WHERE site_pk = ${sitePk} AND visit_id = ${visit} LIMIT 1;`,
    `INSERT OR IGNORE INTO custom_event_json_nodes (event_pk, node_id, parent_node_id, key_id, path_id, value_type, member_order, array_index, depth) VALUES (${eventPk}, 1, NULL, NULL, ${rootPathId}, 4, NULL, NULL, 0);`,
    `INSERT OR IGNORE INTO custom_event_json_nodes (event_pk, node_id, parent_node_id, key_id, path_id, value_type, member_order, array_index, depth) VALUES (${eventPk}, 2, 1, ${planKeyId}, ${planPathId}, 1, 0, NULL, 1);`,
    `INSERT OR IGNORE INTO custom_event_json_values (event_pk, node_id, site_id, event_name_id, path_id, occurred_at, scope_node_id, value_type, string_value, string_hash, number_value, boolean_value, site_pk) VALUES (${eventPk}, 2, ${site}, ${eventNameId}, ${planPathId}, ${sqlLiteral(occurredAt)}, NULL, 1, 'pro', ${proHash}, NULL, NULL, ${sitePk});`,
  ];
}

export function buildGoalSeed(input: GoalSeedInput): string {
  const visitorA = `${input.runId}-goal-visitor-a`;
  const visitorB = `${input.runId}-goal-visitor-b`;
  const visitA = `${input.runId}-goal-visit-a`;
  const visitB = `${input.runId}-goal-visit-b`;
  const visitOther = `${input.runId}-goal-visit-other`;
  const firstAt = input.nowMs - 2 * DAY_MS;
  const secondAt = input.nowMs;
  const rows = [
    visitRow(
      input,
      visitA,
      visitorA,
      `${input.runId}-goal-session-a`,
      firstAt,
      "/e2e-goal-first-bucket",
    ),
    visitRow(
      input,
      visitB,
      visitorA,
      `${input.runId}-goal-session-b`,
      secondAt,
      "/e2e-goal-second-bucket",
    ),
    visitRow(
      input,
      visitOther,
      visitorB,
      `${input.runId}-goal-session-other`,
      secondAt,
      "/e2e-goal-other-visitor",
    ),
  ];
  const sql = [
    `PRAGMA foreign_keys = ON;`,
    `INSERT OR IGNORE INTO site_identities (site_id) VALUES (${sqlLiteral(input.siteId)});`,
    `INSERT INTO custom_event_names (site_id, name, site_pk, created_at, last_seen_at) VALUES (${sqlLiteral(input.siteId)}, ${sqlLiteral(input.eventName)}, (SELECT site_pk FROM site_identities WHERE site_id = ${sqlLiteral(input.siteId)}), ${sqlLiteral(input.nowMs)}, ${sqlLiteral(input.nowMs)}) ON CONFLICT(site_pk, name) DO UPDATE SET last_seen_at = excluded.last_seen_at;`,
    `INSERT INTO custom_event_json_keys (site_id, "key", site_pk, created_at, last_seen_at) VALUES (${sqlLiteral(input.siteId)}, 'plan', (SELECT site_pk FROM site_identities WHERE site_id = ${sqlLiteral(input.siteId)}), ${sqlLiteral(input.nowMs)}, ${sqlLiteral(input.nowMs)}) ON CONFLICT(site_pk, "key") DO UPDATE SET last_seen_at = excluded.last_seen_at;`,
    `INSERT INTO custom_event_json_paths (site_id, path, site_pk, created_at, last_seen_at) VALUES (${sqlLiteral(input.siteId)}, '/', (SELECT site_pk FROM site_identities WHERE site_id = ${sqlLiteral(input.siteId)}), ${sqlLiteral(input.nowMs)}, ${sqlLiteral(input.nowMs)}) ON CONFLICT(site_pk, path) DO UPDATE SET last_seen_at = excluded.last_seen_at;`,
    `INSERT INTO custom_event_json_paths (site_id, path, site_pk, created_at, last_seen_at) VALUES (${sqlLiteral(input.siteId)}, '/plan', (SELECT site_pk FROM site_identities WHERE site_id = ${sqlLiteral(input.siteId)}), ${sqlLiteral(input.nowMs)}, ${sqlLiteral(input.nowMs)}) ON CONFLICT(site_pk, path) DO UPDATE SET last_seen_at = excluded.last_seen_at;`,
    ...rows.map((row) => visitSql(input, row)),
    ...customEventSql(input, `${input.runId}-goal-event-a`, visitA, firstAt),
    ...customEventSql(input, `${input.runId}-goal-event-b`, visitB, secondAt),
  ];
  return `${sql.join("\n")}\n`;
}
