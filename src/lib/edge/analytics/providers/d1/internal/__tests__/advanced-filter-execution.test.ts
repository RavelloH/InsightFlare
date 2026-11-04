import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { aggregateCache } from "@/lib/api-v1/analytics/overview";
import { handlePlannedSiteOverview } from "@/lib/api-v1/analytics/overview-handler";
import {
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
} from "@/lib/db/d1-budget";
import type { DemoCustomEventFact } from "@/lib/demo/realtime/events-facts";
import { demoEventRecordPayload } from "@/lib/demo/realtime/events-payload";
import { applyDemoFilters } from "@/lib/demo/realtime/fact-filters";
import type { DemoFactDataset, DemoVisitFact } from "@/lib/demo/realtime/types";
import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition/edge-runtime";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  createTimeRange,
  prepareScopedQuery,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import type { SiteId, TeamId } from "@/lib/edge/analytics/contract/types";
import {
  buildAdvancedCountFilterGuardPlan,
  buildAdvancedCountFilterMatchPlan,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { advancedCountSelectorField } from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { compileScopedDatasetSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { queryAdvancedFilterActivityRange } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-activity-query";
import {
  compileAdvancedFilterCountGuardQuery,
  compileAdvancedFilterCountMatchesQuery,
  queryAdvancedFilterCountGuard,
  queryAdvancedFilterCountMatches,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-query";
import { classifyAdvancedCountFilter } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-support";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { compileFilterDocument } from "@/lib/edge/analytics/providers/d1/internal/filter-compiler";
import type { ApiKeyPrincipal } from "@/lib/edge/auth/api-key-auth";
import { expandCustomEventDataJson } from "@/lib/edge/ingest/custom-event-json";
import type { Env } from "@/lib/edge/types";
import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  normalizeFilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";
import * as filterEvaluator from "@/lib/filter-contract/filter-evaluator";
import {
  evaluateFilterDocument,
  type FilterEvaluationDataset,
  type FilterEvaluationEntity,
} from "@/lib/filter-contract/filter-evaluator";

const SITE_ID = "site-advanced-filter";

type Wave91QueryRecord = {
  readonly sql: string;
  readonly bindings: readonly (string | number | boolean | null)[];
  readonly rows: readonly Record<string, unknown>[];
};

function writeWave91Evidence(filename: string, evidence: unknown): void {
  const directory = join(process.cwd(), "plan", "execution-wave91");
  mkdirSync(directory, { recursive: true });
  const stem = filename.replace(/\.json$/iu, "");
  const isolatedFilename = `91c-${stem}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const json = JSON.stringify(
    evidence,
    (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    2,
  );
  writeFileSync(join(directory, isolatedFilename), json + "\n", {
    encoding: "utf8",
    flag: "wx",
  });
}

function createPayloadSelectorDiagnosticDataset(
  payload: unknown,
): FilterEvaluationDataset {
  const page = {
    kind: "page" as const,
    id: "wave91-diagnostic-page",
    visitId: "wave91-diagnostic-page",
    sessionId: "wave91-diagnostic-session",
    visitorId: "wave91-diagnostic-visitor",
    time: 100,
    fields: {},
  };
  const event = {
    kind: "event" as const,
    id: "wave91-diagnostic-event",
    visitId: "wave91-diagnostic-page",
    sessionId: "wave91-diagnostic-session",
    visitorId: "wave91-diagnostic-visitor",
    time: 110,
    fields: { "event.name": "purchase" },
    payload,
  };
  return {
    pages: [page],
    events: [event],
    coverageRange: { startMs: 0, endExclusiveMs: 2_000 },
  };
}

function wave91QueryEvidence(records: readonly Wave91QueryRecord[]) {
  return records.map((record) => ({
    kind: /custom_event_json_nodes/iu.test(record.sql)
      ? "payload"
      : /\b(?:visits|custom_events)\b/iu.test(record.sql)
        ? "activity"
        : /\bsites\b/iu.test(record.sql)
          ? "coverage"
          : "other",
    sql: record.sql,
    bindings: [...record.bindings],
    rows: record.rows.map((row) => ({ ...row })),
  }));
}

function findWave91PayloadTarget(value: unknown): object | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findWave91PayloadTarget(child);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "event-payload") return value;
  for (const child of Object.values(record)) {
    const found = findWave91PayloadTarget(child);
    if (found) return found;
  }
  return undefined;
}

type SelectorNumericValue = number | string | Uint8Array | null;
interface SharedActivityBase {
  readonly visitId: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly pageTimeMs: number;
  readonly pathname: string;
  readonly selectorPathOverride?: string | Uint8Array | null;
  readonly title?: string;
  readonly selectorTitleOverride?: string | Uint8Array | null;
  readonly query?: string | null;
  readonly selectorQueryOverride?: string | Uint8Array | null;
  readonly hash?: string | null;
  readonly selectorHashOverride?: string | Uint8Array | null;
  readonly durationMs?: number | null;
  readonly perfTtfbMs?: number | null;
  readonly perfFcpMs?: number | null;
  readonly perfLcpMs?: number | null;
  readonly perfCls?: number | null;
  readonly perfInpMs?: number | null;
  readonly selectorDurationMsOverride?: SelectorNumericValue;
  readonly selectorPerfTtfbMsOverride?: SelectorNumericValue;
  readonly selectorPerfFcpMsOverride?: SelectorNumericValue;
  readonly selectorPerfLcpMsOverride?: SelectorNumericValue;
  readonly selectorPerfClsOverride?: SelectorNumericValue;
  readonly selectorPerfInpMsOverride?: SelectorNumericValue;
  readonly hostname?: string;
  readonly additionalEvents?: readonly SharedEvent[];
}
interface SharedEvent {
  readonly id: string;
  readonly name: string;
  readonly selectorNameOverride?: string | Uint8Array | null;
  readonly timeMs: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}
type SharedActivity = SharedActivityBase &
  ({ readonly event: SharedEvent } | { readonly event?: never });

function activityEvents(activity: SharedActivity): readonly SharedEvent[] {
  return [
    ...(activity.event ? [activity.event] : []),
    ...(activity.additionalEvents ?? []),
  ];
}
const SHARED_ACTIVITIES = [
  {
    visitId: "history-signup",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 10,
    pathname: "/history",
    event: { id: "history-signup:signup", name: "signup", timeMs: 1_010 },
  },
  {
    visitId: "history-purchase",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 20,
    pathname: "/history",
    event: {
      id: "history-purchase:purchase",
      name: "purchase",
      timeMs: 1_020,
    },
  },
  {
    visitId: "history-cancel",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 15,
    pathname: "/history",
    event: {
      id: "history-cancel:cancellation",
      name: "cancellation",
      timeMs: 1_015,
    },
  },
  {
    visitId: "same-millisecond-page",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 1_020,
    pathname: "/same-millisecond",
  },
  {
    visitId: "candidate-a",
    sessionId: "session-a",
    visitorId: "visitor-a",
    pageTimeMs: 15_000,
    pathname: "/candidate",
  },
  {
    visitId: "candidate-b",
    sessionId: "session-b",
    visitorId: "visitor-b",
    pageTimeMs: 16_000,
    pathname: "/candidate",
  },
] as const satisfies readonly SharedActivity[];
const SHARED_FILTER_DSL =
  'page.path eq "/candidate" AND session { count(page { page.path eq "/history" }) gte 1 AND sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists AND event { event.name eq "purchase" AND event.payload("/order/amount") gt 0 } exists } exists';
const RAW_COLUMNS = [
  "started_at",
  "status",
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
] as const;
const REAL_COLUMNS = new Set([
  "latitude",
  "longitude",
  "perf_ttfb_ms",
  "perf_fcp_ms",
  "perf_lcp_ms",
  "perf_cls",
  "perf_inp_ms",
]);

function sqliteEnv(
  activities: readonly SharedActivity[] = SHARED_ACTIVITIES,
  onQueryComplete?: (
    sql: string,
    bindings: readonly (string | number | boolean | null)[],
    rows: readonly Record<string, unknown>[],
  ) => void,
  readUnsafeIntegersAsNumber = false,
): {
  readonly env: Env;
  readonly database: DatabaseSync;
  readonly queries: string[];
} {
  const database = new DatabaseSync(":memory:");
  const queries: string[] = [];
  database.exec(`
    CREATE TABLE sites (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      public_enabled INTEGER NOT NULL DEFAULT 0,
      public_slug TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE site_identities (site_pk INTEGER PRIMARY KEY, site_id TEXT NOT NULL UNIQUE);
    CREATE TABLE visits (
      visit_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      site_pk INTEGER NOT NULL,
      visitor_id TEXT,
      session_id TEXT,
      ${RAW_COLUMNS.map((column) => `${column} ${REAL_COLUMNS.has(column) ? "REAL" : column === "started_at" || column.endsWith("_ms") || column === "is_eu" ? "INTEGER" : "TEXT"}`).join(",\n      ")}
      ,ae_synced_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_pk INTEGER NOT NULL,
      site_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE custom_event_json_paths (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL,
      site_pk INTEGER NOT NULL
    );
    CREATE TABLE custom_event_json_keys (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      key TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL,
      site_pk INTEGER NOT NULL
    );
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      site_pk INTEGER NOT NULL,
      visit_id TEXT NOT NULL,
      event_name_id INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER NOT NULL DEFAULT 0,
      node_count INTEGER NOT NULL DEFAULT 0,
      value_count INTEGER NOT NULL DEFAULT 0,
      ae_synced_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      user_id TEXT
    );
    CREATE TABLE custom_event_json_nodes (
      event_pk INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      key_id INTEGER,
      path_id INTEGER NOT NULL,
      value_type INTEGER NOT NULL,
      array_index INTEGER,
      depth INTEGER NOT NULL,
      member_order INTEGER
    );
    CREATE INDEX idx_fixture_custom_event_nodes_event_node
      ON custom_event_json_nodes (event_pk, node_id);
    CREATE TABLE custom_event_json_values (
      event_pk INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      site_id TEXT NOT NULL,
      event_name_id INTEGER NOT NULL,
      path_id INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      scope_node_id INTEGER,
      value_type INTEGER NOT NULL,
      string_value TEXT,
      string_hash TEXT,
      number_value REAL,
      boolean_value INTEGER,
      site_pk INTEGER NOT NULL
    );
  `);
  database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(SITE_ID, "team-1", "Test Site", "example.test", 0);
  database
    .prepare("INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)")
    .run(1, SITE_ID);
  const insertVisit = database.prepare(`
    INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, started_at,
      pathname, query_string, hash_fragment, title, duration_ms,
      perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms, hostname
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.exec("BEGIN");
  try {
    for (const activity of activities) {
      insertVisit.run(
        activity.visitId,
        SITE_ID,
        activity.visitorId,
        activity.sessionId,
        activity.pageTimeMs,
        activity.pathname,
        activity.query ?? null,
        activity.hash ?? null,
        activity.title ?? activity.pathname,
        activity.durationMs === undefined ? 5 : activity.durationMs,
        activity.perfTtfbMs ?? null,
        activity.perfFcpMs ?? null,
        activity.perfLcpMs ?? null,
        activity.perfCls ?? null,
        activity.perfInpMs ?? null,
        activity.hostname ?? "example.test",
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
  database
    .prepare(
      "INSERT INTO custom_event_names (id, site_pk, name) VALUES (1, 1, 'signup'), (2, 1, 'purchase'), (3, 1, 'cancellation'), (4, 1, 'refund'), (5, 1, 'view')",
    )
    .run();
  const insertEvent = database.prepare(`
    INSERT INTO custom_events (event_pk, event_id, site_id, site_pk, visit_id, event_name_id, occurred_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
  `);
  let eventPk = 1;
  const pathIds = new Map<string, number>();
  const keyIds = new Map<string, number>();
  const ensurePathId = (path: string): number => {
    const existing = pathIds.get(path);
    if (existing !== undefined) return existing;
    const id = pathIds.size + 1;
    database
      .prepare(
        "INSERT INTO custom_event_json_paths (id, site_id, site_pk, path, last_seen_at) VALUES (?, ?, 1, ?, 0)",
      )
      .run(id, SITE_ID, path);
    pathIds.set(path, id);
    return id;
  };
  const ensureKeyId = (key: string): number => {
    const existing = keyIds.get(key);
    if (existing !== undefined) return existing;
    const id = keyIds.size + 1;
    database
      .prepare(
        "INSERT INTO custom_event_json_keys (id, site_id, site_pk, key, last_seen_at) VALUES (?, ?, 1, ?, 0)",
      )
      .run(id, SITE_ID, key);
    keyIds.set(key, id);
    return id;
  };
  const eventNameIds: Readonly<Record<string, number>> = {
    signup: 1,
    purchase: 2,
    cancellation: 3,
    refund: 4,
    view: 5,
  };
  for (const activity of activities) {
    for (const eventInput of activityEvents(activity)) {
      const currentEventPk = eventPk++;
      insertEvent.run(
        currentEventPk,
        eventInput.id,
        SITE_ID,
        activity.visitId,
        eventNameIds[eventInput.name]!,
        eventInput.timeMs,
      );
      const event: DemoCustomEventFact = {
        eventId: eventInput.id,
        eventName: eventInput.name,
        occurredAt: eventInput.timeMs,
        receivedAt: eventInput.timeMs + 120,
        sequence: 1,
        visit: demoVisit(activity),
      };
      const expanded = expandCustomEventDataJson(
        JSON.stringify(eventInput.payload ?? demoEventRecordPayload(event)),
      );
      if (!expanded.ok) throw new Error(expanded.error);
      for (const node of expanded.data.nodes) {
        const pathId = ensurePathId(node.path);
        const keyId = node.key === null ? null : ensureKeyId(node.key);
        database
          .prepare(
            `INSERT INTO custom_event_json_nodes (
            event_pk, node_id, parent_node_id, key_id, path_id, value_type,
            array_index, depth
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            currentEventPk,
            node.nodeId,
            node.parentNodeId,
            keyId,
            pathId,
            node.valueType,
            node.arrayIndex,
            node.depth,
          );
      }
      for (const value of expanded.data.values) {
        database
          .prepare(
            `INSERT INTO custom_event_json_values (
            event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
            scope_node_id, value_type, string_value, string_hash, number_value,
            boolean_value, site_pk
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(
            currentEventPk,
            value.nodeId,
            SITE_ID,
            eventNameIds[eventInput.name]!,
            ensurePathId(value.path),
            eventInput.timeMs,
            value.scopeNodeId,
            value.valueType,
            value.stringValue,
            value.stringHash,
            value.numberValue,
            value.booleanValue,
          );
      }
    }
  }

  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: Array<string | number | boolean | null>) => ({
          all: async <T extends object>() => {
            queries.push(sql);
            const sqliteBindings = bindings.map((binding) =>
              typeof binding === "boolean" ? Number(binding) : binding,
            );
            let results: T[];
            try {
              results = database.prepare(sql).all(...sqliteBindings) as T[];
            } catch (error) {
              if (
                !readUnsafeIntegersAsNumber ||
                !(error instanceof RangeError) ||
                !/too large to be represented as a JavaScript number/iu.test(
                  error.message,
                )
              )
                throw error;
              const statement = database.prepare(sql);
              statement.setReadBigInts(true);
              results = (
                statement.all(...sqliteBindings) as Array<
                  Record<string, unknown>
                >
              ).map(
                (row) =>
                  Object.fromEntries(
                    Object.entries(row).map(([key, value]) => [
                      key,
                      typeof value === "bigint" ? Number(value) : value,
                    ]),
                  ) as T,
              );
            }
            onQueryComplete?.(
              sql,
              bindings,
              results as readonly Record<string, unknown>[],
            );
            return {
              results,
            };
          },
        }),
      }),
    },
    DAILY_SALT_SECRET: "test-secret",
    INGEST_DO: {},
  } as unknown as Env;
  return { env, database, queries };
}

function advancedFilterInput(
  time: QueryTime,
  siteIds = [SITE_ID],
  filterDsl = "count(page) gte 1",
  scope: "event" | "session" | "visitor" = "session",
) {
  const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("overview", document, scope);
  if (!plan) throw new Error("expected_scoped_filter_plan");
  const filters = attachScopedFilterMetadata(document, {
    requestedScope: scope,
    resolvedScope: scope,
    plan,
    time,
    siteIds,
  });
  return {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    filters,
    scopePreference: scope,
    scopePlan: plan,
    time,
  };
}

function advancedFilterTeamInput(
  time: QueryTime,
  siteIds: readonly string[],
  filterDsl = "count(page) gte 1",
  scope: "event" | "session" = "session",
) {
  const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("overview", document, scope);
  if (!plan) throw new Error("expected_team_scoped_filter_plan");
  const filters = attachScopedFilterMetadata(document, {
    requestedScope: scope,
    resolvedScope: scope,
    plan,
    time,
    siteIds,
  });
  return {
    context: teamQueryContext("team-1", "private-dashboard", siteIds),
    filters,
    scopePreference: scope,
    scopePlan: plan,
    time,
  };
}

function addTeamSite(
  database: DatabaseSync,
  siteId: string,
  sitePk: number,
  createdAtSeconds = 0,
): void {
  database
    .prepare(
      "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(siteId, "team-1", siteId, `${siteId}.example.test`, createdAtSeconds);
  database
    .prepare("INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)")
    .run(sitePk, siteId);
}

function addTeamPage(
  database: DatabaseSync,
  input: {
    readonly siteId: string;
    readonly sitePk: number;
    readonly rawSiteId?: string;
    readonly visitId: string;
    readonly sessionId: string;
    readonly visitorId?: string;
    readonly startedAt: number;
  },
): void {
  database
    .prepare(
      "INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, started_at, pathname, title, duration_ms, hostname) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.visitId,
      input.rawSiteId ?? input.siteId,
      input.sitePk,
      input.visitorId ?? "wave75-team-visitor",
      input.sessionId,
      input.startedAt,
      "/wave75-team",
      "/wave75-team",
      5,
      "example.test",
    );
}

function teamSiteIds(count: number): string[] {
  return [
    SITE_ID,
    ...Array.from(
      { length: count - 1 },
      (_, index) => `wave75-team-site-${String(index + 1).padStart(3, "0")}`,
    ),
  ];
}

function seedTeamSites(
  database: DatabaseSync,
  siteIds: readonly string[],
  createdAtBySite: ReadonlyMap<string, number> = new Map(),
): void {
  for (const [index, siteId] of siteIds.entries()) {
    if (index === 0) {
      const createdAtSeconds = createdAtBySite.get(siteId);
      if (createdAtSeconds !== undefined)
        database
          .prepare("UPDATE sites SET created_at = ? WHERE id = ?")
          .run(createdAtSeconds, siteId);
    } else {
      addTeamSite(
        database,
        siteId,
        index + 1,
        createdAtBySite.get(siteId) ?? 0,
      );
    }
  }
}

interface AdvancedCountParityRequest {
  readonly activities: readonly SharedActivity[];
  readonly filterDsl: string;
  readonly scope: "session" | "visitor";
  readonly candidateRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly readRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly filterRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly expectedAnchorPlan?: "single-bag" | "two-bag";
  readonly expectedIdentities?: readonly string[];
  readonly capturedAtMs: number;
}

async function evaluateAdvancedCountFixture(
  request: AdvancedCountParityRequest,
) {
  const time = {
    ...createQueryTime(
      request.candidateRange.startMs,
      request.candidateRange.endExclusiveMs,
      "UTC",
      request.capturedAtMs,
    ),
    ...(request.readRange
      ? {
          readRange: createTimeRange(
            request.readRange.startMs,
            request.readRange.endExclusiveMs,
          ),
        }
      : {}),
    ...(request.filterRange
      ? {
          filterRange: createTimeRange(
            request.filterRange.startMs,
            request.filterRange.endExclusiveMs,
          ),
        }
      : {}),
  };
  const statements: Array<{
    readonly sql: string;
    readonly bindings: readonly (string | number | boolean | null)[];
    readonly rows: readonly Record<string, unknown>[];
  }> = [];
  const { env, database, queries } = sqliteEnv(
    request.activities,
    (sql, bindings, rows) => statements.push({ sql, bindings, rows }),
  );
  try {
    for (const activity of request.activities) {
      if (activity.selectorPathOverride !== undefined)
        database
          .prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?")
          .run(activity.selectorPathOverride, activity.visitId);
      if (activity.selectorTitleOverride !== undefined)
        if (
          activity.selectorTitleOverride instanceof Uint8Array &&
          activity.selectorTitleOverride.byteLength === 0
        )
          database
            .prepare("UPDATE visits SET title = zeroblob(0) WHERE visit_id = ?")
            .run(activity.visitId);
        else
          database
            .prepare("UPDATE visits SET title = ? WHERE visit_id = ?")
            .run(activity.selectorTitleOverride, activity.visitId);
      if (activity.selectorQueryOverride !== undefined)
        database
          .prepare("UPDATE visits SET query_string = ? WHERE visit_id = ?")
          .run(activity.selectorQueryOverride, activity.visitId);
      if (activity.selectorHashOverride !== undefined)
        database
          .prepare("UPDATE visits SET hash_fragment = ? WHERE visit_id = ?")
          .run(activity.selectorHashOverride, activity.visitId);
      const numericOverrides = [
        ["duration_ms", activity.selectorDurationMsOverride],
        ["perf_ttfb_ms", activity.selectorPerfTtfbMsOverride],
        ["perf_fcp_ms", activity.selectorPerfFcpMsOverride],
        ["perf_lcp_ms", activity.selectorPerfLcpMsOverride],
        ["perf_cls", activity.selectorPerfClsOverride],
        ["perf_inp_ms", activity.selectorPerfInpMsOverride],
      ] as const;
      for (const [column, value] of numericOverrides)
        if (value !== undefined)
          database
            .prepare(`UPDATE visits SET ${column} = ? WHERE visit_id = ?`)
            .run(value, activity.visitId);
      for (const event of activityEvents(activity))
        if (event.selectorNameOverride !== undefined)
          database
            .prepare(
              `UPDATE custom_event_names
               SET name = ?
               WHERE id = (
                 SELECT event_name_id FROM custom_events WHERE event_id = ?
               )`,
            )
            .run(event.selectorNameOverride, event.id);
    }
    const rawNumericRows = database
      .prepare(
        `SELECT visit_id, duration_ms, perf_ttfb_ms, perf_fcp_ms,
           perf_lcp_ms, perf_cls, perf_inp_ms,
           typeof(duration_ms) AS duration_ms_type,
           typeof(perf_ttfb_ms) AS perf_ttfb_ms_type,
           typeof(perf_cls) AS perf_cls_type
         FROM visits`,
      )
      .all() as Array<Record<string, unknown>>;
    const rawStringRows = database
      .prepare(
        `SELECT visit_id, typeof(pathname) AS pathname_type,
           typeof(title) AS title_type, typeof(query_string) AS query_type,
           typeof(hash_fragment) AS hash_type
         FROM visits`,
      )
      .all() as Array<Record<string, unknown>>;
    const rawNumericByVisitId = new Map(
      rawNumericRows.map((row) => [row.visit_id as string, row]),
    );
    const diagnostics = createD1ReadDiagnostics();
    const input = advancedFilterInput(
      time,
      [SITE_ID],
      request.filterDsl,
      request.scope,
    );
    const prepared = (await d1AdvancedFilterMiddleware(env, diagnostics)(
      "performance",
      input,
      async (value) => value,
    )) as typeof input;
    const d1 = (prepared.scopePlan?.advancedMatches?.entityIds ?? [])
      .map((identity) => identity.id)
      .sort();

    const pages: FilterEvaluationEntity[] = request.activities.map(
      (activity) => {
        const numeric = rawNumericByVisitId.get(activity.visitId);
        if (!numeric)
          throw new Error("advanced_count_fixture_numeric_row_missing");
        return {
          kind: "page",
          id: activity.visitId,
          time: activity.pageTimeMs,
          visitId: activity.visitId,
          sessionId: activity.sessionId,
          visitorId: activity.visitorId,
          fields: {
            "event.name": null,
            "page.path":
              activity.selectorPathOverride === undefined
                ? activity.pathname
                : activity.selectorPathOverride,
            "page.title":
              activity.selectorTitleOverride === undefined
                ? (activity.title ?? activity.pathname)
                : activity.selectorTitleOverride,
            "page.query":
              activity.selectorQueryOverride === undefined
                ? (activity.query ?? null)
                : activity.selectorQueryOverride,
            "page.hash":
              activity.selectorHashOverride === undefined
                ? (activity.hash ?? null)
                : activity.selectorHashOverride,
            "page.hostname": activity.hostname ?? "example.test",
            "page.durationMs": numeric.duration_ms,
            "performance.ttfbMs": numeric.perf_ttfb_ms,
            "performance.fcpMs": numeric.perf_fcp_ms,
            "performance.lcpMs": numeric.perf_lcp_ms,
            "performance.cls": numeric.perf_cls,
            "performance.inpMs": numeric.perf_inp_ms,
          },
        };
      },
    );
    const events: FilterEvaluationEntity[] = request.activities.flatMap(
      (activity) => {
        const numeric = rawNumericByVisitId.get(activity.visitId);
        if (!numeric)
          throw new Error("advanced_count_fixture_numeric_row_missing");
        return activityEvents(activity).map((event) => ({
          kind: "event",
          id: event.id,
          time: event.timeMs,
          visitId: activity.visitId,
          sessionId: activity.sessionId,
          visitorId: activity.visitorId,
          payload: event.payload ?? {},
          fields: {
            "event.name":
              event.selectorNameOverride === undefined
                ? event.name
                : event.selectorNameOverride,
            "page.path":
              activity.selectorPathOverride === undefined
                ? activity.pathname
                : activity.selectorPathOverride,
            "page.title":
              activity.selectorTitleOverride === undefined
                ? (activity.title ?? activity.pathname)
                : activity.selectorTitleOverride,
            "page.query":
              activity.selectorQueryOverride === undefined
                ? (activity.query ?? null)
                : activity.selectorQueryOverride,
            "page.hash":
              activity.selectorHashOverride === undefined
                ? (activity.hash ?? null)
                : activity.selectorHashOverride,
            "page.durationMs": numeric.duration_ms,
            "performance.ttfbMs": numeric.perf_ttfb_ms,
            "performance.fcpMs": numeric.perf_fcp_ms,
            "performance.lcpMs": numeric.perf_lcp_ms,
            "performance.cls": numeric.perf_cls,
            "performance.inpMs": numeric.perf_inp_ms,
          },
        }));
      },
    );
    const readRange = request.readRange ?? request.candidateRange;
    const rangeStarts = [
      request.candidateRange.startMs,
      readRange.startMs,
      ...(request.filterRange ? [request.filterRange.startMs] : []),
      ...pages.map((page) => page.time!),
      ...events.map((event) => event.time!),
    ];
    const rangeEnds = [
      request.candidateRange.endExclusiveMs,
      readRange.endExclusiveMs,
      ...(request.filterRange ? [request.filterRange.endExclusiveMs] : []),
      ...pages.map((page) => page.time! + 1),
      ...events.map((event) => event.time! + 1),
    ];
    const oracle = evaluateFilterDocument(
      input.filters!,
      {
        pages,
        events,
        coverageRange: {
          startMs: Math.min(...rangeStarts),
          endExclusiveMs: Math.max(...rangeEnds),
        },
      },
      {
        scope: request.scope,
        candidateRange: request.candidateRange,
        ...(request.filterRange ? { filterRange: request.filterRange } : {}),
        readRange,
        reportingTimeZone: "UTC",
        capturedAtMs: request.capturedAtMs,
      },
    );
    return {
      d1,
      oracle: [...oracle.matchingScopeEntityIds].sort(),
      queries,
      statements,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      rawNumericStorageTypes: rawNumericRows.map((row) => ({
        visitId: row.visit_id,
        durationMs: row.duration_ms_type,
        perfTtfbMs: row.perf_ttfb_ms_type,
        perfCls: row.perf_cls_type,
      })),
      rawStringStorageTypes: rawStringRows.map((row) => ({
        visitId: row.visit_id,
        pathname: row.pathname_type,
        title: row.title_type,
        query: row.query_type,
        hash: row.hash_type,
      })),
    };
  } finally {
    database.close();
  }
}

function demoVisit(activity: SharedActivity): DemoVisitFact {
  return {
    visitId: activity.visitId,
    sessionId: activity.sessionId,
    visitorId: activity.visitorId,
    startedAt: activity.pageTimeMs,
    pathname: activity.pathname,
    title: activity.title ?? activity.pathname,
    hostname: activity.hostname ?? "example.test",
    referrerHost: "",
    referrerUrl: "",
    browser: "Chrome",
    browserVersion: "1",
    osVersion: "Test OS",
    deviceType: "Desktop",
    language: "en",
    screenSize: "1280x720",
    country: "US",
    regionCode: "",
    regionName: "",
    region: "",
    cityName: "",
    city: "",
    continent: "",
    timezone: "UTC",
    organization: "",
    latitude: 0,
    longitude: 0,
    eventType: activity.event?.name ?? "pageview",
    durationMs: 5,
    ...(activity.event?.payload !== undefined
      ? { customEventPayload: activity.event.payload }
      : {}),
  };
}

function sharedDemoDataset(
  activities: readonly SharedActivity[] = SHARED_ACTIVITIES,
  from = 0,
  to = 20_000,
): DemoFactDataset {
  const visits = activities.map(demoVisit);
  return {
    from,
    to,
    viewWeight: 1,
    visits,
    sessions: new Map(),
    visitors: new Map(),
  };
}

interface SharedFilterRequest {
  readonly activities: readonly SharedActivity[];
  readonly filterDsl: string;
  readonly scope: "session" | "visitor";
  readonly candidateRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly filterRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly reportingTimeZone: string;
  readonly capturedAtMs: number;
}

async function evaluateSharedFixture(request: SharedFilterRequest): Promise<{
  readonly d1: readonly string[];
  readonly mock: readonly string[];
  readonly mockVisitIds: readonly string[];
}> {
  const document = parseFilterDsl(request.filterDsl, analyticsFilterRegistry);
  const { env, database } = sqliteEnv(request.activities);
  try {
    const baseTime = createQueryTime(
      request.candidateRange.startMs,
      request.candidateRange.endExclusiveMs,
      request.reportingTimeZone,
      request.capturedAtMs,
    );
    const time = request.filterRange
      ? {
          ...baseTime,
          filterRange: createTimeRange(
            request.filterRange.startMs,
            request.filterRange.endExclusiveMs,
          ),
        }
      : baseTime;
    const input = prepareScopedQuery("overview", {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      filters: document,
      scopePreference: request.scope,
      time,
    });
    if (!input.scopePlan || !input.filters || !("time" in input))
      throw new Error("expected_prepared_scoped_filter_query");
    const preparedTime = (input as typeof input & { time: QueryTime }).time;
    const output = await d1AdvancedFilterMiddleware(env)(
      "performance",
      input,
      async (prepared) => prepared,
    );
    const prepared = output as typeof input;
    const d1Ids = (prepared.scopePlan?.advancedMatches?.entityIds ?? [])
      .map((item) => item.id)
      .sort();

    const fixtureStart = Math.min(
      ...request.activities.flatMap((activity) => [
        activity.pageTimeMs,
        ...(activity.event ? [activity.event.timeMs] : []),
      ]),
    );
    const coverageStart = Math.min(
      request.candidateRange.startMs,
      preparedTime.readRange?.startMs ?? request.candidateRange.startMs,
      preparedTime.filterRange?.startMs ?? request.candidateRange.startMs,
      preparedTime.fullHistory ? fixtureStart : Number.MAX_SAFE_INTEGER,
    );
    const coverageEnd = Math.max(
      request.candidateRange.endExclusiveMs,
      preparedTime.readRange?.endExclusiveMs ??
        request.candidateRange.endExclusiveMs,
      preparedTime.filterRange?.endExclusiveMs ??
        request.candidateRange.endExclusiveMs,
      preparedTime.fullHistory ? request.capturedAtMs + 1 : 0,
    );
    const mockResult = applyDemoFilters(
      sharedDemoDataset(request.activities, coverageStart, coverageEnd),
      {
        filterDocument: prepared.filters ?? document,
        scope: request.scope,
        candidateRange: request.candidateRange,
        ...(preparedTime.filterRange
          ? { filterRange: preparedTime.filterRange }
          : {}),
        ...(preparedTime.filterRangeEmpty ? { filterRangeEmpty: true } : {}),
        ...(preparedTime.readRange
          ? { readRange: preparedTime.readRange }
          : {}),
        ...(preparedTime.fullHistory ? { fullHistory: true } : {}),
        reportingTimeZone: request.reportingTimeZone,
        capturedAtMs: request.capturedAtMs,
      },
    );
    const mockIds = [
      ...(request.scope === "session"
        ? mockResult.sessions
        : mockResult.visitors),
    ].sort();
    return {
      d1: d1Ids,
      mock: mockIds,
      mockVisitIds: mockResult.visits.map((visit) => visit.visitId).sort(),
    };
  } finally {
    database.close();
  }
}

describe("D1 advanced filter execution", () => {
  it("rejects scoped-filter site ids outside the actual query subject", async () => {
    const { env, database, queries } = sqliteEnv();
    try {
      const time = createQueryTime(0, 2_000, "UTC", 2_000);
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          advancedFilterInput(time, [SITE_ID, "unauthorized-site"]),
          async (prepared) => prepared,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [
            {
              path: "filters",
              code: "advanced_filter_execution_site_context_mismatch",
            },
          ],
        },
      });
      expect(queries).toEqual([]);
    } finally {
      database.close();
    }
  });

  it.each(["foreign-raw-site", ""])(
    "falls back when raw observation site id %j disagrees with canonical identity",
    async (rawSiteId) => {
      const capturedQueries: Array<{
        readonly sql: string;
        readonly rows: readonly Record<string, unknown>[];
      }> = [];
      const { env, database, queries } = sqliteEnv(
        [
          {
            visitId: "mismatched-site-page",
            sessionId: "mismatched-site-session",
            visitorId: "mismatched-site-visitor",
            pageTimeMs: 10,
            pathname: "/mismatched-site",
          },
        ],
        (sql, _bindings, rows) => capturedQueries.push({ sql, rows }),
      );
      database
        .prepare("UPDATE visits SET site_id = ? WHERE visit_id = ?")
        .run(rawSiteId, "mismatched-site-page");
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("0x10", "mismatched-site-page");
      const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
      const diagnostics = createD1ReadDiagnostics();
      try {
        const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
          "performance",
          advancedFilterInput(
            createQueryTime(0, 100, "UTC", 100),
            [SITE_ID],
            "count(page { page.durationMs gt 5 }) eq 1",
          ),
          async (input) => input,
        )) as ReturnType<typeof advancedFilterInput>;

        expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
        expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
          kind: "site-identity-mismatch",
        });
        expect(evaluatorSpy).toHaveBeenCalledTimes(1);
        const guard = capturedQueries.find(({ rows }) =>
          rows.some((row) => "siteIdentityMismatchCount" in row),
        );
        expect(guard?.sql).toMatch(/siteIdentityMismatchCount/iu);
        expect(guard?.rows[0]).toMatchObject({
          rawCount: 1,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 1,
          invalidContextPageDurationMsCount: 1,
        });
        expect(queries.some((sql) => /GROUP BY/iu.test(sql))).toBe(true);
      } finally {
        evaluatorSpy.mockRestore();
        database.close();
      }
    },
  );

  it("falls back for an Event whose raw site id disagrees with its canonical site", async () => {
    const capturedQueries: Array<{
      readonly sql: string;
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv(
      [
        {
          visitId: "mismatched-event-owner",
          sessionId: "mismatched-event-session",
          visitorId: "mismatched-event-visitor",
          pageTimeMs: 10,
          pathname: "/mismatched-event",
          event: {
            id: "mismatched-site-event",
            name: "purchase",
            timeMs: 20,
          },
        },
      ],
      (sql, _bindings, rows) => capturedQueries.push({ sql, rows }),
    );
    database
      .prepare("UPDATE custom_events SET site_id = ? WHERE event_id = ?")
      .run("foreign-raw-site", "mismatched-site-event");
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "performance",
        advancedFilterInput(
          createQueryTime(0, 100, "UTC", 100),
          [SITE_ID],
          "count(event) gte 1",
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;

      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "site-identity-mismatch",
      });
      expect(evaluatorSpy).toHaveBeenCalled();
      const guard = capturedQueries.find(({ rows }) =>
        rows.some((row) => "siteIdentityMismatchCount" in row),
      );
      expect(guard?.rows[0]).toMatchObject({
        rawCount: 2,
        siteIdentityMismatchCount: 1,
      });
      expect(queries.some((sql) => /GROUP BY/iu.test(sql))).toBe(true);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("uses one combined snapshot and discovers numeric mutations on the next request", async () => {
    const mutationDatabase: { current?: DatabaseSync } = {};
    let mutated = false;
    const { env, database, queries } = sqliteEnv(
      [
        {
          visitId: "combined-snapshot-page",
          sessionId: "combined-snapshot-session",
          visitorId: "combined-snapshot-visitor",
          pageTimeMs: 10,
          pathname: "/before",
        },
      ],
      (_sql, _bindings, rows) => {
        if (!mutated && rows.some((row) => row.rowKind === "guard")) {
          mutated = true;
          mutationDatabase.current
            ?.prepare(
              "UPDATE visits SET pathname = ?, duration_ms = ? WHERE visit_id = ?",
            )
            .run("/after", "bad", "combined-snapshot-page");
        }
      },
    );
    mutationDatabase.current = database;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const request = () =>
      advancedFilterInput(
        createQueryTime(0, 100, "UTC", 100),
        [SITE_ID],
        'count(page { page.path eq "/before" AND page.durationMs gt 0 }) eq 1',
      );
    try {
      const firstDiagnostics = createD1ReadDiagnostics();
      const first = (await d1AdvancedFilterMiddleware(env, firstDiagnostics)(
        "performance",
        request(),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;
      expect(first.scopePlan?.advancedMatches?.entityIds).toEqual([
        { siteId: SITE_ID, id: "combined-snapshot-session" },
      ]);
      expect(mutated).toBe(true);
      expect(firstDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(
        queries.filter((sql) => /AS MATERIALIZED/iu.test(sql)),
      ).toHaveLength(1);

      const secondDiagnostics = createD1ReadDiagnostics();
      const second = (await d1AdvancedFilterMiddleware(env, secondDiagnostics)(
        "performance",
        request(),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;
      expect(second.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(secondDiagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(
        queries.filter((sql) => /AS MATERIALIZED/iu.test(sql)),
      ).toHaveLength(2);
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("proves inherited Event values for an empty scope and discards its identities", async () => {
    const capturedQueries: Array<{
      readonly sql: string;
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv(
      [
        {
          visitId: "combined-event-proof-page",
          sessionId: "",
          visitorId: "combined-event-proof-visitor",
          pageTimeMs: 10,
          pathname: "/combined-event-proof",
          selectorDurationMsOverride: "bad",
          event: {
            id: "combined-event-proof-event",
            name: "purchase",
            timeMs: 20,
          },
        },
      ],
      (sql, _bindings, rows) => capturedQueries.push({ sql, rows }),
    );
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("bad", "combined-event-proof-page");
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "performance",
        advancedFilterInput(
          createQueryTime(0, 100, "UTC", 100),
          [SITE_ID],
          'page.durationMs gt 5 AND count(event { event.name eq "purchase" }) gte 1',
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;

      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      const guard = capturedQueries.find(({ rows }) =>
        rows.some((row) => row.rowKind === "guard"),
      );
      expect(guard?.rows).toContainEqual(
        expect.objectContaining({
          rowKind: "guard",
          rawCount: 2,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          invalidContextPageDurationMsCount: 2,
        }),
      );
      expect(
        queries.filter((sql) => /AS MATERIALIZED/iu.test(sql)),
      ).toHaveLength(1);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("emits a zero numeric proof guard when the bounded bag has no candidate rows", async () => {
    const capturedQueries: Array<{
      readonly sql: string;
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv(
      [
        {
          visitId: "combined-empty-bag-page",
          sessionId: "combined-empty-bag-session",
          visitorId: "combined-empty-bag-visitor",
          pageTimeMs: 10,
          pathname: "/outside-range",
          durationMs: 2,
        },
      ],
      (sql, _bindings, rows) => capturedQueries.push({ sql, rows }),
    );
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "performance",
        advancedFilterInput(
          createQueryTime(100, 200, "UTC", 200),
          [SITE_ID],
          "count(page) eq 0 AND sum(page.durationMs) eq 0",
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;

      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(evaluatorSpy).not.toHaveBeenCalled();
      const guard = capturedQueries.find(({ rows }) =>
        rows.some((row) => row.rowKind === "guard"),
      );
      expect(guard?.rows).toContainEqual(
        expect.objectContaining({
          rowKind: "guard",
          rawCount: 0,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          invalidContextPageDurationMsCount: 0,
        }),
      );
      expect(
        queries.filter((sql) => /AS MATERIALIZED/iu.test(sql)),
      ).toHaveLength(1);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("honors abort after the combined SQL completes before returning identities", async () => {
    const controller = new AbortController();
    const { env, database, queries } = sqliteEnv(
      [
        {
          visitId: "combined-abort-page",
          sessionId: "combined-abort-session",
          visitorId: "combined-abort-visitor",
          pageTimeMs: 10,
          pathname: "/combined-abort",
        },
      ],
      (_sql, _bindings, rows) => {
        if (rows.some((row) => row.rowKind === "guard")) controller.abort();
      },
    );
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    let nextCalled = false;
    try {
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "performance",
          advancedFilterInput(
            createQueryTime(0, 100, "UTC", 100),
            [SITE_ID],
            "count(page) gte 1",
          ),
          async (prepared) => {
            nextCalled = true;
            return prepared;
          },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(evaluatorSpy).not.toHaveBeenCalled();
      expect(nextCalled).toBe(false);
      expect(
        queries.filter((sql) => /AS MATERIALIZED/iu.test(sql)),
      ).toHaveLength(1);
      expect(queries).toHaveLength(2);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("preserves raw-site grouping across authorized full-history matcher chunks", async () => {
    const siteIds = teamSiteIds(26);
    const createdAtBySite = new Map([[siteIds[25]!, 2]]);
    const capturedQueries: Array<{
      readonly sql: string;
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv([], (sql, _bindings, rows) =>
      capturedQueries.push({ sql, rows }),
    );
    seedTeamSites(database, siteIds, createdAtBySite);
    addTeamPage(database, {
      siteId: siteIds[0]!,
      sitePk: 1,
      rawSiteId: siteIds[25],
      visitId: "cross-group-canonical-a-raw-b",
      sessionId: "cross-group-shared-session",
      startedAt: 1_500,
    });
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const time = {
        ...createQueryTime(1_000, 1_800, "UTC", 3_000),
        fullHistory: true,
      };
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "overview",
        advancedFilterTeamInput(time, siteIds),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterTeamInput>;

      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "site-identity-mismatch",
      });
      expect(evaluatorSpy).toHaveBeenCalled();
      const guard = capturedQueries.find(({ rows }) =>
        rows.some((row) => "siteIdentityMismatchCount" in row),
      );
      expect(guard?.rows[0]).toMatchObject({
        rawCount: 1,
        siteIdentityMismatchCount: 1,
      });
      expect(queries.some((sql) => /GROUP BY/iu.test(sql))).toBe(false);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("keeps same raw session ids separate across 91 authorized sites and returns the tail chunk", async () => {
    const siteIds = teamSiteIds(91);
    const { env, database, queries } = sqliteEnv([]);
    seedTeamSites(database, siteIds);
    const tailSiteId = siteIds.at(-1)!;
    addTeamPage(database, {
      siteId: tailSiteId,
      sitePk: siteIds.length,
      visitId: "tail-chunk-page",
      sessionId: "same-raw-session-id",
      startedAt: 10,
    });
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const time = createQueryTime(0, 100, "UTC", 100);
      const first = (await d1AdvancedFilterMiddleware(env)(
        "overview",
        advancedFilterTeamInput(time, siteIds),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterTeamInput>;
      expect(first.scopePlan?.advancedMatches?.entityIds).toEqual([
        { siteId: tailSiteId, id: "same-raw-session-id" },
      ]);
      expect(evaluatorSpy).not.toHaveBeenCalled();
      const firstQueries = [...queries];
      expect(firstQueries.filter((sql) => /rawCount/iu.test(sql))).toHaveLength(
        2,
      );
      expect(firstQueries.filter((sql) => /GROUP BY/iu.test(sql))).toHaveLength(
        2,
      );

      addTeamPage(database, {
        siteId: siteIds[0]!,
        sitePk: 1,
        visitId: "same-raw-session-first-site",
        sessionId: "same-raw-session-id",
        startedAt: 20,
      });
      queries.length = 0;
      const second = (await d1AdvancedFilterMiddleware(env)(
        "overview",
        advancedFilterTeamInput(time, siteIds, "count(page) gte 2"),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterTeamInput>;
      expect(second.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(evaluatorSpy).not.toHaveBeenCalled();
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("keeps root bare-field sums isolated by authorized site and scope identity", async () => {
    const siteIds = teamSiteIds(2);
    const { env, database, queries } = sqliteEnv([]);
    seedTeamSites(database, siteIds);
    addTeamPage(database, {
      siteId: siteIds[0]!,
      sitePk: 1,
      visitId: "bare-cross-site-page-a",
      sessionId: "bare-cross-site-shared-session",
      startedAt: 1_500,
    });
    addTeamPage(database, {
      siteId: siteIds[1]!,
      sitePk: 2,
      visitId: "bare-cross-site-page-b",
      sessionId: "bare-cross-site-shared-session",
      startedAt: 1_500,
    });
    database
      .prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?")
      .run("/same-site-a", "bare-cross-site-page-a");
    database
      .prepare("UPDATE visits SET pathname = ? WHERE visit_id = ?")
      .run("/same-site-b", "bare-cross-site-page-b");
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const time = createQueryTime(1_000, 2_000, "UTC", 3_000);
      const filterDsl =
        'page.path eq "/same-site-a" AND page.path eq "/same-site-b" AND count(page) gte 0';
      const supported = (await d1AdvancedFilterMiddleware(env)(
        "overview",
        advancedFilterTeamInput(time, siteIds, filterDsl),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterTeamInput>;
      expect(supported.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(evaluatorSpy).not.toHaveBeenCalled();
      expect(
        queries.some(
          (sql) => /GROUP BY/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(true);

      evaluatorSpy.mockClear();
      const compatibility = (await d1AdvancedFilterMiddleware(env)(
        "overview",
        advancedFilterTeamInput(
          time,
          siteIds,
          `${filterDsl} AND countDistinct(page) gte 0`,
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterTeamInput>;
      expect(compatibility.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(evaluatorSpy).toHaveBeenCalled();
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("accumulates the 20k raw cap across 90-site guard chunks before any matcher query", async () => {
    const siteIds = teamSiteIds(91);
    const capturedQueries: Array<{
      readonly sql: string;
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv([], (sql, _bindings, rows) =>
      capturedQueries.push({ sql, rows }),
    );
    seedTeamSites(database, siteIds);
    const insert = database.prepare(
      "INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, started_at, pathname, title, duration_ms, hostname) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    database.exec("BEGIN");
    try {
      for (let index = 0; index < 20_000; index += 1)
        insert.run(
          `raw-cap-page-${index}`,
          siteIds[0],
          1,
          "raw-cap-visitor",
          "raw-cap-session",
          10,
          "/raw-cap",
          "/raw-cap",
          index === 0 ? "0x10" : 5,
          "example.test",
        );
      insert.run(
        "raw-cap-tail-page",
        siteIds.at(-1)!,
        siteIds.length,
        "raw-cap-tail-visitor",
        "raw-cap-tail-session",
        10,
        "/raw-cap",
        "/raw-cap",
        5,
        "example.test",
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          advancedFilterTeamInput(
            createQueryTime(0, 100, "UTC", 100),
            siteIds,
            "count(page { page.durationMs gt 0 }) gte 1",
          ),
          async (input) => input,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(evaluatorSpy).not.toHaveBeenCalled();
      expect(
        capturedQueries.filter(({ rows }) =>
          rows.some((row) => "rawCount" in row),
        ),
      ).toHaveLength(2);
      expect(
        capturedQueries
          .filter(({ rows }) => rows.some((row) => "rawCount" in row))
          .reduce(
            (total, { rows }) =>
              total + Number(rows[0]?.invalidContextPageDurationMsCount ?? 0),
            0,
          ),
      ).toBe(1);
      expect(queries).toHaveLength(4);
      expect(queries.some((sql) => /GROUP BY/iu.test(sql))).toBe(false);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("stops before the next typed range read when execution is aborted", async () => {
    const controller = new AbortController();
    const { env, database, queries } = sqliteEnv(SHARED_ACTIVITIES, (sql) => {
      if (/custom_event_names/iu.test(sql)) controller.abort();
    });
    try {
      const time = {
        ...createQueryTime(1_000, 1_100, "UTC", 2_000),
        readRange: createTimeRange(0, 100),
      };
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          advancedFilterInput(time),
          async (prepared) => prepared,
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(
        queries.filter((sql) => /custom_event_names/iu.test(sql)),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("stops before the next payload range read when execution is aborted", async () => {
    const controller = new AbortController();
    const { env, database, queries } = sqliteEnv(SHARED_ACTIVITIES, (sql) => {
      if (/custom_event_json_nodes/iu.test(sql)) controller.abort();
    });
    try {
      const time = {
        ...createQueryTime(1_000, 1_100, "UTC", 2_000),
        readRange: createTimeRange(0, 100),
      };
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          advancedFilterInput(
            time,
            [SITE_ID],
            'first(event.payload("/amount")) eq 1',
          ),
          async (prepared) => prepared,
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(
        queries.filter((sql) => /custom_event_json_nodes/iu.test(sql)),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("propagates typed activity database failures without falling back", async () => {
    const { env, database, queries } = sqliteEnv();
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      database.exec("DROP TABLE custom_event_names");
      const time = createQueryTime(0, 2_000, "UTC", 2_000);
      await expect(
        d1AdvancedFilterMiddleware(env, diagnostics)(
          "performance",
          advancedFilterInput(time),
          async (prepared) => prepared,
        ),
      ).rejects.toThrow(/no such table: custom_event_names/iu);
      expect(queries.some((sql) => /custom_event_names/iu.test(sql))).toBe(
        true,
      );
      expect(evaluatorSpy).not.toHaveBeenCalled();
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("propagates typed payload database failures without falling back", async () => {
    const { env, database, queries } = sqliteEnv();
    try {
      database.exec("DROP TABLE custom_event_json_nodes");
      const time = createQueryTime(0, 2_000, "UTC", 2_000);
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          advancedFilterInput(
            time,
            [SITE_ID],
            'first(event.payload("/amount")) eq 1',
          ),
          async (prepared) => prepared,
        ),
      ).rejects.toThrow(/no such table: custom_event_json_nodes/iu);
      expect(queries.some((sql) => /custom_event_json_nodes/iu.test(sql))).toBe(
        true,
      );
    } finally {
      database.close();
    }
  });

  it("enforces the cumulative payload node budget with real SQLite rows", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "payload-limit-owner",
        sessionId: "payload-limit-session",
        visitorId: "payload-limit-visitor",
        pageTimeMs: 10,
        pathname: "/payload-limit",
        event: {
          id: "payload-limit-event",
          name: "purchase",
          timeMs: 1_010,
          payload: { amount: 1 },
        },
      },
    ];
    const { env, database, queries } = sqliteEnv(activities);
    try {
      const eventPk = database
        .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
        .get("payload-limit-event") as { event_pk: number };
      const path = database
        .prepare("SELECT id FROM custom_event_json_paths WHERE path = ?")
        .get("/amount") as { id: number };
      database
        .prepare("DELETE FROM custom_event_json_values WHERE event_pk = ?")
        .run(eventPk.event_pk);
      database
        .prepare("DELETE FROM custom_event_json_nodes WHERE event_pk = ?")
        .run(eventPk.event_pk);
      const insertNode = database.prepare(`
        INSERT INTO custom_event_json_nodes (
          event_pk, node_id, parent_node_id, key_id, path_id, value_type,
          array_index, depth, member_order
        ) VALUES (?, ?, NULL, NULL, ?, 0, NULL, 0, NULL)
      `);
      database.exec("BEGIN");
      try {
        for (let nodeId = 1; nodeId <= 50_001; nodeId++)
          insertNode.run(eventPk.event_pk, nodeId, path.id);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          advancedFilterInput(
            createQueryTime(0, 2_000, "UTC", 2_000),
            [SITE_ID],
            'first(event.payload("/amount")) eq 1',
          ),
          async (prepared) => prepared,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [
            { path: "filters", code: "filter_payload_node_limit_exceeded" },
          ],
        },
      });
      expect(
        queries.filter((sql) => /custom_event_json_nodes/iu.test(sql)),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  // The isolated V8-coverage run took about six seconds; leave a bounded 20s
  // for both real range reads and the overflow check under full-check CPU load.
  it("keeps the 20,000 activity budget across separate range reads", async () => {
    const pageCountPerRange = 10_000;
    const activities = Array.from(
      { length: pageCountPerRange * 2 },
      (_, index): SharedActivity => ({
        visitId: `limit-${index}`,
        sessionId: "session-limit",
        visitorId: "visitor-limit",
        pageTimeMs:
          index < pageCountPerRange
            ? index
            : 20_000 + index - pageCountPerRange,
        pathname: "/limit",
      }),
    );
    const { env, database, queries } = sqliteEnv(activities);
    try {
      const time = {
        ...createQueryTime(20_000, 30_000, "UTC", 31_000),
        readRange: createTimeRange(0, 10_000),
      };
      const input = advancedFilterInput(time);
      const output = (await d1AdvancedFilterMiddleware(env)(
        "overview",
        input,
        async (prepared) => prepared,
      )) as typeof input;
      expect(output.scopePlan.advancedMatches?.entityIds).toEqual([
        { siteId: SITE_ID, id: "session-limit" },
      ]);
      expect(
        queries.filter((sql) => /custom_event_names/iu.test(sql)),
      ).toHaveLength(3);

      database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, site_pk, visitor_id, session_id, started_at,
            pathname, title, duration_ms, hostname
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 5, ?)`,
        )
        .run(
          "limit-extra",
          SITE_ID,
          "visitor-limit",
          "session-limit",
          pageCountPerRange - 1,
          "/limit",
          "/limit",
          "example.test",
        );

      const beforeOverflowQueries = queries.length;
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          input,
          async (prepared) => prepared,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(
        queries
          .slice(beforeOverflowQueries)
          .filter((sql) => /custom_event_names/iu.test(sql)),
      ).toHaveLength(2);
      expect(
        queries.filter((sql) => /custom_event_names/iu.test(sql)),
      ).toHaveLength(5);
    } finally {
      database.close();
    }
  }, 20_000);

  it("matches the evaluator for bounded count arithmetic and empty bags", async () => {
    const cases: readonly AdvancedCountParityRequest[] = [
      {
        activities: [
          {
            visitId: "fraction-page-a",
            sessionId: "fraction-session",
            visitorId: "fraction-visitor",
            pageTimeMs: 15_100,
            pathname: "/fraction-a",
            event: {
              id: "fraction-event",
              name: "purchase",
              timeMs: 15_250,
            },
          },
          {
            visitId: "fraction-page-b",
            sessionId: "fraction-session",
            visitorId: "fraction-visitor",
            pageTimeMs: 15_300,
            pathname: "/fraction-b",
          },
        ],
        filterDsl:
          "div(count(event), count(page)) eq 0.5 AND (count(event) gt 0 OR NOT (count(page) lt 1))",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedAnchorPlan: "single-bag",
        capturedAtMs: 20_000,
      },
      {
        activities: [
          {
            visitId: "empty-read-candidate",
            sessionId: "empty-read-session",
            visitorId: "empty-read-visitor",
            pageTimeMs: 15_100,
            pathname: "/candidate",
          },
        ],
        filterDsl: "NOT (count(page) gt 0) AND count(event) eq 0",
        scope: "visitor",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        readRange: { startMs: 1_000, endExclusiveMs: 2_000 },
        expectedAnchorPlan: "two-bag",
        capturedAtMs: 20_000,
      },
      {
        activities: [
          {
            visitId: "event-only-filter-anchor",
            sessionId: "event-only-session",
            visitorId: "event-only-visitor",
            pageTimeMs: 10,
            pathname: "/before-filter-range",
            event: {
              id: "event-only-filter-event",
              name: "purchase",
              timeMs: 1_010,
            },
          },
        ],
        filterDsl:
          "NOT (div(count(event), count(page)) eq 0) AND div(count(event), count(page)) isNull",
        scope: "session",
        candidateRange: { startMs: 0, endExclusiveMs: 2_000 },
        filterRange: { startMs: 1_000, endExclusiveMs: 2_000 },
        expectedAnchorPlan: "single-bag",
        capturedAtMs: 3_000,
      },
      {
        activities: [
          {
            visitId: "broader-history-only",
            sessionId: "broader-history-only-session",
            visitorId: "broader-history-only-visitor",
            pageTimeMs: 1_100,
            pathname: "/history-only",
          },
          {
            visitId: "broader-target-history",
            sessionId: "broader-target-session",
            visitorId: "broader-target-visitor",
            pageTimeMs: 1_200,
            pathname: "/target-history",
          },
          {
            visitId: "broader-target-candidate",
            sessionId: "broader-target-session",
            visitorId: "broader-target-visitor",
            pageTimeMs: 15_100,
            pathname: "/target-candidate",
          },
        ],
        filterDsl: "count(page) eq 2",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        readRange: { startMs: 1_000, endExclusiveMs: 20_000 },
        expectedAnchorPlan: "single-bag",
        capturedAtMs: 20_000,
      },
      {
        activities: [
          {
            visitId: "ratio-add-page-a",
            sessionId: "ratio-add-session",
            visitorId: "ratio-add-visitor",
            pageTimeMs: 15_100,
            pathname: "/ratio-a",
            event: {
              id: "ratio-add-event",
              name: "purchase",
              timeMs: 15_250,
            },
          },
          {
            visitId: "ratio-add-page-b",
            sessionId: "ratio-add-session",
            visitorId: "ratio-add-visitor",
            pageTimeMs: 15_300,
            pathname: "/ratio-b",
          },
        ],
        filterDsl:
          "add(div(count(event), count(page)), div(count(event), count(page))) eq 1",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        capturedAtMs: 20_000,
      },
      {
        activities: [
          {
            visitId: "ratio-product-page-a",
            sessionId: "ratio-product-session",
            visitorId: "ratio-product-visitor",
            pageTimeMs: 15_100,
            pathname: "/ratio-a",
            event: {
              id: "ratio-product-event",
              name: "purchase",
              timeMs: 15_250,
            },
          },
          {
            visitId: "ratio-product-page-b",
            sessionId: "ratio-product-session",
            visitorId: "ratio-product-visitor",
            pageTimeMs: 15_300,
            pathname: "/ratio-b",
          },
        ],
        filterDsl: "mul(count(page), div(count(event), count(page))) eq 1",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        capturedAtMs: 20_000,
      },
    ];

    for (const request of cases) {
      const result = await evaluateAdvancedCountFixture(request);
      expect(result.d1, request.filterDsl).toEqual(result.oracle);
      if (request.expectedIdentities)
        expect(result.d1).toEqual(request.expectedIdentities);
      expect(
        result.queries.some(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(true);
      if (request.expectedAnchorPlan) {
        const matcher = result.queries.find(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        );
        expect(matcher).toBeDefined();
        expect(/SELECT\s+DISTINCT/iu.test(matcher!)).toBe(
          request.expectedAnchorPlan === "two-bag",
        );
      }
    }
  });

  it("aggregates root bare string fields independently from count predicates", async () => {
    const splitActivities = [
      {
        visitId: "bare-split-page-a",
        sessionId: "bare-split-session",
        visitorId: "bare-split-visitor",
        pageTimeMs: 18,
        pathname: "/a",
        title: "X",
      },
      {
        visitId: "bare-split-page-b",
        sessionId: "bare-split-session",
        visitorId: "bare-split-visitor",
        pageTimeMs: 19,
        pathname: "/b",
        title: "Y",
      },
    ] as const satisfies readonly SharedActivity[];
    const splitRanges = {
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      capturedAtMs: 100,
    } as const;
    const historyAndCandidate = [
      {
        visitId: "bare-history-page",
        sessionId: "bare-history-session",
        visitorId: "bare-history-visitor",
        pageTimeMs: 10,
        pathname: "/history",
      },
      {
        visitId: "bare-candidate-page",
        sessionId: "bare-history-session",
        visitorId: "bare-history-visitor",
        pageTimeMs: 20,
        pathname: "/candidate",
      },
    ] as const satisfies readonly SharedActivity[];
    const cases: readonly AdvancedCountParityRequest[] = [
      {
        activities: splitActivities,
        filterDsl:
          'page.path eq "/a" AND page.title eq "Y" AND count(page { page.path eq "/a" AND page.title eq "Y" }) eq 0',
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-split-session"],
      },
      {
        activities: splitActivities,
        filterDsl: 'NOT (page.path eq "/a") AND count(page) gte 0',
        scope: "session",
        ...splitRanges,
        expectedIdentities: [],
      },
      {
        activities: splitActivities,
        filterDsl: 'NOT (NOT (page.path eq "/a")) AND count(page) gte 0',
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-split-session"],
      },
      {
        activities: splitActivities,
        filterDsl:
          '(page.path eq "/missing" OR page.title eq "Y") AND count(page) gte 0',
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-split-session"],
      },
      {
        activities: [
          {
            visitId: "bare-missing-event-name-page",
            sessionId: "bare-missing-event-name-session",
            visitorId: "bare-missing-event-name-visitor",
            pageTimeMs: 18,
            pathname: "/page-only",
          },
        ],
        filterDsl:
          "event.name isNull AND count(event { event.name isNull }) eq 0",
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-missing-event-name-session"],
      },
      {
        activities: [
          {
            visitId: "bare-owner-outside-candidate",
            sessionId: "bare-owner-session",
            visitorId: "bare-owner-visitor",
            pageTimeMs: 10,
            pathname: "/owner",
            event: {
              id: "bare-owner-candidate-event",
              name: "purchase",
              timeMs: 20,
            },
          },
        ],
        filterDsl: 'page.path eq "/owner" AND count(page) gte 0',
        scope: "session",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 0, endExclusiveMs: 30 },
        expectedIdentities: ["bare-owner-session"],
        capturedAtMs: 100,
      },
      {
        activities: [
          {
            visitId: "bare-event-selector-page",
            sessionId: "bare-event-selector-session",
            visitorId: "bare-event-selector-visitor",
            pageTimeMs: 18,
            pathname: "/event-selector",
            title: "Event selector",
            event: {
              id: "bare-event-selector-event",
              name: "purchase",
              timeMs: 19,
            },
          },
        ],
        filterDsl:
          'page.path eq "/event-selector" AND page.title eq "Event selector" AND count(event { event.name eq "purchase" }) eq 1',
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-event-selector-session"],
      },
      {
        activities: historyAndCandidate,
        filterDsl: 'page.path eq "/history" AND count(page) gte 0',
        scope: "session",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 0, endExclusiveMs: 100 },
        expectedIdentities: [],
        capturedAtMs: 100,
      },
      {
        activities: historyAndCandidate,
        filterDsl: 'count(page { page.path eq "/history" }) eq 1',
        scope: "session",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 0, endExclusiveMs: 100 },
        expectedIdentities: ["bare-history-session"],
        capturedAtMs: 100,
      },
      {
        activities: historyAndCandidate,
        filterDsl: 'page.path eq "/history" AND count(page) gte 0',
        scope: "session",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 0, endExclusiveMs: 100 },
        filterRange: { startMs: 0, endExclusiveMs: 15 },
        expectedIdentities: ["bare-history-session"],
        capturedAtMs: 100,
      },
      {
        activities: historyAndCandidate,
        filterDsl:
          'page.path eq "/candidate" AND count(page { page.path eq "/history" }) eq 1',
        scope: "session",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 0, endExclusiveMs: 15 },
        expectedIdentities: ["bare-history-session"],
        capturedAtMs: 100,
      },
      {
        activities: historyAndCandidate,
        filterDsl: 'page.path eq "/candidate" AND count(page) eq 0',
        scope: "session",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 30, endExclusiveMs: 100 },
        expectedIdentities: ["bare-history-session"],
        capturedAtMs: 100,
      },
      {
        activities: historyAndCandidate,
        filterDsl: 'page.path eq "/candidate" AND count(page) eq 0',
        scope: "visitor",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 30, endExclusiveMs: 100 },
        expectedIdentities: ["bare-history-visitor"],
        capturedAtMs: 100,
      },
      {
        activities: [
          {
            visitId: "numeric-anchor-candidate-page",
            sessionId: "numeric-anchor-candidate-session",
            visitorId: "numeric-anchor-candidate-visitor",
            pageTimeMs: 20,
            pathname: "/candidate",
            durationMs: 10,
          },
        ],
        filterDsl: "count(page { page.durationMs gt 5 }) eq 0",
        scope: "session",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 30, endExclusiveMs: 100 },
        expectedIdentities: ["numeric-anchor-candidate-session"],
        capturedAtMs: 100,
      },
      {
        activities: [
          {
            visitId: "bare-visitor-page-a",
            sessionId: "bare-visitor-session-a",
            visitorId: "bare-shared-visitor",
            pageTimeMs: 18,
            pathname: "/visitor-a",
            title: "A",
          },
          {
            visitId: "bare-visitor-page-b",
            sessionId: "bare-visitor-session-b",
            visitorId: "bare-shared-visitor",
            pageTimeMs: 19,
            pathname: "/visitor-b",
            title: "B",
          },
        ],
        filterDsl:
          'page.path eq "/visitor-a" AND page.title eq "B" AND count(page) gte 0',
        scope: "visitor",
        ...splitRanges,
        expectedIdentities: ["bare-shared-visitor"],
      },
      {
        activities: [
          {
            visitId: "bare-null-path-page",
            sessionId: "bare-null-path-session",
            visitorId: "bare-null-path-visitor",
            pageTimeMs: 18,
            pathname: "/fallback",
            selectorPathOverride: null,
          },
        ],
        filterDsl: "page.path isNull AND count(page) gte 0",
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-null-path-session"],
      },
      {
        activities: [
          {
            visitId: "bare-empty-query-page",
            sessionId: "bare-empty-query-session",
            visitorId: "bare-empty-query-visitor",
            pageTimeMs: 18,
            pathname: "/empty-query",
            query: "",
          },
        ],
        filterDsl: "page.query isEmpty AND count(page) gte 0",
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-empty-query-session"],
      },
      {
        activities: [
          {
            visitId: "bare-blob-path-page",
            sessionId: "bare-blob-path-session",
            visitorId: "bare-blob-path-visitor",
            pageTimeMs: 18,
            pathname: "/fallback",
            selectorPathOverride: new Uint8Array([
              0x2f, 0x62, 0x6c, 0x6f, 0x62,
            ]),
          },
        ],
        filterDsl: 'page.path neq "/blob" AND count(page) gte 0',
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-blob-path-session"],
      },
      {
        activities: [
          {
            visitId: "bare-unicode-title-page",
            sessionId: "bare-unicode-title-session",
            visitorId: "bare-unicode-title-visitor",
            pageTimeMs: 18,
            pathname: "/unicode",
            title: "\u2003Café 😀\u00a0",
          },
        ],
        filterDsl: 'page.title contains "Café 😀" AND count(page) gte 0',
        scope: "session",
        ...splitRanges,
        expectedIdentities: ["bare-unicode-title-session"],
      },
      {
        activities: [
          {
            visitId: "bare-no-candidate-page",
            sessionId: "bare-no-candidate-session",
            visitorId: "bare-no-candidate-visitor",
            pageTimeMs: 10,
            pathname: "/history-only",
          },
        ],
        filterDsl: 'NOT (page.path eq "/missing") AND count(page) gte 0',
        scope: "session",
        candidateRange: { startMs: 15, endExclusiveMs: 25 },
        readRange: { startMs: 0, endExclusiveMs: 15 },
        expectedIdentities: [],
        capturedAtMs: 100,
      },
    ];

    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      for (const request of cases) {
        evaluatorSpy.mockClear();
        const result = await evaluateAdvancedCountFixture(request);
        expect(result.d1, request.filterDsl).toEqual(result.oracle);
        expect(result.d1, request.filterDsl).toEqual(
          request.expectedIdentities,
        );
        expect(result.fallbackReason, request.filterDsl).toBeUndefined();
        expect(evaluatorSpy, request.filterDsl).toHaveBeenCalledTimes(1);
        expect(
          result.queries.some(
            (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
          ),
          `${request.filterDsl}
${result.queries.join("\n")}`,
        ).toBe(true);
      }
    } finally {
      evaluatorSpy.mockRestore();
    }

    const blobCase = cases.find(({ filterDsl }) =>
      filterDsl.startsWith('page.path neq "/blob"'),
    );
    if (!blobCase) throw new Error("bare_blob_case_missing");
    const blobResult = await evaluateAdvancedCountFixture(blobCase);
    expect(
      blobResult.rawStringStorageTypes.find(
        ({ visitId }) => visitId === "bare-blob-path-page",
      )?.pathname,
    ).toBe("blob");
  });

  it("keeps unsupported root field trees on the complete evaluator path", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "bare-unsupported-page",
        sessionId: "bare-unsupported-session",
        visitorId: "bare-unsupported-visitor",
        pageTimeMs: 15_100,
        pathname: "/unsupported",
        durationMs: 5,
        event: {
          id: "bare-unsupported-event",
          name: "purchase",
          timeMs: 15_200,
          payload: { kind: "checkout" },
        },
      },
    ];
    const cases: readonly AdvancedCountParityRequest[] = [
      {
        activities,
        filterDsl:
          'page.path eq "/unsupported" AND page.hostname eq "example.test" AND count(page) eq 1',
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: ["bare-unsupported-session"],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl:
          'page.path eq "/unsupported" AND event.payload("/kind") eq "missing" AND count(page) eq 1',
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: [],
        capturedAtMs: 20_000,
      },
    ];
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      for (const request of cases) {
        evaluatorSpy.mockClear();
        const result = await evaluateAdvancedCountFixture(request);
        expect(result.d1, request.filterDsl).toEqual(result.oracle);
        expect(result.d1).toEqual(request.expectedIdentities);
        expect(evaluatorSpy, request.filterDsl).toHaveBeenCalledTimes(2);
        expect(
          result.queries.some(
            (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
          ),
        ).toBe(false);
      }
    } finally {
      evaluatorSpy.mockRestore();
    }
  });

  it("keeps valid string distinct reducers on the complete evaluator path", async () => {
    const filterDsl = "countDistinct(page.path) eq 2";
    const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
    expect(classifyAdvancedCountFilter(document, "session")).toMatchObject({
      kind: "unsupported",
    });

    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const result = await evaluateAdvancedCountFixture({
        activities: [
          {
            visitId: "string-distinct-hit-a",
            sessionId: "string-distinct-hit-session",
            visitorId: "string-distinct-hit-visitor",
            pageTimeMs: 15_100,
            pathname: "/a",
          },
          {
            visitId: "string-distinct-hit-b",
            sessionId: "string-distinct-hit-session",
            visitorId: "string-distinct-hit-visitor",
            pageTimeMs: 15_200,
            pathname: "/b",
          },
          {
            visitId: "string-distinct-hit-a-again",
            sessionId: "string-distinct-hit-session",
            visitorId: "string-distinct-hit-visitor",
            pageTimeMs: 15_300,
            pathname: "/a",
          },
          {
            visitId: "string-distinct-miss-a",
            sessionId: "string-distinct-miss-session",
            visitorId: "string-distinct-miss-visitor",
            pageTimeMs: 15_400,
            pathname: "/only-value",
          },
          {
            visitId: "string-distinct-miss-a-again",
            sessionId: "string-distinct-miss-session",
            visitorId: "string-distinct-miss-visitor",
            pageTimeMs: 15_500,
            pathname: "/only-value",
          },
        ],
        filterDsl,
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: ["string-distinct-hit-session"],
        capturedAtMs: 20_000,
      });

      expect(result.d1).toEqual(result.oracle);
      expect(result.d1).toEqual(["string-distinct-hit-session"]);
      expect(evaluatorSpy).toHaveBeenCalledTimes(2);
      expect(
        result.statements.some(
          ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(false);
    } finally {
      evaluatorSpy.mockRestore();
    }
  });

  it("keeps unsafe arithmetic trees wholly on the evaluator path", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "unbounded-count-page-a",
        sessionId: "unbounded-count-session",
        visitorId: "unbounded-count-visitor",
        pageTimeMs: 15_100,
        pathname: "/unbounded-a",
        title: "title-a",
        event: {
          id: "unbounded-count-event",
          name: "purchase",
          timeMs: 15_200,
        },
      },
      {
        visitId: "unbounded-count-page-b",
        sessionId: "unbounded-count-session",
        visitorId: "unbounded-count-visitor",
        pageTimeMs: 15_300,
        pathname: "/unbounded-b",
        title: "title-b",
      },
    ];
    const escapedLoneSurrogate = "\\uD800";
    const cases = [
      {
        filterDsl: "div(count(page), div(count(event), count(page))) eq 4",
        expectedIdentities: ["unbounded-count-session"],
      },
      {
        filterDsl: "div(count(page), countDistinct(page)) eq 2",
        expectedIdentities: ["unbounded-count-session"],
      },
      {
        filterDsl: "add(countDistinct(page), count(page)) eq 3",
        expectedIdentities: ["unbounded-count-session"],
      },
      {
        filterDsl:
          'count(page { page.hostname contains "unbounded" }) eq 0 AND count(page) eq 2',
        expectedIdentities: ["unbounded-count-session"],
      },
      {
        filterDsl: `count(page { page.path eq "${escapedLoneSurrogate}" }) eq 0 AND countDistinct(page) gte 0`,
        expectedIdentities: ["unbounded-count-session"],
      },
      {
        filterDsl: `count(page { page.path eq "${escapedLoneSurrogate}" }) eq 0 AND countDistinct(page) gte 0`,
        expectedIdentities: ["unbounded-count-session"],
      },
    ] as const;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      for (const { filterDsl, expectedIdentities } of cases) {
        evaluatorSpy.mockClear();
        const result = await evaluateAdvancedCountFixture({
          activities,
          filterDsl,
          scope: "session",
          candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
          expectedIdentities,
          capturedAtMs: 20_000,
        });
        expect(result.d1, filterDsl).toEqual(result.oracle);
        expect(result.d1, filterDsl).toEqual(expectedIdentities);
        expect(evaluatorSpy).toHaveBeenCalledTimes(2);
        expect(
          result.statements.some(
            ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
          ),
        ).toBe(false);
      }
    } finally {
      evaluatorSpy.mockRestore();
    }
  });

  it("keeps legal nested count selectors wholly on the evaluator path", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "nested-count-page-a",
        sessionId: "nested-count-session",
        visitorId: "nested-count-visitor",
        pageTimeMs: 15_100,
        pathname: "/x",
        event: {
          id: "nested-count-event",
          name: "purchase",
          timeMs: 15_200,
        },
      },
      {
        visitId: "nested-count-page-b",
        sessionId: "nested-count-session",
        visitorId: "nested-count-visitor",
        pageTimeMs: 15_300,
        pathname: "/y",
      },
    ];
    const cases = [
      "count(event) gte 1 AND count(session { count(page) gte 1 }) eq 1",
      "count(event) gte 1 AND count(visitor { count(page) gte 1 }) eq 1",
      'count(event) gte 1 AND count(page { page.path eq "/x" } { page.path neq "/y" }) eq 1',
    ] as const;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      for (const filterDsl of cases) {
        const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
        expect(classifyAdvancedCountFilter(document, "session")).toMatchObject({
          kind: "unsupported",
          path: "root.children[1].target.input",
          code: "count_sql_selector_requires_page_or_event",
        });

        evaluatorSpy.mockClear();
        const result = await evaluateAdvancedCountFixture({
          activities,
          filterDsl,
          scope: "session",
          candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
          expectedIdentities: ["nested-count-session"],
          capturedAtMs: 20_000,
        });
        expect(result.d1, filterDsl).toEqual(result.oracle);
        expect(result.d1, filterDsl).toEqual(["nested-count-session"]);
        expect(evaluatorSpy).toHaveBeenCalledTimes(2);
        expect(
          result.statements.some(
            ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
          ),
        ).toBe(false);
      }
    } finally {
      evaluatorSpy.mockRestore();
    }
  });

  it("falls back the whole count tree when a selector Boolean child is unsupported", async () => {
    const filterDsl =
      'count(event) gte 1 AND count(page { page.path eq "/x" AND page.hostname eq "other" }) eq 0';
    const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
    expect(classifyAdvancedCountFilter(document, "session")).toMatchObject({
      kind: "unsupported",
      path: "root.children[1].target.input.predicate.children[0].target",
      code: "count_sql_selector_field_mismatch",
    });

    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const result = await evaluateAdvancedCountFixture({
        activities: [
          {
            visitId: "unsupported-selector-page",
            sessionId: "unsupported-selector-session",
            visitorId: "unsupported-selector-visitor",
            pageTimeMs: 15_100,
            pathname: "/x",
            title: "actual title",
            event: {
              id: "unsupported-selector-event",
              name: "purchase",
              timeMs: 15_200,
            },
          },
        ],
        filterDsl,
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: ["unsupported-selector-session"],
        capturedAtMs: 20_000,
      });

      expect(result.d1).toEqual(result.oracle);
      expect(result.d1).toEqual(["unsupported-selector-session"]);
      expect(evaluatorSpy).toHaveBeenCalledTimes(2);
      expect(
        result.statements.some(
          ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(false);
    } finally {
      evaluatorSpy.mockRestore();
    }
  });

  it("matches numeric sets and closed ranges across SQL and evaluator semantics", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "numeric-set-page-a",
        sessionId: "numeric-set-session",
        visitorId: "numeric-set-visitor",
        pageTimeMs: 15_100,
        pathname: "/set-a",
        event: {
          id: "numeric-set-event",
          name: "purchase",
          timeMs: 15_200,
        },
      },
      {
        visitId: "numeric-set-page-b",
        sessionId: "numeric-set-session",
        visitorId: "numeric-set-visitor",
        pageTimeMs: 15_300,
        pathname: "/set-b",
      },
    ];
    const cases: readonly AdvancedCountParityRequest[] = [
      {
        activities,
        filterDsl:
          "count(page) in [0, 2, 2] AND count(page) notIn [0, 1] AND count(page) between [2, 2] AND count(page) between [1, 2] AND count(page) between [2, 3] AND (count(page) in [1] OR count(page) in [2])",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedAnchorPlan: "single-bag",
        expectedIdentities: ["numeric-set-session"],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl: "count(page) in [3, 4] OR count(page) in [null]",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: [],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl: "count(page) between [3, 4]",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: [],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl: "count(page) in [null]",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: [],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl: "count(page) notIn [null]",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: ["numeric-set-session"],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl: "count(page) in [null] AND count(page) notIn [null]",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: [],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl:
          "div(count(event), sub(count(page), count(page))) notIn [0, 1]",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: [],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl:
          "NOT (div(count(event), sub(count(page), count(page))) notIn [0, 1])",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: ["numeric-set-session"],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl:
          "div(count(event), count(page)) in [0.5, 0.25] AND sub(count(event), count(page)) in [-1, -0]",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: ["numeric-set-session"],
        capturedAtMs: 20_000,
      },
      {
        activities,
        filterDsl: "sub(count(page), count(page)) in [-0]",
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: ["numeric-set-session"],
        capturedAtMs: 20_000,
      },
      {
        activities: activities.map((activity, index) => ({
          ...activity,
          sessionId: `numeric-set-visitor-session-${index}`,
        })),
        filterDsl: "count(page) between [2, 2] AND count(page) notIn [0, 1]",
        scope: "visitor",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        expectedIdentities: ["numeric-set-visitor"],
        capturedAtMs: 20_000,
      },
      {
        activities: [
          {
            visitId: "numeric-set-empty-read-page",
            sessionId: "numeric-set-empty-read-session",
            visitorId: "numeric-set-empty-read-visitor",
            pageTimeMs: 15_100,
            pathname: "/candidate-only",
          },
        ],
        filterDsl: "count(page) in [0]",
        scope: "visitor",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        readRange: { startMs: 1_000, endExclusiveMs: 2_000 },
        expectedAnchorPlan: "two-bag",
        expectedIdentities: ["numeric-set-empty-read-visitor"],
        capturedAtMs: 20_000,
      },
    ];

    for (const request of cases) {
      const result = await evaluateAdvancedCountFixture(request);
      expect(result.d1, request.filterDsl).toEqual(result.oracle);
      expect(result.d1).toEqual(request.expectedIdentities);
      expect(
        result.queries.some(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
        `${request.filterDsl}
${result.queries.join("\n")}`,
      ).toBe(true);
      if (request.expectedAnchorPlan) {
        const matcher = result.queries.find(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        );
        expect(matcher).toBeDefined();
        expect(/SELECT\s+DISTINCT/iu.test(matcher!)).toBe(
          request.expectedAnchorPlan === "two-bag",
        );
      }
    }
  });

  it("matches local Page text-field count selectors with raw storage semantics", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "selector-page-fields-target",
        sessionId: "selector-page-fields-target-session",
        visitorId: "selector-page-fields-shared-visitor",
        pageTimeMs: 15_100,
        pathname: "/shared-page",
        title: "\u2003Pricing Café\u00a0",
        query: "\u2003?utm=gold\u00a0",
        hash: "\u2003#Top\u00a0",
        event: {
          id: "selector-page-fields-target-event",
          name: "purchase",
          timeMs: 15_110,
        },
      },
      {
        visitId: "selector-page-fields-cross-a",
        sessionId: "selector-page-fields-cross-session",
        visitorId: "selector-page-fields-cross-visitor",
        pageTimeMs: 15_200,
        pathname: "/cross-a",
        title: "Pricing",
        query: "?utm=other",
        hash: "#A",
      },
      {
        visitId: "selector-page-fields-cross-b",
        sessionId: "selector-page-fields-cross-session",
        visitorId: "selector-page-fields-cross-visitor",
        pageTimeMs: 15_300,
        pathname: "/cross-b",
        title: "Other",
        query: "?utm=paid",
        hash: "#B",
      },
      {
        visitId: "selector-page-fields-query",
        sessionId: "selector-page-fields-query-session",
        visitorId: "selector-page-fields-shared-visitor",
        pageTimeMs: 15_400,
        pathname: "/query",
        title: "Landing",
        query: "\u2003?utm=paid\u00a0",
        hash: "#Landing",
      },
      {
        visitId: "selector-page-fields-hash",
        sessionId: "selector-page-fields-hash-session",
        visitorId: "selector-page-fields-hash-visitor",
        pageTimeMs: 15_500,
        pathname: "/hash",
        title: "Docs",
        query: "",
        hash: "\u2003#Section\u00a0",
      },
      {
        visitId: "selector-page-fields-blob",
        sessionId: "selector-page-fields-blob-session",
        visitorId: "selector-page-fields-blob-visitor",
        pageTimeMs: 15_600,
        pathname: "/blob",
        query: "",
        hash: "",
        selectorTitleOverride: new TextEncoder().encode("Pricing"),
      },
      {
        visitId: "selector-page-fields-null",
        sessionId: "selector-page-fields-null-session",
        visitorId: "selector-page-fields-null-visitor",
        pageTimeMs: 15_700,
        pathname: "/null",
        query: "",
        hash: "",
        selectorTitleOverride: null,
      },
    ];
    const shared = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
      capturedAtMs: 20_000,
    };
    const cases: readonly (AdvancedCountParityRequest & {
      readonly filterDsl: string;
      readonly expectedIdentities: readonly string[];
    })[] = [
      {
        ...shared,
        filterDsl: 'count(page { page.title contains "Café" }) eq 1',
        expectedIdentities: ["selector-page-fields-target-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.title eq ${JSON.stringify("Pricing Café")} }) eq 1`,
        expectedIdentities: ["selector-page-fields-target-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.query startsWith ${JSON.stringify("?utm=paid")} }) eq 1`,
        expectedIdentities: [
          "selector-page-fields-cross-session",
          "selector-page-fields-query-session",
        ],
      },
      {
        ...shared,
        filterDsl: `count(page { page.query contains ${JSON.stringify("\u2003utm=gold\u00a0")} }) eq 1`,
        expectedIdentities: ["selector-page-fields-target-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.hash endsWith ${JSON.stringify("Section")} }) eq 1`,
        expectedIdentities: ["selector-page-fields-hash-session"],
      },
      {
        ...shared,
        filterDsl:
          'count(page { page.title contains "Pricing" AND page.query endsWith "gold" AND page.hash endsWith "Top" }) eq 1',
        expectedIdentities: ["selector-page-fields-target-session"],
      },
      {
        ...shared,
        filterDsl:
          'count(page { page.title contains "Pricing" AND page.query contains "paid" }) eq 1',
        expectedIdentities: [],
      },
      {
        ...shared,
        filterDsl:
          'count(page { page.title contains "Pricing" OR page.query contains "paid" }) eq 2',
        expectedIdentities: ["selector-page-fields-cross-session"],
      },
      {
        ...shared,
        filterDsl: 'count(page { NOT (page.title contains "Pricing") }) eq 1',
        expectedIdentities: [
          "selector-page-fields-blob-session",
          "selector-page-fields-cross-session",
          "selector-page-fields-hash-session",
          "selector-page-fields-null-session",
          "selector-page-fields-query-session",
        ],
      },
      {
        ...shared,
        filterDsl: "count(page { page.title isNull }) eq 1",
        expectedIdentities: ["selector-page-fields-null-session"],
      },
      {
        ...shared,
        activities: [activities[0]!, activities[3]!],
        scope: "visitor",
        filterDsl: 'count(page { page.hash eq "#Top" }) eq 1',
        expectedIdentities: ["selector-page-fields-shared-visitor"],
      },
    ];

    for (const request of cases) {
      const result = await evaluateAdvancedCountFixture(request);
      expect(result.d1, request.filterDsl).toEqual(result.oracle);
      expect(result.d1, request.filterDsl).toEqual(
        [...request.expectedIdentities].sort(),
      );
      expect(result.fallbackReason, request.filterDsl).toBeUndefined();
      const matcher = result.queries.find(
        (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(matcher, request.filterDsl).toBeDefined();
      if (!/\b(?:isNull|notNull)\b/u.test(request.filterDsl))
        expect(matcher, request.filterDsl).toMatch(/typeof\s*\(/iu);
    }
  });

  it("preserves raw Page presence and empty-string count semantics", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "selector-presence-empty-page",
        sessionId: "selector-presence-empty-session",
        visitorId: "selector-presence-empty-visitor",
        pageTimeMs: 16_010,
        pathname: "/empty",
        title: "",
      },
      {
        visitId: "selector-presence-ascii-page",
        sessionId: "selector-presence-ascii-session",
        visitorId: "selector-presence-shared-visitor",
        pageTimeMs: 16_020,
        pathname: "/ascii-space",
        title: " \t ",
      },
      {
        visitId: "selector-presence-unicode-page",
        sessionId: "selector-presence-unicode-session",
        visitorId: "selector-presence-shared-visitor",
        pageTimeMs: 16_030,
        pathname: "/unicode-space",
        title: "\u2003\u00a0",
      },
      {
        visitId: "selector-presence-text-page",
        sessionId: "selector-presence-text-session",
        visitorId: "selector-presence-text-visitor",
        pageTimeMs: 16_040,
        pathname: "/text",
        title: "x",
        event: {
          id: "selector-presence-text-event",
          name: "purchase",
          timeMs: 16_041,
        },
      },
      {
        visitId: "selector-presence-empty-blob-page",
        sessionId: "selector-presence-empty-blob-session",
        visitorId: "selector-presence-empty-blob-visitor",
        pageTimeMs: 16_050,
        pathname: "/empty-blob",
        selectorTitleOverride: new TextEncoder().encode(""),
      },
      {
        visitId: "selector-presence-blob-page",
        sessionId: "selector-presence-blob-session",
        visitorId: "selector-presence-blob-visitor",
        pageTimeMs: 16_060,
        pathname: "/blob",
        selectorTitleOverride: new TextEncoder().encode("x"),
      },
      {
        visitId: "selector-presence-null-page",
        sessionId: "selector-presence-null-session",
        visitorId: "selector-presence-null-visitor",
        pageTimeMs: 16_070,
        pathname: "/null",
        selectorTitleOverride: null,
      },
    ];
    const shared = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 16_000, endExclusiveMs: 17_000 },
      capturedAtMs: 20_000,
    };
    const cases: readonly (AdvancedCountParityRequest & {
      readonly filterDsl: string;
      readonly expectedIdentities: readonly string[];
    })[] = [
      {
        ...shared,
        filterDsl: "count(page { page.title exists }) eq 1",
        expectedIdentities: [
          "selector-presence-ascii-session",
          "selector-presence-blob-session",
          "selector-presence-empty-blob-session",
          "selector-presence-empty-session",
          "selector-presence-text-session",
          "selector-presence-unicode-session",
        ],
      },
      {
        ...shared,
        filterDsl: "count(page { page.title notExists }) eq 1",
        expectedIdentities: ["selector-presence-null-session"],
      },
      {
        ...shared,
        filterDsl: "count(page { page.title isEmpty }) eq 1",
        expectedIdentities: ["selector-presence-empty-session"],
      },
      {
        ...shared,
        filterDsl: "count(page { page.title notEmpty }) eq 1",
        expectedIdentities: [
          "selector-presence-ascii-session",
          "selector-presence-text-session",
          "selector-presence-unicode-session",
        ],
      },
      {
        ...shared,
        filterDsl: "count(page { NOT (page.title isEmpty) }) eq 1",
        expectedIdentities: [
          "selector-presence-ascii-session",
          "selector-presence-blob-session",
          "selector-presence-empty-blob-session",
          "selector-presence-null-session",
          "selector-presence-text-session",
          "selector-presence-unicode-session",
        ],
      },
      {
        ...shared,
        filterDsl: "count(page { NOT (page.title notEmpty) }) eq 1",
        expectedIdentities: [
          "selector-presence-empty-blob-session",
          "selector-presence-empty-session",
          "selector-presence-null-session",
          "selector-presence-blob-session",
        ],
      },
      {
        ...shared,
        filterDsl: "count(page { NOT (page.title exists) }) eq 1",
        expectedIdentities: ["selector-presence-null-session"],
      },
      {
        ...shared,
        filterDsl: "count(page { NOT (page.title notExists) }) eq 1",
        expectedIdentities: [
          "selector-presence-ascii-session",
          "selector-presence-blob-session",
          "selector-presence-empty-blob-session",
          "selector-presence-empty-session",
          "selector-presence-text-session",
          "selector-presence-unicode-session",
        ],
      },
      {
        ...shared,
        filterDsl:
          'count(page { page.title notEmpty AND page.title contains "x" }) eq 1',
        expectedIdentities: ["selector-presence-text-session"],
      },
      {
        ...shared,
        activities: [activities[1]!, activities[2]!],
        scope: "visitor",
        filterDsl: "count(page { page.title notEmpty }) eq 2",
        expectedIdentities: ["selector-presence-shared-visitor"],
      },
      {
        ...shared,
        filterDsl: "count(event { event.name exists }) eq 1",
        expectedIdentities: ["selector-presence-text-session"],
      },
      {
        ...shared,
        filterDsl: "count(event { event.name notEmpty }) eq 1",
        expectedIdentities: ["selector-presence-text-session"],
      },
      {
        ...shared,
        filterDsl: "count(event { event.name isEmpty }) eq 1",
        expectedIdentities: [],
      },
    ];

    for (const request of cases) {
      const result = await evaluateAdvancedCountFixture(request);
      expect(result.d1, request.filterDsl).toEqual(result.oracle);
      expect(result.d1, request.filterDsl).toEqual(
        [...request.expectedIdentities].sort(),
      );
      expect(result.fallbackReason, request.filterDsl).toBeUndefined();
      const matcher = result.queries.find(
        (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(matcher, request.filterDsl).toBeDefined();
      if (/\b(?:isNull|notNull|exists|notExists)\b/u.test(request.filterDsl))
        expect(matcher, request.filterDsl).not.toMatch(/typeof\s*\(/iu);
      else expect(matcher, request.filterDsl).toMatch(/typeof\s*\(/iu);
    }
  });

  it("counts finite Page numeric scalars and distinct NULL values", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "scalar-distinct-page-a",
        sessionId: "scalar-distinct-session",
        visitorId: "scalar-distinct-visitor",
        pageTimeMs: 18_010,
        pathname: "/selected/a",
        durationMs: 10,
        perfCls: 0.5,
        event: {
          id: "scalar-distinct-event-a",
          name: "purchase",
          timeMs: 18_011,
        },
      },
      {
        visitId: "scalar-distinct-page-b",
        sessionId: "scalar-distinct-session",
        visitorId: "scalar-distinct-visitor",
        pageTimeMs: 18_020,
        pathname: "/selected/b",
        durationMs: null,
        perfCls: null,
      },
      {
        visitId: "scalar-distinct-page-c",
        sessionId: "scalar-distinct-session",
        visitorId: "scalar-distinct-visitor",
        pageTimeMs: 18_030,
        pathname: "/other",
        durationMs: null,
        perfCls: 0.5,
      },
    ];
    const request = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 18_000, endExclusiveMs: 19_000 },
      capturedAtMs: 20_000,
      filterDsl:
        'count(page.durationMs) eq 3 AND countDistinct(page.durationMs) eq 2 AND count(page { page.path startsWith "/selected" }.durationMs) eq 2 AND countDistinct(page { page.path startsWith "/selected" }.performance.cls) eq 2',
    };

    const result = await evaluateAdvancedCountFixture(request);
    expect(result.d1).toEqual(result.oracle);
    expect(result.d1).toEqual(["scalar-distinct-session"]);
    expect(result.fallbackReason).toBeUndefined();
    const matcher = result.statements.find(({ sql }) =>
      /COUNT\s*\(\s*DISTINCT/iu.test(sql),
    );
    expect(matcher).toBeDefined();
    expect(matcher!.sql).toMatch(/SUM\s*\(/iu);

    const countOnly = await evaluateAdvancedCountFixture({
      ...request,
      filterDsl: "count(page.durationMs) eq 3",
    });
    expect(countOnly.d1).toEqual(countOnly.oracle);
    expect(countOnly.d1).toEqual(["scalar-distinct-session"]);
    expect(countOnly.fallbackReason).toBeUndefined();
    const countOnlyMatcher = countOnly.statements.find(({ sql }) =>
      /\bGROUP BY\b/iu.test(sql),
    );
    expect(countOnlyMatcher).toBeDefined();
    expect(countOnlyMatcher!.sql).not.toMatch(/typeof\s*\(/iu);

    const legacy = await evaluateAdvancedCountFixture({
      ...request,
      activities: [
        { ...activities[0]!, selectorDurationMsOverride: "text-value" },
        activities[1]!,
        activities[2]!,
      ],
      filterDsl: "countDistinct(page.durationMs) eq 3",
    });
    expect(legacy.d1).toEqual(legacy.oracle);
    expect(legacy.rawNumericStorageTypes[0]?.durationMs).toBe("text");
    expect(legacy.fallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
  });

  it("counts string members as collection rows and reuses presence counts", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "string-cardinality-page-a",
        sessionId: "string-cardinality-session",
        visitorId: "string-cardinality-visitor",
        pageTimeMs: 18_110,
        pathname: "/page-a",
        title: "selected",
        selectorPathOverride: null,
        selectorQueryOverride: new Uint8Array([255]),
        selectorHashOverride: null,
        event: {
          id: "string-cardinality-event-a",
          name: "view",
          timeMs: 18_111,
          selectorNameOverride: new Uint8Array([255]),
        },
      },
      {
        visitId: "string-cardinality-page-b",
        sessionId: "string-cardinality-session",
        visitorId: "string-cardinality-visitor",
        pageTimeMs: 18_120,
        pathname: "/page-b",
        title: "other",
        query: "",
        hash: "#page-b",
        event: {
          id: "string-cardinality-event-b",
          name: "purchase",
          timeMs: 18_121,
        },
      },
    ];
    const shared = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 18_000, endExclusiveMs: 19_000 },
      capturedAtMs: 20_000,
      expectedIdentities: ["string-cardinality-session"],
    };
    const cases = [
      "count(page.path) eq 2 AND count(page.title) eq 2 AND count(page.query) eq 2 AND count(page.hash) eq 2 AND count(event.name) eq 2 AND count(page.durationMs) eq 2",
      'count(page { page.title eq "selected" }) eq 1 AND count(page { page.title eq "selected" }.path) eq 1 AND page { page.title eq "selected" }.path exists',
      'page { page.title eq "selected" }.path exists AND page { page.title eq "missing" }.hash notExists',
      'NOT (page { page.title eq "selected" }.path exists)',
      "page.path exists AND count(page.path) eq 2",
      'page { page.title eq "selected" } exists',
      'page { page.title eq "missing" } notExists',
      'page { page.title eq "selected" }.path notExists',
      'page { page.title eq "missing" }.hash notExists',
      'event { event.name eq "purchase" } exists',
      'event { event.name eq "missing" } notExists',
      'event { event.name eq "purchase" }.name exists',
      'event { event.name eq "missing" }.name notExists',
      "page exists AND event exists",
    ];

    for (const filterDsl of cases) {
      const result = await evaluateAdvancedCountFixture({
        ...shared,
        filterDsl,
        expectedIdentities:
          filterDsl === 'page { page.title eq "selected" }.path notExists' ||
          filterDsl === 'NOT (page { page.title eq "selected" }.path exists)'
            ? []
            : shared.expectedIdentities,
      });
      expect(result.d1, filterDsl).toEqual(result.oracle);
      expect(result.d1, filterDsl).toEqual(
        filterDsl === 'page { page.title eq "selected" }.path notExists' ||
          filterDsl === 'NOT (page { page.title eq "selected" }.path exists)'
          ? []
          : shared.expectedIdentities,
      );
      expect(result.fallbackReason, filterDsl).toBeUndefined();
      const matcher = result.queries.find(
        (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(matcher, filterDsl).toBeDefined();
      if (filterDsl.startsWith("count(page.path)"))
        expect(matcher).not.toMatch(/IsString|SafeNumber|typeof\s*\(/iu);
      if (filterDsl.startsWith('count(page { page.title eq "selected" })'))
        expect(matcher!.match(/TRIM\s*\(/giu)).toHaveLength(1);
    }

    const visitorResult = await evaluateAdvancedCountFixture({
      ...shared,
      scope: "visitor",
      filterDsl:
        "count(page.path) eq 2 AND count(event.name) eq 2 AND page exists",
      expectedIdentities: ["string-cardinality-visitor"],
    });
    expect(visitorResult.d1).toEqual(visitorResult.oracle);
    expect(visitorResult.d1).toEqual(["string-cardinality-visitor"]);
    expect(visitorResult.fallbackReason).toBeUndefined();

    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const unsupported = await evaluateAdvancedCountFixture({
        ...shared,
        filterDsl:
          'count(page.path) eq 2 AND page { page.title eq "selected" }.path notEmpty',
        expectedIdentities: [],
      });
      expect(unsupported.d1).toEqual(unsupported.oracle);
      expect(unsupported.d1).toEqual([]);
      expect(evaluatorSpy).toHaveBeenCalledTimes(2);
      expect(
        unsupported.queries.some(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(false);
    } finally {
      evaluatorSpy.mockRestore();
    }
  });

  it("keeps Event counts independent of an out-of-range owner Page", async () => {
    const request = {
      activities: [
        {
          visitId: "event-only-out-of-range-page",
          sessionId: "event-only-session",
          visitorId: "event-only-visitor",
          pageTimeMs: 10,
          pathname: "/outside-read-range",
          event: {
            id: "event-only-in-range-event",
            name: "purchase",
            timeMs: 90,
          },
        },
      ] satisfies readonly SharedActivity[],
      scope: "session" as const,
      candidateRange: { startMs: 80, endExclusiveMs: 100 },
      readRange: { startMs: 80, endExclusiveMs: 100 },
      capturedAtMs: 100,
      filterDsl: "page notExists AND count(event.name) eq 1",
      expectedIdentities: ["event-only-session"],
    };
    const result = await evaluateAdvancedCountFixture(request);
    expect(result.d1).toEqual(result.oracle);
    expect(result.d1).toEqual(request.expectedIdentities);
    expect(result.fallbackReason).toBeUndefined();
  });

  it("keeps string-member cardinality in candidate, read, and Filter ranges", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "string-range-history-a",
        sessionId: "string-range-session",
        visitorId: "string-range-visitor",
        pageTimeMs: 10,
        pathname: "/history-a",
        durationMs: 5,
      },
      {
        visitId: "string-range-history-b",
        sessionId: "string-range-session",
        visitorId: "string-range-visitor",
        pageTimeMs: 12,
        pathname: "/history-b",
        durationMs: 6,
      },
      {
        visitId: "string-range-candidate",
        sessionId: "string-range-session",
        visitorId: "string-range-visitor",
        pageTimeMs: 20,
        pathname: "/candidate",
        durationMs: 99,
      },
    ];
    const shared = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      capturedAtMs: 100,
      expectedIdentities: ["string-range-session"],
    };
    const cases: readonly AdvancedCountParityRequest[] = [
      {
        ...shared,
        expectedAnchorPlan: "single-bag",
        filterDsl:
          "count(page.path) eq 1 AND count(page.durationMs) eq 1 AND page exists",
      },
      {
        ...shared,
        readRange: { startMs: 0, endExclusiveMs: 30 },
        expectedAnchorPlan: "single-bag",
        filterDsl:
          "count(page.path) eq 3 AND count(page.durationMs) eq 3 AND page exists",
      },
      {
        ...shared,
        readRange: { startMs: 0, endExclusiveMs: 15 },
        expectedAnchorPlan: "two-bag",
        filterDsl:
          "count(page.path) eq 2 AND count(page.durationMs) eq 2 AND page exists",
      },
      {
        ...shared,
        readRange: { startMs: 0, endExclusiveMs: 30 },
        filterRange: { startMs: 0, endExclusiveMs: 15 },
        filterDsl:
          "count(page.path) eq 2 AND count(page.durationMs) eq 2 AND page exists",
      },
    ];

    for (const request of cases) {
      const result = await evaluateAdvancedCountFixture(request);
      expect(result.d1, request.filterDsl).toEqual(result.oracle);
      expect(result.d1, request.filterDsl).toEqual(request.expectedIdentities);
      expect(result.fallbackReason, request.filterDsl).toBeUndefined();
      const matcher = result.queries.find(
        (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(matcher, request.filterDsl).toBeDefined();
      if (request.expectedAnchorPlan)
        expect(/SELECT\s+DISTINCT/iu.test(matcher!)).toBe(
          request.expectedAnchorPlan === "two-bag",
        );
    }
  });

  it("keeps scalar distinct values scoped to each candidate and expression bag", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "range-scalar-history-a",
        sessionId: "range-scalar-session",
        visitorId: "range-scalar-visitor",
        pageTimeMs: 10,
        pathname: "/history/a",
        durationMs: 5,
        perfCls: 0.75,
      },
      {
        visitId: "range-scalar-history-b",
        sessionId: "range-scalar-session",
        visitorId: "range-scalar-visitor",
        pageTimeMs: 12,
        pathname: "/history/b",
        durationMs: 6,
        perfCls: 0.75,
      },
      {
        visitId: "range-scalar-candidate",
        sessionId: "range-scalar-session",
        visitorId: "range-scalar-visitor",
        pageTimeMs: 20,
        pathname: "/candidate",
        durationMs: 99,
        perfCls: null,
      },
    ];
    const shared = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      capturedAtMs: 100,
      expectedIdentities: ["range-scalar-session"],
    };
    const cases: readonly AdvancedCountParityRequest[] = [
      {
        ...shared,
        readRange: { startMs: 0, endExclusiveMs: 30 },
        expectedAnchorPlan: "single-bag",
        filterDsl:
          "countDistinct(page.durationMs) eq 3 AND countDistinct(page.performance.cls) eq 2",
      },
      {
        ...shared,
        readRange: { startMs: 0, endExclusiveMs: 15 },
        expectedAnchorPlan: "two-bag",
        filterDsl:
          "countDistinct(page.durationMs) eq 2 AND countDistinct(page.performance.cls) eq 1",
      },
      {
        ...shared,
        readRange: { startMs: 0, endExclusiveMs: 15 },
        filterDsl:
          'page.path eq "/candidate" AND countDistinct(page.durationMs) eq 2',
      },
    ];

    for (const request of cases) {
      const result = await evaluateAdvancedCountFixture(request);
      expect(result.d1, request.filterDsl).toEqual(result.oracle);
      expect(result.d1, request.filterDsl).toEqual(request.expectedIdentities);
      expect(result.fallbackReason, request.filterDsl).toBeUndefined();
      const matcher = result.statements.find(({ sql }) =>
        /COUNT\s*\(\s*DISTINCT/iu.test(sql),
      );
      expect(matcher, request.filterDsl).toBeDefined();
      expect(matcher!.sql, request.filterDsl).toMatch(/typeof\s*\(/iu);
      expect(matcher!.sql, request.filterDsl).not.toMatch(
        /CAST\s*\([^)]*duration_ms/iu,
      );
      if (request.expectedAnchorPlan)
        expect(/SELECT\s+DISTINCT/iu.test(matcher!.sql)).toBe(
          request.expectedAnchorPlan === "two-bag",
        );
    }

    const eventOnlyOwnerPage = await evaluateAdvancedCountFixture({
      activities: [
        {
          visitId: "range-scalar-event-owner-page",
          sessionId: "range-scalar-event-owner-session",
          visitorId: "range-scalar-event-owner-visitor",
          pageTimeMs: 10,
          pathname: "/outside-read-range",
          durationMs: 99,
          perfCls: 0.75,
          event: {
            id: "range-scalar-event-owner-event",
            name: "purchase",
            timeMs: 20,
          },
        },
      ],
      scope: "session",
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      capturedAtMs: 100,
      filterDsl:
        "count(event) eq 1 AND countDistinct(page.durationMs) eq 0 AND countDistinct(page.performance.cls) eq 0",
    });
    expect(eventOnlyOwnerPage.d1).toEqual(eventOnlyOwnerPage.oracle);
    expect(eventOnlyOwnerPage.d1).toEqual(["range-scalar-event-owner-session"]);
    expect(eventOnlyOwnerPage.fallbackReason).toBeUndefined();
  });

  it("aggregates finite Page numeric scalars with min and max", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "scalar-minmax-a",
        sessionId: "scalar-minmax-session",
        visitorId: "scalar-minmax-visitor",
        pageTimeMs: 18_010,
        pathname: "/selected/a",
        durationMs: -5,
        perfTtfbMs: 20,
        perfFcpMs: 22.5,
        perfLcpMs: 30,
        perfCls: 0.25,
        perfInpMs: 40,
      },
      {
        visitId: "scalar-minmax-b",
        sessionId: "scalar-minmax-session",
        visitorId: "scalar-minmax-visitor",
        pageTimeMs: 18_020,
        pathname: "/selected/b",
        durationMs: 2.5,
        perfTtfbMs: -2,
        perfFcpMs: 25,
        perfLcpMs: 29.5,
        perfCls: 0.75,
        perfInpMs: 10.5,
      },
      {
        visitId: "scalar-minmax-null",
        sessionId: "scalar-minmax-session",
        visitorId: "scalar-minmax-visitor",
        pageTimeMs: 18_030,
        pathname: "/null",
        durationMs: null,
        perfTtfbMs: null,
        perfFcpMs: null,
        perfLcpMs: null,
        perfCls: null,
        perfInpMs: null,
      },
      {
        visitId: "scalar-minmax-candidate-extreme",
        sessionId: "scalar-minmax-session",
        visitorId: "scalar-minmax-visitor",
        pageTimeMs: 18_045,
        pathname: "/candidate",
        durationMs: 99,
        perfTtfbMs: 99,
        perfFcpMs: 99,
        perfLcpMs: 99,
        perfCls: 99,
        perfInpMs: 99,
      },
    ];
    const result = await evaluateAdvancedCountFixture({
      activities,
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_000, endExclusiveMs: 18_050 },
      filterRange: { startMs: 18_000, endExclusiveMs: 18_040 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-minmax-session"],
      filterDsl: [
        "add(min(page.durationMs), max(page.durationMs)) eq -2.5",
        "countDistinct(page.durationMs) eq 3",
        "min(page.performance.ttfbMs) eq -2",
        "max(page.performance.ttfbMs) eq 20",
        "min(page.performance.fcpMs) eq 22.5",
        "max(page.performance.fcpMs) eq 25",
        "min(page.performance.lcpMs) eq 29.5",
        "max(page.performance.lcpMs) eq 30",
        "min(page.performance.cls) eq 0.25",
        "max(page.performance.cls) eq 0.75",
        "min(page.performance.inpMs) eq 10.5",
        "max(page.performance.inpMs) eq 40",
        'min(page { page.path startsWith "/selected" }.durationMs) eq -5',
        'max(page { page.path startsWith "/selected" }.durationMs) eq 2.5',
        'max(page { page.path eq "/null" }.durationMs) isNull',
        'NOT (min(page { page.path eq "/null" }.durationMs) neq 0)',
      ].join(" AND "),
    });

    expect(result.d1).toEqual(result.oracle);
    expect(result.d1).toEqual(["scalar-minmax-session"]);
    expect(result.fallbackReason).toBeUndefined();
    const matcher = result.statements.find(({ sql }) =>
      /\bGROUP BY\b/iu.test(sql),
    );
    expect(matcher).toBeDefined();
    expect(matcher!.sql).toMatch(/MIN\s*\(/iu);
    expect(matcher!.sql).toMatch(/MAX\s*\(/iu);
    expect(matcher!.sql).toMatch(/COUNT\s*\(\s*DISTINCT/iu);
    expect(matcher!.sql).not.toMatch(/CAST\s*\([^)]*duration_ms/iu);

    const visitorResult = await evaluateAdvancedCountFixture({
      activities,
      scope: "visitor",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_000, endExclusiveMs: 18_050 },
      filterRange: { startMs: 18_000, endExclusiveMs: 18_040 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-minmax-visitor"],
      filterDsl: [
        "min(page.durationMs) eq -5",
        "max(page.performance.ttfbMs) eq 20",
        "min(page.performance.cls) eq 0.25",
        "max(page.performance.cls) eq 0.75",
      ].join(" AND "),
    });
    expect(visitorResult.d1).toEqual(visitorResult.oracle);
    expect(visitorResult.d1).toEqual(["scalar-minmax-visitor"]);
    expect(visitorResult.fallbackReason).toBeUndefined();

    const emptyRead = await evaluateAdvancedCountFixture({
      activities: [activities[3]!],
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_060, endExclusiveMs: 18_070 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-minmax-session"],
      filterDsl:
        "min(page.durationMs) isNull AND max(page.performance.cls) isNull",
    });
    expect(emptyRead.d1).toEqual(emptyRead.oracle);
    expect(emptyRead.d1).toEqual(["scalar-minmax-session"]);
    expect(emptyRead.fallbackReason).toBeUndefined();

    const candidateMarked = await evaluateAdvancedCountFixture({
      activities,
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_000, endExclusiveMs: 18_100 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-minmax-session"],
      filterDsl: "min(page.durationMs) eq -5 AND max(page.durationMs) eq 99",
    });
    expect(candidateMarked.d1).toEqual(candidateMarked.oracle);
    expect(candidateMarked.d1).toEqual(["scalar-minmax-session"]);
    expect(candidateMarked.fallbackReason).toBeUndefined();

    const separate = await evaluateAdvancedCountFixture({
      activities: [
        ...activities,
        {
          visitId: "scalar-minmax-read-a",
          sessionId: "scalar-minmax-session",
          visitorId: "scalar-minmax-visitor",
          pageTimeMs: 18_065,
          pathname: "/read/a",
          durationMs: -20,
        },
        {
          visitId: "scalar-minmax-read-b",
          sessionId: "scalar-minmax-session",
          visitorId: "scalar-minmax-visitor",
          pageTimeMs: 18_066,
          pathname: "/read/b",
          durationMs: -10,
        },
      ],
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_060, endExclusiveMs: 18_070 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-minmax-session"],
      filterDsl:
        'page.path eq "/candidate" AND min(page.durationMs) eq -20 AND max(page.durationMs) eq -10',
    });
    expect(separate.d1).toEqual(separate.oracle);
    expect(separate.d1).toEqual(["scalar-minmax-session"]);
    expect(separate.fallbackReason).toBeUndefined();
  });

  it("aggregates exact Page scalars with sum and average across anchor modes", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "scalar-sum-average-a",
        sessionId: "scalar-sum-average-session",
        visitorId: "scalar-sum-average-visitor",
        pageTimeMs: 18_010,
        pathname: "/selected/a",
        durationMs: 2,
        perfTtfbMs: 10,
        perfFcpMs: -2,
        perfLcpMs: 6,
        perfCls: 0,
        perfInpMs: 20,
      },
      {
        visitId: "scalar-sum-average-b",
        sessionId: "scalar-sum-average-session",
        visitorId: "scalar-sum-average-visitor",
        pageTimeMs: 18_020,
        pathname: "/selected/b",
        durationMs: -6,
        perfTtfbMs: 10,
        perfFcpMs: 4,
        perfLcpMs: 8,
        perfCls: 1,
        perfInpMs: 40,
        event: {
          id: "scalar-sum-average-owner-event",
          name: "purchase",
          timeMs: 18_025,
        },
      },
      {
        visitId: "scalar-sum-average-null",
        sessionId: "scalar-sum-average-session",
        visitorId: "scalar-sum-average-visitor",
        pageTimeMs: 18_030,
        pathname: "/null",
        durationMs: null,
        perfTtfbMs: null,
        perfFcpMs: null,
        perfLcpMs: null,
        perfCls: null,
        perfInpMs: null,
      },
      {
        visitId: "scalar-sum-average-candidate-extreme",
        sessionId: "scalar-sum-average-session",
        visitorId: "scalar-sum-average-visitor",
        pageTimeMs: 18_045,
        pathname: "/candidate",
        durationMs: 99,
        perfTtfbMs: 99,
        perfFcpMs: 99,
        perfLcpMs: 99,
        perfCls: 99,
        perfInpMs: 99,
      },
    ];
    const sameRange = await evaluateAdvancedCountFixture({
      activities,
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_000, endExclusiveMs: 18_050 },
      filterRange: { startMs: 18_000, endExclusiveMs: 18_040 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-sum-average-session"],
      filterDsl: [
        "sum(page.durationMs) eq -4",
        "avg(page.durationMs) eq -2",
        "add(sum(page.durationMs), avg(page.durationMs)) eq -6",
        "sum(page.performance.ttfbMs) eq 20",
        "avg(page.performance.ttfbMs) eq 10",
        "sum(page.performance.fcpMs) eq 2",
        "avg(page.performance.fcpMs) eq 1",
        "sum(page.performance.lcpMs) eq 14",
        "avg(page.performance.lcpMs) eq 7",
        "sum(page.performance.cls) eq 1",
        "avg(page.performance.cls) eq 0.5",
        "sum(page.performance.inpMs) eq 60",
        "avg(page.performance.inpMs) eq 30",
        'sum(page { page.path eq "/selected/a" }.durationMs) eq 2',
        'sum(page { page.path eq "/selected/b" }.durationMs) eq -6',
        'sum(page { page.path eq "/null" }.durationMs) eq 0',
        'avg(page { page.path eq "/null" }.durationMs) isNull',
        'NOT (avg(page { page.path eq "/null" }.durationMs) neq 0)',
        "min(page.durationMs) eq -6",
        "max(page.durationMs) eq 2",
        "countDistinct(page.durationMs) eq 3",
      ].join(" AND "),
    });
    expect(sameRange.d1).toEqual(sameRange.oracle);
    expect(sameRange.d1).toEqual(["scalar-sum-average-session"]);
    expect(sameRange.fallbackReason).toBeUndefined();
    const matcher = sameRange.statements.find(({ sql }) =>
      /\bGROUP BY\b/iu.test(sql),
    );
    expect(matcher?.sql).toMatch(/SUM\s*\(/iu);
    expect(matcher?.sql).toMatch(/AVG\s*\(/iu);
    expect(matcher?.sql).toMatch(/CAST\s*\([^)]*AS REAL\)/iu);
    expect(matcher?.sql).toMatch(/COUNT\s*\(\s*DISTINCT/iu);
    expect(matcher?.sql.match(/\bGROUP BY\b/giu)).toHaveLength(1);

    const candidateMarked = await evaluateAdvancedCountFixture({
      activities,
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_000, endExclusiveMs: 18_050 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-sum-average-session"],
      filterDsl:
        'page.path eq "/candidate" AND sum(page { page.path startsWith "/selected/" }.durationMs) eq -4 AND avg(page { page.path startsWith "/selected/" }.durationMs) eq -2',
    });
    expect(candidateMarked.d1).toEqual(candidateMarked.oracle);
    expect(candidateMarked.d1).toEqual(["scalar-sum-average-session"]);
    expect(candidateMarked.fallbackReason).toBeUndefined();

    const separate = await evaluateAdvancedCountFixture({
      activities: [
        ...activities,
        {
          visitId: "scalar-sum-average-separate-a",
          sessionId: "scalar-sum-average-session",
          visitorId: "scalar-sum-average-visitor",
          pageTimeMs: 18_065,
          pathname: "/read/a",
          durationMs: -20,
        },
        {
          visitId: "scalar-sum-average-separate-b",
          sessionId: "scalar-sum-average-session",
          visitorId: "scalar-sum-average-visitor",
          pageTimeMs: 18_066,
          pathname: "/read/b",
          durationMs: -10,
        },
      ],
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_060, endExclusiveMs: 18_070 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-sum-average-session"],
      filterDsl:
        'page.path eq "/candidate" AND sum(page.durationMs) eq -30 AND avg(page.durationMs) eq -15',
    });
    expect(separate.d1).toEqual(separate.oracle);
    expect(separate.d1).toEqual(["scalar-sum-average-session"]);
    expect(separate.fallbackReason).toBeUndefined();

    const visitor = await evaluateAdvancedCountFixture({
      activities: [
        ...activities,
        {
          visitId: "scalar-sum-average-other-session",
          sessionId: "scalar-sum-average-other-session",
          visitorId: "scalar-sum-average-visitor",
          pageTimeMs: 18_035,
          pathname: "/other-session",
          durationMs: 100,
        },
      ],
      scope: "visitor",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_000, endExclusiveMs: 18_050 },
      filterRange: { startMs: 18_000, endExclusiveMs: 18_040 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-sum-average-visitor"],
      filterDsl: "sum(page.durationMs) eq 96 AND avg(page.durationMs) eq 32",
    });
    expect(visitor.d1).toEqual(visitor.oracle);
    expect(visitor.d1).toEqual(["scalar-sum-average-visitor"]);
    expect(visitor.fallbackReason).toBeUndefined();
  });

  it.each([
    {
      name: "fractional REAL",
      value: 1.5,
      expectedSum: 1.5,
      expectedAverage: 1.5,
    },
    {
      name: "integer outside the exact bound",
      value: ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT + 1,
      expectedSum: ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT + 1,
      expectedAverage: ADVANCED_FILTER_EXACT_AGGREGATE_VALUE_LIMIT + 1,
    },
    {
      name: "numeric-looking TEXT",
      value: "0x10",
      expectedSum: 0,
      expectedAverage: null,
    },
    {
      name: "numeric-looking BLOB",
      value: new Uint8Array([48, 120, 49, 48]),
      expectedSum: 0,
      expectedAverage: null,
    },
  ])(
    "falls back for $name values in exact scalar aggregates",
    async ({ value, expectedSum, expectedAverage }) => {
      const activities: readonly SharedActivity[] = [
        {
          visitId: "scalar-sum-average-invalid",
          sessionId: "scalar-sum-average-invalid-session",
          visitorId: "scalar-sum-average-invalid-visitor",
          pageTimeMs: 10,
          pathname: "/invalid",
          selectorDurationMsOverride: value,
        },
      ];
      const result = await evaluateAdvancedCountFixture({
        activities,
        scope: "session",
        candidateRange: { startMs: 0, endExclusiveMs: 100 },
        capturedAtMs: 100,
        expectedIdentities: ["scalar-sum-average-invalid-session"],
        filterDsl: `sum(page.durationMs) eq ${String(expectedSum)} AND avg(page.durationMs) ${expectedAverage === null ? "isNull" : `eq ${String(expectedAverage)}`}`,
      });
      expect(result.d1).toEqual(result.oracle);
      expect(result.d1).toEqual(["scalar-sum-average-invalid-session"]);
      expect(result.fallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
    },
  );

  it("ignores owner Page scalars outside the read range and falls back for nonnumeric storage", async () => {
    const eventOnlyOwner = await evaluateAdvancedCountFixture({
      activities: [
        {
          visitId: "scalar-minmax-event-owner",
          sessionId: "scalar-minmax-event-owner-session",
          visitorId: "scalar-minmax-event-owner-visitor",
          pageTimeMs: 17_900,
          pathname: "/outside-read-range",
          durationMs: 123,
          perfCls: 0.75,
          event: {
            id: "scalar-minmax-event-owner-event",
            name: "purchase",
            timeMs: 18_045,
          },
        },
      ],
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      readRange: { startMs: 18_000, endExclusiveMs: 18_050 },
      capturedAtMs: 20_000,
      expectedIdentities: ["scalar-minmax-event-owner-session"],
      filterDsl:
        "count(event) eq 1 AND min(page.durationMs) isNull AND max(page.performance.cls) isNull",
    });
    expect(eventOnlyOwner.d1).toEqual(eventOnlyOwner.oracle);
    expect(eventOnlyOwner.d1).toEqual(["scalar-minmax-event-owner-session"]);
    expect(eventOnlyOwner.fallbackReason).toBeUndefined();

    const invalidStorage = await evaluateAdvancedCountFixture({
      activities: [
        {
          visitId: "scalar-minmax-text-storage",
          sessionId: "scalar-minmax-text-session",
          visitorId: "scalar-minmax-text-visitor",
          pageTimeMs: 18_045,
          pathname: "/text",
          selectorDurationMsOverride: "not-a-number",
        },
      ],
      scope: "session",
      candidateRange: { startMs: 18_040, endExclusiveMs: 18_050 },
      capturedAtMs: 20_000,
      expectedIdentities: [],
      filterDsl: "min(page.durationMs) isNull",
    });
    expect(invalidStorage.d1).toEqual(invalidStorage.oracle);
    expect(invalidStorage.d1).toEqual([]);
    expect(invalidStorage.fallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
  });

  it("matches bare Page numeric fields across candidate and read domains", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "bare-numeric-safe-page",
        sessionId: "bare-numeric-safe-session",
        visitorId: "bare-numeric-safe-visitor",
        pageTimeMs: 18,
        pathname: "/safe",
        durationMs: 10,
        perfTtfbMs: 20,
        perfFcpMs: 30,
        perfLcpMs: 40,
        perfCls: 0.75,
        perfInpMs: 50,
        event: {
          id: "bare-numeric-safe-event",
          name: "purchase",
          timeMs: 19,
        },
      },
      {
        visitId: "bare-numeric-fraction-page",
        sessionId: "bare-numeric-fraction-session",
        visitorId: "bare-numeric-fraction-visitor",
        pageTimeMs: 20,
        pathname: "/fraction",
        durationMs: 2.5,
        perfTtfbMs: 60,
        perfFcpMs: 70,
        perfLcpMs: 80,
        perfCls: 0.25,
        perfInpMs: 90,
      },
      {
        visitId: "bare-numeric-null-page",
        sessionId: "bare-numeric-null-session",
        visitorId: "bare-numeric-null-visitor",
        pageTimeMs: 21,
        pathname: "/null",
        durationMs: null,
        perfTtfbMs: null,
        perfFcpMs: null,
        perfLcpMs: null,
        perfCls: null,
        perfInpMs: null,
      },
      {
        visitId: "bare-numeric-blob-page",
        sessionId: "bare-numeric-blob-session",
        visitorId: "bare-numeric-blob-visitor",
        pageTimeMs: 22,
        pathname: "/blob",
        selectorDurationMsOverride: new Uint8Array([49, 48]),
      },
    ];
    const shared = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      capturedAtMs: 100,
    };
    const cases = [
      {
        filterDsl:
          "page.durationMs eq 10 AND performance.ttfbMs gt 15 AND performance.fcpMs gte 30 AND performance.lcpMs lte 40 AND performance.cls between [0.7, 0.8] AND performance.inpMs in [50, 51] AND count(page) gte 0",
        expected: ["bare-numeric-safe-session"],
        guarded: true,
      },
      {
        filterDsl: "performance.cls gt 0.5 AND count(page) gte 0",
        expected: ["bare-numeric-safe-session"],
        guarded: true,
      },
      {
        filterDsl: "performance.ttfbMs in [20, 60] AND count(page) gte 0",
        expected: [
          "bare-numeric-fraction-session",
          "bare-numeric-safe-session",
        ],
        guarded: true,
      },
      {
        filterDsl:
          "(page.durationMs eq 10 OR performance.cls between [0.2, 0.3]) AND count(page) gte 0",
        expected: [
          "bare-numeric-fraction-session",
          "bare-numeric-safe-session",
        ],
        guarded: true,
      },
      {
        filterDsl: "NOT (page.durationMs gt 5) AND count(page) gte 0",
        expected: [
          "bare-numeric-fraction-session",
          "bare-numeric-null-session",
        ],
        guarded: true,
      },
      {
        filterDsl: "page.durationMs exists AND count(page) gte 0",
        expected: [
          "bare-numeric-blob-session",
          "bare-numeric-fraction-session",
          "bare-numeric-safe-session",
        ],
        guarded: false,
      },
    ] as const;

    for (const testCase of cases) {
      const result = await evaluateAdvancedCountFixture({
        ...shared,
        activities: testCase.guarded ? activities.slice(0, 3) : activities,
        filterDsl: testCase.filterDsl,
      });
      expect(result.d1, testCase.filterDsl).toEqual(result.oracle);
      expect(result.d1, testCase.filterDsl).toEqual(
        [...testCase.expected].sort(),
      );
      expect(result.fallbackReason, testCase.filterDsl).toBeUndefined();
      const guard = result.statements.find(({ rows }) =>
        rows.some((row) => "rawCount" in row),
      );
      const matcher = result.statements.find(({ sql }) =>
        /\bGROUP BY\b/iu.test(sql),
      );
      expect(guard, testCase.filterDsl).toBeDefined();
      expect(matcher, testCase.filterDsl).toBeDefined();
      if (testCase.guarded) {
        expect(guard!.sql, testCase.filterDsl).toMatch(/typeof\s*\(/iu);
        expect(matcher!.sql, testCase.filterDsl).toMatch(/typeof\s*\(/iu);
      } else {
        expect(guard!.sql, testCase.filterDsl).not.toMatch(/typeof\s*\(/iu);
        expect(matcher!.sql, testCase.filterDsl).not.toMatch(/typeof\s*\(/iu);
      }
    }

    const splitRange = await evaluateAdvancedCountFixture({
      activities: [activities[0]!],
      scope: "session",
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      readRange: { startMs: 30, endExclusiveMs: 40 },
      capturedAtMs: 100,
      filterDsl: "page.durationMs eq 10 AND count(page) eq 0",
    });
    expect(splitRange.d1).toEqual(splitRange.oracle);
    expect(splitRange.d1).toEqual(["bare-numeric-safe-session"]);
    expect(splitRange.fallbackReason).toBeUndefined();
  });

  it("guards invalid numeric values inherited by candidate Event rows", async () => {
    const activity: SharedActivity = {
      visitId: "bare-numeric-event-anomaly-page",
      sessionId: "bare-numeric-event-anomaly-session",
      visitorId: "bare-numeric-event-anomaly-visitor",
      pageTimeMs: 10,
      pathname: "/owner-outside-candidate",
      selectorDurationMsOverride: "bad",
      event: {
        id: "bare-numeric-event-anomaly-candidate-event",
        name: "purchase",
        timeMs: 20,
      },
    };
    const result = await evaluateAdvancedCountFixture({
      activities: [activity],
      scope: "session",
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      readRange: { startMs: 30, endExclusiveMs: 100 },
      capturedAtMs: 100,
      filterDsl: "page.durationMs gt 5 AND count(event) eq 0",
    });

    expect(result.d1).toEqual(result.oracle);
    expect(result.fallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    const guard = result.statements.find(({ rows }) =>
      rows.some((row) => "rawCount" in row),
    );
    expect(guard?.rows).toContainEqual(
      expect.objectContaining({
        rawCount: 1,
        invalidContextPageDurationMsCount: 1,
      }),
    );
    expect(
      result.statements.some(
        ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      ),
    ).toBe(false);
  });

  it("keeps bare numeric fields existential across pages, Visitors, and filter ranges", async () => {
    const splitActivities: readonly SharedActivity[] = [
      {
        visitId: "bare-numeric-independent-a",
        sessionId: "bare-numeric-independent-session",
        visitorId: "bare-numeric-independent-visitor",
        pageTimeMs: 18,
        pathname: "/numeric-only",
        durationMs: 10,
        perfCls: null,
      },
      {
        visitId: "bare-numeric-independent-b",
        sessionId: "bare-numeric-independent-session",
        visitorId: "bare-numeric-independent-visitor",
        pageTimeMs: 19,
        pathname: "/ratio-only",
        durationMs: 2.5,
        perfCls: 0.25,
      },
    ];
    const independent = await evaluateAdvancedCountFixture({
      activities: splitActivities,
      scope: "session",
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      capturedAtMs: 100,
      filterDsl:
        'page.durationMs eq 10 AND page.path eq "/ratio-only" AND count(page) eq 2',
    });
    expect(independent.d1).toEqual(independent.oracle);
    expect(independent.d1).toEqual(["bare-numeric-independent-session"]);
    expect(independent.fallbackReason).toBeUndefined();

    const samePage = await evaluateAdvancedCountFixture({
      activities: splitActivities,
      scope: "session",
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      capturedAtMs: 100,
      filterDsl:
        'count(page { page.durationMs eq 10 AND page.path eq "/ratio-only" }) eq 0 AND count(page) eq 2',
    });
    expect(samePage.d1).toEqual(samePage.oracle);
    expect(samePage.d1).toEqual(["bare-numeric-independent-session"]);
    expect(samePage.fallbackReason).toBeUndefined();

    const visitor = await evaluateAdvancedCountFixture({
      activities: [
        {
          ...splitActivities[0]!,
          sessionId: "bare-numeric-visitor-session-a",
        },
        {
          ...splitActivities[1]!,
          sessionId: "bare-numeric-visitor-session-b",
        },
      ],
      scope: "visitor",
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      capturedAtMs: 100,
      filterDsl: "page.durationMs gt 5 AND count(page) eq 2",
    });
    expect(visitor.d1).toEqual(visitor.oracle);
    expect(visitor.d1).toEqual(["bare-numeric-independent-visitor"]);
    expect(visitor.fallbackReason).toBeUndefined();

    const explicitFilterRange = await evaluateAdvancedCountFixture({
      activities: [
        {
          visitId: "bare-numeric-filter-history",
          sessionId: "bare-numeric-filter-session",
          visitorId: "bare-numeric-filter-visitor",
          pageTimeMs: 10,
          pathname: "/history-numeric",
          durationMs: 10,
        },
        {
          visitId: "bare-numeric-filter-candidate",
          sessionId: "bare-numeric-filter-session",
          visitorId: "bare-numeric-filter-visitor",
          pageTimeMs: 20,
          pathname: "/candidate-numeric",
          durationMs: 2.5,
        },
      ],
      scope: "session",
      candidateRange: { startMs: 15, endExclusiveMs: 25 },
      readRange: { startMs: 0, endExclusiveMs: 100 },
      filterRange: { startMs: 0, endExclusiveMs: 15 },
      capturedAtMs: 100,
      filterDsl: "page.durationMs eq 10 AND count(page) eq 1",
    });
    expect(explicitFilterRange.d1).toEqual(explicitFilterRange.oracle);
    expect(explicitFilterRange.d1).toEqual(["bare-numeric-filter-session"]);
    expect(explicitFilterRange.fallbackReason).toBeUndefined();
  });

  it("emits candidate-wide Event owner numeric controls without scope identity", async () => {
    const activity: SharedActivity = {
      visitId: "bare-numeric-event-owner-page",
      sessionId: "bare-numeric-event-owner-session",
      visitorId: "bare-numeric-event-owner-visitor",
      pageTimeMs: 10,
      pathname: "/owner-outside-candidate",
      durationMs: 10,
      event: {
        id: "bare-numeric-event-owner-candidate-event",
        name: "purchase",
        timeMs: 20,
      },
    };
    const candidateRange = { startMs: 15, endExclusiveMs: 25 };
    const readRange = { startMs: 30, endExclusiveMs: 100 };
    const input = advancedFilterInput(
      {
        ...createQueryTime(15, 25, "UTC", 100),
        readRange: createTimeRange(readRange.startMs, readRange.endExclusiveMs),
      },
      [SITE_ID],
      "page.durationMs gt 5 AND count(event) eq 0",
      "session",
    );
    const capturedQueries: Array<{
      readonly sql: string;
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const guardResponses: Array<readonly Record<string, unknown>[]> = [];
    const mutationDatabase: { current?: DatabaseSync } = {};
    const { env, database } = sqliteEnv([activity], (sql, _bindings, rows) => {
      capturedQueries.push({ sql, rows });
      if (rows.some((row) => "rawCount" in row)) {
        guardResponses.push(rows);
        if (guardResponses.length === 2) {
          mutationDatabase.current
            ?.prepare(
              "UPDATE visits SET duration_ms = ?, session_id = NULL WHERE visit_id = ?",
            )
            .run("bad", activity.visitId);
        }
      }
    });
    mutationDatabase.current = database;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "overview",
        input,
        async (value) => value,
      )) as typeof input;
      const matcher = capturedQueries.find(({ rows }) =>
        rows.some((row) => row.rowKind === "numeric-domain"),
      );

      expect(guardResponses).toHaveLength(2);
      expect(
        guardResponses
          .flat()
          .every((row) => (row.invalidContextPageDurationMsCount ?? 0) === 0),
      ).toBe(true);
      expect(matcher?.rows).toContainEqual(
        expect.objectContaining({
          rowKind: "numeric-domain",
          invalidContextPageDurationMsCount: 1,
        }),
      );
      expect(matcher?.rows.filter((row) => row.rowKind === "match")).toEqual(
        [],
      );
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("matches safe numeric Page selectors and guards legacy numeric storage", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "numeric-safe-integer-page",
        sessionId: "numeric-safe-integer-session",
        visitorId: "numeric-shared-visitor",
        pageTimeMs: 18_010,
        pathname: "/fast/safe",
        durationMs: 10,
        perfTtfbMs: 20,
        perfCls: 0.75,
      },
      {
        visitId: "numeric-safe-fraction-page",
        sessionId: "numeric-safe-fraction-session",
        visitorId: "numeric-shared-visitor",
        pageTimeMs: 18_020,
        pathname: "/slow/fraction",
        durationMs: 2.5,
        perfTtfbMs: 60,
        perfCls: 0.25,
      },
      {
        visitId: "numeric-safe-null-page",
        sessionId: "numeric-safe-null-session",
        visitorId: "numeric-null-visitor",
        pageTimeMs: 18_030,
        pathname: "/missing",
        durationMs: null,
        perfCls: null,
      },
      {
        visitId: "numeric-cross-page-a",
        sessionId: "numeric-cross-page-session",
        visitorId: "numeric-cross-page-visitor",
        pageTimeMs: 18_040,
        pathname: "/cross-other",
        durationMs: 10,
        perfCls: 0.7,
      },
      {
        visitId: "numeric-cross-page-b",
        sessionId: "numeric-cross-page-session",
        visitorId: "numeric-cross-page-visitor",
        pageTimeMs: 18_050,
        pathname: "/cross-match",
        durationMs: 2.5,
        perfCls: 0.3,
      },
    ];
    const shared = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 18_000, endExclusiveMs: 19_000 },
      capturedAtMs: 20_000,
    };
    const cases: readonly {
      readonly filterDsl: string;
      readonly expected: readonly string[];
      readonly invalidGuardCountField?: string;
      readonly scope?: "session" | "visitor";
    }[] = [
      {
        filterDsl: "count(page { page.durationMs eq 10 }) eq 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-integer-session",
        ],
      },
      {
        filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-integer-session",
        ],
      },
      {
        filterDsl: "count(page { page.durationMs in [2.5, 10] }) eq 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-safe-fraction-session",
          "numeric-safe-integer-session",
        ],
      },
      {
        filterDsl: "count(page { page.durationMs between [0, 10] }) gte 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-fraction-session",
          "numeric-safe-integer-session",
        ],
      },
      {
        filterDsl: "count(page { NOT (page.durationMs eq 10) }) eq 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-fraction-session",
          "numeric-safe-null-session",
        ],
      },
      {
        filterDsl: "count(page { NOT (page.durationMs neq 10) }) eq 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-integer-session",
          "numeric-safe-null-session",
        ],
      },
      {
        filterDsl: "count(page { NOT (page.durationMs gt 5) }) eq 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-fraction-session",
          "numeric-safe-null-session",
        ],
      },
      {
        filterDsl: "count(page { NOT (page.durationMs in [10]) }) eq 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-fraction-session",
          "numeric-safe-null-session",
        ],
      },
      {
        filterDsl: "count(page { NOT (page.durationMs between [0, 5]) }) eq 1",
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-integer-session",
          "numeric-safe-null-session",
        ],
      },
      {
        filterDsl:
          'count(page { NOT ((page.durationMs gt 5 AND page.path eq "/missing") OR page.path eq "/slow/fraction") }) eq 1',
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: ["numeric-safe-integer-session", "numeric-safe-null-session"],
      },
      {
        filterDsl: "count(page { performance.cls between [0.5, 0.8] }) eq 1",
        invalidGuardCountField: "invalidContextPagePerfClsCount",
        expected: [
          "numeric-cross-page-session",
          "numeric-safe-integer-session",
        ],
      },
      {
        filterDsl: "count(page { performance.ttfbMs lt 50 }) eq 1",
        invalidGuardCountField: "invalidContextPagePerfTtfbMsCount",
        expected: ["numeric-safe-integer-session"],
      },
      {
        filterDsl:
          'count(page { page.durationMs gt 5 AND page.path contains "/fast" }) eq 1',
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: ["numeric-safe-integer-session"],
      },
      {
        filterDsl:
          'count(page { page.durationMs gt 5 AND page.path contains "match" }) eq 1',
        invalidGuardCountField: "invalidContextPageDurationMsCount",
        expected: [],
      },
      {
        filterDsl: "count(page { NOT (performance.cls notExists) }) eq 1",
        expected: [
          "numeric-safe-fraction-session",
          "numeric-safe-integer-session",
        ],
      },
      {
        ...shared,
        scope: "visitor" as const,
        filterDsl: "count(page { performance.cls gte 0.5 }) eq 1",
        invalidGuardCountField: "invalidContextPagePerfClsCount",
        expected: ["numeric-cross-page-visitor", "numeric-shared-visitor"],
      },
    ];

    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      for (const testCase of cases) {
        evaluatorSpy.mockClear();
        const request = { ...shared, ...testCase };
        const result = await evaluateAdvancedCountFixture(request);
        expect(result.d1, testCase.filterDsl).toEqual(result.oracle);
        expect(result.d1, testCase.filterDsl).toEqual(
          [...testCase.expected].sort(),
        );
        expect(result.fallbackReason, testCase.filterDsl).toBeUndefined();
        expect(evaluatorSpy).toHaveBeenCalledTimes(1);
        const matcher = result.statements.find(
          ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        );
        expect(matcher, testCase.filterDsl).toBeDefined();
        expect(matcher!.sql).not.toContain("IsCountSafeNumber");
        expect(
          matcher!.rows
            .filter(
              (row) => row.rowKind === "match" || row.rowKind === undefined,
            )
            .map((row) => row.entityId)
            .sort(),
        ).toEqual([...testCase.expected].sort());
        const guard = result.statements.find(({ rows }) =>
          rows.some((row) => "rawCount" in row),
        );
        expect(guard, testCase.filterDsl).toBeDefined();
        if (testCase.invalidGuardCountField) {
          expect(guard!.rows[0]).toMatchObject({ rawCount: activities.length });
          expect(guard!.rows[0]).toHaveProperty(
            testCase.invalidGuardCountField,
            0,
          );
          expect(guard!.sql).toMatch(/typeof\s*\(/iu);
        }
        if (
          !testCase.invalidGuardCountField &&
          !testCase.filterDsl.includes("page.path")
        )
          expect(matcher!.sql).not.toMatch(/typeof\s*\(/iu);
        expect(
          result.rawNumericStorageTypes.find(
            ({ visitId }) => visitId === "numeric-safe-null-page",
          )?.durationMs,
        ).toBe("null");
      }
    } finally {
      evaluatorSpy.mockRestore();
    }

    const anomalyActivities: readonly SharedActivity[] = [
      {
        visitId: "numeric-anomaly-safe-page",
        sessionId: "numeric-anomaly-safe-session",
        visitorId: "numeric-anomaly-safe-visitor",
        pageTimeMs: 18_110,
        pathname: "/safe",
        durationMs: 10,
      },
      {
        visitId: "numeric-anomaly-affinity-page",
        sessionId: "numeric-anomaly-affinity-session",
        visitorId: "numeric-anomaly-affinity-visitor",
        pageTimeMs: 18_120,
        pathname: "/text-number",
        selectorDurationMsOverride: "10",
      },
      {
        visitId: "numeric-anomaly-hex-page",
        sessionId: "numeric-anomaly-hex-session",
        visitorId: "numeric-anomaly-hex-visitor",
        pageTimeMs: 18_130,
        pathname: "/hex-text",
        selectorDurationMsOverride: "0x10",
      },
      {
        visitId: "numeric-anomaly-empty-page",
        sessionId: "numeric-anomaly-empty-session",
        visitorId: "numeric-anomaly-empty-visitor",
        pageTimeMs: 18_140,
        pathname: "/empty-text",
        selectorDurationMsOverride: "",
      },
      {
        visitId: "numeric-anomaly-invalid-page",
        sessionId: "numeric-anomaly-invalid-session",
        visitorId: "numeric-anomaly-invalid-visitor",
        pageTimeMs: 18_150,
        pathname: "/invalid-text",
        selectorDurationMsOverride: "bad",
      },
      {
        visitId: "numeric-anomaly-blob-page",
        sessionId: "numeric-anomaly-blob-session",
        visitorId: "numeric-anomaly-blob-visitor",
        pageTimeMs: 18_160,
        pathname: "/blob",
        selectorDurationMsOverride: new Uint8Array([49, 48]),
      },
      {
        visitId: "numeric-anomaly-large-page",
        sessionId: "numeric-anomaly-large-session",
        visitorId: "numeric-anomaly-large-visitor",
        pageTimeMs: 18_170,
        pathname: "/large-real",
        selectorDurationMsOverride: 1e20,
      },
      {
        visitId: "numeric-anomaly-null-page",
        sessionId: "numeric-anomaly-null-session",
        visitorId: "numeric-anomaly-null-visitor",
        pageTimeMs: 18_180,
        pathname: "/null",
        selectorDurationMsOverride: null,
      },
    ];
    const anomalyShared = {
      activities: anomalyActivities,
      scope: "session" as const,
      candidateRange: { startMs: 18_100, endExclusiveMs: 19_000 },
      capturedAtMs: 20_000,
    };
    const numericComparison = await evaluateAdvancedCountFixture({
      ...anomalyShared,
      filterRange: anomalyShared.candidateRange,
      filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
    });
    const numericGuard = numericComparison.statements.find(({ rows }) =>
      rows.some((row) => "rawCount" in row),
    );
    expect(numericGuard?.sql).toMatch(/typeof\s*\(/iu);
    expect(numericGuard?.sql).toMatch(/duration_ms/iu);
    expect(numericComparison.d1).toEqual(numericComparison.oracle);
    expect(numericComparison.d1).toEqual(
      [
        "numeric-anomaly-affinity-session",
        "numeric-anomaly-hex-session",
        "numeric-anomaly-large-session",
        "numeric-anomaly-safe-session",
      ].sort(),
    );
    expect(numericComparison.fallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    expect(
      numericComparison.statements.some(
        ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      ),
    ).toBe(false);
    const numericStorage = new Map(
      numericComparison.rawNumericStorageTypes.map((row) => [
        row.visitId,
        row.durationMs,
      ]),
    );
    for (const [visitId, storageClass] of [
      ["numeric-anomaly-affinity-page", "integer"],
      ["numeric-anomaly-hex-page", "text"],
      ["numeric-anomaly-empty-page", "text"],
      ["numeric-anomaly-invalid-page", "text"],
      ["numeric-anomaly-blob-page", "blob"],
      ["numeric-anomaly-large-page", "real"],
      ["numeric-anomaly-null-page", "null"],
    ] as const)
      expect(numericStorage.get(visitId)).toBe(storageClass);

    const numericPresence = await evaluateAdvancedCountFixture({
      ...anomalyShared,
      filterDsl: "count(page { page.durationMs exists }) eq 1",
    });
    expect(numericPresence.d1).toEqual(numericPresence.oracle);
    expect(numericPresence.d1).toEqual(
      [
        "numeric-anomaly-affinity-session",
        "numeric-anomaly-blob-session",
        "numeric-anomaly-empty-session",
        "numeric-anomaly-hex-session",
        "numeric-anomaly-large-session",
        "numeric-anomaly-invalid-session",
        "numeric-anomaly-safe-session",
      ].sort(),
    );
    expect(numericPresence.fallbackReason).toBeUndefined();
    const numericPresenceGuard = numericPresence.statements.find(({ rows }) =>
      rows.some((row) => "rawCount" in row),
    );
    expect(numericPresenceGuard).toBeDefined();
    expect(numericPresenceGuard!.sql).not.toMatch(
      /IsCountSafeNumber|invalidContextPageDurationMsCount/iu,
    );
    const presenceMatcher = numericPresence.statements.find(
      ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
    );
    expect(presenceMatcher).toBeDefined();
    expect(presenceMatcher!.sql).not.toContain("IsCountSafeNumber");

    const eventOwnerOnlyActivity: SharedActivity = {
      visitId: "numeric-event-owner-outside-page-range",
      sessionId: "numeric-event-owner-session",
      visitorId: "numeric-event-owner-visitor",
      pageTimeMs: 10,
      pathname: "/outside-range",
      selectorDurationMsOverride: "0x10",
      event: {
        id: "numeric-event-owner-inside-range-event",
        name: "purchase",
        timeMs: 18_250,
      },
    };
    const eventOwnerResult = await evaluateAdvancedCountFixture({
      activities: [eventOwnerOnlyActivity],
      scope: "session",
      candidateRange: { startMs: 18_200, endExclusiveMs: 18_300 },
      capturedAtMs: 20_000,
      filterDsl: "count(page { page.durationMs gt 5 }) eq 0",
    });
    expect(eventOwnerResult.d1).toEqual(eventOwnerResult.oracle);
    expect(eventOwnerResult.d1).toEqual(["numeric-event-owner-session"]);
    expect(eventOwnerResult.fallbackReason).toBeUndefined();
  });

  it("preserves page-only safe-number defaults for legacy guard field IDs", async () => {
    const guardRows: Array<readonly Record<string, unknown>[]> = [];
    const activity: SharedActivity = {
      visitId: "legacy-count-guard-page",
      sessionId: "legacy-count-guard-session",
      visitorId: "legacy-count-guard-visitor",
      pageTimeMs: 10,
      pathname: "/legacy-guard",
      event: {
        id: "legacy-count-guard-event",
        name: "purchase",
        timeMs: 20,
      },
    };
    const { env, database } = sqliteEnv([activity], (_sql, _bindings, rows) => {
      if (rows.some((row) => "rawCount" in row)) guardRows.push(rows);
    });
    try {
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("not-a-number", activity.visitId);
      const field = advancedCountSelectorField("page.durationMs");
      if (!field || field.kind !== "number")
        throw new Error("expected_Page_duration_count_field");
      const subject = createSemanticSubjectDomain({
        origin: "site",
        siteIds: [SITE_ID as SiteId],
      });
      const range = { startMs: 0, endExclusiveMs: 100 };
      const requirements = [
        {
          fieldId: "page.durationMs",
          domain: "page-only",
          proof: "safe-number",
        },
      ] as const;
      const queries = [
        compileAdvancedFilterCountGuardQuery(
          buildAdvancedCountFilterGuardPlan({
            subject,
            range,
            reportingTimeZone: "UTC",
            numericCompatibilityFieldIds: [field.fieldId],
          }),
        ),
        compileAdvancedFilterCountGuardQuery(
          buildAdvancedCountFilterGuardPlan({
            subject,
            range,
            reportingTimeZone: "UTC",
            numericCompatibilityRequirements: requirements,
          }),
        ),
        compileAdvancedFilterCountGuardQuery(
          buildAdvancedCountFilterGuardPlan({
            subject,
            range,
            reportingTimeZone: "UTC",
            numericCompatibilityFieldIds: [field.fieldId],
            numericCompatibilityRequirements: requirements,
          }),
        ),
      ];

      expect(queries[0]).toMatchObject({
        sql: queries[1]!.sql,
        bindings: queries[1]!.bindings,
      });
      expect(queries[2]).toMatchObject({
        sql: queries[1]!.sql,
        bindings: queries[1]!.bindings,
      });

      const results = [];
      for (const query of queries)
        results.push(
          await queryAdvancedFilterCountGuard({
            env,
            query,
            numericCompatibilityFields: [field],
          }),
        );
      expect(results).toEqual([
        {
          rawCount: 2,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          numericCompatibilityFieldIds: ["page.durationMs"],
        },
        {
          rawCount: 2,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          numericCompatibilityFieldIds: ["page.durationMs"],
        },
        {
          rawCount: 2,
          nullActivityIdCount: 0,
          siteIdentityMismatchCount: 0,
          numericCompatibilityFieldIds: ["page.durationMs"],
        },
      ]);
      expect(guardRows).toHaveLength(3);
      for (const [row] of guardRows) {
        expect(row).toMatchObject({
          rawCount: 2,
          invalidContextPageDurationMsCount: 1,
        });
      }
    } finally {
      database.close();
    }
  });

  it("checks numeric storage in the matcher snapshot after the preflight guard", async () => {
    const capturedQueries: Array<{
      readonly sql: string;
      readonly bindings: readonly (string | number | boolean | null)[];
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const mutationDatabase: { current?: DatabaseSync } = {};
    let changedAfterGuard = false;
    const { env, database, queries } = sqliteEnv(
      [
        {
          visitId: "numeric-snapshot-page",
          sessionId: "numeric-snapshot-session",
          visitorId: "numeric-snapshot-visitor",
          pageTimeMs: 10,
          pathname: "/numeric-snapshot",
          durationMs: 10,
        },
      ],
      (sql, bindings, rows) => {
        capturedQueries.push({ sql, bindings, rows });
        if (!changedAfterGuard && rows.some((row) => "rawCount" in row)) {
          mutationDatabase.current
            ?.prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
            .run("bad", "numeric-snapshot-page");
          changedAfterGuard = true;
        }
      },
    );
    mutationDatabase.current = database;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "overview",
        advancedFilterInput(
          {
            ...createQueryTime(0, 100, "UTC", 100),
            filterRange: createTimeRange(0, 100),
          },
          [SITE_ID],
          "min(page.durationMs) eq 10 AND max(page.durationMs) eq 10",
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;

      expect(changedAfterGuard).toBe(true);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      const guard = capturedQueries.find(({ rows }) =>
        rows.some((row) => "rawCount" in row),
      );
      expect(guard?.rows[0]).toMatchObject({
        rawCount: 1,
        invalidContextPageDurationMsCount: 0,
      });
      const matcher = capturedQueries.find(({ rows }) =>
        rows.some((row) => row.rowKind === "numeric-domain"),
      );
      expect(matcher?.rows).toContainEqual(
        expect.objectContaining({
          rowKind: "numeric-domain",
          invalidContextPageDurationMsCount: 1,
        }),
      );
      expect(matcher?.sql).toMatch(/typeof\s*\(/iu);
      expect(queries.filter((sql) => /typeof\s*\(/iu.test(sql))).toHaveLength(
        2,
      );
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("keeps selector-presence numeric proofs active for history Pages after the guard", async () => {
    const capturedQueries: Array<{
      readonly sql: string;
      readonly bindings: readonly (string | number | boolean | null)[];
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    let changedAfterGuard = false;
    const { env, database, queries } = sqliteEnv(
      [
        {
          visitId: "presence-proof-history-page",
          sessionId: "presence-proof-session",
          visitorId: "presence-proof-visitor",
          pageTimeMs: 10,
          pathname: "/history",
          durationMs: 10,
        },
        {
          visitId: "presence-proof-candidate-page",
          sessionId: "presence-proof-session",
          visitorId: "presence-proof-visitor",
          pageTimeMs: 20,
          pathname: "/candidate",
          durationMs: 2,
        },
      ],
      (sql, bindings, rows) => {
        capturedQueries.push({ sql, bindings, rows });
        if (!changedAfterGuard && rows.some((row) => "rawCount" in row)) {
          database
            .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
            .run("bad", "presence-proof-history-page");
          changedAfterGuard = true;
        }
      },
    );
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const time = {
        ...createQueryTime(15, 25, "UTC", 100),
        readRange: createTimeRange(0, 30),
      };
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "overview",
        advancedFilterInput(
          time,
          [SITE_ID],
          "count(page { page.durationMs gt 5 }.path) eq 1 AND page { page.durationMs gt 5 }.path exists",
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;

      expect(changedAfterGuard).toBe(true);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      const guard = capturedQueries.find(({ rows }) =>
        rows.some((row) => "rawCount" in row),
      );
      expect(guard?.rows[0]).toMatchObject({
        rawCount: 2,
        invalidContextPageDurationMsCount: 0,
      });
      const matcher = capturedQueries.find(({ rows }) =>
        rows.some((row) => row.rowKind === "numeric-domain"),
      );
      expect(matcher?.rows).toContainEqual(
        expect.objectContaining({
          rowKind: "numeric-domain",
          invalidContextPageDurationMsCount: 1,
        }),
      );
      expect(queries.filter((sql) => /typeof\s*\(/iu.test(sql))).toHaveLength(
        2,
      );
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("gates an overflowing INTEGER sum and emits the post-guard exact-domain control", async () => {
    const capturedQueries: Array<{
      readonly sql: string;
      readonly bindings: readonly (string | number | boolean | null)[];
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const mutationDatabase: { current?: DatabaseSync } = {};
    let changedAfterGuard = false;
    const { env, database } = sqliteEnv(
      [
        {
          visitId: "exact-overflow-a",
          sessionId: "exact-overflow-session",
          visitorId: "exact-overflow-visitor",
          pageTimeMs: 10,
          pathname: "/exact-overflow/a",
          durationMs: 1,
        },
        {
          visitId: "exact-overflow-b",
          sessionId: "exact-overflow-session",
          visitorId: "exact-overflow-visitor",
          pageTimeMs: 11,
          pathname: "/exact-overflow/b",
          durationMs: 1,
        },
      ],
      (sql, bindings, rows) => {
        capturedQueries.push({ sql, bindings, rows });
        if (!changedAfterGuard && rows.some((row) => "rawCount" in row)) {
          mutationDatabase.current
            ?.prepare(
              "UPDATE visits SET duration_ms = ? WHERE visit_id IN (?, ?)",
            )
            .run(
              9_000_000_000_000_000_000n,
              "exact-overflow-a",
              "exact-overflow-b",
            );
          changedAfterGuard = true;
        }
      },
      true,
    );
    mutationDatabase.current = database;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "overview",
        advancedFilterInput(
          {
            ...createQueryTime(0, 100, "UTC", 100),
            filterRange: createTimeRange(0, 100),
          },
          [SITE_ID],
          "sum(page.durationMs) eq 2",
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;

      expect(changedAfterGuard).toBe(true);
      const guard = capturedQueries.find(({ rows }) =>
        rows.some((row) => "rawCount" in row),
      );
      expect(guard?.rows[0]).toMatchObject({ rawCount: 2 });
      const matcher = capturedQueries.find(({ rows }) =>
        rows.some((row) => row.rowKind === "numeric-domain"),
      );
      expect(matcher).toBeDefined();
      expect(matcher!.rows).toContainEqual(
        expect.objectContaining({
          rowKind: "numeric-domain",
          invalidContextPageDurationMsCount: 2,
        }),
      );
      expect(matcher!.rows.filter((row) => row.rowKind === "match")).toEqual(
        [],
      );
      expect(matcher!.sql).toMatch(/SUM\s*\(\s*CAST\s*\(/iu);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("retains an exact Page count-cap control for Pages inserted after the guard", async () => {
    const capturedQueries: Array<{
      readonly sql: string;
      readonly bindings: readonly (string | number | boolean | null)[];
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database } = sqliteEnv(
      [
        {
          visitId: "exact-cap-candidate",
          sessionId: "exact-cap-session",
          visitorId: "exact-cap-visitor",
          pageTimeMs: 10,
          pathname: "/exact-cap-candidate",
          durationMs: 1,
        },
      ],
      (sql, bindings, rows) => capturedQueries.push({ sql, bindings, rows }),
    );
    const input = advancedFilterInput(
      createQueryTime(0, 100, "UTC", 100),
      [SITE_ID],
      "sum(page.durationMs) eq 20002",
    );
    const support = classifyAdvancedCountFilter(input.filters!, "session");
    if (support.kind !== "supported")
      throw new Error("expected supported exact aggregate Filter");
    const numericFields = support.numericCompatibilityRequirements.map(
      ({ fieldId }) => {
        const field = advancedCountSelectorField(fieldId);
        if (!field || field.kind !== "number")
          throw new Error("expected a Page numeric compatibility field");
        return field;
      },
    );
    const subject = createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID as SiteId],
    });
    const range = { startMs: 0, endExclusiveMs: 100 };
    try {
      const guard = await queryAdvancedFilterCountGuard({
        env,
        query: compileAdvancedFilterCountGuardQuery(
          buildAdvancedCountFilterGuardPlan({
            subject,
            range,
            reportingTimeZone: "UTC",
            numericCompatibilityRequirements:
              support.numericCompatibilityRequirements,
          }),
        ),
        numericCompatibilityFields: numericFields,
      });
      expect(guard.rawCount).toBe(1);
      expect(guard.numericCompatibilityFieldIds).toEqual([]);

      database
        .prepare(
          `WITH RECURSIVE generated(n) AS (
             SELECT 1
             UNION ALL SELECT n + 1 FROM generated WHERE n < 20001
           )
           INSERT INTO visits (
             visit_id, site_id, site_pk, visitor_id, session_id,
             started_at, pathname, duration_ms
           )
           SELECT 'exact-cap-inserted-' || n, ?, 1, ?, ?, 20,
             '/exact-cap-inserted', 1
           FROM generated`,
        )
        .run(SITE_ID, "exact-cap-visitor", "exact-cap-session");

      const matchPlan = buildAdvancedCountFilterMatchPlan({
        subject,
        candidateRange: range,
        readRange: range,
        expressionRange: range,
        expressionUsesExplicitRange: false,
        lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
        scope: "session",
        reportingTimeZone: "UTC",
        capturedAtMs: 100,
        analysis: support.analysis,
        numericCompatibilityRequirements:
          support.numericCompatibilityRequirements,
      });
      const result = await queryAdvancedFilterCountMatches({
        env,
        query: compileAdvancedFilterCountMatchesQuery(matchPlan),
        numericCompatibilityFields: numericFields,
      });
      const matcher = capturedQueries.find(({ rows }) =>
        rows.some((row) => row.rowKind === "numeric-domain"),
      );
      expect(result.matches).toEqual([]);
      expect(result.numericCompatibilityFieldIds).toEqual(["page.durationMs"]);
      expect(matcher?.rows).toContainEqual(
        expect.objectContaining({
          rowKind: "numeric-domain",
          invalidContextPageDurationMsCount: 1,
        }),
      );
      expect(matcher?.rows.filter((row) => row.rowKind === "match")).toEqual(
        [],
      );
    } finally {
      database.close();
    }
  });

  it("falls back for numeric changes in the separate candidate contribution bag", async () => {
    const candidateRange = { startMs: 15, endExclusiveMs: 25 };
    const readRange = { startMs: 30, endExclusiveMs: 100 };
    const filterDsl =
      'page.path eq "/candidate" AND count(page { page.durationMs gt 5 }) eq 0';
    const activities: readonly SharedActivity[] = [
      {
        visitId: "candidate-numeric-history-page",
        sessionId: "candidate-numeric-history-session",
        visitorId: "candidate-numeric-history-visitor",
        pageTimeMs: 10,
        pathname: "/history",
        durationMs: 10,
      },
      {
        visitId: "candidate-numeric-page",
        sessionId: "candidate-numeric-session",
        visitorId: "candidate-numeric-visitor",
        pageTimeMs: 20,
        pathname: "/candidate",
        durationMs: 10,
      },
    ];
    const queryTime = {
      ...createQueryTime(
        candidateRange.startMs,
        candidateRange.endExclusiveMs,
        "UTC",
        100,
      ),
      readRange: createTimeRange(readRange.startMs, readRange.endExclusiveMs),
    };
    const input = advancedFilterInput(
      queryTime,
      [SITE_ID],
      filterDsl,
      "session",
    );
    const oracle = evaluateFilterDocument(
      input.filters!,
      {
        pages: [
          {
            kind: "page",
            id: "candidate-numeric-history-page",
            time: 10,
            visitId: "candidate-numeric-history-page",
            sessionId: "candidate-numeric-history-session",
            visitorId: "candidate-numeric-history-visitor",
            fields: {
              "page.path": "/history",
              "page.durationMs": 10,
            },
          },
          {
            kind: "page",
            id: "candidate-numeric-page",
            time: 20,
            visitId: "candidate-numeric-page",
            sessionId: "candidate-numeric-session",
            visitorId: "candidate-numeric-visitor",
            fields: {
              "page.path": "/candidate",
              "page.durationMs": "0x10",
            },
          },
        ],
        events: [],
        coverageRange: { startMs: 0, endExclusiveMs: 100 },
      },
      {
        scope: "session",
        candidateRange,
        readRange,
        reportingTimeZone: "UTC",
        capturedAtMs: 100,
      },
    );
    expect([...oracle.matchingScopeEntityIds].sort()).toEqual([
      "candidate-numeric-session",
    ]);

    const capturedQueries: Array<{
      readonly sql: string;
      readonly bindings: readonly (string | number | boolean | null)[];
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const guardResponses: Array<readonly Record<string, unknown>[]> = [];
    const mutationDatabase: { current?: DatabaseSync } = {};
    let changedAfterGuards = false;
    const { env, database } = sqliteEnv(activities, (sql, bindings, rows) => {
      capturedQueries.push({ sql, bindings, rows });
      if (rows.some((row) => "rawCount" in row)) {
        guardResponses.push(rows);
        if (guardResponses.length === 2) {
          mutationDatabase.current
            ?.prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
            .run("0x10", "candidate-numeric-page");
          changedAfterGuards = true;
        }
      }
    });
    mutationDatabase.current = database;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "overview",
        input,
        async (value) => value,
      )) as typeof input;
      const guardRows = guardResponses.flat();
      const matcher = capturedQueries.find(({ rows }) =>
        rows.some((row) => row.rowKind === "numeric-domain"),
      );
      const outputIdentities =
        output.scopePlan?.advancedMatches?.entityIds ?? [];

      expect(changedAfterGuards).toBe(true);
      expect(guardResponses).toHaveLength(2);
      expect(guardRows.map((row) => row.rawCount).sort()).toEqual([0, 1]);
      expect(
        guardRows.every(
          (row) => (row.invalidContextPageDurationMsCount ?? 0) === 0,
        ),
      ).toBe(true);
      expect(matcher?.sql).toMatch(/typeof\s*\(/iu);
      expect(matcher?.rows).toContainEqual(
        expect.objectContaining({
          rowKind: "numeric-domain",
          invalidContextPageDurationMsCount: 1,
        }),
      );
      expect(matcher?.rows.filter((row) => row.rowKind === "match")).toEqual(
        [],
      );
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(outputIdentities).toEqual([
        { siteId: SITE_ID, id: "candidate-numeric-session" },
      ]);
      expect(outputIdentities.map(({ id }) => id)).toEqual(
        [...oracle.matchingScopeEntityIds].sort(),
      );
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it.each([
    {
      name: "candidate-marked session bag",
      scope: "session" as const,
      readRange: { startMs: 0, endExclusiveMs: 100 },
    },
    {
      name: "separate visitor bag",
      scope: "visitor" as const,
      readRange: { startMs: 0, endExclusiveMs: 15 },
    },
  ])(
    "retains a local Page numeric proof in the $name after guard mutation",
    async ({ scope, readRange }) => {
      const candidateRange = { startMs: 15, endExclusiveMs: 25 };
      const scopeId =
        scope === "session" ? "local-numeric-session" : "local-numeric-visitor";
      const expectedMinimum = scope === "session" ? 2 : 10;
      const filterDsl = [
        "page.durationMs gt 1",
        "count(page { page.durationMs gt 5 }) eq 1",
        `min(page.durationMs) eq ${expectedMinimum}`,
        "max(page.durationMs) eq 10",
      ].join(" AND ");
      const activities: readonly SharedActivity[] = [
        {
          visitId: "local-numeric-history-page",
          sessionId: "local-numeric-session",
          visitorId: "local-numeric-visitor",
          pageTimeMs: 10,
          pathname: "/history",
          durationMs: 10,
        },
        {
          visitId: "local-numeric-candidate-page",
          sessionId: "local-numeric-session",
          visitorId: "local-numeric-visitor",
          pageTimeMs: 20,
          pathname: "/candidate",
          durationMs: 2,
        },
      ];
      const queryTime = {
        ...createQueryTime(
          candidateRange.startMs,
          candidateRange.endExclusiveMs,
          "UTC",
          100,
        ),
        readRange: createTimeRange(readRange.startMs, readRange.endExclusiveMs),
      };
      const input = advancedFilterInput(queryTime, [SITE_ID], filterDsl, scope);
      const evaluate = (historyDuration: unknown) =>
        evaluateFilterDocument(
          input.filters!,
          {
            pages: [
              {
                kind: "page",
                id: "local-numeric-history-page",
                visitId: "local-numeric-history-page",
                time: 10,
                sessionId: "local-numeric-session",
                visitorId: "local-numeric-visitor",
                fields: { "page.durationMs": historyDuration },
              },
              {
                kind: "page",
                id: "local-numeric-candidate-page",
                visitId: "local-numeric-candidate-page",
                time: 20,
                sessionId: "local-numeric-session",
                visitorId: "local-numeric-visitor",
                fields: { "page.durationMs": 2 },
              },
            ],
            events: [],
            coverageRange: { startMs: 0, endExclusiveMs: 100 },
          },
          {
            scope,
            candidateRange,
            readRange,
            reportingTimeZone: "UTC",
            capturedAtMs: 100,
          },
        );

      expect([...evaluate(10).matchingScopeEntityIds]).toEqual([scopeId]);
      expect([...evaluate("bad").matchingScopeEntityIds]).toEqual([]);

      const capturedQueries: Array<{
        readonly sql: string;
        readonly bindings: readonly (string | number | boolean | null)[];
        readonly rows: readonly Record<string, unknown>[];
      }> = [];
      const mutationDatabase: { current?: DatabaseSync } = {};
      let changedAfterGuard = false;
      let guardCount = 0;
      const { env, database } = sqliteEnv(activities, (sql, bindings, rows) => {
        capturedQueries.push({ sql, bindings, rows });
        if (!changedAfterGuard && rows.some((row) => "rawCount" in row)) {
          guardCount += 1;
          mutationDatabase.current
            ?.prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
            .run("bad", "local-numeric-history-page");
          changedAfterGuard = true;
        }
      });
      mutationDatabase.current = database;
      const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
      const diagnostics = createD1ReadDiagnostics();
      try {
        const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
          "overview",
          input,
          async (value) => value,
        )) as typeof input;
        const matcher = capturedQueries.find(({ rows }) =>
          rows.some((row) => row.rowKind === "numeric-domain"),
        );

        expect(changedAfterGuard).toBe(true);
        expect(guardCount).toBe(1);
        expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });
        expect(matcher?.rows).toContainEqual(
          expect.objectContaining({
            rowKind: "numeric-domain",
            invalidContextPageDurationMsCount: 1,
          }),
        );
        expect(matcher?.rows.filter((row) => row.rowKind === "match")).toEqual(
          [],
        );
        expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
        expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      } finally {
        evaluatorSpy.mockRestore();
        database.close();
      }
    },
  );

  it.each([
    {
      name: "candidate-marked Session",
      scope: "session" as const,
      readRange: { startMs: 0, endExclusiveMs: 100 },
    },
    {
      name: "separate Visitor",
      scope: "visitor" as const,
      readRange: { startMs: 0, endExclusiveMs: 15 },
    },
  ])(
    "retains local Page numeric proof for a $name after guard mutation",
    async ({ scope, readRange }) => {
      const candidateRange = { startMs: 15, endExclusiveMs: 25 };
      const scopeId =
        scope === "session" ? "local-numeric-session" : "local-numeric-visitor";
      const filterDsl =
        "page.durationMs gt 1 AND count(page { page.durationMs gt 5 }) eq 1";
      const activities: readonly SharedActivity[] = [
        {
          visitId: "local-numeric-history-page",
          sessionId: "local-numeric-session",
          visitorId: "local-numeric-visitor",
          pageTimeMs: 10,
          pathname: "/history",
          durationMs: 10,
        },
        {
          visitId: "local-numeric-candidate-page",
          sessionId: "local-numeric-session",
          visitorId: "local-numeric-visitor",
          pageTimeMs: 20,
          pathname: "/candidate",
          durationMs: 2,
        },
      ];
      const queryTime = {
        ...createQueryTime(
          candidateRange.startMs,
          candidateRange.endExclusiveMs,
          "UTC",
          100,
        ),
        readRange: createTimeRange(readRange.startMs, readRange.endExclusiveMs),
      };
      const input = advancedFilterInput(queryTime, [SITE_ID], filterDsl, scope);
      const evaluate = (historyDuration: unknown) =>
        evaluateFilterDocument(
          input.filters!,
          {
            pages: [
              {
                kind: "page",
                id: "local-numeric-history-page",
                visitId: "local-numeric-history-page",
                time: 10,
                sessionId: "local-numeric-session",
                visitorId: "local-numeric-visitor",
                fields: { "page.durationMs": historyDuration },
              },
              {
                kind: "page",
                id: "local-numeric-candidate-page",
                visitId: "local-numeric-candidate-page",
                time: 20,
                sessionId: "local-numeric-session",
                visitorId: "local-numeric-visitor",
                fields: { "page.durationMs": 2 },
              },
            ],
            events: [],
            coverageRange: { startMs: 0, endExclusiveMs: 100 },
          },
          {
            scope,
            candidateRange,
            readRange,
            reportingTimeZone: "UTC",
            capturedAtMs: 100,
          },
        );

      expect([...evaluate(10).matchingScopeEntityIds]).toEqual([scopeId]);
      expect([...evaluate("bad").matchingScopeEntityIds]).toEqual([]);

      const capturedQueries: Array<{
        readonly sql: string;
        readonly bindings: readonly (string | number | boolean | null)[];
        readonly rows: readonly Record<string, unknown>[];
      }> = [];
      const mutationDatabase: { current?: DatabaseSync } = {};
      let changedAfterGuard = false;
      let guardCount = 0;
      const { env, database } = sqliteEnv(activities, (sql, bindings, rows) => {
        capturedQueries.push({ sql, bindings, rows });
        if (!changedAfterGuard && rows.some((row) => "rawCount" in row)) {
          guardCount += 1;
          mutationDatabase.current
            ?.prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
            .run("bad", "local-numeric-history-page");
          changedAfterGuard = true;
        }
      });
      mutationDatabase.current = database;
      const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
      const diagnostics = createD1ReadDiagnostics();
      try {
        const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
          "overview",
          input,
          async (value) => value,
        )) as typeof input;
        const matcher = capturedQueries.find(({ rows }) =>
          rows.some((row) => row.rowKind === "numeric-domain"),
        );

        expect(changedAfterGuard).toBe(true);
        expect(guardCount).toBe(1);
        expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });
        expect(matcher?.rows).toContainEqual(
          expect.objectContaining({
            rowKind: "numeric-domain",
            invalidContextPageDurationMsCount: 1,
          }),
        );
        expect(matcher?.rows.filter((row) => row.rowKind === "match")).toEqual(
          [],
        );
        expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([]);
        expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      } finally {
        evaluatorSpy.mockRestore();
        database.close();
      }
    },
  );

  it("matches same-field Page and Event count selectors across text, BLOB, and NULL values", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "selector-match-page",
        sessionId: "selector-match-session",
        visitorId: "selector-match-visitor",
        pageTimeMs: 15_100,
        pathname: "/match",
        event: {
          id: "selector-match-event",
          name: "purchase",
          timeMs: 15_200,
        },
        additionalEvents: [
          {
            id: "selector-match-second-event",
            name: "signup",
            timeMs: 15_250,
          },
        ],
      },
      {
        visitId: "selector-other-page",
        sessionId: "selector-other-session",
        visitorId: "selector-other-visitor",
        pageTimeMs: 15_300,
        pathname: "\u2003/other\u00a0",
        event: {
          id: "selector-other-event",
          name: "signup",
          timeMs: 15_400,
        },
      },
      {
        visitId: "selector-blob-page",
        sessionId: "selector-blob-session",
        visitorId: "selector-blob-visitor",
        pageTimeMs: 15_500,
        pathname: "/match",
        selectorPathOverride: new Uint8Array([47, 109, 97, 116, 99, 104]),
        event: {
          id: "selector-blob-event",
          name: "refund",
          selectorNameOverride: new Uint8Array([114, 101, 102, 117, 110, 100]),
          timeMs: 15_600,
        },
      },
      {
        visitId: "selector-null-page",
        sessionId: "selector-null-session",
        visitorId: "selector-null-visitor",
        pageTimeMs: 15_700,
        pathname: "/null",
        selectorPathOverride: null,
        event: {
          id: "selector-null-event",
          name: "cancellation",
          timeMs: 15_800,
        },
      },
      {
        visitId: "selector-special-text-page",
        sessionId: "selector-special-text-session",
        visitorId: "selector-special-text-visitor",
        pageTimeMs: 15_900,
        pathname: "\u2003/café/😀%_\\Suffix\u0000tail\u00a0",
      },
    ];
    const shared = {
      activities,
      scope: "session" as const,
      candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
      capturedAtMs: 20_000,
    };
    const cases: readonly (AdvancedCountParityRequest & {
      readonly filterDsl: string;
      readonly expectedIdentities: readonly string[];
    })[] = [
      {
        ...shared,
        filterDsl: 'count(page { page.path eq "/match" }) eq 1',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl: 'count(page { page.path eq "/other" }) eq 1',
        expectedIdentities: ["selector-other-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.path contains ${JSON.stringify("/other")} }) eq 1`,
        expectedIdentities: ["selector-other-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.path contains ${JSON.stringify("\u2003/other\u00a0")} }) eq 1`,
        expectedIdentities: ["selector-other-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.path startsWith ${JSON.stringify("/café/😀")} }) eq 1`,
        expectedIdentities: ["selector-special-text-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.path endsWith ${JSON.stringify("\\Suffix\u0000tail")} }) eq 1`,
        expectedIdentities: ["selector-special-text-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.path contains ${JSON.stringify("%_\\")} }) eq 1`,
        expectedIdentities: ["selector-special-text-session"],
      },
      {
        ...shared,
        filterDsl: 'count(page { page.path contains "CAFÉ" }) eq 1',
        expectedIdentities: [],
      },
      {
        ...shared,
        filterDsl: 'count(page { page.path contains "" }) eq 1',
        expectedIdentities: [
          "selector-match-session",
          "selector-other-session",
          "selector-special-text-session",
        ],
      },
      {
        ...shared,
        filterDsl: 'count(page { NOT (page.path contains "match") }) eq 0',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.path startsWith ${JSON.stringify("/café/")} AND page.path contains ${JSON.stringify("😀%_\\")} }) eq 1`,
        expectedIdentities: ["selector-special-text-session"],
      },
      {
        ...shared,
        filterDsl: `count(page { page.path startsWith ${JSON.stringify("/missing/")} OR page.path endsWith ${JSON.stringify("tail")} }) eq 1`,
        expectedIdentities: ["selector-special-text-session"],
      },
      {
        ...shared,
        filterDsl:
          'count(page { page.path eq "/match" OR page.path eq "/other" }) eq 1',
        expectedIdentities: [
          "selector-match-session",
          "selector-other-session",
        ],
      },
      {
        ...shared,
        filterDsl: 'count(page { page.path in ["/match", "/match"] }) eq 1',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl: 'count(page { page.path neq "/match" }) eq 1',
        expectedIdentities: [
          "selector-blob-session",
          "selector-other-session",
          "selector-special-text-session",
        ],
      },
      {
        ...shared,
        filterDsl: 'count(page { page.path notIn ["/match"] }) eq 1',
        expectedIdentities: [
          "selector-blob-session",
          "selector-other-session",
          "selector-special-text-session",
        ],
      },
      {
        ...shared,
        filterDsl: 'count(page { NOT (page.path eq "/match") }) eq 1',
        expectedIdentities: [
          "selector-blob-session",
          "selector-null-session",
          "selector-other-session",
          "selector-special-text-session",
        ],
      },
      {
        ...shared,
        filterDsl: "count(page { page.path isNull }) eq 1",
        expectedIdentities: ["selector-null-session"],
      },
      {
        ...shared,
        filterDsl: 'count(event { event.name eq "purchase" }) eq 1',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl: 'count(event { event.name contains "pur" }) eq 1',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl: 'count(event { event.name startsWith "pur" }) eq 1',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl: 'count(event { event.name endsWith "up" }) eq 1',
        expectedIdentities: [
          "selector-match-session",
          "selector-other-session",
        ],
      },
      {
        ...shared,
        filterDsl:
          'count(event { event.name startsWith "pur" AND event.name endsWith "ase" }) eq 1',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl:
          'count(event { event.name startsWith "pur" OR event.name startsWith "sig" }) eq 2',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl:
          'count(event { event.name eq "purchase" AND event.name eq "signup" }) eq 0 AND count(event { event.name eq "purchase" OR event.name eq "signup" }) eq 2',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl: 'count(event { event.name neq "purchase" }) eq 1',
        expectedIdentities: [
          "selector-blob-session",
          "selector-match-session",
          "selector-null-session",
          "selector-other-session",
        ],
      },
      {
        ...shared,
        filterDsl:
          'count(page { page.path eq "/match" }) eq 1 AND count(event { event.name eq "purchase" }) eq 1',
        expectedIdentities: ["selector-match-session"],
      },
      {
        ...shared,
        filterDsl:
          'add(count(page { page.path in ["/match"] }), count(event { event.name in ["purchase"] })) in [0, 2]',
        expectedIdentities: [
          "selector-blob-session",
          "selector-null-session",
          "selector-other-session",
          "selector-match-session",
          "selector-special-text-session",
        ],
      },
      {
        ...shared,
        activities: activities.slice(0, 2).map((activity) => ({
          ...activity,
          visitorId: "selector-shared-visitor",
        })),
        scope: "visitor",
        filterDsl: 'count(page { page.path eq "/match" }) eq 1',
        expectedIdentities: ["selector-shared-visitor"],
      },
      {
        ...shared,
        activities: activities.slice(0, 2).map((activity) => ({
          ...activity,
          visitorId: "selector-shared-string-visitor",
        })),
        scope: "visitor",
        filterDsl: 'count(page { page.path contains "other" }) eq 1',
        expectedIdentities: ["selector-shared-string-visitor"],
      },
      {
        ...shared,
        activities: [
          {
            visitId: "selector-empty-read-page",
            sessionId: "selector-empty-read-session",
            visitorId: "selector-empty-read-visitor",
            pageTimeMs: 15_100,
            pathname: "/candidate",
          },
        ],
        readRange: { startMs: 1_000, endExclusiveMs: 2_000 },
        expectedAnchorPlan: "two-bag",
        filterDsl: 'count(page { page.path eq "/missing" }) eq 0',
        expectedIdentities: ["selector-empty-read-session"],
      },
      {
        ...shared,
        activities: [
          {
            visitId: "selector-history-only-page",
            sessionId: "selector-history-only-session",
            visitorId: "selector-history-only-visitor",
            pageTimeMs: 1_100,
            pathname: "/target",
          },
          {
            visitId: "selector-candidate-page",
            sessionId: "selector-candidate-session",
            visitorId: "selector-candidate-visitor",
            pageTimeMs: 15_100,
            pathname: "/target",
          },
        ],
        readRange: { startMs: 1_000, endExclusiveMs: 20_000 },
        expectedAnchorPlan: "single-bag",
        filterDsl: 'count(page { page.path eq "/target" }) eq 1',
        expectedIdentities: ["selector-candidate-session"],
      },
    ];

    for (const request of cases) {
      const result = await evaluateAdvancedCountFixture(request);
      expect(result.d1, request.filterDsl).toEqual(result.oracle);
      expect(result.d1, request.filterDsl).toEqual(
        [...request.expectedIdentities].sort(),
      );
      expect(result.fallbackReason, request.filterDsl).toBeUndefined();
      const matcher = result.queries.find(
        (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(matcher, request.filterDsl).toBeDefined();
      if (
        /(?:page\.path|event\.name)\s+(?:eq|neq|in|notIn|contains|startsWith|endsWith)\b/u.test(
          request.filterDsl,
        )
      )
        expect(matcher).toMatch(/typeof\s*\(/iu);
      if (/\bisNull\b/u.test(request.filterDsl))
        expect(matcher).not.toMatch(/typeof\s*\(/iu);
    }
  });

  it("uses common JSON membership for 128 integers and whole-tree budget fallback for decimals", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "numeric-set-budget-page",
        sessionId: "numeric-set-budget-session",
        visitorId: "numeric-set-budget-visitor",
        pageTimeMs: 101,
        pathname: "/numeric-set-budget",
      },
    ];
    const integerValues = Array.from({ length: 128 }, (_, index) => index);
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const packed = await evaluateAdvancedCountFixture({
        activities,
        filterDsl: `count(page) in [${integerValues.join(",")}]`,
        scope: "session",
        candidateRange: { startMs: 100, endExclusiveMs: 200 },
        expectedIdentities: ["numeric-set-budget-session"],
        capturedAtMs: 1_000,
      });
      expect(packed.d1).toEqual(packed.oracle);
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      const packedMatcher = packed.statements.find(
        ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(packedMatcher).toBeDefined();
      expect(packedMatcher!.sql).toMatch(/json_each/iu);
      expect(Buffer.byteLength(packedMatcher!.sql, "utf8")).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(packedMatcher!.bindings.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      const encodedSet = packedMatcher!.bindings.find(
        (binding) =>
          typeof binding === "string" && binding.startsWith("[0,1,2,"),
      );
      expect(encodedSet).toBeDefined();
      expect(JSON.parse(String(encodedSet))).toEqual(integerValues);

      evaluatorSpy.mockClear();
      const decimalValues = Array.from(
        { length: 128 },
        (_, index) => (index + 1) / 1_000,
      );
      const budgetFallback = await evaluateAdvancedCountFixture({
        activities,
        filterDsl: `count(page) in [${decimalValues.join(",")}]`,
        scope: "session",
        candidateRange: { startMs: 100, endExclusiveMs: 200 },
        expectedIdentities: [],
        capturedAtMs: 1_000,
      });
      expect(budgetFallback.d1).toEqual(budgetFallback.oracle);
      expect(evaluatorSpy).toHaveBeenCalledTimes(2);
      expect(budgetFallback.fallbackReason).toMatchObject({
        kind: "compile-budget",
        item: "bindings",
        limit: D1_MAX_BOUND_PARAMETERS,
      });
      expect(
        budgetFallback.statements.some(
          ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(false);

      evaluatorSpy.mockClear();
      const selectorValues = Array.from(
        { length: 128 },
        (_, index) => `selector-value-${index}`,
      );
      const selectorBudgetFallback = await evaluateAdvancedCountFixture({
        activities,
        filterDsl: `count(page { page.path in [${selectorValues.map((value) => JSON.stringify(value)).join(",")}] }) eq 1`,
        scope: "session",
        candidateRange: { startMs: 100, endExclusiveMs: 200 },
        expectedIdentities: [],
        capturedAtMs: 1_000,
      });
      expect(selectorBudgetFallback.d1).toEqual(selectorBudgetFallback.oracle);
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      expect(selectorBudgetFallback.fallbackReason).toBeUndefined();
      const selectorMatcher = selectorBudgetFallback.statements.find(
        ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(selectorMatcher).toBeDefined();
      expect(selectorMatcher!.sql).toMatch(/json_each/iu);
      expect(selectorMatcher!.bindings.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );

      evaluatorSpy.mockClear();
      const selectorClauses = Array.from(
        { length: 55 },
        (_, index) =>
          `count(page { page.path eq ${JSON.stringify(`selector-ast-${index}`)} }) eq ${index}`,
      );
      const selectorAstFallback = await evaluateAdvancedCountFixture({
        activities,
        filterDsl: selectorClauses.join(" AND "),
        scope: "session",
        candidateRange: { startMs: 100, endExclusiveMs: 200 },
        expectedIdentities: [],
        capturedAtMs: 1_000,
      });
      expect(selectorAstFallback.d1).toEqual(selectorAstFallback.oracle);
      expect(evaluatorSpy).toHaveBeenCalledTimes(2);
      expect(selectorAstFallback.fallbackReason).toMatchObject({
        kind: "compile-budget",
      });
      expect(
        selectorAstFallback.statements.some(
          ({ sql }) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(false);
    } finally {
      evaluatorSpy.mockRestore();
    }
  });

  it("uses one full-history bag for candidate anchors and drops history-only identities", async () => {
    const siteIds = teamSiteIds(2);
    const { env, database, queries } = sqliteEnv([]);
    seedTeamSites(database, siteIds, new Map([[siteIds[1]!, 1]]));
    addTeamPage(database, {
      siteId: siteIds[0]!,
      sitePk: 1,
      visitId: "single-bag-history-only-page",
      sessionId: "single-bag-history-only-session",
      startedAt: 500,
    });
    addTeamPage(database, {
      siteId: siteIds[1]!,
      sitePk: 2,
      visitId: "single-bag-candidate-page",
      sessionId: "single-bag-candidate-session",
      startedAt: 1_500,
    });
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const time = {
        ...createQueryTime(1_000, 1_800, "UTC", 3_000),
        fullHistory: true,
      };
      const output = (await d1AdvancedFilterMiddleware(env)(
        "overview",
        advancedFilterTeamInput(time, siteIds, "count(page) eq 1"),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterTeamInput>;

      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([
        { siteId: siteIds[1], id: "single-bag-candidate-session" },
      ]);
      expect(evaluatorSpy).not.toHaveBeenCalled();
      const matcher = queries.find(
        (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(matcher).toBeDefined();
      expect(/SELECT\s+DISTINCT/iu.test(matcher!)).toBe(false);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("keeps candidate anchors outside a late per-site read lower bound", async () => {
    const siteIds = teamSiteIds(2);
    const { env, database, queries } = sqliteEnv([]);
    seedTeamSites(database, siteIds, new Map([[siteIds[1]!, 2]]));
    addTeamPage(database, {
      siteId: siteIds[1]!,
      sitePk: 2,
      visitId: "late-created-candidate-page",
      sessionId: "late-created-candidate-session",
      startedAt: 1_500,
    });
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const time = {
        ...createQueryTime(1_000, 1_800, "UTC", 3_000),
        fullHistory: true,
      };
      const output = (await d1AdvancedFilterMiddleware(env)(
        "overview",
        advancedFilterTeamInput(time, siteIds, "count(page) eq 0"),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterTeamInput>;

      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([
        { siteId: siteIds[1], id: "late-created-candidate-session" },
      ]);
      expect(evaluatorSpy).not.toHaveBeenCalled();
      const matcher = queries.find(
        (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
      );
      expect(matcher).toBeDefined();
      expect(/SELECT\s+DISTINCT/iu.test(matcher!)).toBe(true);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("executes mixed-unit count arithmetic through SQL and matches the evaluator", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "mixed-unit-page-a",
        sessionId: "mixed-unit-session",
        visitorId: "mixed-unit-visitor",
        pageTimeMs: 15_100,
        pathname: "/mixed-a",
        event: {
          id: "mixed-unit-event",
          name: "purchase",
          timeMs: 15_250,
        },
      },
      {
        visitId: "mixed-unit-page-b",
        sessionId: "mixed-unit-session",
        visitorId: "mixed-unit-visitor",
        pageTimeMs: 15_300,
        pathname: "/mixed-b",
      },
    ];
    for (const filterDsl of [
      "add(count(page), div(count(event), count(page))) gt 2",
      "sub(count(page), div(count(event), count(page))) eq 1.5",
      "mul(div(count(event), count(page)), div(count(event), count(page))) eq 0.25",
    ]) {
      const result = await evaluateAdvancedCountFixture({
        activities,
        filterDsl,
        scope: "session",
        candidateRange: { startMs: 15_000, endExclusiveMs: 16_000 },
        capturedAtMs: 20_000,
      });
      expect(result.d1).toEqual(result.oracle);
      expect(result.d1).toEqual(["mixed-unit-session"]);
      expect(result.fallbackReason).toBeUndefined();
      expect(
        result.queries.some(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(true);
    }
  });

  it("matches JavaScript binary64 at a real 19,999-row count and rounded layers", async () => {
    const count = 19_999;
    const activities: readonly SharedActivity[] = Array.from(
      { length: count },
      (_, index) => ({
        visitId: `binary64-page-${index}`,
        sessionId: "binary64-session",
        visitorId: "binary64-visitor",
        pageTimeMs: index + 1,
        pathname: "/binary64",
      }),
    );
    const { env, database, queries } = sqliteEnv(activities);
    const range = { startMs: 0, endExclusiveMs: 20_000 };
    const fourthPower =
      "mul(mul(count(page), count(page)), mul(count(page), count(page)))";
    const jsFourthPower = count * count * (count * count);
    const expressions = [
      `${fourthPower} eq ${jsFourthPower}`,
      `${fourthPower} neq ${jsFourthPower + 32}`,
      `${fourthPower} gt ${jsFourthPower - 32}`,
      `add(${fourthPower}, div(count(page), count(page))) eq ${jsFourthPower}`,
    ];
    const oraclePages: FilterEvaluationEntity[] = activities.map(
      (activity) => ({
        kind: "page",
        id: activity.visitId,
        time: activity.pageTimeMs,
        visitId: activity.visitId,
        sessionId: activity.sessionId,
        visitorId: activity.visitorId,
        fields: {},
      }),
    );
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      expect((BigInt(count) ** 4n).toString()).toBe("159968002399920001");
      expect(jsFourthPower).toBe(159968002399920000);

      for (const filterDsl of expressions) {
        const input = advancedFilterInput(
          createQueryTime(range.startMs, range.endExclusiveMs, "UTC", 20_000),
          [SITE_ID],
          filterDsl,
        );
        const queryOffset = queries.length;
        const diagnostics = createD1ReadDiagnostics();
        evaluatorSpy.mockClear();
        const prepared = (await d1AdvancedFilterMiddleware(env, diagnostics)(
          "performance",
          input,
          async (value) => value,
        )) as typeof input;

        expect(evaluatorSpy).not.toHaveBeenCalled();
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        expect(prepared.scopePlan?.advancedMatches?.entityIds).toEqual([
          { siteId: SITE_ID, id: "binary64-session" },
        ]);
        const matcherStatements = queries.slice(queryOffset);
        expect(matcherStatements).toHaveLength(2);
        const matcher = matcherStatements.find(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        );
        expect(matcher).toBeDefined();
        expect(matcher).toMatch(/CAST\s*\(/iu);
        expect(matcher).toMatch(/AS REAL/iu);

        const oracle = evaluateFilterDocument(
          input.filters!,
          {
            pages: oraclePages,
            events: [],
            coverageRange: range,
          },
          {
            scope: "session",
            candidateRange: range,
            readRange: range,
            reportingTimeZone: "UTC",
            capturedAtMs: 20_000,
          },
        );
        expect([...oracle.matchingScopeEntityIds]).toEqual([
          "binary64-session",
        ]);
      }
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  }, 20_000);

  it("falls back when count arithmetic can exceed the conservative binary64 bound", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "nonfinite-count-page",
        sessionId: "nonfinite-count-session",
        visitorId: "nonfinite-count-visitor",
        pageTimeMs: 101,
        pathname: "/nonfinite-count",
      },
    ];
    let target = "count(page)";
    for (let depth = 0; depth < 7; depth++)
      target = `mul(${target}, ${target})`;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const result = await evaluateAdvancedCountFixture({
        activities,
        filterDsl: `${target} eq 1`,
        scope: "session",
        candidateRange: { startMs: 100, endExclusiveMs: 200 },
        capturedAtMs: 1_000,
      });

      expect(result.d1).toEqual(result.oracle);
      expect(result.d1).toEqual(["nonfinite-count-session"]);
      // One invocation is the middleware fallback and one is the helper's oracle.
      expect(evaluatorSpy).toHaveBeenCalledTimes(2);
      expect(
        result.queries.some(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bSUM\s*\(/iu.test(sql),
        ),
      ).toBe(false);
    } finally {
      evaluatorSpy.mockRestore();
    }
  });

  it("captures null activity ID guard and legacy activity evidence", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "null-activity-id",
        sessionId: "null-id-session",
        visitorId: "null-id-visitor",
        pageTimeMs: 10,
        pathname: "/null-id",
      },
      {
        visitId: "same-time-non-null-activity-id",
        sessionId: "null-id-session",
        visitorId: "null-id-visitor",
        pageTimeMs: 10,
        pathname: "/same-time",
      },
    ];
    const capturedQueries: Array<{
      readonly sql: string;
      readonly bindings: readonly (string | number | boolean | null)[];
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv(
      activities,
      (sql, bindings, rows) => capturedQueries.push({ sql, bindings, rows }),
    );
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const columns = database
        .prepare("PRAGMA table_info(visits)")
        .all() as Array<{ readonly name: string }>;
      const viewColumns = columns.map(({ name }) =>
        name === "visit_id"
          ? "CASE WHEN visit_id = 'null-activity-id' THEN NULL ELSE visit_id END AS visit_id"
          : `"${name.replaceAll('"', '""')}"`,
      );
      database.exec("ALTER TABLE visits RENAME TO visits_storage");
      database.exec(
        `CREATE VIEW visits AS SELECT ${viewColumns.join(", ")} FROM visits_storage`,
      );

      const input = advancedFilterInput(
        createQueryTime(0, 100, "UTC", 100),
        [SITE_ID],
        "count(page) gte 1",
      );
      const middlewareResult = await d1AdvancedFilterMiddleware(env)(
        "performance",
        input,
        async (prepared) => prepared,
      );
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      expect(queries).toHaveLength(3);
      const guard = capturedQueries[1]!;
      expect(guard.sql).toMatch(/nullActivityIdCount/iu);
      expect(guard.sql).toMatch(/AS MATERIALIZED/iu);
      expect(guard.bindings).toContain(20_001);
      const combinedGuardRow = guard.rows.find(
        (row) => row.rowKind === "guard",
      );
      expect(combinedGuardRow).toMatchObject({
        rawCount: 2,
        nullActivityIdCount: 1,
      });
      expect(middlewareResult).toMatchObject({
        scopePlan: {
          advancedMatches: { entityIds: [{ id: "null-id-session" }] },
        },
      });

      const subject = createSemanticSubjectDomain({
        origin: "team",
        teamId: "team-1" as TeamId,
        siteIds: [SITE_ID as SiteId],
      });
      const currentLegacyRows = await queryAdvancedFilterActivityRange({
        env,
        subject,
        siteIds: [SITE_ID],
        range: { startMs: 0, endExclusiveMs: 100 },
      });
      expect(
        currentLegacyRows.map(({ kind, id, time }) => ({ kind, id, time })),
      ).toEqual([
        { kind: "page", id: null, time: 10 },
        { kind: "page", id: "same-time-non-null-activity-id", time: 10 },
      ]);

      const pages = currentLegacyRows.map(
        (row) =>
          ({
            kind: "page",
            id: row.id,
            time: row.time,
            visitId: row.visit_id,
            sessionId: row.session_id,
            visitorId: row.visitor_id,
            fields: {},
          }) as unknown as FilterEvaluationEntity,
      );
      const legacyEvaluation = evaluateFilterDocument(
        input.filters!,
        {
          pages,
          events: [],
          coverageRange: { startMs: 0, endExclusiveMs: 100 },
        },
        {
          scope: "session",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          readRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 100,
        },
      );
      expect([...legacyEvaluation.matchingScopeEntityIds]).toEqual([
        "null-id-session",
      ]);
      const fallbackActivityQuery = capturedQueries[2]!;
      expect(fallbackActivityQuery.sql).toMatch(/visit_id/iu);
      expect(fallbackActivityQuery.rows).toHaveLength(2);
      expect(
        (evaluatorSpy.mock.calls[0]?.[1] as FilterEvaluationDataset).pages.map(
          (page) => page.id,
        ),
      ).toEqual([null, "same-time-non-null-activity-id"]);
      const activityQuery = capturedQueries.at(-1)!;
      expect(activityQuery.sql).toMatch(/visit_id/iu);
      expect(activityQuery.rows).toHaveLength(2);
      expect(activityQuery).toEqual(fallbackActivityQuery);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("keeps null activity ID fallback ahead of numeric-domain fallback", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "null-numeric-activity-id",
        sessionId: "null-numeric-session",
        visitorId: "null-numeric-visitor",
        pageTimeMs: 10,
        pathname: "/null-numeric",
        selectorDurationMsOverride: "0x10",
      },
    ];
    const capturedQueries: Array<{
      readonly sql: string;
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv(
      activities,
      (sql, _bindings, rows) => capturedQueries.push({ sql, rows }),
    );
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("0x10", "null-numeric-activity-id");
    expect(
      database
        .prepare(
          "SELECT duration_ms, typeof(duration_ms) AS storage_class FROM visits",
        )
        .get(),
    ).toMatchObject({ duration_ms: "0x10", storage_class: "text" });
    const columns = database
      .prepare("PRAGMA table_info(visits)")
      .all() as Array<{ readonly name: string }>;
    const viewColumns = columns.map(({ name }) =>
      name === "visit_id"
        ? "CASE WHEN visit_id = 'null-numeric-activity-id' THEN NULL ELSE visit_id END AS visit_id"
        : `"${name.replaceAll('"', '""')}"`,
    );
    database.exec("ALTER TABLE visits RENAME TO visits_storage");
    database.exec(
      `CREATE VIEW visits AS SELECT ${viewColumns.join(", ")} FROM visits_storage`,
    );
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const output = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "performance",
        advancedFilterInput(
          createQueryTime(0, 100, "UTC", 100),
          [SITE_ID],
          "count(page) gte 1 AND count(page { page.durationMs gt 5 }) gte 0",
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;

      expect(output.scopePlan?.advancedMatches?.entityIds).toEqual([
        { siteId: SITE_ID, id: "null-numeric-session" },
      ]);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "null-activity-id",
      });
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      expect(queries.some((sql) => /GROUP BY/iu.test(sql))).toBe(true);
      const guard = capturedQueries.find(({ rows }) =>
        rows.some((row) => "rawCount" in row),
      );
      expect(guard?.rows[0]).toMatchObject({
        rawCount: 1,
        nullActivityIdCount: 1,
        invalidContextPageDurationMsCount: 1,
      });
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("preflights a legal AST that exceeds one matcher budget before guard SQL", async () => {
    const activities: readonly SharedActivity[] = [
      ...Array.from({ length: 128 }, (_, index) => ({
        visitId: `large-count-pass-page-${index}`,
        sessionId: "large-count-pass-session",
        visitorId: "large-count-pass-visitor",
        pageTimeMs: 10 + index,
        pathname: "/large-count-pass",
      })),
      ...Array.from({ length: 127 }, (_, index) => ({
        visitId: `large-count-fail-page-${index}`,
        sessionId: "large-count-fail-session",
        visitorId: "large-count-fail-visitor",
        pageTimeMs: 500 + index,
        pathname: "/large-count-fail",
      })),
    ];
    const capturedQueries: Array<{
      readonly sql: string;
      readonly bindings: readonly (string | number | boolean | null)[];
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv(
      activities,
      (sql, bindings, rows) => capturedQueries.push({ sql, bindings, rows }),
    );
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const filterDsl = Array.from(
        { length: 128 },
        (_, index) => `count(page) gt ${index + 0.125}`,
      ).join(" AND ");
      const prepared = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "performance",
        advancedFilterInput(
          createQueryTime(0, 2_000, "UTC", 2_000),
          [SITE_ID],
          filterDsl,
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;

      expect(prepared.scopePlan?.advancedMatches?.entityIds).toEqual([
        { siteId: SITE_ID, id: "large-count-pass-session" },
      ]);
      expect(evaluatorSpy).toHaveBeenCalledTimes(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "compile-budget",
        item: "bindings",
        actual: expect.any(Number),
        limit: 100,
      });
      expect(diagnostics.advancedCountSqlFallbackReason?.kind).toBe(
        "compile-budget",
      );
      expect(queries).toHaveLength(2);
      expect(capturedQueries).toHaveLength(2);
      expect(capturedQueries.some(({ sql }) => /SUM\s*\(/iu.test(sql))).toBe(
        false,
      );
      expect(capturedQueries.some(({ sql }) => /GROUP BY/iu.test(sql))).toBe(
        false,
      );
      expect(capturedQueries[1]?.rows).toHaveLength(255);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("keeps a near-limit distinct threshold AST on the SQL path", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "near-budget-page-a",
        sessionId: "near-budget-session",
        visitorId: "near-budget-visitor",
        pageTimeMs: 10,
        pathname: "/near-budget-a",
      },
      {
        visitId: "near-budget-page-b",
        sessionId: "near-budget-session",
        visitorId: "near-budget-visitor",
        pageTimeMs: 20,
        pathname: "/near-budget-b",
      },
    ];
    const capturedQueries: Array<{
      readonly sql: string;
      readonly bindings: readonly (string | number | boolean | null)[];
      readonly rows: readonly Record<string, unknown>[];
    }> = [];
    const { env, database, queries } = sqliteEnv(
      activities,
      (sql, bindings, rows) => capturedQueries.push({ sql, bindings, rows }),
    );
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    try {
      const filterDsl = Array.from(
        { length: 90 },
        (_, index) => `count(page) gt ${index / 1_000}`,
      ).join(" AND ");
      const prepared = (await d1AdvancedFilterMiddleware(env, diagnostics)(
        "performance",
        advancedFilterInput(
          createQueryTime(0, 100, "UTC", 100),
          [SITE_ID],
          filterDsl,
        ),
        async (input) => input,
      )) as ReturnType<typeof advancedFilterInput>;
      expect(prepared.scopePlan?.advancedMatches?.entityIds).toEqual([
        { siteId: SITE_ID, id: "near-budget-session" },
      ]);
      expect(evaluatorSpy).not.toHaveBeenCalled();
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      const matcher = capturedQueries.find(({ sql }) => /GROUP BY/iu.test(sql));
      expect(matcher).toBeDefined();
      expect(matcher!.bindings.length).toBeGreaterThanOrEqual(90);
      expect(matcher!.bindings.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(matcher!.sql, "utf8")).toBeLessThanOrEqual(
        100_000,
      );
      expect(queries).toHaveLength(2);
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("carries SQL matches through the public overview DTO like the legacy evaluator", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "public-overview-page-a",
        sessionId: "public-overview-session-a",
        visitorId: "public-overview-visitor-a",
        pageTimeMs: 1_000,
        pathname: "/selected-a",
      },
      {
        visitId: "public-overview-page-b",
        sessionId: "public-overview-session-a",
        visitorId: "public-overview-visitor-a",
        pageTimeMs: 1_500,
        pathname: "/selected-b",
      },
      {
        visitId: "public-overview-page-c",
        sessionId: "public-overview-session-b",
        visitorId: "public-overview-visitor-b",
        pageTimeMs: 2_000,
        pathname: "/unselected",
      },
    ];
    const { env, database, queries } = sqliteEnv(activities);
    const principal: ApiKeyPrincipal = {
      keyId: "count-sql-public-test-key",
      teamId: "team-1",
      prefix: "count-sql-public",
      scopes: ["analytics:read"],
      siteIds: [SITE_ID],
      status: "active",
    };
    const runtime = createEdgeSiteAnalyticsRuntime({ env, siteId: SITE_ID });
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const request = (expression: string) =>
      new Request("https://app.test/api/v1/sites/site/analytics/overview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeRange: {
            kind: "absolute",
            from: "1970-01-01T00:00:00.000Z",
            to: "1970-01-01T00:00:03.000Z",
            timeZone: "UTC",
          },
          filter: { type: "dsl", expression },
          scope: "session",
        }),
      });
    const execute = async (expression: string) => {
      aggregateCache.clear();
      const response = await handlePlannedSiteOverview(
        request(expression),
        principal,
        SITE_ID,
        runtime,
        { capturedAtMs: 4_000 },
      );
      return {
        status: response.status,
        body: (await response.json()) as {
          readonly data?: Record<string, unknown>;
        },
      };
    };

    try {
      const sqlResult = await execute("count(page) gte 2");
      expect(sqlResult.status).toBe(200);
      expect(sqlResult.body.data).toMatchObject({ views: 2, sessions: 1 });
      expect(evaluatorSpy).not.toHaveBeenCalled();
      expect(
        queries.some(
          (sql) => /\bGROUP BY\b/iu.test(sql) && /\bCOUNT\s*\(/iu.test(sql),
        ),
      ).toBe(true);

      const legacyResult = await execute(
        "count(page) gte 2 AND countDistinct(page) gte 0",
      );
      expect(legacyResult.status).toBe(200);
      expect(legacyResult.body.data).toEqual(sqlResult.body.data);
      expect(evaluatorSpy).toHaveBeenCalled();
    } finally {
      evaluatorSpy.mockRestore();
      aggregateCache.clear();
      database.close();
    }
  });

  it("uses evaluation history for Core and Relation while legacy fields stay in the candidate range", async () => {
    const { env, database } = sqliteEnv();
    try {
      const document = parseFilterDsl(
        SHARED_FILTER_DSL,
        analyticsFilterRegistry,
      );
      const time = {
        ...createQueryTime(10_000, 20_000, "UTC", 25_000),
        readRange: createTimeRange(0, 10_000),
      };
      const plan = createScopedFilterPlan("overview", document, "session");
      expect(plan).not.toBeNull();
      const filters = attachScopedFilterMetadata(document, {
        requestedScope: "session",
        resolvedScope: "session",
        plan: plan!,
        time,
        siteIds: [SITE_ID],
      });
      const input = {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        filters,
        scopePreference: "session" as const,
        scopePlan: plan!,
        time,
      };
      const middleware = d1AdvancedFilterMiddleware(env);
      const output = await middleware(
        "overview",
        input,
        async (prepared) => prepared,
      );
      const prepared = output as typeof input;
      const resolvedPlan = prepared.scopePlan!;
      expect(resolvedPlan.advancedMatches?.entityIds).toEqual([
        { siteId: SITE_ID, id: "session-a" },
      ]);

      const compiled = compileScopedDatasetSql({
        filters: prepared.filters!,
        plan: resolvedPlan,
        siteIds: [SITE_ID],
        window: {
          startMs: 10_000,
          endExclusiveMs: 20_000,
          nowMs: 25_000,
          timeZone: "UTC",
        },
      });
      expect(compiled.ctes).toContain("scope_advanced_matching_entities");
      expect(compiled.ctes).toContain(
        "matching_entities.entity_id = rv.session_id",
      );
      expect(compiled.bindings.map((binding) => binding.value)).toContain(
        "session-a",
      );

      const mockResult = applyDemoFilters(sharedDemoDataset(), {
        filterDocument: document,
        scope: "session",
        candidateRange: { startMs: 10_000, endExclusiveMs: 20_000 },
        readRange: { startMs: 0, endExclusiveMs: 10_000 },
        reportingTimeZone: "UTC",
        capturedAtMs: 25_000,
      });
      expect([...mockResult.sessions]).toEqual(
        (resolvedPlan.advancedMatches?.entityIds ?? []).map((item) => item.id),
      );
      expect([...mockResult.sessions]).toEqual(["session-a"]);
    } finally {
      database.close();
    }
  });

  it("compiles session and visitor fact filters with typed SQL bindings", () => {
    const cases = [
      ["session.views gt 1", "scope_session_facts", [1]],
      ["session.bounce eq true", "session_bounce", [1]],
      ["session.views between [1, 3]", " BETWEEN ? AND ?", [1, 3]],
      ["session.events notIn [2, 4]", " NOT IN (?, ?)", [2, 4]],
      ["visitor.sessions gte 2", "scope_visitor_facts", [2]],
    ] as const;
    const window = {
      startMs: 0,
      endExclusiveMs: 20_000,
      nowMs: 25_000,
      timeZone: "UTC",
    };

    for (const [source, expectedSql, expectedValues] of cases) {
      const document = parseFilterDsl(source, analyticsFilterRegistry);
      const plan = createScopedFilterPlan("overview", document, "session");
      expect(plan).not.toBeNull();
      const time = createQueryTime(
        window.startMs,
        window.endExclusiveMs,
        window.timeZone,
        window.nowMs,
      );
      const filters = attachScopedFilterMetadata(document, {
        requestedScope: "session",
        resolvedScope: "session",
        plan: plan!,
        time,
        siteIds: [SITE_ID],
      });
      const compiled = compileScopedDatasetSql({
        filters,
        plan: plan!,
        siteIds: [SITE_ID],
        window,
      });

      expect(compiled.ctes).toContain(expectedSql);
      expect(compiled.bindings.map((binding) => binding.value)).toEqual(
        expect.arrayContaining([...expectedValues]),
      );
    }
  });

  it("rejects whole-payload object members when a JSON path is required", () => {
    const eventRoot = { kind: "entity-root", entity: "event" } as const;
    const payloadProjection = {
      kind: "selector",
      collection: eventRoot,
      predicate: {
        kind: "condition",
        target: {
          kind: "projection",
          collection: eventRoot,
          member: "payload",
        },
        operator: "exists",
      },
    } as const;
    const document = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: {
            kind: "selector",
            collection: { kind: "entity-root", entity: "session" },
            predicate: {
              kind: "condition",
              target: payloadProjection,
              operator: "exists",
            },
          },
          operator: "exists",
        },
      },
      analyticsFilterRegistry,
    );
    expect(() =>
      prepareScopedQuery("overview", {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        filters: document,
        scopePreference: "session",
        time: createQueryTime(0, 20_000, "UTC", 25_000),
      } as never),
    ).toThrow(expect.objectContaining({ code: "invalid_member" }));
  });

  it("prepares both comparison sides and rejects advanced filters without execution metadata", async () => {
    const { env, database } = sqliteEnv();
    try {
      const document = parseFilterDsl(
        "count(page) gte 1",
        analyticsFilterRegistry,
      );
      const makeSide = (from: number, to: number) => {
        const time = createQueryTime(from, to, "UTC", 25_000);
        const plan = createScopedFilterPlan("comparison", document, "session");
        if (!plan) throw new Error("expected_scoped_filter_plan");
        return {
          time,
          filters: attachScopedFilterMetadata(document, {
            requestedScope: "session",
            resolvedScope: "session",
            plan,
            time,
            siteIds: [SITE_ID],
          }),
        };
      };
      const current = makeSide(10_000, 20_000);
      const reference = makeSide(0, 10_000);
      const prepared = (await d1AdvancedFilterMiddleware(env)(
        "comparison",
        {
          context: siteQueryContext(SITE_ID, "private-dashboard"),
          current,
          reference,
        },
        async (input) => input,
      )) as {
        current: ReturnType<typeof makeSide>;
        reference: ReturnType<typeof makeSide>;
      };

      expect(
        scopedFilterMetadata(prepared.current.filters)?.plan.advancedMatches,
      ).toEqual({
        entityIds: [
          { siteId: SITE_ID, id: "session-a" },
          { siteId: SITE_ID, id: "session-b" },
        ],
      });
      expect(
        scopedFilterMetadata(prepared.reference.filters)?.plan.advancedMatches,
      ).toEqual({ entityIds: [{ siteId: SITE_ID, id: "session-a" }] });

      const unscoped = parseFilterDsl(
        "count(page) gte 1",
        analyticsFilterRegistry,
      );
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "comparison",
          {
            context: siteQueryContext(SITE_ID, "private-dashboard"),
            filters: unscoped,
          },
          async (input) => input,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [
            {
              path: "filters",
              code: "advanced_filter_execution_context_required",
            },
          ],
        },
      });
    } finally {
      database.close();
    }
  });

  it("keeps Relation semantics consistent across D1 and Mock fixtures", async () => {
    const sharedRange = { startMs: 0, endExclusiveMs: 20_000 };
    const sameMillisecond = await evaluateSharedFixture({
      activities: SHARED_ACTIVITIES,
      filterDsl:
        'session { adjacent(sequence([page { page.path eq "/same-millisecond" }, event { event.name eq "purchase" }])) exists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(sameMillisecond.d1).toEqual(["session-a"]);
    expect(sameMillisecond.mock).toEqual(sameMillisecond.d1);

    const reverseSameMillisecond = await evaluateSharedFixture({
      activities: SHARED_ACTIVITIES,
      filterDsl:
        'session { sequence([event { event.name eq "purchase" }, page { page.path eq "/same-millisecond" }]) exists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(reverseSameMillisecond.d1).toEqual([]);
    expect(reverseSameMillisecond.mock).toEqual(reverseSameMillisecond.d1);

    const withoutBetweenEndpoints = await evaluateSharedFixture({
      activities: SHARED_ACTIVITIES,
      filterDsl:
        'session { sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists AND without(sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]), event { event.name eq "cancellation" }) notExists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(withoutBetweenEndpoints.d1).toEqual(["session-a"]);
    expect(withoutBetweenEndpoints.mock).toEqual(withoutBetweenEndpoints.d1);

    const descendantActivities: readonly SharedActivity[] = [
      {
        visitId: "descendant-page-a",
        sessionId: "descendant-session",
        visitorId: "descendant-visitor",
        pageTimeMs: 10,
        pathname: "/home",
        title: "Home",
      },
      {
        visitId: "descendant-page-b",
        sessionId: "descendant-session",
        visitorId: "descendant-visitor",
        pageTimeMs: 20,
        pathname: "/pricing",
        title: "Checkout",
      },
      {
        visitId: "descendant-event-c",
        sessionId: "descendant-session",
        visitorId: "descendant-visitor",
        pageTimeMs: 25,
        pathname: "/other",
        event: {
          id: "descendant-event-c:purchase",
          name: "purchase",
          timeMs: 30,
        },
      },
    ];
    const lifted = await evaluateSharedFixture({
      activities: descendantActivities,
      filterDsl:
        'session { page.path eq "/pricing" AND event.name eq "purchase" } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(lifted.d1).toEqual(["descendant-session"]);
    expect(lifted.mock).toEqual(lifted.d1);

    const independentlyLifted = await evaluateSharedFixture({
      activities: descendantActivities,
      filterDsl:
        'session { page.path eq "/pricing" AND page.title eq "Home" } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(independentlyLifted.d1).toEqual(["descendant-session"]);
    expect(independentlyLifted.mock).toEqual(independentlyLifted.d1);

    const samePageOnly = await evaluateSharedFixture({
      activities: descendantActivities,
      filterDsl:
        'session { page { page.path eq "/pricing" AND page.title eq "Home" } exists } exists',
      scope: "session",
      candidateRange: sharedRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(samePageOnly.d1).toEqual([]);
    expect(samePageOnly.mock).toEqual(samePageOnly.d1);
  });

  it("keeps Legacy string predicates and canonical scope facts consistent across providers", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "legacy-docs",
        sessionId: "legacy-session-a",
        visitorId: "legacy-visitor-a",
        pageTimeMs: 10,
        pathname: "/Docs/start",
        hostname: "Example.Test",
      },
      {
        visitId: "legacy-lower",
        sessionId: "legacy-session-b",
        visitorId: "legacy-visitor-b",
        pageTimeMs: 20,
        pathname: "/docs/start",
        hostname: "example.test",
      },
      {
        visitId: "legacy-wildcard",
        sessionId: "legacy-session-c",
        visitorId: "legacy-visitor-c",
        pageTimeMs: 30,
        pathname: "/Docs/100X_ready",
        hostname: "api.example.test",
      },
      {
        visitId: "legacy-empty-title",
        sessionId: "legacy-session-empty",
        visitorId: "legacy-visitor-empty",
        pageTimeMs: 40,
        pathname: "/empty-title",
        title: "",
        hostname: "empty.example.test",
      },
    ];
    const { database } = sqliteEnv(activities);
    const legacyIds = (filterDsl: string) => {
      const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
      const compiled = compileFilterDocument(document);
      return (
        database
          .prepare(
            `SELECT DISTINCT visitor_id FROM visits visit_source WHERE site_pk = 1 AND (${compiled.clause.replace(/^WHERE\s+/u, "")}) ORDER BY visitor_id`,
          )
          .all(...compiled.bindings) as Array<{ visitor_id: string }>
      ).map((row) => row.visitor_id);
    };
    try {
      const parityCases = [
        ['page.path eq "/Docs/start"', ["legacy-visitor-a"]],
        [
          'page.path neq "/elsewhere"',
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          'page.path in ["/Docs/start", "/docs/start"]',
          ["legacy-visitor-a", "legacy-visitor-b"],
        ],
        [
          'page.path notIn ["/elsewhere"]',
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        ['page.path contains "Docs"', ["legacy-visitor-a", "legacy-visitor-c"]],
        [
          'page.path startsWith "/Docs"',
          ["legacy-visitor-a", "legacy-visitor-c"],
        ],
        [
          'page.path endsWith "start"',
          ["legacy-visitor-a", "legacy-visitor-b"],
        ],
        [
          "page.durationMs gt 4",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.durationMs gte 5",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.durationMs lt 6",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.durationMs lte 5",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.durationMs between [5, 5]",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        [
          "page.path exists",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        ["page.path notExists", []],
        ["page.path isNull", []],
        [
          "page.path notNull",
          [
            "legacy-visitor-a",
            "legacy-visitor-b",
            "legacy-visitor-c",
            "legacy-visitor-empty",
          ],
        ],
        ["page.title isEmpty", ["legacy-visitor-empty"]],
        [
          "page.title notEmpty",
          ["legacy-visitor-a", "legacy-visitor-b", "legacy-visitor-c"],
        ],
        [
          'page.hostname eq "EXAMPLE.TEST"',
          ["legacy-visitor-a", "legacy-visitor-b"],
        ],
      ] as const;
      for (const [legacyFilter, expected] of parityCases) {
        const mixedFilter = `${legacyFilter} AND count(event) gte 0`;
        const baseline = legacyIds(legacyFilter);
        const result = await evaluateSharedFixture({
          activities,
          filterDsl: mixedFilter,
          scope: "visitor",
          candidateRange: { startMs: 0, endExclusiveMs: 100 },
          reportingTimeZone: "UTC",
          capturedAtMs: 100,
        });
        expect(baseline).toEqual(expected);
        expect(result.d1).toEqual(baseline);
        expect(result.mock).toEqual(baseline);
      }
    } finally {
      database.close();
    }

    const factParity = await evaluateSharedFixture({
      activities: [
        {
          visitId: "fact-entry",
          sessionId: "fact-session-a",
          visitorId: "fact-visitor",
          pageTimeMs: 10,
          pathname: "/entry",
        },
        {
          visitId: "fact-event",
          sessionId: "fact-session-a",
          visitorId: "fact-visitor",
          pageTimeMs: 15,
          pathname: "/event",
          event: { id: "fact-event:purchase", name: "purchase", timeMs: 16 },
        },
        {
          visitId: "fact-exit",
          sessionId: "fact-session-a",
          visitorId: "fact-visitor",
          pageTimeMs: 20,
          pathname: "/exit",
        },
        {
          visitId: "fact-bounce",
          sessionId: "fact-session-b",
          visitorId: "fact-visitor",
          pageTimeMs: 30,
          pathname: "/bounce",
        },
      ],
      filterDsl:
        'visitor { visitor.sessions eq 2 AND visitor.views eq 4 AND visitor.events eq 1 AND session { session.durationMs eq 15 AND session.views eq 3 AND session.events eq 1 AND session.bounce eq false AND session.entryPath eq "/entry" AND session.exitPath eq "/exit" } exists } exists',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 2_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 2_000,
    });
    expect(factParity.d1).toEqual(["fact-visitor"]);
    expect(factParity.mock).toEqual(factParity.d1);
  });

  it("keeps numeric arithmetic, typed payloads, Duration ranges, auto history, and root Relations in provider parity", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "advanced-candidate-a",
        sessionId: "candidate-session-a",
        visitorId: "advanced-visitor",
        pageTimeMs: 15_000,
        pathname: "/candidate-a",
      },
      {
        visitId: "advanced-candidate-b",
        sessionId: "candidate-session-b",
        visitorId: "advanced-visitor",
        pageTimeMs: 16_000,
        pathname: "/candidate-b",
      },
      {
        visitId: "advanced-signup",
        sessionId: "history-session-a",
        visitorId: "advanced-visitor",
        pageTimeMs: 10,
        pathname: "/signup",
        event: { id: "advanced-signup:signup", name: "signup", timeMs: 1_010 },
      },
      {
        visitId: "advanced-purchase-text",
        sessionId: "history-session-b",
        visitorId: "advanced-visitor",
        pageTimeMs: 20,
        pathname: "/purchase-text",
        event: {
          id: "advanced-purchase-text:purchase",
          name: "purchase",
          timeMs: 1_020,
          payload: { amount: "0", productId: "123" },
        },
      },
      {
        visitId: "advanced-purchase-number-a",
        sessionId: "history-session-b",
        visitorId: "advanced-visitor",
        pageTimeMs: 30,
        pathname: "/purchase-number-a",
        event: {
          id: "advanced-purchase-number-a:purchase",
          name: "purchase",
          timeMs: 1_030,
          payload: { amount: 20, productId: 123 },
        },
      },
      {
        visitId: "advanced-purchase-number-b",
        sessionId: "history-session-b",
        visitorId: "advanced-visitor",
        pageTimeMs: 40,
        pathname: "/purchase-number-b",
        event: {
          id: "advanced-purchase-number-b:purchase",
          name: "purchase",
          timeMs: 1_040,
          payload: { amount: 30, productId: "123" },
        },
      },
    ];
    const automaticHistory = await evaluateSharedFixture({
      activities,
      filterDsl:
        'count(event { event.name eq "purchase" }) gte 3 AND min(event { event.name eq "purchase" }.payload("/amount")) gt 15 AND countDistinct(event { event.name eq "purchase" }.payload("/productId")) eq 2 AND sub(count(event { event.name eq "purchase" }), count(page)) lt 0 AND div(sub(count(event { event.name eq "purchase" }), count(page)), count(page)) lt 0',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(automaticHistory.d1).toEqual(["advanced-visitor"]);
    expect(automaticHistory.mock).toEqual(automaticHistory.d1);

    const narrowedNumber = await evaluateSharedFixture({
      activities,
      filterDsl: 'first(event.payload("/amount")) eq 20',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(narrowedNumber.d1).toEqual(["advanced-visitor"]);
    expect(narrowedNumber.mock).toEqual(narrowedNumber.d1);

    const narrowedString = await evaluateSharedFixture({
      activities,
      filterDsl: 'first(event.payload("/amount")) eq "0"',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(narrowedString.d1).toEqual(["advanced-visitor"]);
    expect(narrowedString.mock).toEqual(narrowedString.d1);

    const narrowedSet = await evaluateSharedFixture({
      activities,
      filterDsl: 'first(event.payload("/amount")) in [20, 30]',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(narrowedSet.d1).toEqual(["advanced-visitor"]);
    expect(narrowedSet.mock).toEqual(narrowedSet.d1);

    const wrappedHistory = await evaluateSharedFixture({
      activities,
      filterDsl:
        'first(periods(event { event.name eq "purchase" }, 1d) { count($items) gte 1 }) exists',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(wrappedHistory.d1).toEqual(["advanced-visitor"]);
    expect(wrappedHistory.mock).toEqual(wrappedHistory.d1);

    const entityAnchoredWindow = await evaluateSharedFixture({
      activities,
      filterDsl:
        'count(window(event { event.name eq "purchase" }, first(event { event.name eq "signup" }), [0ms, 20ms])) gte 1',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(entityAnchoredWindow.d1).toEqual(["advanced-visitor"]);
    expect(entityAnchoredWindow.mock).toEqual(entityAnchoredWindow.d1);

    const visitorSequence =
      'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists';
    const visitorRelation = await evaluateSharedFixture({
      activities,
      filterDsl: visitorSequence,
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(visitorRelation.d1).toEqual(["advanced-visitor"]);
    expect(visitorRelation.mock).toEqual(visitorRelation.d1);

    const sessionRelation = await evaluateSharedFixture({
      activities,
      filterDsl: visitorSequence,
      scope: "session",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(sessionRelation.d1).toEqual([]);
    expect(sessionRelation.mock).toEqual(sessionRelation.d1);

    const contextualActivities: readonly SharedActivity[] = [
      {
        visitId: "same-view-a",
        sessionId: "same-session-a",
        visitorId: "same-visitor-a",
        pageTimeMs: 10,
        pathname: "/view-a",
        event: {
          id: "same-view-a:event",
          name: "view",
          timeMs: 10,
          payload: { productId: "A" },
        },
      },
      {
        visitId: "same-purchase-a",
        sessionId: "same-session-a",
        visitorId: "same-visitor-a",
        pageTimeMs: 20,
        pathname: "/purchase-a",
        event: {
          id: "same-purchase-a:event",
          name: "purchase",
          timeMs: 20,
          payload: { productId: "A" },
        },
      },
      {
        visitId: "same-view-b",
        sessionId: "same-session-b",
        visitorId: "same-visitor-b",
        pageTimeMs: 10,
        pathname: "/view-b",
        event: {
          id: "same-view-b:event",
          name: "view",
          timeMs: 10,
          payload: { productId: "A" },
        },
      },
      {
        visitId: "same-purchase-b",
        sessionId: "same-session-b",
        visitorId: "same-visitor-b",
        pageTimeMs: 20,
        pathname: "/purchase-b",
        event: {
          id: "same-purchase-b:event",
          name: "purchase",
          timeMs: 20,
          payload: { productId: "B" },
        },
      },
    ];
    const contextualParity = await evaluateSharedFixture({
      activities: contextualActivities,
      filterDsl:
        'sequence([event { event.name eq "view" }, event { event.name eq "purchase" }]) { $span lte 20ms AND $gap(1, 2) eq 10ms AND $same(event.payload("/productId")) } exists',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 2_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 2_000,
    });
    expect(contextualParity.d1).toEqual(["same-visitor-a"]);
    expect(contextualParity.mock).toEqual(contextualParity.d1);

    const occurrenceTimeParity = await evaluateSharedFixture({
      activities: contextualActivities,
      filterDsl:
        'sub(time(first(event { event.name eq "purchase" })), time(first(event { event.name eq "view" }))) eq 10ms',
      scope: "visitor",
      candidateRange: { startMs: 0, endExclusiveMs: 2_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 2_000,
    });
    expect(occurrenceTimeParity.d1).toEqual([
      "same-visitor-a",
      "same-visitor-b",
    ]);
    expect(occurrenceTimeParity.mock).toEqual(occurrenceTimeParity.d1);
  });

  it("evaluates complete Visitor filters in Filter time and projects only Query time", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "aug-signup-match",
        sessionId: "aug-session-match",
        visitorId: "visitor-history-match",
        pageTimeMs: 105,
        pathname: "/signup",
        event: {
          id: "aug-signup-event",
          name: "signup",
          timeMs: 115,
        },
      },
      {
        visitId: "aug-page-match",
        sessionId: "aug-session-match",
        visitorId: "visitor-history-match",
        pageTimeMs: 110,
        pathname: "/august",
        event: {
          id: "aug-purchase-match",
          name: "purchase",
          timeMs: 120,
        },
      },
      {
        visitId: "sep-page-match",
        sessionId: "sep-session-match",
        visitorId: "visitor-history-match",
        pageTimeMs: 3_220,
        pathname: "/september",
      },
      {
        visitId: "aug-page-no-purchase",
        sessionId: "aug-session-no-purchase",
        visitorId: "visitor-current-only-purchase",
        pageTimeMs: 130,
        pathname: "/august",
      },
      {
        visitId: "sep-page-current-purchase",
        sessionId: "sep-session-current-purchase",
        visitorId: "visitor-current-only-purchase",
        pageTimeMs: 3_230,
        pathname: "/september",
        event: {
          id: "sep-purchase-current-only",
          name: "purchase",
          timeMs: 3_240,
        },
      },
    ];
    const filters = [
      'event.name eq "purchase"',
      'count(event { event.name eq "purchase" }) eq 1',
      'first(event).name eq "signup"',
      'sequence([event { event.name eq "signup" }, event { event.name eq "purchase" }]) exists',
    ];
    for (const expression of filters) {
      const result = await evaluateSharedFixture({
        activities,
        filterDsl: `time between ["1970-01-01T00:00:00.100Z", "1970-01-01T00:00:01.999Z"] AND ${expression}`,
        scope: "visitor",
        candidateRange: { startMs: 3_000, endExclusiveMs: 4_000 },
        reportingTimeZone: "UTC",
        capturedAtMs: 3_999,
      });

      expect(result.d1).toEqual(["visitor-history-match"]);
      expect(result.mock).toEqual(result.d1);
      expect(result.mockVisitIds).toEqual(["sep-page-match"]);
    }

    const sessionActivities: readonly SharedActivity[] = [
      {
        visitId: "session-history-purchase",
        sessionId: "session-history",
        visitorId: "visitor-session-history",
        pageTimeMs: 110,
        pathname: "/august",
        event: {
          id: "session-history-purchase-event",
          name: "purchase",
          timeMs: 120,
        },
      },
      {
        visitId: "session-current-page",
        sessionId: "session-history",
        visitorId: "visitor-session-history",
        pageTimeMs: 3_220,
        pathname: "/september",
      },
      {
        visitId: "session-current-only-purchase",
        sessionId: "session-current-only",
        visitorId: "visitor-current-only",
        pageTimeMs: 3_230,
        pathname: "/september",
        event: {
          id: "session-current-only-purchase-event",
          name: "purchase",
          timeMs: 3_240,
        },
      },
    ];
    const sessionResult = await evaluateSharedFixture({
      activities: sessionActivities,
      filterDsl:
        'time between ["1970-01-01T00:00:00.100Z", "1970-01-01T00:00:01.999Z"] AND event.name eq "purchase"',
      scope: "session",
      candidateRange: { startMs: 3_000, endExclusiveMs: 4_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 3_999,
    });
    expect(sessionResult.d1).toEqual(["session-history"]);
    expect(sessionResult.mock).toEqual(sessionResult.d1);
    expect(sessionResult.mockVisitIds).toEqual(["session-current-page"]);
  });

  it("short-circuits future-only Filter ranges in D1 and Mock", async () => {
    const result = await evaluateSharedFixture({
      activities: SHARED_ACTIVITIES,
      filterDsl: "time gte @now+1ms AND count(event) gte 1",
      scope: "visitor",
      candidateRange: { startMs: 10_000, endExclusiveMs: 20_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 25_000,
    });
    expect(result.d1).toEqual([]);
    expect(result.mock).toEqual([]);
    expect(result.mockVisitIds).toEqual([]);
  });

  it("skips a Filter time domain that ends before confirmed site coverage", async () => {
    const { env, database } = sqliteEnv([]);
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const diagnostics = createD1ReadDiagnostics();
    database
      .prepare("UPDATE sites SET created_at = 1 WHERE id = ?")
      .run(SITE_ID);
    try {
      const input = prepareScopedQuery("overview", {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        filters: parseFilterDsl(
          "time lt @now-50ms AND count(page) gte 1",
          analyticsFilterRegistry,
        ),
        scopePreference: "session",
        time: createQueryTime(0, 200, "UTC", 200),
      });
      if (!input.scopePlan) throw new Error("expected_scoped_filter_plan");
      const preparedTime = (input as typeof input & { time: QueryTime }).time;
      expect(preparedTime).toMatchObject({
        filterRange: { endExclusiveMs: 150 },
        fullHistory: true,
      });
      expect(preparedTime.filterRangeEmpty).not.toBe(true);

      const output = await d1AdvancedFilterMiddleware(env, diagnostics)(
        "overview",
        input,
        async (prepared) => prepared,
      );
      expect(
        (output as typeof input).scopePlan?.advancedMatches?.entityIds,
      ).toEqual([]);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(evaluatorSpy).not.toHaveBeenCalled();
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("extends Window reads beyond Filter time without widening candidate projection", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "window-purchase",
        sessionId: "window-session",
        visitorId: "visitor-window",
        pageTimeMs: 1_100,
        pathname: "/history/purchase",
        event: {
          id: "window-purchase-event",
          name: "purchase",
          timeMs: 1_200,
        },
      },
      {
        visitId: "window-refund",
        sessionId: "window-session",
        visitorId: "visitor-window",
        pageTimeMs: 8_000_000,
        pathname: "/history/refund",
        event: {
          id: "window-refund-event",
          name: "refund",
          timeMs: 8_000_100,
        },
      },
      {
        visitId: "window-query-projection",
        sessionId: "query-session",
        visitorId: "visitor-window",
        pageTimeMs: 9_000_000,
        pathname: "/current-window",
      },
    ];
    const result = await evaluateSharedFixture({
      activities,
      filterDsl:
        'time between ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:03.000Z"] AND count(window(event, first(event { event.name eq "purchase" }), [0d, 7d])) gte 2',
      scope: "visitor",
      candidateRange: { startMs: 9_000_000, endExclusiveMs: 10_000_000 },
      filterRange: { startMs: 1_000, endExclusiveMs: 3_001 },
      reportingTimeZone: "UTC",
      capturedAtMs: 10_000_000,
    });
    expect(result.d1).toEqual(["visitor-window"]);
    expect(result.mock).toEqual(result.d1);
    expect(result.mockVisitIds).toEqual(["window-query-projection"]);
  });

  it("applies top-level Activity time to aggregate Scopes without removing the predicate", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "old-history",
        sessionId: "old-session",
        visitorId: "visitor-with-old-activity",
        pageTimeMs: 500,
        pathname: "/candidate",
      },
      {
        visitId: "old-candidate",
        sessionId: "old-session",
        visitorId: "visitor-with-old-activity",
        pageTimeMs: 15_000,
        pathname: "/candidate",
      },
      {
        visitId: "new-candidate",
        sessionId: "new-session",
        visitorId: "visitor-without-old-activity",
        pageTimeMs: 16_000,
        pathname: "/candidate",
      },
    ];
    const result = await evaluateSharedFixture({
      activities,
      filterDsl: 'time lt @now-19s AND page.path eq "/candidate"',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(result.d1).toEqual(["visitor-with-old-activity"]);
    expect(result.mock).toEqual(result.d1);

    const beforeCoverage = await evaluateSharedFixture({
      activities,
      filterDsl:
        'time lt "1969-12-31T23:59:59.999Z" AND page.path eq "/candidate"',
      scope: "visitor",
      candidateRange: { startMs: 15_000, endExclusiveMs: 17_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(beforeCoverage.d1).toEqual([]);
    expect(beforeCoverage.mock).toEqual(beforeCoverage.d1);
  });

  it("uses Filter Range Visitor facts for the full Filter and keeps D1/Mock aligned", async () => {
    const filterDsl =
      'time between ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:03.000Z"] AND visitor.sessions gte 2';
    const candidateRange = { startMs: 10_000, endExclusiveMs: 20_000 };

    const filterRangeOneSession = await evaluateSharedFixture({
      activities: [
        {
          visitId: "visitor-filter-one",
          sessionId: "filter-session-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 1_100,
          pathname: "/filter",
        },
        {
          visitId: "visitor-query-one",
          sessionId: "query-session-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 15_000,
          pathname: "/query",
        },
        {
          visitId: "visitor-query-two",
          sessionId: "query-session-b",
          visitorId: "visitor-range-a",
          pageTimeMs: 16_000,
          pathname: "/query",
        },
      ],
      filterDsl,
      scope: "visitor",
      candidateRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(filterRangeOneSession.d1).toEqual([]);
    expect(filterRangeOneSession.mock).toEqual(filterRangeOneSession.d1);
    expect(filterRangeOneSession.mockVisitIds).toEqual([]);

    const filterRangeTwoSessions = await evaluateSharedFixture({
      activities: [
        {
          visitId: "visitor-filter-one",
          sessionId: "filter-session-a",
          visitorId: "visitor-range-b",
          pageTimeMs: 1_100,
          pathname: "/filter",
        },
        {
          visitId: "visitor-filter-two",
          sessionId: "filter-session-b",
          visitorId: "visitor-range-b",
          pageTimeMs: 1_200,
          pathname: "/filter",
        },
        {
          visitId: "visitor-query-one",
          sessionId: "query-session-a",
          visitorId: "visitor-range-b",
          pageTimeMs: 15_000,
          pathname: "/query",
        },
      ],
      filterDsl,
      scope: "visitor",
      candidateRange,
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });
    expect(filterRangeTwoSessions.d1).toEqual(["visitor-range-b"]);
    expect(filterRangeTwoSessions.mock).toEqual(filterRangeTwoSessions.d1);
    expect(filterRangeTwoSessions.mockVisitIds).toEqual(["visitor-query-one"]);
  });

  it("uses Filter Range Session facts instead of Query Range candidates", async () => {
    const result = await evaluateSharedFixture({
      activities: [
        {
          visitId: "session-filter-one",
          sessionId: "session-range-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 1_100,
          pathname: "/filter-one",
        },
        {
          visitId: "session-filter-two",
          sessionId: "session-range-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 1_200,
          pathname: "/filter-two",
        },
        {
          visitId: "session-query-one",
          sessionId: "session-range-a",
          visitorId: "visitor-range-a",
          pageTimeMs: 15_000,
          pathname: "/query",
        },
      ],
      filterDsl:
        'time between ["1970-01-01T00:00:01.000Z", "1970-01-01T00:00:03.000Z"] AND session.views eq 2 AND session.durationMs eq 10',
      scope: "session",
      candidateRange: { startMs: 10_000, endExclusiveMs: 20_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 20_000,
    });

    expect(result.d1).toEqual(["session-range-a"]);
    expect(result.mock).toEqual(result.d1);
    expect(result.mockVisitIds).toEqual(["session-query-one"]);
  });

  it("keeps DST calendar bucket counts, periods, and empty reducers consistent across providers", async () => {
    for (const timestamp of [
      Date.parse("2026-03-08T20:00:00Z"),
      Date.parse("2026-11-01T20:00:00Z"),
    ] as const) {
      const range = { startMs: timestamp - 1, endExclusiveMs: timestamp + 1 };
      const activity: SharedActivity = {
        visitId: `dst-${timestamp}`,
        sessionId: `session-dst-${timestamp}`,
        visitorId: `visitor-dst-${timestamp}`,
        pageTimeMs: timestamp,
        pathname: "/dst",
      };
      const expressions = [
        "countDistinct(bucket(page, 1d)) eq 1",
        "count(periods(page, 1d)) eq 1",
      ];
      for (const filterDsl of expressions) {
        const result = await evaluateSharedFixture({
          activities: [activity],
          filterDsl,
          scope: "session",
          candidateRange: range,
          reportingTimeZone: "America/Los_Angeles",
          capturedAtMs: timestamp + 1,
        });
        expect(result.d1).toEqual([activity.sessionId]);
        expect(result.mock).toEqual(result.d1);
      }
    }

    const sunday = Date.parse("2026-03-08T20:00:00Z");
    const saturday = Date.parse("2026-03-14T20:00:00Z");
    const weekRange = { startMs: sunday - 1, endExclusiveMs: saturday + 1 };
    const weekActivities: readonly SharedActivity[] = [
      {
        visitId: "week-sunday",
        sessionId: "session-week",
        visitorId: "visitor-week",
        pageTimeMs: sunday,
        pathname: "/sunday",
      },
      {
        visitId: "week-saturday",
        sessionId: "session-week",
        visitorId: "visitor-week",
        pageTimeMs: saturday,
        pathname: "/saturday",
      },
    ];
    const mondayWeeks = await evaluateSharedFixture({
      activities: weekActivities,
      filterDsl: "count(periods(page, 1w)) eq 2",
      scope: "session",
      candidateRange: weekRange,
      reportingTimeZone: "America/Los_Angeles",
      capturedAtMs: saturday + 1,
    });
    expect(mondayWeeks.d1).toEqual(["session-week"]);
    expect(mondayWeeks.mock).toEqual(mondayWeeks.d1);

    const emptyReducers = await evaluateSharedFixture({
      activities: [
        {
          visitId: "empty-reducer-page",
          sessionId: "session-empty",
          visitorId: "visitor-empty",
          pageTimeMs: 10,
          pathname: "/candidate",
        },
      ],
      filterDsl:
        'count(event) eq 0 AND sum(event.payload("/amount")) eq 0 AND avg(event.payload("/amount")) isNull AND min(event.payload("/amount")) isNull AND max(event.payload("/amount")) isNull AND first(event) notExists AND last(page) exists AND nth(event, 2) notExists AND countDistinct(event.payload("/amount")) eq 0 AND div(count(event), count(event)) isNull',
      scope: "session",
      candidateRange: { startMs: 0, endExclusiveMs: 100 },
      reportingTimeZone: "UTC",
      capturedAtMs: 100,
    });
    expect(emptyReducers.d1).toEqual(["session-empty"]);
    expect(emptyReducers.mock).toEqual(emptyReducers.d1);
  });

  it("rejects evaluation ranges that begin before confirmed site coverage", async () => {
    const { env, database, queries } = sqliteEnv();
    try {
      const document = parseFilterDsl(
        "count(page) gte 1",
        analyticsFilterRegistry,
      );
      const time = {
        ...createQueryTime(100, 200, "UTC", 250),
        readRange: createTimeRange(-1, 100),
      };
      const plan = createScopedFilterPlan("overview", document, "session");
      const filters = attachScopedFilterMetadata(document, {
        requestedScope: "session",
        resolvedScope: "session",
        plan: plan!,
        time,
        siteIds: [SITE_ID],
      });
      const input = {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        filters,
        scopePreference: "session" as const,
        scopePlan: plan!,
        time,
      };
      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          input,
          async (prepared) => prepared,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [
            {
              path: "readRange",
              code: "filter_evaluation_range_unavailable",
            },
          ],
        },
      });
      expect(queries.some((sql) => /FROM visits\b/iu.test(sql))).toBe(false);
      expect(queries.some((sql) => /FROM custom_events\b/iu.test(sql))).toBe(
        false,
      );
    } finally {
      database.close();
    }
  });

  it("passes ordinary Event Boolean filters through without advanced evaluation", async () => {
    const { env, database, queries } = sqliteEnv();
    const input = advancedFilterInput(
      createQueryTime(0, 100, "UTC", 100),
      [SITE_ID],
      'event.name eq "purchase" AND page.path contains "/shop"',
      "event",
    );
    let nextCalls = 0;
    let nextInput: unknown;
    try {
      const output = await d1AdvancedFilterMiddleware(env)(
        "overview",
        input,
        async (prepared) => {
          nextCalls += 1;
          nextInput = prepared;
          return prepared;
        },
      );
      expect(nextCalls).toBe(1);
      expect(output).toBe(nextInput);
      expect((output as typeof input).filters).toBe(input.filters);
      expect(
        (output as typeof input).scopePlan.advancedMatches,
      ).toBeUndefined();
      expect(queries).toEqual([]);
    } finally {
      database.close();
    }
  });

  describe("captures the actual payload-selector contract against full JSON for Session and Visitor", () => {
    const payloadCases = [
      { label: "missing", payload: {} },
      { label: "null", payload: { value: null } },
      { label: "empty-string", payload: { value: "" } },
      { label: "number-seven", payload: { value: 7 } },
      { label: "string-seven", payload: { value: "7" } },
      { label: "padded-string", payload: { value: " 7 " } },
      { label: "boolean-true", payload: { value: true } },
      { label: "object", payload: { value: { child: "nested" } } },
      { label: "empty-array", payload: { value: [] } },
      { label: "nonempty-array", payload: { value: [7] } },
      { label: "seven-prefix", payload: { value: "7ish" } },
      { label: "seven-suffix", payload: { value: "ish7" } },
      { label: "paid", payload: { value: "paid" } },
      { label: "upper-paid", payload: { value: "PAID" } },
    ] as const;
    const activities: readonly SharedActivity[] = payloadCases.map(
      (payloadCase, index) => ({
        visitId: "wave91-page-" + payloadCase.label,
        sessionId: "wave91-session-" + payloadCase.label,
        visitorId: "wave91-visitor-" + payloadCase.label,
        pageTimeMs: 100 + index,
        pathname: "/wave91/" + payloadCase.label,
        event: {
          id: "wave91-event-" + payloadCase.label,
          name: "purchase",
          timeMs: 100 + index,
          payload: payloadCase.payload,
        },
      }),
    );
    const originalPayloadByEventId = new Map(
      activities.flatMap((activity) =>
        activityEvents(activity).map(
          (event) => [event.id, event.payload] as const,
        ),
      ),
    );
    const predicates = [
      {
        name: "eq-string",
        predicate: 'event.payload("/value") eq "7"',
        expected: ["string-seven"],
      },
      {
        name: "neq-string",
        predicate: 'event.payload("/value") neq "7"',
        expected: [
          "empty-string",
          "number-seven",
          "padded-string",
          "boolean-true",
          "object",
          "empty-array",
          "nonempty-array",
          "seven-prefix",
          "seven-suffix",
          "paid",
          "upper-paid",
        ],
      },
      {
        name: "not-eq-string",
        predicate: 'NOT (event.payload("/value") eq "7")',
        expected: [
          "missing",
          "null",
          "empty-string",
          "number-seven",
          "padded-string",
          "boolean-true",
          "object",
          "empty-array",
          "nonempty-array",
          "seven-prefix",
          "seven-suffix",
          "paid",
          "upper-paid",
        ],
      },
      {
        name: "in-strings",
        predicate: 'event.payload("/value") in ["7", "paid"]',
        expected: ["string-seven", "paid"],
      },
      {
        name: "not-in-strings",
        predicate: 'event.payload("/value") notIn ["7"]',
        expected: [
          "empty-string",
          "number-seven",
          "padded-string",
          "boolean-true",
          "object",
          "empty-array",
          "nonempty-array",
          "seven-prefix",
          "seven-suffix",
          "paid",
          "upper-paid",
        ],
      },
      {
        name: "contains",
        predicate: 'event.payload("/value") contains "7"',
        expected: [
          "string-seven",
          "padded-string",
          "seven-prefix",
          "seven-suffix",
        ],
      },
      {
        name: "starts-with",
        predicate: 'event.payload("/value") startsWith "7"',
        expected: ["string-seven", "seven-prefix"],
      },
      {
        name: "ends-with",
        predicate: 'event.payload("/value") endsWith "7"',
        expected: ["string-seven", "seven-suffix"],
      },
      {
        name: "is-empty",
        predicate: 'event.payload("/value") isEmpty',
        expected: ["empty-string"],
      },
      {
        name: "not-empty",
        predicate: 'event.payload("/value") notEmpty',
        expected: [
          "string-seven",
          "padded-string",
          "seven-prefix",
          "seven-suffix",
          "paid",
          "upper-paid",
        ],
      },
      {
        name: "exists",
        predicate: 'event.payload("/value") exists',
        expected: [
          "empty-string",
          "null",
          "number-seven",
          "string-seven",
          "padded-string",
          "boolean-true",
          "object",
          "nonempty-array",
          "seven-prefix",
          "seven-suffix",
          "paid",
          "upper-paid",
        ],
      },
      {
        name: "not-exists",
        predicate: 'event.payload("/value") notExists',
        expected: ["missing", "empty-array"],
      },
      {
        name: "is-null",
        predicate: 'event.payload("/value") isNull',
        expected: ["null"],
      },
      {
        name: "not-null",
        predicate: 'event.payload("/value") notNull',
        expected: [
          "empty-string",
          "number-seven",
          "string-seven",
          "padded-string",
          "boolean-true",
          "object",
          "empty-array",
          "nonempty-array",
          "seven-prefix",
          "seven-suffix",
          "paid",
          "upper-paid",
        ],
      },
      {
        name: "eq-number",
        predicate: 'event.payload("/value") eq 7',
        expected: ["number-seven"],
      },
      {
        name: "eq-boolean",
        predicate: 'event.payload("/value") eq true',
        expected: ["boolean-true"],
      },
      {
        name: "eq-padded",
        predicate: 'event.payload("/value") eq " 7 "',
        expected: ["padded-string"],
      },
      {
        name: "eq-paid",
        predicate: 'event.payload("/value") eq "paid"',
        expected: ["paid"],
      },
      {
        name: "eq-upper-paid",
        predicate: 'event.payload("/value") eq "PAID"',
        expected: ["upper-paid"],
      },
    ] as const;
    const traceByScope: Record<string, Wave91QueryRecord[]> = {
      session: [],
      visitor: [],
    };
    let captureScope: string | null = null;
    let runtime: ReturnType<typeof sqliteEnv> | undefined;
    beforeAll(() => {
      runtime = sqliteEnv(activities, (sql, bindings, rows) => {
        if (captureScope)
          traceByScope[captureScope]!.push({
            sql,
            bindings: [...bindings],
            rows: rows.map((row) => ({ ...row })),
          });
      });
    });
    const originalEvaluator = filterEvaluator.evaluateFilterDocument;
    const results: Array<Record<string, unknown>> = [];
    describe.each(["session", "visitor"] as const)(
      "%s payload selector",
      (scope) => {
        it.each(predicates)("$name", async (testCase) => {
          const activeRuntime = runtime;
          if (!activeRuntime)
            throw new Error("payload selector database not initialized");
          const evaluatorSpy = vi.spyOn(
            filterEvaluator,
            "evaluateFilterDocument",
          );
          const callOffset = evaluatorSpy.mock.calls.length;
          try {
            const filterDsl =
              'count(event { event.name eq "purchase" AND ' +
              testCase.predicate +
              " }) gte 1";
            const input = advancedFilterInput(
              createQueryTime(0, 10_000, "UTC", 10_000),
              [SITE_ID],
              filterDsl,
              scope,
            );
            if (testCase.name === "contains") captureScope = scope;
            const output = (await d1AdvancedFilterMiddleware(activeRuntime.env)(
              "overview",
              input,
              async (prepared) => prepared,
            )) as typeof input;
            const invocation = evaluatorSpy.mock.calls[callOffset];
            const document = invocation?.[0] ?? input.filters!;
            const formalDataset = invocation?.[1];
            const evaluationOptions = invocation?.[2];
            const payloadTarget = findWave91PayloadTarget(document.root);
            const expectedPayloadTargetType = payloadTarget
              ? (analyzeFilterDocument(
                  document,
                  analyticsFilterRegistry,
                ).expectedTargetTypes.get(payloadTarget as never) ?? null)
              : "not-found";
            const formalResult =
              formalDataset && evaluationOptions
                ? originalEvaluator(document, formalDataset, evaluationOptions)
                : undefined;
            const fullDataset: FilterEvaluationDataset | undefined =
              formalDataset
                ? {
                    ...formalDataset,
                    events: formalDataset.events.map((event) => {
                      const payload = originalPayloadByEventId.get(event.id);
                      return payload === undefined
                        ? event
                        : { ...event, payload };
                    }),
                  }
                : undefined;
            const fullResult =
              fullDataset && evaluationOptions
                ? originalEvaluator(document, fullDataset, evaluationOptions)
                : undefined;
            const actualIds =
              (
                output.scopePlan.advancedMatches as
                  | { readonly entityIds?: readonly { readonly id: string }[] }
                  | undefined
              )?.entityIds?.map(({ id }) => id) ?? [];
            const toIds = (labels: readonly string[]) =>
              labels.map((label) => "wave91-" + scope + "-" + label).sort();
            const formalExpected =
              testCase.name === "exists"
                ? testCase.expected.filter(
                    (label) => label !== "nonempty-array",
                  )
                : testCase.name === "not-exists"
                  ? [...testCase.expected, "nonempty-array"]
                  : testCase.expected;
            const classifier = classifyAdvancedCountFilter(
              document,
              scope,
            ).kind;
            const evaluatorCallCount =
              evaluatorSpy.mock.calls.length - callOffset;
            const result = {
              scope,
              name: testCase.name,
              filterDsl,
              classifier,
              expectedPayloadTargetType,
              evaluatorCallCount,
              middlewareEntityIds: [...actualIds].sort(),
              reconstructedDatasetEntityIds: formalResult
                ? [...formalResult.matchingScopeEntityIds].sort()
                : null,
              fullPayloadEntityIds: fullResult
                ? [...fullResult.matchingScopeEntityIds].sort()
                : toIds(testCase.expected),
              expectedReconstructedEntityIds: toIds(formalExpected),
              expectedFullPayloadEntityIds: toIds(testCase.expected),
            };
            results.push(result);

            if (classifier === "supported") {
              expect(evaluatorCallCount, filterDsl).toBe(0);
              expect(result.middlewareEntityIds, filterDsl).toEqual(
                result.expectedFullPayloadEntityIds,
              );
            } else {
              expect(classifier, filterDsl).toBe("unsupported");
              expect(evaluatorCallCount, filterDsl).toBe(1);
              expect(result.middlewareEntityIds, filterDsl).toEqual(
                result.expectedReconstructedEntityIds,
              );
              expect(result.reconstructedDatasetEntityIds, filterDsl).toEqual(
                result.expectedReconstructedEntityIds,
              );
              expect(result.fullPayloadEntityIds, filterDsl).toEqual(
                result.expectedFullPayloadEntityIds,
              );
            }
          } finally {
            captureScope = null;
            evaluatorSpy.mockRestore();
          }
        });
      },
    );

    afterAll(() => {
      try {
        const queryEvidence = Object.fromEntries(
          Object.entries(traceByScope).map(([scope, records]) => [
            scope,
            wave91QueryEvidence(records),
          ]),
        );
        writeWave91Evidence("payload-selector-contract-evidence.json", {
          fixture: payloadCases,
          queryEvidence,
          rawActivityCount:
            traceByScope.session.find((record) =>
              /\b(?:visits|custom_events)\b/iu.test(record.sql),
            )?.rows.length ?? null,
          selectedPayloadNodeCount:
            traceByScope.session.find((record) =>
              /custom_event_json_nodes/iu.test(record.sql),
            )?.rows.length ?? null,
          results,
        });
        expect(results).toHaveLength(predicates.length * 2);
        for (const scope of ["session", "visitor"] as const) {
          const evidence = wave91QueryEvidence(traceByScope[scope]!);
          const kinds = evidence.map((query) => query.kind);
          expect(kinds).toContain("coverage");
          expect(kinds).toContain("activity");
          expect(kinds).toContain("payload");
          expect(
            evidence.find((query) => query.kind === "activity")?.rows,
          ).toHaveLength(28);
          expect(
            evidence.find((query) => query.kind === "payload")?.rows,
          ).toHaveLength(26);
        }
      } finally {
        runtime?.database.close();
      }
    });
  });

  it("keeps payload AND predicates on one Event and counts each matching Event once", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "wave91-same-page",
        sessionId: "wave91-same-session",
        visitorId: "wave91-shared-visitor",
        pageTimeMs: 100,
        pathname: "/same",
        event: {
          id: "wave91-same-both",
          name: "purchase",
          timeMs: 110,
          payload: { left: "yes", right: "yes", extra: "ignored" },
        },
        additionalEvents: [
          {
            id: "wave91-same-left-only",
            name: "purchase",
            timeMs: 120,
            payload: { left: "yes" },
          },
          {
            id: "wave91-same-right-only",
            name: "purchase",
            timeMs: 130,
            payload: { right: "yes" },
          },
          {
            id: "wave91-refund-both",
            name: "refund",
            timeMs: 140,
            payload: { left: "yes", right: "yes" },
          },
        ],
      },
      {
        visitId: "wave91-second-page",
        sessionId: "wave91-second-session",
        visitorId: "wave91-shared-visitor",
        pageTimeMs: 200,
        pathname: "/second",
        event: {
          id: "wave91-second-both",
          name: "purchase",
          timeMs: 210,
          payload: { left: "yes", right: "yes" },
        },
      },
      {
        visitId: "wave91-split-page",
        sessionId: "wave91-split-session",
        visitorId: "wave91-split-visitor",
        pageTimeMs: 300,
        pathname: "/split",
        event: {
          id: "wave91-split-left",
          name: "purchase",
          timeMs: 310,
          payload: { left: "yes" },
        },
        additionalEvents: [
          {
            id: "wave91-split-right",
            name: "purchase",
            timeMs: 320,
            payload: { right: "yes" },
          },
        ],
      },
      {
        visitId: "wave91-empty-page",
        sessionId: "wave91-empty-session",
        visitorId: "wave91-empty-visitor",
        pageTimeMs: 400,
        pathname: "/empty",
      },
    ];
    const originalPayloadByEventId = new Map(
      activities.flatMap((activity) =>
        activityEvents(activity).map(
          (event) => [event.id, event.payload] as const,
        ),
      ),
    );
    const trace: Wave91QueryRecord[] = [];
    let capture = true;
    const { env, database } = sqliteEnv(activities, (sql, bindings, rows) => {
      if (capture)
        trace.push({
          sql,
          bindings: [...bindings],
          rows: rows.map((row) => ({ ...row })),
        });
    });
    const originalEvaluator = filterEvaluator.evaluateFilterDocument;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const cases = [
      {
        scope: "session" as const,
        operator: "eq 1",
        expected: ["wave91-same-session", "wave91-second-session"],
      },
      { scope: "session" as const, operator: "eq 2", expected: [] },
      {
        scope: "session" as const,
        operator: "eq 0",
        expected: ["wave91-empty-session", "wave91-split-session"],
      },
      {
        scope: "visitor" as const,
        operator: "eq 2",
        expected: ["wave91-shared-visitor"],
      },
      { scope: "visitor" as const, operator: "eq 1", expected: [] },
      {
        scope: "visitor" as const,
        operator: "eq 0",
        expected: ["wave91-empty-visitor", "wave91-split-visitor"],
      },
    ];
    const results: Array<Record<string, unknown>> = [];
    try {
      for (let index = 0; index < cases.length; index += 1) {
        const testCase = cases[index]!;
        const filterDsl =
          'count(event { event.name eq "purchase" AND event.payload("/left") eq "yes" AND event.payload("/right") eq "yes" }) ' +
          testCase.operator;
        const input = advancedFilterInput(
          createQueryTime(0, 5_000, "UTC", 5_000),
          [SITE_ID],
          filterDsl,
          testCase.scope,
        );
        const callOffset = evaluatorSpy.mock.calls.length;
        const output = (await d1AdvancedFilterMiddleware(env)(
          "overview",
          input,
          async (prepared) => prepared,
        )) as typeof input;
        capture = false;
        const invocation = evaluatorSpy.mock.calls[callOffset];
        const fullResult = invocation
          ? originalEvaluator(
              invocation[0],
              {
                ...invocation[1],
                events: invocation[1].events.map((event) => {
                  const payload = originalPayloadByEventId.get(event.id);
                  return payload === undefined ? event : { ...event, payload };
                }),
              },
              invocation[2],
            )
          : undefined;
        const actualIds =
          (
            output.scopePlan.advancedMatches as
              | { readonly entityIds?: readonly { readonly id: string }[] }
              | undefined
          )?.entityIds?.map(({ id }) => id) ?? [];
        results.push({
          scope: testCase.scope,
          filterDsl,
          evaluatorCallCount: evaluatorSpy.mock.calls.length - callOffset,
          middlewareEntityIds: [...actualIds].sort(),
          fullPayloadEntityIds: fullResult
            ? [...fullResult.matchingScopeEntityIds].sort()
            : [...testCase.expected].sort(),
          expectedEntityIds: [...testCase.expected].sort(),
        });
      }
      writeWave91Evidence("payload-selector-multievent-evidence.json", {
        queryEvidence: wave91QueryEvidence(trace),
        rawActivityCount:
          trace.find((record) =>
            /\b(?:visits|custom_events)\b/iu.test(record.sql),
          )?.rows.length ?? null,
        selectedPayloadNodeCount:
          trace.find((record) => /custom_event_json_nodes/iu.test(record.sql))
            ?.rows.length ?? null,
        payloadEventIds: [
          ...new Set(
            (
              trace.find((record) =>
                /custom_event_json_nodes/iu.test(record.sql),
              )?.rows ?? []
            ).map((row) => row.event_id),
          ),
        ].sort(),
        results,
      });
      expect(
        trace.some((record) => /custom_event_json_nodes/iu.test(record.sql)),
      ).toBe(true);
      for (const result of results) {
        expect(result.evaluatorCallCount, String(result.filterDsl)).toBe(0);
        expect(result.middlewareEntityIds, String(result.filterDsl)).toEqual(
          result.expectedEntityIds,
        );
        expect(result.fullPayloadEntityIds, String(result.filterDsl)).toEqual(
          result.expectedEntityIds,
        );
      }
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("records array, container, empty-key, and prototype payload diagnostics against the full JSON", async () => {
    const diagnosticPayload = JSON.parse(
      '{"escaped/key~tilde":"escaped","container":{"child":"nested"},"list":[{"value":"first"}],"":"empty-key","__proto__":"prototype-value"}',
    ) as Readonly<Record<string, unknown>>;
    const activities: readonly SharedActivity[] = [
      {
        visitId: "wave91-diagnostic-page",
        sessionId: "wave91-diagnostic-session",
        visitorId: "wave91-diagnostic-visitor",
        pageTimeMs: 100,
        pathname: "/diagnostic",
        event: {
          id: "wave91-diagnostic-event",
          name: "purchase",
          timeMs: 110,
          payload: diagnosticPayload,
        },
      },
    ];
    const trace: Wave91QueryRecord[] = [];
    let capture = true;
    const { env, database } = sqliteEnv(activities, (sql, bindings, rows) => {
      if (capture)
        trace.push({
          sql,
          bindings: [...bindings],
          rows: rows.map((row) => ({ ...row })),
        });
    });
    const originalEvaluator = filterEvaluator.evaluateFilterDocument;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const cases = [
      {
        name: "escaped-pointer",
        predicate: 'event.payload("/escaped~1key~0tilde") eq "escaped"',
        formal: true,
        full: true,
      },
      {
        name: "container-presence",
        predicate: 'event.payload("/container") exists',
        formal: true,
        full: true,
      },
      {
        name: "concrete-array-index",
        predicate: 'event.payload("/list/0/value") eq "first"',
        formal: false,
        full: true,
      },
      {
        name: "array-wildcard-pointer",
        predicate: 'event.payload("/list/*/value") eq "first"',
        formal: false,
        full: false,
      },
      {
        name: "prototype-key",
        predicate: 'event.payload("/__proto__") eq "prototype-value"',
        formal: false,
        full: true,
      },
    ] as const;
    const results: Array<Record<string, unknown>> = [];
    // This hand-authored historical formal-oracle fixture retains the
    // selected object member and container while excluding array members and
    // the prototype key. It is not output from the production payload reader.
    // The independent full-JSON oracle below uses the original parsed payload.
    const legacyFormalPayloadFixture = {
      "escaped/key~tilde": "escaped",
      container: {},
    };
    try {
      for (let index = 0; index < cases.length; index += 1) {
        capture = true;
        const testCase = cases[index]!;
        const filterDsl =
          'count(event { event.name eq "purchase" AND ' +
          testCase.predicate +
          " }) gte 1";
        const input = advancedFilterInput(
          createQueryTime(0, 2_000, "UTC", 2_000),
          [SITE_ID],
          filterDsl,
          "session",
        );
        const callOffset = evaluatorSpy.mock.calls.length;
        const output = (await d1AdvancedFilterMiddleware(env)(
          "overview",
          input,
          async (prepared) => prepared,
        )) as typeof input;
        capture = false;
        const formalDataset = createPayloadSelectorDiagnosticDataset(
          legacyFormalPayloadFixture,
        );
        const fullDataset =
          createPayloadSelectorDiagnosticDataset(diagnosticPayload);
        const evaluationOptions = {
          scope: "session" as const,
          candidateRange: { startMs: 0, endExclusiveMs: 2_000 },
          readRange: { startMs: 0, endExclusiveMs: 2_000 },
          reportingTimeZone: "UTC",
          capturedAtMs: 2_000,
        };
        const formalResult = originalEvaluator(
          input.filters!,
          formalDataset,
          evaluationOptions,
        );
        const fullResult = originalEvaluator(
          input.filters!,
          fullDataset,
          evaluationOptions,
        );
        const actualIds =
          (
            output.scopePlan.advancedMatches as
              | { readonly entityIds?: readonly { readonly id: string }[] }
              | undefined
          )?.entityIds?.map(({ id }) => id) ?? [];
        results.push({
          name: testCase.name,
          filterDsl,
          classification: classifyAdvancedCountFilter(input.filters!, "session")
            .kind,
          evaluatorCallCount: evaluatorSpy.mock.calls.length - callOffset,
          formalExpected: testCase.formal,
          fullExpected: testCase.full,
          middlewareEntityIds: [...actualIds].sort(),
          formalFixtureOracleEntityIds: [
            ...formalResult.matchingScopeEntityIds,
          ].sort(),
          fullPayloadEntityIds: [...fullResult.matchingScopeEntityIds].sort(),
        });
      }
      const writerExpansion = expandCustomEventDataJson(
        JSON.stringify(diagnosticPayload),
      );
      const emptyKeyWriterPaths = writerExpansion.ok
        ? writerExpansion.data.nodes
            .filter((node) => node.path === "/")
            .map((node) => ({
              nodeId: node.nodeId,
              parentNodeId: node.parentNodeId,
              key: node.key,
              valueType: node.valueType,
            }))
        : [];
      let emptyKeyDslDiagnostic: { accepted: boolean; message?: string } = {
        accepted: true,
      };
      try {
        parseFilterDsl(
          'count(event { event.name eq "purchase" AND event.payload("/") eq "empty-key" }) gte 1',
          analyticsFilterRegistry,
        );
      } catch (error) {
        emptyKeyDslDiagnostic = {
          accepted: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      writeWave91Evidence("payload-selector-diagnostic-evidence.json", {
        originalPayload: diagnosticPayload,
        legacyFormalPayloadFixture,
        emptyKeyWriterPaths,
        emptyKeyDslDiagnostic,
        emptyKeyPureJsonValue: diagnosticPayload[""],
        queryEvidence: wave91QueryEvidence(trace),
        selectedPayloadNodeCount:
          trace.find((record) => /custom_event_json_nodes/iu.test(record.sql))
            ?.rows.length ?? null,
        results,
      });
      for (const result of results) {
        const expectedFormal = result.formalExpected
          ? ["wave91-diagnostic-session"]
          : [];
        const expectedFull = result.fullExpected
          ? ["wave91-diagnostic-session"]
          : [];
        expect(result.middlewareEntityIds, String(result.filterDsl)).toEqual(
          expectedFormal,
        );
        expect(
          result.formalFixtureOracleEntityIds,
          String(result.filterDsl),
        ).toEqual(expectedFormal);
        expect(result.fullPayloadEntityIds, String(result.filterDsl)).toEqual(
          expectedFull,
        );
      }
      expect(emptyKeyDslDiagnostic.accepted).toBe(false);
      expect(emptyKeyWriterPaths).toHaveLength(2);
      expect(
        results.find((result) => result.name === "concrete-array-index"),
      ).toMatchObject({
        middlewareEntityIds: [],
        fullPayloadEntityIds: ["wave91-diagnostic-session"],
      });
      expect(
        results.find((result) => result.name === "prototype-key"),
      ).toMatchObject({
        middlewareEntityIds: [],
        fullPayloadEntityIds: ["wave91-diagnostic-session"],
      });
    } finally {
      evaluatorSpy.mockRestore();
      database.close();
    }
  });

  it("carries a payload-selector match through the public overview DTO", async () => {
    const activities: readonly SharedActivity[] = [
      {
        visitId: "wave91-public-page-a",
        sessionId: "wave91-public-session-a",
        visitorId: "wave91-public-visitor-a",
        pageTimeMs: 500,
        pathname: "/selected-a",
        event: {
          id: "wave91-public-paid",
          name: "purchase",
          timeMs: 1_000,
          payload: { category: "paid" },
        },
      },
      {
        visitId: "wave91-public-page-b",
        sessionId: "wave91-public-session-a",
        visitorId: "wave91-public-visitor-a",
        pageTimeMs: 1_500,
        pathname: "/selected-b",
      },
      {
        visitId: "wave91-public-page-c",
        sessionId: "wave91-public-session-b",
        visitorId: "wave91-public-visitor-b",
        pageTimeMs: 2_000,
        pathname: "/unselected",
        event: {
          id: "wave91-public-free",
          name: "purchase",
          timeMs: 2_100,
          payload: { category: "free" },
        },
      },
    ];
    const originalPayloadByEventId = new Map(
      activities.flatMap((activity) =>
        activityEvents(activity).map(
          (event) => [event.id, event.payload] as const,
        ),
      ),
    );
    const trace: Wave91QueryRecord[] = [];
    const { env, database } = sqliteEnv(activities, (sql, bindings, rows) => {
      trace.push({
        sql,
        bindings: [...bindings],
        rows: rows.map((row) => ({ ...row })),
      });
    });
    const principal: ApiKeyPrincipal = {
      keyId: "wave91-public-test-key",
      teamId: "team-1",
      prefix: "wave91-public",
      scopes: ["analytics:read"],
      siteIds: [SITE_ID],
      status: "active",
    };
    const runtime = createEdgeSiteAnalyticsRuntime({ env, siteId: SITE_ID });
    const filterDsl =
      'count(event { event.name eq "purchase" AND event.payload("/category") eq "paid" }) gte 1';
    const request = new Request(
      "https://app.test/api/v1/sites/site/analytics/overview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeRange: {
            kind: "absolute",
            from: "1970-01-01T00:00:00.000Z",
            to: "1970-01-01T00:00:03.000Z",
            timeZone: "UTC",
          },
          filter: { type: "dsl", expression: filterDsl },
          scope: "session",
        }),
      },
    );
    const originalEvaluator = filterEvaluator.evaluateFilterDocument;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    aggregateCache.clear();
    try {
      const response = await handlePlannedSiteOverview(
        request,
        principal,
        SITE_ID,
        runtime,
        { capturedAtMs: 4_000 },
      );
      const body = (await response.json()) as {
        readonly data?: Record<string, unknown>;
      };
      const invocation = evaluatorSpy.mock.calls[0];
      const formalDataset = invocation?.[1];
      const evaluationOptions = invocation?.[2];
      const fullDataset: FilterEvaluationDataset | undefined = formalDataset
        ? {
            ...formalDataset,
            events: formalDataset.events.map((event) => {
              const payload = originalPayloadByEventId.get(event.id);
              return payload === undefined ? event : { ...event, payload };
            }),
          }
        : undefined;
      const fullResult =
        invocation && fullDataset
          ? originalEvaluator(invocation[0], fullDataset, evaluationOptions!)
          : undefined;
      writeWave91Evidence("payload-selector-public-dto-evidence.json", {
        filterDsl,
        response: { status: response.status, body },
        queryEvidence: wave91QueryEvidence(trace),
        evaluatorCallCount: evaluatorSpy.mock.calls.length,
        formalDatasetEntityIds: formalDataset
          ? [
              ...originalEvaluator(
                invocation![0],
                formalDataset,
                evaluationOptions!,
              ).matchingScopeEntityIds,
            ].sort()
          : [],
        fullPayloadEntityIds: fullResult
          ? [...fullResult.matchingScopeEntityIds].sort()
          : [],
      });
      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({ views: 2, sessions: 1 });
      expect(evaluatorSpy).toHaveBeenCalledTimes(0);
      expect(
        trace.some((record) => /custom_event_json_nodes/iu.test(record.sql)),
      ).toBe(true);
    } finally {
      evaluatorSpy.mockRestore();
      aggregateCache.clear();
      database.close();
    }
  });
});
