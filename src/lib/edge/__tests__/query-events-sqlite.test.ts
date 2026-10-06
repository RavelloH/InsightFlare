import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  compileD1Query,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
  sort,
  union,
} from "@/lib/db";
import {
  analyticsFilterRegistry,
  attachScopedFilterMetadata,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type FunnelConfigV2,
  normalizeFilterDocument,
  planObservationFilter,
  prepareScopedQuery,
  type QueryAudience,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import { createEventReportSourceContext } from "@/lib/edge/analytics/engine/event-source-plan";
import {
  buildEventTrendOtherPlan,
  buildEventTrendPointsPlan,
  buildEventTrendSeriesPlan,
  buildEventTypeTrendPlan,
  EVENT_TREND_OUTPUTS,
  type EventTrendPlanInput,
} from "@/lib/edge/analytics/engine/event-trend-plan";
import {
  buildEventTypeOverviewPlan,
  EVENT_TYPE_OVERVIEW_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-type-overview-plan";
import { queryEventAnalyticsContextCardsParentOracleFromD1 } from "@/lib/edge/analytics/providers/d1/internal/__tests__/event-context-parent-oracle";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import {
  buildEventFilteredSourceCte,
  buildTimeBuckets,
  type Interval,
  type QueryWindow,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
  shareTrendSeriesKey,
  timeBucketCase,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryEventAnalyticsContextCardsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-context";
import { queryEventFieldsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-fields";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import {
  type EventRecordCursor,
  queryEventRecordPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-records";
import { queryEventSummaryMetricsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import {
  queryEventsTrendFromD1,
  queryEventTypeTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import { queryFunnelAnalysis } from "@/lib/edge/analytics/providers/d1/internal/funnels";
import {
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  queryVisitorsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import { compileScopedDatasetSql } from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import type { Env } from "@/lib/edge/types";
import type { FilterExpression } from "@/lib/filter-contract/filters";
import { sha256Hex } from "@/lib/sha256";

import { filterFixture } from "./filter-fixtures";
import { queryLegacyEventTypeOverviewFromD1 } from "./query-events-overview-legacy-oracle";

type Binding = string | number | boolean | null;
type D1Row = Record<string, unknown>;

function sqliteBindings(bindings: readonly Binding[]): SQLInputValue[] {
  // D1 accepts booleans as integer parameters; node:sqlite requires the
  // adapter to translate them at this boundary.
  return bindings.map((binding) =>
    typeof binding === "boolean" ? (binding ? 1 : 0) : binding,
  );
}

interface TrendEvidenceResult {
  readonly series: readonly {
    readonly eventName: string;
    readonly isOther?: boolean;
  }[];
}

function compileTrendOutput(
  plan: ReturnType<typeof buildEventTrendSeriesPlan>,
  outputId: string,
) {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(`wave39_missing_trend_output:${outputId}`);
  const siteIds = plan.context.subject.siteIds;
  if (siteIds.length !== 1)
    throw new Error(`wave39_unsupported_trend_subject:${siteIds.length}`);
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: siteIds[0]!,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  return compileD1Query(
    lowerLogicalPlan(
      lowerer.projectOutput(
        lowered,
        output.fields.map((field) => ({ name: field.name, slot: field.slot })),
      ),
    ),
    { tag: `wave39.${outputId}` },
  );
}

async function compiledPhysicalPlanHash(
  query: ReturnType<typeof compileD1Query>,
): Promise<string> {
  const shape = query.physicalPlanShape;
  if (!shape) throw new Error("wave41_missing_physical_plan_shape");
  const payload =
    shape.version === 1
      ? JSON.stringify([
          "d1-query-shape-v1",
          query.sql,
          shape.cteCount,
          shape.directScanProjectionCount,
          shape.nativeMembershipCount,
          shape.jsonMembershipCount,
        ])
      : JSON.stringify([
          "d1-query-shape-v2",
          query.sql,
          shape.cteCount,
          shape.directScanProjectionCount,
          shape.nativeMembershipCount,
          shape.jsonMembershipCount,
          shape.nativeRowRelationCount,
          shape.jsonRowRelationCount,
        ]);
  return `v${shape.version}:${await sha256Hex(payload)}`;
}

function compileOverviewOutput(input: {
  readonly filters: FilterDocument;
  readonly eventName: string;
  readonly includeBreakdowns?: boolean;
}) {
  const metadata = scopedFilterMetadata(input.filters);
  const includeBreakdowns = input.includeBreakdowns !== false;
  const plan = buildEventTypeOverviewPlan({
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters: input.filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    eventName: input.eventName,
    includeBreakdowns,
    denominatorSource: metadata
      ? "event-report"
      : planObservationFilter(input.filters.root).event.kind === "all"
        ? "raw-event-domain"
        : "event-report",
  });
  const outputIds = [
    EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
    ...(includeBreakdowns
      ? [
          EVENT_TYPE_OVERVIEW_OUTPUTS.page,
          EVENT_TYPE_OVERVIEW_OUTPUTS.country,
          EVENT_TYPE_OVERVIEW_OUTPUTS.device,
          EVENT_TYPE_OVERVIEW_OUTPUTS.browser,
        ]
      : []),
  ];
  const outputs = outputIds.map((outputId) => {
    const output = plan.outputs.find((candidate) => candidate.id === outputId);
    if (!output) throw new Error(`wave41_missing_overview_output:${outputId}`);
    return output;
  });
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: plan.context.subject.siteIds[0]!,
    time: plan.context.time,
  });
  const loweredOutputs = lowerer.lowerMany(outputs);
  const branches = outputs.map((output, index) =>
    lowerer.projectOutput(
      loweredOutputs[index]!,
      output.fields.map(({ name, slot }) => ({ name, slot })),
    ),
  );
  let combined = branches[0]!;
  for (const branch of branches.slice(1))
    combined = union(combined, branch, true);
  const ordered = sort(combined, [
    { expression: combined.columns.cardType!, direction: "ASC" },
    { expression: combined.columns.events!, direction: "DESC" },
    { expression: combined.columns.sessions!, direction: "DESC" },
    { expression: combined.columns.value!, direction: "ASC" },
  ]);
  return compileD1Query(lowerLogicalPlan(ordered), {
    tag: "wave42.event-type-overview-evidence",
  });
}

function sqliteExplainEvidence(
  database: DatabaseSync,
  statement: { readonly sql: string; readonly bindings: Binding[] },
) {
  const details = (
    database
      .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .all(...sqliteBindings(statement.bindings)) as Array<{ detail: string }>
  ).map(({ detail }) => detail);
  return {
    steps: details.length,
    searches: details.filter((detail) => detail.includes("SEARCH ")).length,
    eventTimeSearches: details.filter((detail) =>
      detail.includes("idx_custom_events_site_pk_time"),
    ).length,
    materializations: details.filter((detail) =>
      detail.includes("MATERIALIZE "),
    ).length,
    temporaryBtrees: details.filter((detail) =>
      detail.includes("USE TEMP B-TREE"),
    ).length,
    indexes: [
      ...new Set(
        details.flatMap((detail) => {
          const match = detail.match(
            /USING (?:COVERING )?(?:INDEX|INTEGER PRIMARY KEY)(.*)$/u,
          );
          return match ? [match[0]] : [];
        }),
      ),
    ],
  };
}

async function recordOverviewPhysicalEvidence(
  label: string,
  input: {
    readonly filters: FilterDocument;
    readonly eventName: string;
    readonly includeBreakdowns?: boolean;
  },
  executed: {
    readonly current: { readonly sql: string; readonly bindings: Binding[] };
    readonly legacy: { readonly sql: string; readonly bindings: Binding[] };
  },
  database: DatabaseSync,
): Promise<void> {
  const compiled = compileOverviewOutput(input);
  expect(compiled.sql, `${label}:compiled SQL`).toBe(executed.current.sql);
  expect(compiled.bindings, `${label}:compiled bindings`).toEqual(
    executed.current.bindings,
  );
  console.info(
    `[Wave41 event-type overview physical evidence] ${JSON.stringify({
      case: label,
      new: {
        sqlUtf8Bytes: new TextEncoder().encode(executed.current.sql).byteLength,
        bindings: executed.current.bindings.length,
        physicalPlanHash: await compiledPhysicalPlanHash(compiled),
        explain: sqliteExplainEvidence(database, executed.current),
      },
      frozenLegacy: {
        sqlUtf8Bytes: new TextEncoder().encode(executed.legacy.sql).byteLength,
        bindings: executed.legacy.bindings.length,
        explain: sqliteExplainEvidence(database, executed.legacy),
      },
    })}`,
  );
}

function eventTrendPlanInput(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  eventName?: string,
): EventTrendPlanInput {
  const metadata = scopedFilterMetadata(filters);
  return {
    siteId,
    queryTime: metadata?.time ?? queryWindowToTime(window),
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    ...(eventName !== undefined ? { eventName } : {}),
  };
}

async function recordTrendPhysicalEvidence(
  label: string,
  plans: readonly {
    readonly plan: ReturnType<typeof buildEventTrendSeriesPlan>;
    readonly outputId: string;
  }[],
  executed: readonly { readonly sql: string; readonly bindings: Binding[] }[],
): Promise<void> {
  expect(executed, label).toHaveLength(plans.length);
  const statements = await Promise.all(
    plans.map(async ({ plan, outputId }, index) => {
      const compiled = compileTrendOutput(plan, outputId);
      const actual = executed[index]!;
      expect(compiled.sql, `${label}:${outputId}:sql`).toBe(actual.sql);
      expect(compiled.bindings, `${label}:${outputId}:bindings`).toEqual(
        actual.bindings,
      );
      return {
        outputId,
        sqlUtf8Bytes: new TextEncoder().encode(actual.sql).byteLength,
        bindings: actual.bindings.length,
        physicalPlanHash: await compiledPhysicalPlanHash(compiled),
      };
    }),
  );
  console.info(
    `[Wave39 trend physical evidence] ${JSON.stringify({
      entrypoint: label,
      statementCount: executed.length,
      statements,
    })}`,
  );
}

function eventTrendOutputPlans(
  input: EventTrendPlanInput,
  limit: number,
  interval: Interval,
  result: TrendEvidenceResult,
) {
  const seriesNames = result.series
    .filter((series) => !series.isOther)
    .map((series) => series.eventName);
  const plans: Array<{
    readonly plan: ReturnType<typeof buildEventTrendSeriesPlan>;
    readonly outputId: string;
  }> = [
    {
      plan: buildEventTrendSeriesPlan({ ...input, limit }),
      outputId: EVENT_TREND_OUTPUTS.series,
    },
    {
      plan: buildEventTrendPointsPlan({
        ...input,
        interval,
        seriesNames,
        otherToken: SHARE_TREND_OTHER_TOKEN,
      }),
      outputId: EVENT_TREND_OUTPUTS.points,
    },
  ];
  if (result.series.some((series) => series.isOther))
    plans.push({
      plan: buildEventTrendOtherPlan({
        ...input,
        seriesNames,
        otherLabel: SHARE_TREND_OTHER_LABEL,
      }),
      outputId: EVENT_TREND_OUTPUTS.other,
    });
  return plans;
}

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: Binding[],
  ) {}

  async all<T extends D1Row>(): Promise<{ results: T[] }> {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...sqliteBindings(this.bindings))
        .map((row) => ({ ...row }) as T),
    };
  }
}

class SqliteD1Database {
  readonly database = new DatabaseSync(":memory:");
  readonly calls: Array<{ sql: string; bindings: Binding[] }> = [];

  prepare(sql: string) {
    return {
      bind: (...bindings: Binding[]) => {
        this.calls.push({ sql, bindings });
        return new SqliteStatement(this.database, sql, bindings);
      },
    };
  }

  close(): void {
    this.database.close();
  }
}

const siteId = "site-event-detail";
const eventName = "outbound_click";
const eventTime = Date.UTC(2026, 7, 14, 10);
const window: QueryWindow = {
  startMs: eventTime - 60 * 60 * 1000,
  endExclusiveMs: eventTime + 60 * 60 * 1000,
  nowMs: eventTime + 60 * 60 * 1000,
  timeZone: "UTC",
};

function funnelConfig(
  steps: FunnelConfigV2["steps"],
  progressionScope: FunnelConfigV2["progressionScope"] = "session",
  conversionWindowMs: number | null = null,
): FunnelConfigV2 {
  return {
    filterDslVersion: 1,
    progressionScope,
    conversionWindowMs,
    steps,
  };
}

function createSqliteEventEnv(): { env: Env; d1: SqliteD1Database } {
  const d1 = new SqliteD1Database();
  d1.database.exec(`
    CREATE TABLE site_identities (
      site_pk INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL UNIQUE
    );
    INSERT INTO site_identities (site_pk, site_id)
      VALUES (1, '${siteId}');

    CREATE TABLE visits (
      visit_id TEXT PRIMARY KEY, site_id TEXT NOT NULL,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED,
      visitor_id TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'closed', started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL DEFAULT 0, ended_at INTEGER, finalized_at INTEGER,
      duration_ms INTEGER, duration_source TEXT, exit_reason TEXT,
      pathname TEXT NOT NULL DEFAULT '', query_string TEXT NOT NULL DEFAULT '',
      hash_fragment TEXT NOT NULL DEFAULT '', hostname TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', referrer_url TEXT NOT NULL DEFAULT '',
      referrer_host TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '', utm_campaign TEXT NOT NULL DEFAULT '',
      utm_term TEXT NOT NULL DEFAULT '', utm_content TEXT NOT NULL DEFAULT '',
      is_eu INTEGER NOT NULL DEFAULT 0, country TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '', region_code TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '', continent TEXT NOT NULL DEFAULT '', latitude REAL,
      longitude REAL, postal_code TEXT NOT NULL DEFAULT '', metro_code TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT '', as_organization TEXT NOT NULL DEFAULT '',
      ua_raw TEXT NOT NULL DEFAULT '', browser TEXT NOT NULL DEFAULT '',
      browser_version TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
      os_version TEXT NOT NULL DEFAULT '', device_type TEXT NOT NULL DEFAULT '',
      screen_width INTEGER, screen_height INTEGER, language TEXT NOT NULL DEFAULT '',
      user_id TEXT, user_name TEXT,
      perf_ttfb_ms REAL, perf_fcp_ms REAL, perf_lcp_ms REAL, perf_cls REAL,
      perf_inp_ms REAL, ae_synced_at INTEGER
    );
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED,
      name TEXT NOT NULL,
      UNIQUE(site_id, name)
    );
    CREATE TABLE custom_events (
      event_pk INTEGER PRIMARY KEY, event_id TEXT NOT NULL, site_id TEXT NOT NULL,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED,
      visit_id TEXT NOT NULL, event_name_id INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL, sequence INTEGER NOT NULL, node_count INTEGER NOT NULL,
      value_count INTEGER NOT NULL, ae_synced_at INTEGER
    );
    CREATE TABLE custom_event_json_paths (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED
    );
    CREATE TABLE custom_event_json_values (
      event_pk INTEGER NOT NULL, node_id INTEGER NOT NULL, site_id TEXT NOT NULL,
      event_name_id INTEGER NOT NULL, path_id INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
      scope_node_id INTEGER, value_type INTEGER NOT NULL, string_value TEXT,
      string_hash TEXT, number_value REAL, boolean_value INTEGER,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED
    );
    CREATE INDEX idx_custom_events_site_pk_name_time
      ON custom_events(site_pk, event_name_id, occurred_at, event_pk);
    CREATE INDEX idx_custom_events_site_pk_time
      ON custom_events(site_pk, occurred_at, event_pk);
    CREATE INDEX idx_visits_site_pk_session_started_at
      ON visits(site_pk, session_id, started_at, visit_id);
    CREATE INDEX idx_visits_site_pk_started_at
      ON visits(site_pk, started_at);
  `);
  d1.database
    .prepare(
      `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, started_at, pathname, hostname,
      title, referrer_url, referrer_host, country, region, city, continent, timezone,
      as_organization, browser, browser_version, os, os_version, device_type,
      screen_width, screen_height, language
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "visit-1",
      siteId,
      "visitor-1",
      "session-1",
      eventTime - 1,
      "/posts/minecraft-meteor-guide",
      "example.com",
      "Meteor guide",
      "https://www.google.com/",
      "www.google.com",
      "CN",
      "Zhejiang",
      "Hangzhou",
      "Asia",
      "Asia/Shanghai",
      "Example Networks",
      "Edge",
      "140",
      "Windows",
      "11",
      "desktop",
      1920,
      1080,
      "zh-CN",
    );
  d1.database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
    )
    .run(1, siteId, eventName);
  d1.database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, pathname
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "visit-entry",
      siteId,
      "visitor-1",
      "session-1",
      eventTime - 2,
      "/entry",
    );
  d1.database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, pathname
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "visit-exit",
      siteId,
      "visitor-1",
      "session-1",
      eventTime + 1,
      "/exit",
    );
  d1.database
    .prepare(
      "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      1,
      "event-1",
      siteId,
      "visit-1",
      1,
      eventTime,
      eventTime,
      1,
      1,
      1,
      null,
    );
  d1.database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
    )
    .run(99, siteId, "purchase");
  d1.database
    .prepare(
      "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      99,
      "event-other-name",
      siteId,
      "visit-1",
      99,
      eventTime,
      eventTime,
      2,
      1,
      1,
      null,
    );
  d1.database
    .prepare(
      "INSERT INTO custom_event_json_paths (id, site_id, path) VALUES (?, ?, ?)",
    )
    .run(1, siteId, "/href");
  d1.database
    .prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, number_value, boolean_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      1,
      1,
      siteId,
      1,
      1,
      eventTime,
      1,
      "https://example.test/next",
      null,
      null,
    );
  return {
    env: {
      DB: d1 as unknown as D1Database,
      DAILY_SALT_SECRET: "test-secret",
      INGEST_DO: {} as DurableObjectNamespace,
    },
    d1,
  } as { env: Env; d1: SqliteD1Database };
}

function insertTrendEvent(
  database: DatabaseSync,
  id: number,
  occurredAt: number,
  eventNameId = 1,
): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count, ae_synced_at
      ) VALUES (?, ?, ?, 'visit-1', ?, ?, ?, ?, 1, 1, NULL)`,
    )
    .run(
      1000 + id,
      `calendar-event-${id}`,
      siteId,
      eventNameId,
      occurredAt,
      occurredAt,
      id,
    );
}

function allowNullableEventNames(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE custom_event_names RENAME TO custom_event_names_required;
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      site_pk INTEGER GENERATED ALWAYS AS (1) STORED,
      name TEXT,
      UNIQUE(site_id, name)
    );
    INSERT INTO custom_event_names (id, site_id, name)
      SELECT id, site_id, name FROM custom_event_names_required;
    DROP TABLE custom_event_names_required;
  `);
}

function frozenCalendarTypeTrend(
  database: DatabaseSync,
  window: QueryWindow,
  interval: Interval,
  filters: FilterDocument = EMPTY_FILTER_DOCUMENT,
  selectedEventName = eventName,
) {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    selectedEventName,
  );
  const buckets = buildTimeBuckets(window, interval);
  const bucketCase = timeBucketCase(buckets, "occurred_at");
  const rows = database
    .prepare(
      `${source.cte}
       SELECT ${bucketCase.sql} AS bucket, count(*) AS events,
         count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
       FROM filtered_events
       GROUP BY bucket
       HAVING bucket IS NOT NULL
       ORDER BY bucket ASC`,
    )
    .all(...source.bindings, ...bucketCase.bindings) as Array<{
    readonly bucket: number;
    readonly events: number;
    readonly visitors: number;
  }>;
  const data = buckets.map((bucket) => ({
    bucket: bucket.index,
    timestampMs: bucket.timestampMs,
    events: 0,
    visitors: 0,
  }));
  for (const row of rows) {
    const point = data[Number(row.bucket)];
    if (!point) continue;
    point.events = Number(row.events);
    point.visitors = Number(row.visitors);
  }
  return data;
}

function frozenLegacyEventTrend(
  database: DatabaseSync,
  queryWindow: QueryWindow,
  interval: Interval,
  filters: FilterDocument,
  limit: number,
  selectedEventName?: string,
) {
  const source = buildEventFilteredSourceCte(
    siteId,
    queryWindow,
    filters,
    selectedEventName,
  );
  const seriesRows = database
    .prepare(
      `${source.cte}
       SELECT event_name AS eventName, count(*) AS events,
         count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
         count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
       FROM filtered_events
       GROUP BY event_name
       ORDER BY events DESC, sessions DESC, eventName ASC
       LIMIT ?`,
    )
    .all(...source.bindings, limit) as Array<{
    readonly eventName: string;
    readonly events: number;
    readonly sessions: number;
    readonly visitors: number;
  }>;
  const buckets = buildTimeBuckets(queryWindow, interval);
  const bucket = timeBucketCase(buckets, "occurred_at");
  const seriesNames = seriesRows.map((row) => row.eventName);
  const namesClause =
    seriesNames.length > 0
      ? `CASE WHEN event_name IN (${seriesNames.map(() => "?").join(", ")}) THEN event_name ELSE ? END`
      : "?";
  const trendRows = database
    .prepare(
      `${source.cte}, bucketed AS (
         SELECT ${bucket.sql} AS bucket, ${namesClause} AS seriesName, count(*) AS events
         FROM filtered_events
         GROUP BY bucket, seriesName
       )
       SELECT bucket, seriesName AS seriesKey, events
       FROM bucketed
       WHERE bucket IS NOT NULL
       ORDER BY bucket ASC`,
    )
    .all(
      ...source.bindings,
      ...bucket.bindings,
      ...seriesNames,
      SHARE_TREND_OTHER_TOKEN,
    ) as Array<{
    readonly bucket: number | null;
    readonly seriesKey: string | null;
    readonly events: number;
  }>;
  const hasOther = trendRows.some(
    (row) => String(row.seriesKey) === SHARE_TREND_OTHER_TOKEN,
  );
  const [otherRow] = hasOther
    ? (database
        .prepare(
          `${source.cte}
           SELECT ? AS eventName, count(*) AS events,
             count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
             count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
           FROM filtered_events
           ${seriesNames.length > 0 ? `WHERE event_name NOT IN (${seriesNames.map(() => "?").join(", ")})` : ""}`,
        )
        .all(
          ...source.bindings,
          SHARE_TREND_OTHER_LABEL,
          ...seriesNames,
        ) as Array<{
        readonly eventName: string;
        readonly events: number;
        readonly sessions: number;
        readonly visitors: number;
      }>)
    : [];

  const seriesKeyByName = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const row of seriesRows)
    seriesKeyByName.set(
      row.eventName,
      shareTrendSeriesKey(row.eventName, usedKeys, "event"),
    );
  const series: Array<{
    key: string;
    eventName: string;
    label: string;
    events: number;
    sessions: number;
    visitors: number;
    isOther?: boolean;
  }> = seriesRows.map((row) => ({
    key: seriesKeyByName.get(row.eventName)!,
    eventName: row.eventName,
    label: row.eventName,
    events: row.events,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
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

type TruthScope = "event" | "session" | "visitor";
type TruthRelationIds = {
  visits: string[];
  events: string[];
  sessions: string[];
  visitors: string[];
};

function truthCondition(field: string, value: string): FilterExpression {
  return {
    kind: "condition",
    target: { kind: "field", field: field as never },
    operator: "eq",
    value,
  };
}

function overviewBudgetPayloadPath(index: number): string {
  return `/wave42-budget/${String(index).padStart(2, "0")}`;
}

function overviewBudgetPayloadCondition(index: number): FilterExpression {
  return {
    kind: "condition",
    target: {
      kind: "event-payload",
      path: overviewBudgetPayloadPath(index) as never,
    },
    operator: "exists",
  };
}

function overviewBudgetPayloadFilters(count: number): FilterDocument {
  const conditions = Array.from({ length: count }, (_, index) =>
    overviewBudgetPayloadCondition(index + 1),
  );
  const root =
    conditions.length === 0
      ? null
      : conditions.length === 1
        ? conditions[0]!
        : { kind: "and" as const, children: conditions };
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function truthPayload(value: string): FilterExpression {
  return {
    kind: "condition",
    target: { kind: "event-payload", path: "/plan" as never },
    operator: "eq",
    value,
  };
}

function truthFilters(root: FilterExpression | null) {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function seedFilterSemanticsTruthFixture(d1: SqliteD1Database): void {
  // Remove the event-detail seed so every expected relation ID belongs to
  // this fixture and the four final relations can be asserted directly.
  d1.database.exec(`
    DELETE FROM custom_event_json_values;
    DELETE FROM custom_events;
    DELETE FROM custom_event_json_paths;
    DELETE FROM custom_event_names;
    DELETE FROM visits;
  `);

  const visits = [
    [
      "truth-pricing",
      "truth-visitor-a",
      "truth-session-pricing",
      "/pricing",
      eventTime - 30,
    ],
    [
      "truth-home",
      "truth-visitor-b",
      "truth-session-home",
      "/home",
      eventTime - 29,
    ],
    [
      "truth-checkout",
      "truth-visitor-c",
      "truth-session-checkout",
      "/checkout",
      eventTime - 28,
    ],
    [
      "truth-outside",
      "truth-visitor-d",
      "truth-session-outside",
      "/pricing",
      window.startMs - 1,
    ],
    [
      "truth-cross-pricing",
      "truth-visitor-e",
      "truth-session-cross",
      "/pricing",
      eventTime - 27,
    ],
    [
      "truth-cross-event",
      "truth-visitor-e",
      "truth-session-cross",
      "/other",
      eventTime - 26,
    ],
    [
      "truth-visitor-pricing",
      "truth-visitor-f",
      "truth-session-visitor-a",
      "/pricing",
      eventTime - 25,
    ],
    [
      "truth-visitor-event",
      "truth-visitor-f",
      "truth-session-visitor-b",
      "/other",
      eventTime - 24,
    ],
    [
      "truth-multi-home",
      "truth-visitor-g",
      "truth-session-multi",
      "/home",
      eventTime - 23,
    ],
    [
      "truth-multi-pricing",
      "truth-visitor-g",
      "truth-session-multi",
      "/pricing",
      eventTime - 22,
    ],
  ] as const;
  const visitStatement = d1.database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, started_at, pathname
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const [visitId, visitorId, sessionId, pathname, startedAt] of visits) {
    visitStatement.run(
      visitId,
      siteId,
      visitorId,
      sessionId,
      startedAt,
      pathname,
    );
  }

  d1.database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
    )
    .run(110, siteId, "truth_purchase");
  d1.database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
    )
    .run(111, siteId, "truth_other");

  const events = [
    [110, "truth-purchase-home", "truth-home", 110, 1],
    [111, "truth-purchase-free", "truth-checkout", 110, 2],
    [112, "truth-other-pro", "truth-checkout", 111, 3],
    [113, "truth-purchase-outside", "truth-outside", 110, 4],
    [114, "truth-purchase-cross", "truth-cross-event", 110, 5],
    [115, "truth-purchase-visitor", "truth-visitor-event", 110, 6],
  ] as const;
  const eventStatement = d1.database.prepare(
    "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [eventPk, eventId, visitId, eventNameId, sequence] of events) {
    eventStatement.run(
      eventPk,
      eventId,
      siteId,
      visitId,
      eventNameId,
      eventTime,
      eventTime,
      sequence,
      1,
      1,
      null,
    );
  }
  d1.database
    .prepare(
      "INSERT INTO custom_event_json_paths (id, site_id, path) VALUES (?, ?, ?)",
    )
    .run(1, siteId, "/plan");
  d1.database
    .prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, number_value, boolean_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(111, 111, siteId, 110, 1, eventTime, 1, "free", null, null);
  d1.database
    .prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, number_value, boolean_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(112, 112, siteId, 111, 1, eventTime, 1, "pro", null, null);
}

function readTruthRelationIds(
  d1: SqliteD1Database,
  root: FilterExpression | null,
  scopePreference: TruthScope,
  audience: QueryAudience = "private-dashboard",
): TruthRelationIds {
  const filters = truthFilters(root);
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(siteId, audience),
    time: {
      range: {
        startMs: window.startMs,
        endExclusiveMs: window.endExclusiveMs,
      },
      reportingTimeZone: "UTC",
      capturedAtMs: window.nowMs,
    },
    filters,
    scopePreference,
  } as QueryInput & { time: QueryTime });
  const dataset = compileScopedDatasetSql({
    filters: prepared.filters!,
    plan: prepared.scopePlan!,
    siteIds: [siteId],
    window,
  });
  const bindings = dataset.bindings.map(({ value }) => value);
  const read = (relation: string, column: string): string[] =>
    (
      d1.database
        .prepare(
          `WITH ${dataset.ctes} SELECT ${column} AS id FROM ${relation} ORDER BY id`,
        )
        .all(...bindings) as Array<{ id: string }>
    ).map(({ id }) => id);

  return {
    visits: read(dataset.visitRelation, "visit_id"),
    events: read(dataset.eventRelation, "event_id"),
    sessions: read(dataset.sessionRelation, "session_id"),
    visitors: read(dataset.visitorRelation, "visitor_id"),
  };
}

function preparedJourneyFilters(
  operation: "sessions" | "visitors",
  filters: FilterDocument,
): FilterDocument {
  const prepared = prepareScopedQuery(operation, {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: {
      range: {
        startMs: window.startMs,
        endExclusiveMs: window.endExclusiveMs,
      },
      reportingTimeZone: "UTC",
      capturedAtMs: window.nowMs,
    },
    filters,
    scopePreference: "auto",
  } as QueryInput & { time: QueryTime });
  return prepared.filters!;
}

function preparedEventRecordFilters(
  filters: FilterDocument,
  scopePreference: TruthScope,
) {
  return prepareScopedQuery("event-records", {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: {
      range: {
        startMs: window.startMs,
        endExclusiveMs: window.endExclusiveMs,
      },
      reportingTimeZone: "UTC",
      capturedAtMs: window.nowMs,
    },
    filters,
    scopePreference,
  } as QueryInput & { time: QueryTime });
}

function preparedOverviewFilters(
  filters: FilterDocument,
  scopePreference: TruthScope,
) {
  return prepareScopedQuery("overview", {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: {
      range: {
        startMs: window.startMs,
        endExclusiveMs: window.endExclusiveMs,
      },
      reportingTimeZone: "UTC",
      capturedAtMs: window.nowMs,
    },
    filters,
    scopePreference,
  } as QueryInput & { time: QueryTime });
}

function recordFieldFilter(
  field: string,
  operator: "eq" | "gte",
  value: string | number,
): FilterDocument {
  return truthFilters({
    kind: "condition",
    target: { kind: "field", field: field as never },
    operator,
    value,
  });
}

describe("event detail D1 SQL", () => {
  it("runs event-record pages through the unified typed query", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const prepared = prepareScopedQuery("event-records", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      },
      filters: EMPTY_FILTER_DOCUMENT,
      scopePreference: "auto",
    } as QueryInput & { time: QueryTime });

    try {
      const page = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        prepared.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
        },
      );

      expect(page.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);
      expect(d1.calls).toHaveLength(1);
      expect(d1.calls[0]?.sql).toContain('FROM "custom_events"');
    } finally {
      d1.close();
    }
  });

  it("applies prepared observation and entity filters to typed event pages", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const sessionFilters = preparedEventRecordFilters(
        recordFieldFilter("session.views", "gte", 2),
        "session",
      );
      const sessionPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        sessionFilters.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: sessionFilters.scopePlan,
        },
      );
      expect(sessionPage.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);

      const pageFilters = preparedEventRecordFilters(
        recordFieldFilter("page.path", "eq", "/entry"),
        "session",
      );
      const pageScoped = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        pageFilters.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: pageFilters.scopePlan,
        },
      );
      expect(pageScoped.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);

      const visitorFilters = preparedEventRecordFilters(
        recordFieldFilter("visitor.sessions", "gte", 1),
        "visitor",
      );
      const visitorPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        visitorFilters.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: visitorFilters.scopePlan,
        },
      );
      expect(visitorPage.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);

      const combinedSessionFilters = preparedEventRecordFilters(
        truthFilters({
          kind: "and",
          children: [
            recordFieldFilter("session.views", "gte", 2).root!,
            recordFieldFilter("session.events", "gte", 2).root!,
          ],
        }),
        "session",
      );
      const combinedSessionPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        combinedSessionFilters.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: combinedSessionFilters.scopePlan,
        },
      );
      expect(combinedSessionPage.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);

      const notSessionFilters = preparedEventRecordFilters(
        truthFilters({
          kind: "not",
          child: recordFieldFilter("session.views", "gte", 3).root!,
        }),
        "session",
      );
      const notSessionPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        notSessionFilters.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: notSessionFilters.scopePlan,
        },
      );
      expect(notSessionPage.rows).toEqual([]);

      const observationFilters = preparedEventRecordFilters(
        recordFieldFilter("page.path", "eq", "/posts/minecraft-meteor-guide"),
        "event",
      );
      const observationPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        observationFilters.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: observationFilters.scopePlan,
        },
      );
      expect(observationPage.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);
    } finally {
      d1.close();
    }
  });

  it("keeps the direct reader's omitted performance dependency error", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      await expect(
        queryEventRecordPageFromD1(
          env,
          siteId,
          window,
          recordFieldFilter("performance.lcpMs", "gte", 1),
          {
            limit: 50,
            sort: { key: "occurredAt", direction: "desc" },
          },
        ),
      ).rejects.toThrow("perf_lcp_ms was not supplied by the current scope");
    } finally {
      d1.close();
    }
  });

  it("lowers payload, cross-entity, disjunctive and prepared identity filters", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const payloadFilters = truthFilters({
        kind: "condition",
        target: { kind: "event-payload", path: "/href" as never },
        operator: "contains",
        value: "example.test",
      });
      const payloadPrepared = preparedEventRecordFilters(
        payloadFilters,
        "event",
      );
      const payloadPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        payloadPrepared.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: payloadPrepared.scopePlan,
        },
      );
      expect(payloadPage.rows.map((row) => row.eventId)).toEqual(["event-1"]);

      const crossEntityFilters = preparedEventRecordFilters(
        recordFieldFilter("visitor.sessions", "gte", 1),
        "session",
      );
      const crossEntityPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        crossEntityFilters.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: crossEntityFilters.scopePlan,
        },
      );
      expect(crossEntityPage.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);

      const disjunction = truthFilters({
        kind: "or",
        children: [
          recordFieldFilter("session.views", "gte", 2).root!,
          recordFieldFilter("session.events", "gte", 2).root!,
        ],
      });
      const disjunctionPrepared = preparedEventRecordFilters(
        disjunction,
        "session",
      );
      const disjunctionPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        disjunctionPrepared.filters!,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: disjunctionPrepared.scopePlan,
        },
      );
      expect(disjunctionPage.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);

      const observationPrepared = preparedEventRecordFilters(
        EMPTY_FILTER_DOCUMENT,
        "event",
      );
      const observationMetadata = scopedFilterMetadata(
        observationPrepared.filters,
      )!;
      const observationPlan = {
        ...observationMetadata.plan,
        advancedMatches: {
          eventIds: [{ siteId, id: "event-1" }],
        },
      };
      const observationFilters = attachScopedFilterMetadata(
        observationPrepared.filters!,
        { ...observationMetadata, plan: observationPlan },
      );
      const explicitObservationPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        observationFilters,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: observationPlan,
        },
      );
      expect(explicitObservationPage.rows.map((row) => row.eventId)).toEqual([
        "event-1",
      ]);

      const entityPrepared = preparedEventRecordFilters(
        EMPTY_FILTER_DOCUMENT,
        "session",
      );
      const entityMetadata = scopedFilterMetadata(entityPrepared.filters)!;
      const entityPlan = {
        ...entityMetadata.plan,
        advancedMatches: {
          entityIds: [{ siteId, id: "session-1" }],
        },
      };
      const entityFilters = attachScopedFilterMetadata(
        entityPrepared.filters!,
        {
          ...entityMetadata,
          plan: entityPlan,
        },
      );
      const explicitEntityPage = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        entityFilters,
        {
          limit: 50,
          sort: { key: "occurredAt", direction: "desc" },
          scopePlan: entityPlan,
        },
      );
      expect(explicitEntityPage.rows.map((row) => row.eventId)).toEqual([
        "event-other-name",
        "event-1",
      ]);
    } finally {
      d1.close();
    }
  });

  it("executes the all-events trend through compiled relational queries", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const result = await queryEventsTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        1,
        eventName,
      );
      expect(d1.calls.length).toBeGreaterThanOrEqual(2);
      for (const query of d1.calls) {
        expect(query.sql).toContain('"custom_events"');
        expect(query.sql).not.toContain("target_event_name AS");
        expect(query.bindings.length).toBeLessThanOrEqual(100);
        expect(new TextEncoder().encode(query.sql).byteLength).toBeLessThan(
          100_000,
        );
      }
      expect(d1.calls[0]?.bindings).toContain(eventName);
      await recordTrendPhysicalEvidence(
        "queryEventsTrendFromD1.direct",
        eventTrendOutputPlans(
          eventTrendPlanInput(siteId, window, EMPTY_FILTER_DOCUMENT, eventName),
          1,
          "hour",
          result,
        ),
        d1.calls,
      );
      expect(d1.calls.length).toBeLessThanOrEqual(3);

      d1.calls.length = 0;
      await queryEventTypeTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        eventName,
      );
      await recordTrendPhysicalEvidence(
        "queryEventTypeTrendFromD1.direct",
        [
          {
            plan: buildEventTypeTrendPlan({
              ...eventTrendPlanInput(
                siteId,
                window,
                EMPTY_FILTER_DOCUMENT,
                eventName,
              ),
              interval: "hour",
            }),
            outputId: EVENT_TREND_OUTPUTS.typePoints,
          },
        ],
        d1.calls,
      );
    } finally {
      d1.close();
    }
  });

  it("matches the frozen trend SQL for prepared filters and explicit identities", async () => {
    const { env, d1 } = createSqliteEventEnv();
    try {
      const preparedPath = preparedEventRecordFilters(
        filterFixture({ path: "/posts/minecraft-meteor-guide" }),
        "event",
      );
      const pathFilters = preparedPath.filters!;
      const preparedTrend = await queryEventsTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        pathFilters,
        1,
      );
      expect(preparedTrend).toEqual(
        frozenLegacyEventTrend(d1.database, window, "hour", pathFilters, 1),
      );
      await recordTrendPhysicalEvidence(
        "queryEventsTrendFromD1.prepared",
        eventTrendOutputPlans(
          eventTrendPlanInput(siteId, window, pathFilters),
          1,
          "hour",
          preparedTrend,
        ),
        d1.calls,
      );
      expect(d1.calls.length).toBeLessThanOrEqual(3);

      const prepared = preparedEventRecordFilters(
        EMPTY_FILTER_DOCUMENT,
        "event",
      );
      const metadata = scopedFilterMetadata(prepared.filters!);
      if (!metadata || !prepared.scopePlan)
        throw new Error("prepared_trend_scope_metadata_missing");
      const filters = attachScopedFilterMetadata(prepared.filters!, {
        ...metadata,
        plan: {
          ...prepared.scopePlan,
          advancedMatches: {
            visitIds: [{ siteId, id: "visit-1" }],
            eventIds: [
              { siteId, id: "event-1" },
              { siteId, id: "event-other-name" },
              { siteId, id: "event-1" },
            ],
          },
        },
      });
      d1.calls.length = 0;
      const advancedTrend = await queryEventsTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        filters,
        5,
      );
      expect(advancedTrend).toEqual(
        frozenLegacyEventTrend(d1.database, window, "hour", filters, 5),
      );
      expect(d1.calls).toHaveLength(2);
      expect(d1.calls.every((query) => query.bindings.length <= 100)).toBe(
        true,
      );

      d1.calls.length = 0;
      const typeTrend = await queryEventTypeTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        filters,
        eventName,
      );
      expect(typeTrend.data).toEqual(
        frozenCalendarTypeTrend(
          d1.database,
          window,
          "hour",
          filters,
          eventName,
        ),
      );
      expect(d1.calls).toHaveLength(1);
      await recordTrendPhysicalEvidence(
        "queryEventTypeTrendFromD1.prepared",
        [
          {
            plan: buildEventTypeTrendPlan({
              ...eventTrendPlanInput(siteId, window, filters, eventName),
              interval: "hour",
            }),
            outputId: EVENT_TREND_OUTPUTS.typePoints,
          },
        ],
        d1.calls,
      );
    } finally {
      d1.close();
    }
  });

  it("keeps the Event-record trimmed gate distinct from direct raw Event analytics", async () => {
    const paddedName = ` ${eventName} `;

    const recordFixture = createSqliteEventEnv();
    try {
      const records = await queryEventRecordPageFromD1(
        recordFixture.env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        {
          limit: 10,
          sort: { key: "occurredAt", direction: "desc" },
          eventName: paddedName,
        },
      );
      expect(records.rows.map((row) => row.eventId)).toEqual(["event-1"]);
    } finally {
      recordFixture.d1.close();
    }

    const analyticsFixture = createSqliteEventEnv();
    try {
      const typeTrend = await queryEventTypeTrendFromD1(
        analyticsFixture.env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        paddedName,
      );
      expect(typeTrend.data.every((point) => point.events === 0)).toBe(true);
      expect(analyticsFixture.d1.calls).toHaveLength(1);

      analyticsFixture.d1.calls.length = 0;
      const allEventsTrend = await queryEventsTrendFromD1(
        analyticsFixture.env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        5,
        paddedName,
      );
      expect(allEventsTrend.series).toEqual([]);
      expect(
        allEventsTrend.data.every((point) => point.totalEvents === 0),
      ).toBe(true);
      expect(analyticsFixture.d1.calls).toHaveLength(2);
    } finally {
      analyticsFixture.d1.close();
    }
  });

  it("keeps Other identity totals distinct across calendar buckets", async () => {
    const { env, d1 } = createSqliteEventEnv();
    try {
      d1.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
        )
        .run(100, siteId, "other-trend");
      insertTrendEvent(d1.database, 20, eventTime - 30 * 60_000, 99);
      insertTrendEvent(d1.database, 21, eventTime + 30 * 60_000, 99);
      insertTrendEvent(d1.database, 22, eventTime - 20 * 60_000, 100);
      insertTrendEvent(d1.database, 23, eventTime + 45 * 60_000, 100);

      const result = await queryEventsTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        1,
      );
      expect(result).toEqual(
        frozenLegacyEventTrend(
          d1.database,
          window,
          "hour",
          EMPTY_FILTER_DOCUMENT,
          1,
        ),
      );
      expect(result.series).toEqual([
        {
          key: "purchase",
          eventName: "purchase",
          label: "purchase",
          events: 3,
          sessions: 1,
          visitors: 1,
        },
        {
          key: SHARE_TREND_OTHER_KEY,
          eventName: SHARE_TREND_OTHER_LABEL,
          label: SHARE_TREND_OTHER_LABEL,
          events: 3,
          sessions: 1,
          visitors: 1,
          isOther: true,
        },
      ]);
      expect(
        result.data.map((point) => point.eventsBySeries[SHARE_TREND_OTHER_KEY]),
      ).toEqual([1, 2]);
      expect(d1.calls).toHaveLength(3);
    } finally {
      d1.close();
    }
  });

  it("preserves raw series names, key collisions, NULL NOT IN, and Other-token collisions", async () => {
    const { env, d1 } = createSqliteEventEnv();
    try {
      allowNullableEventNames(d1.database);
      const insertName = d1.database.prepare(
        "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
      );
      insertName.run(100, siteId, "a b");
      insertName.run(101, siteId, "a-b");
      insertName.run(102, siteId, " ");
      insertName.run(103, siteId, SHARE_TREND_OTHER_TOKEN);
      insertName.run(104, siteId, null);
      insertTrendEvent(d1.database, 30, eventTime, 99);
      insertTrendEvent(d1.database, 31, eventTime, 99);
      insertTrendEvent(d1.database, 32, eventTime, 100);
      insertTrendEvent(d1.database, 33, eventTime + 1, 100);
      insertTrendEvent(d1.database, 34, eventTime, 101);
      insertTrendEvent(d1.database, 35, eventTime + 1, 101);
      insertTrendEvent(d1.database, 36, eventTime, 102);
      insertTrendEvent(d1.database, 37, eventTime, 103);
      insertTrendEvent(d1.database, 38, eventTime, 104);

      const result = await queryEventsTrendFromD1(
        env,
        siteId,
        window,
        "hour",
        EMPTY_FILTER_DOCUMENT,
        3,
      );
      expect(result).toEqual(
        frozenLegacyEventTrend(
          d1.database,
          window,
          "hour",
          EMPTY_FILTER_DOCUMENT,
          3,
        ),
      );
      expect(
        result.series.slice(0, 3).map((item) => [item.eventName, item.key]),
      ).toEqual([
        ["purchase", "purchase"],
        ["a b", "a-b"],
        ["a-b", "a-b-2"],
      ]);
      expect(result.series.at(-1)).toMatchObject({
        key: SHARE_TREND_OTHER_KEY,
        events: 3,
        sessions: 1,
        visitors: 1,
      });
      expect(result.data[1]?.eventsBySeries[SHARE_TREND_OTHER_KEY]).toBe(4);
      expect(d1.calls).toHaveLength(3);

      d1.calls.length = 0;
      await expect(
        queryEventsTrendFromD1(
          env,
          siteId,
          window,
          "hour",
          EMPTY_FILTER_DOCUMENT,
          20,
        ),
      ).rejects.toThrow(TypeError);
      expect(d1.calls).toHaveLength(1);
    } finally {
      d1.close();
    }
  });

  it("matches the legacy timeBucketCase at calendar boundaries", async () => {
    const cases: Array<{
      readonly label: string;
      readonly interval: Interval;
      readonly window: QueryWindow;
      readonly eventTimes: readonly number[];
      readonly expectedStarts: readonly number[];
      readonly expectedDurations?: readonly number[];
    }> = [
      {
        label: "minute",
        interval: "minute",
        window: {
          startMs: Date.parse("2024-01-01T00:00:30Z"),
          endExclusiveMs: Date.parse("2024-01-01T00:02:00Z"),
          nowMs: Date.parse("2024-01-01T00:02:00Z"),
          timeZone: "UTC",
        },
        eventTimes: [
          Date.parse("2024-01-01T00:00:00Z"),
          Date.parse("2024-01-01T00:00:30Z"),
          Date.parse("2024-01-01T00:01:00Z"),
          Date.parse("2024-01-01T00:02:00Z"),
        ],
        expectedStarts: [
          Date.parse("2024-01-01T00:00:00Z"),
          Date.parse("2024-01-01T00:01:00Z"),
        ],
      },
      {
        label: "hour",
        interval: "hour",
        window: {
          startMs: Date.parse("2024-01-01T10:30:00Z"),
          endExclusiveMs: Date.parse("2024-01-01T12:00:00Z"),
          nowMs: Date.parse("2024-01-01T12:00:00Z"),
          timeZone: "UTC",
        },
        eventTimes: [
          Date.parse("2024-01-01T10:00:00Z"),
          Date.parse("2024-01-01T10:30:00Z"),
          Date.parse("2024-01-01T11:00:00Z"),
          Date.parse("2024-01-01T12:00:00Z"),
        ],
        expectedStarts: [
          Date.parse("2024-01-01T10:00:00Z"),
          Date.parse("2024-01-01T11:00:00Z"),
        ],
      },
      {
        label: "non-hour-zone-day",
        interval: "day",
        window: {
          startMs: Date.parse("2025-01-01T12:00:00+05:45"),
          endExclusiveMs: Date.parse("2025-01-02T12:00:00+05:45"),
          nowMs: Date.parse("2025-01-02T12:00:00+05:45"),
          timeZone: "Asia/Kathmandu",
        },
        eventTimes: [
          Date.parse("2025-01-01T00:00:00+05:45"),
          Date.parse("2025-01-01T12:00:00+05:45"),
          Date.parse("2025-01-02T00:00:00+05:45"),
          Date.parse("2025-01-02T12:00:00+05:45"),
        ],
        expectedStarts: [
          Date.parse("2025-01-01T00:00:00+05:45"),
          Date.parse("2025-01-02T00:00:00+05:45"),
        ],
      },
      {
        label: "week",
        interval: "week",
        window: {
          startMs: Date.parse("2024-01-10T12:00:00Z"),
          endExclusiveMs: Date.parse("2024-01-16T12:00:00Z"),
          nowMs: Date.parse("2024-01-16T12:00:00Z"),
          timeZone: "UTC",
        },
        eventTimes: [
          Date.parse("2024-01-08T00:00:00Z"),
          Date.parse("2024-01-10T12:00:00Z"),
          Date.parse("2024-01-15T00:00:00Z"),
          Date.parse("2024-01-16T12:00:00Z"),
        ],
        expectedStarts: [
          Date.parse("2024-01-08T00:00:00Z"),
          Date.parse("2024-01-15T00:00:00Z"),
        ],
      },
      {
        label: "month",
        interval: "month",
        window: {
          startMs: Date.parse("2024-02-15T00:00:00Z"),
          endExclusiveMs: Date.parse("2024-03-15T00:00:00Z"),
          nowMs: Date.parse("2024-03-15T00:00:00Z"),
          timeZone: "UTC",
        },
        eventTimes: [
          Date.parse("2024-02-01T00:00:00Z"),
          Date.parse("2024-02-15T00:00:00Z"),
          Date.parse("2024-03-01T00:00:00Z"),
          Date.parse("2024-03-15T00:00:00Z"),
        ],
        expectedStarts: [
          Date.parse("2024-02-01T00:00:00Z"),
          Date.parse("2024-03-01T00:00:00Z"),
        ],
      },
      {
        label: "dst-day",
        interval: "day",
        window: {
          startMs: Date.parse("2026-03-08T00:00:00-05:00"),
          endExclusiveMs: Date.parse("2026-03-10T00:00:00-04:00"),
          nowMs: Date.parse("2026-03-10T00:00:00-04:00"),
          timeZone: "America/New_York",
        },
        eventTimes: [
          Date.parse("2026-03-08T00:00:00-05:00"),
          Date.parse("2026-03-09T00:00:00-04:00"),
          Date.parse("2026-03-10T00:00:00-04:00"),
        ],
        expectedStarts: [
          Date.parse("2026-03-08T00:00:00-05:00"),
          Date.parse("2026-03-09T00:00:00-04:00"),
        ],
        expectedDurations: [23 * 60 * 60 * 1000, 24 * 60 * 60 * 1000],
      },
    ];

    for (const [caseIndex, testCase] of cases.entries()) {
      const { env, d1 } = createSqliteEventEnv();
      try {
        testCase.eventTimes.forEach((time, index) =>
          insertTrendEvent(d1.database, caseIndex * 10 + index, time),
        );
        const buckets = buildTimeBuckets(testCase.window, testCase.interval);
        expect(
          buckets.map((bucket) => bucket.startMs),
          testCase.label,
        ).toEqual(testCase.expectedStarts);
        if (testCase.expectedDurations)
          expect(
            buckets.map((bucket) => bucket.endExclusiveMs - bucket.startMs),
            testCase.label,
          ).toEqual(testCase.expectedDurations);

        const result = await queryEventTypeTrendFromD1(
          env,
          siteId,
          testCase.window,
          testCase.interval,
          EMPTY_FILTER_DOCUMENT,
          eventName,
        );
        expect(result.data, testCase.label).toEqual(
          frozenCalendarTypeTrend(
            d1.database,
            testCase.window,
            testCase.interval,
          ),
        );
        expect(d1.calls).toHaveLength(1);
        expect(d1.calls[0]?.bindings.length).toBeLessThanOrEqual(100);
      } finally {
        d1.close();
      }
    }
  });

  it("keeps long-window bucket SQL within the D1 budget and caps at 2000 buckets", async () => {
    const startMs = Date.UTC(2024, 0, 1);
    const { env, d1 } = createSqliteEventEnv();
    try {
      const evidence: Array<Record<string, unknown>> = [];
      for (const bucketCount of [360, 480, 600, 720, 900, 1200, 1500, 2001]) {
        const longWindow: QueryWindow = {
          startMs,
          endExclusiveMs: startMs + bucketCount * 60_000,
          nowMs: startMs + bucketCount * 60_000,
          timeZone: "UTC",
        };
        const legacySource = buildEventFilteredSourceCte(
          siteId,
          longWindow,
          EMPTY_FILTER_DOCUMENT,
          eventName,
        );
        const legacyBucketCase = timeBucketCase(
          buildTimeBuckets(longWindow, "minute"),
          "occurred_at",
        );
        const legacySql = `${legacySource.cte}
          SELECT ${legacyBucketCase.sql} AS bucket, count(*) AS events
          FROM filtered_events
          GROUP BY bucket HAVING bucket IS NOT NULL ORDER BY bucket ASC`;
        const legacyBytes = new TextEncoder().encode(legacySql).byteLength;
        const callsBefore = d1.calls.length;
        let compileFailure: string | null = null;
        try {
          const result = await queryEventTypeTrendFromD1(
            env,
            siteId,
            longWindow,
            "minute",
            EMPTY_FILTER_DOCUMENT,
            eventName,
          );
          expect(result.data).toHaveLength(Math.min(bucketCount, 2000));
        } catch (error) {
          compileFailure = String(error);
        }
        const compiled = d1.calls[callsBefore];
        const compiledBytes = compiled
          ? new TextEncoder().encode(compiled.sql).byteLength
          : null;
        evidence.push({
          bucketCount,
          legacySqlUtf8Bytes: legacyBytes,
          legacyBindings:
            legacySource.bindings.length + legacyBucketCase.bindings.length,
          compiledSqlUtf8Bytes: compiledBytes,
          compiledBindings: compiled?.bindings.length ?? null,
          compileFailure,
        });
        if (legacyBytes <= 100_000) {
          expect(
            compileFailure,
            `new query for ${bucketCount} buckets`,
          ).toBeNull();
          expect(compiledBytes).toBeLessThan(100_000);
          expect(compiled?.bindings.length).toBeLessThanOrEqual(100);
        }
        if (compiled) expect(d1.calls).toHaveLength(callsBefore + 1);
      }
      console.info(
        `[Wave39 long-window SQL comparison] ${JSON.stringify(evidence)}`,
      );

      const capped = buildTimeBuckets(
        {
          startMs,
          endExclusiveMs: startMs + 2001 * 60_000,
          nowMs: startMs + 2001 * 60_000,
          timeZone: "UTC",
        },
        "minute",
      );
      expect(capped).toHaveLength(2000);
      expect(capped.at(-1)).toMatchObject({ index: 1999 });
      console.info(
        `[Wave39 time-bucket SQL budget] ${JSON.stringify({
          interval: "minute",
          cappedBucketCount: capped.length,
        })}`,
      );
    } finally {
      d1.close();
    }
  });

  it("adds a scoped visit source for session-boundary event filters", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const summary = await queryEventSummaryMetricsFromD1(
        env,
        siteId,
        window,
        filterFixture({ entry: "/entry" }),
      );
      expect(summary.events).toBe(2);
      const query = d1.calls.at(-1);
      expect(query?.sql).toContain('"custom_events"');
      expect(query?.sql).toContain("ROW_NUMBER() OVER");
      expect(query?.bindings).toEqual(
        expect.arrayContaining([
          siteId,
          window.startMs,
          window.endExclusiveMs,
          "/entry",
        ]),
      );
    } finally {
      d1.close();
    }
  });

  it("returns the same event context and payload data as the event records query", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const [records, overview, trend, fields, cards] = await Promise.all([
        queryEventRecordPageFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, {
          limit: 25,
          sort: { key: "occurredAt", direction: "desc" },
          eventName,
        }),
        queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          eventName,
        ),
        queryEventTypeTrendFromD1(
          env,
          siteId,
          window,
          "hour",
          EMPTY_FILTER_DOCUMENT,
          eventName,
        ),
        queryEventFieldsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          eventName,
          100,
        ),
        queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          100,
          eventName,
        ),
      ]);

      expect(records.rows).toHaveLength(1);
      expect(overview.summary.events).toBe(1);
      expect(overview.summary.shareOfAllEvents).toBe(0.5);
      expect(trend.data.some((point) => point.events === 1)).toBe(true);
      expect(fields).toMatchObject([{ path: "/href", events: 1 }]);
      expect(cards.page.path).toMatchObject([
        { value: "/posts/minecraft-meteor-guide", views: 1 },
      ]);
      expect(cards.source.domain).toMatchObject([
        { value: "www.google.com", views: 1 },
      ]);
      expect(cards.client.browser).toMatchObject([{ value: "Edge", views: 1 }]);
      expect(cards.geo.country).toMatchObject([{ value: "CN", views: 1 }]);
      expect(cards.page.entry).toMatchObject([{ value: "/entry", views: 1 }]);
      expect(cards.page.exit).toMatchObject([{ value: "/exit", views: 1 }]);
      expect(d1.calls).toHaveLength(5);
      const cardQuery = d1.calls.at(-1)!;
      expect(Buffer.byteLength(cardQuery.sql, "utf8")).toBeLessThanOrEqual(
        100_000,
      );
      expect(cardQuery.bindings.length).toBeLessThanOrEqual(100);
      const cardPlan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cardQuery.sql}`)
        .all(...sqliteBindings(cardQuery.bindings)) as Array<{
        detail: string;
      }>;
      const cardPlanDetails = cardPlan.map((row) => row.detail).join("\n");
      expect(cardPlanDetails).toContain("MATERIALIZE _d1_shared_");
      const overviewQuery = d1.calls.find(({ sql }) =>
        sql.includes('"scopedEvents"'),
      );
      expect(overviewQuery).toBeDefined();
      expect((overviewQuery?.sql.match(/UNION ALL/g) ?? []).length).toBe(4);
      expect(overviewQuery!.bindings.length).toBeLessThanOrEqual(100);
      expect(
        new TextEncoder().encode(overviewQuery!.sql).byteLength,
      ).toBeLessThanOrEqual(100_000);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${overviewQuery?.sql ?? "SELECT 1"}`)
        .all(...sqliteBindings(overviewQuery?.bindings ?? [])) as Array<{
        detail: string;
      }>;
      const planDetails = plan.map((row) => row.detail).join("\n");
      expect(planDetails).toContain("MATERIALIZE _d1_shared_");
      expect(planDetails).toContain("idx_custom_events_site_pk_time");

      const entryExitPlan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cardQuery.sql}`)
        .all(...sqliteBindings(cardQuery.bindings)) as Array<{
        detail: string;
      }>;
      expect(entryExitPlan.map((row) => row.detail).join("\n")).toContain(
        "idx_visits_site_pk_started_at",
      );

      const parentStart = d1.calls.length;
      const parentCards =
        await queryEventAnalyticsContextCardsParentOracleFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          100,
          eventName,
        );
      const parentQuery = d1.calls[parentStart]!;
      expect(parentCards).toEqual(cards);
      expect(d1.calls).toHaveLength(parentStart + 1);
      expect(Buffer.byteLength(parentQuery.sql, "utf8")).toBe(12_463);
      expect(parentQuery.bindings).toHaveLength(9);
    } finally {
      d1.close();
    }
  });

  it("matches the parent oracle for plain default-19 Event Context", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const actual = await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        100,
      );
      const actualQuery = d1.calls[0]!;
      expect(d1.calls).toHaveLength(1);
      expect(Buffer.byteLength(actualQuery.sql, "utf8")).toBeLessThanOrEqual(
        100_000,
      );
      expect(actualQuery.bindings.length).toBeLessThanOrEqual(100);

      const parent = await queryEventAnalyticsContextCardsParentOracleFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        100,
      );
      const parentQuery = d1.calls[1]!;
      expect(actual).toEqual(parent);
      expect(d1.calls).toHaveLength(2);
      expect(Buffer.byteLength(parentQuery.sql, "utf8")).toBeLessThanOrEqual(
        100_000,
      );
      expect(parentQuery.bindings.length).toBeLessThanOrEqual(100);
    } finally {
      d1.close();
    }
  });

  it("matches the parent Event Context oracle across scopes, boundary ties, and empty dimensions", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const insertVisit = d1.database.prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, pathname,
        browser, country
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertVisit.run(
      "a-visit-entry",
      siteId,
      "edge-visitor",
      "session-1",
      eventTime - 2,
      "/entry-tie-winner",
      "",
      "",
    );
    insertVisit.run(
      "z-visit-exit",
      siteId,
      "edge-visitor",
      "session-1",
      eventTime + 1,
      "/exit-tie-winner",
      "",
      "",
    );
    insertVisit.run(
      "visit-scope-peer",
      siteId,
      "visitor-1",
      "session-1",
      eventTime - 1,
      "/session-peer",
      " Edge ",
      "US",
    );
    insertVisit.run(
      "visit-scope-other-owner",
      siteId,
      "visitor-3",
      "session-1",
      eventTime - 1,
      "/owner-other",
      "",
      "",
    );
    insertVisit.run(
      "visit-visitor-peer",
      siteId,
      "visitor-1",
      "session-2",
      eventTime,
      "/visitor-peer",
      "",
      "GB",
    );
    const insertEvent = d1.database.prepare(
      `INSERT INTO custom_events (
        event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count, ae_synced_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, 1, NULL)`,
    );
    for (const [eventPk, eventId, visitId, sequence] of [
      [2, "event-session-peer", "visit-scope-peer", 2],
      [3, "event-visitor-peer", "visit-visitor-peer", 3],
      [4, "event-other-owner", "visit-scope-other-owner", 4],
    ] as const)
      insertEvent.run(
        eventPk,
        eventId,
        siteId,
        visitId,
        eventTime,
        eventTime,
        sequence,
      );

    try {
      const scopePaths = new Map<TruthScope, string[]>([
        ["event", ["/posts/minecraft-meteor-guide"]],
        [
          "session",
          ["/owner-other", "/posts/minecraft-meteor-guide", "/session-peer"],
        ],
        [
          "visitor",
          ["/posts/minecraft-meteor-guide", "/session-peer", "/visitor-peer"],
        ],
      ]);
      for (const scope of ["event", "session", "visitor"] as const) {
        const prepared = preparedEventRecordFilters(
          filterFixture({ path: "/posts/minecraft-meteor-guide" }),
          scope,
        );
        const actualStart = d1.calls.length;
        const actual = await queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          prepared.filters!,
          100,
          eventName,
        );
        const actualQuery = d1.calls[actualStart]!;
        const parent = await queryEventAnalyticsContextCardsParentOracleFromD1(
          env,
          siteId,
          window,
          prepared.filters!,
          100,
          eventName,
        );
        const parentQuery = d1.calls[actualStart + 1]!;
        expect(actual, `scope-${scope}`).toEqual(parent);
        expect(d1.calls).toHaveLength(actualStart + 2);
        expect(actual.page.path.map(({ value }) => value).sort()).toEqual(
          scopePaths.get(scope),
        );
        for (const query of [actualQuery, parentQuery]) {
          expect(Buffer.byteLength(query.sql, "utf8")).toBeLessThanOrEqual(
            100_000,
          );
          expect(query.bindings.length).toBeLessThanOrEqual(100);
        }
      }

      const actualStart = d1.calls.length;
      const actual = await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        100,
        eventName,
        ["entry", "exit", "sourceDomain", "sourceLink", "browser", "country"],
      );
      const actualQuery = d1.calls[actualStart]!;
      const parent = await queryEventAnalyticsContextCardsParentOracleFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        100,
        eventName,
        ["entry", "exit", "sourceDomain", "sourceLink", "browser", "country"],
      );
      expect(actual).toEqual(parent);
      expect(d1.calls).toHaveLength(actualStart + 2);
      // These migrated text columns are NOT NULL; this fixture covers their
      // reachable empty-string grouping without weakening the production DDL.
      expect(actual.page.entry).toContainEqual({
        value: "/entry-tie-winner",
        views: 3,
        sessions: 1,
        visitors: 2,
      });
      expect(actual.page.exit).toContainEqual({
        value: "/exit-tie-winner",
        views: 3,
        sessions: 1,
        visitors: 2,
      });
      expect(actual.source.domain).toContainEqual({
        value: "",
        views: 3,
        sessions: 2,
        visitors: 2,
      });
      expect(actual.source.link).toContainEqual({
        value: "",
        views: 3,
        sessions: 2,
        visitors: 2,
      });
      expect(actual.client.browser).toContainEqual({
        value: "Edge",
        views: 2,
        sessions: 1,
        visitors: 1,
      });
      expect(actual.geo.country).toContainEqual({
        value: "US",
        label: "US",
        views: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(Buffer.byteLength(actualQuery.sql, "utf8")).toBeLessThanOrEqual(
        100_000,
      );
      expect(actualQuery.bindings.length).toBeLessThanOrEqual(100);
    } finally {
      d1.close();
    }
  });

  it("keeps entry-filtered default-19 Context queries within the statement budget", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const cases = [
      filterFixture({ entry: "/entry" }),
      filterFixture({ entry: "/entry", exit: "/exit" }),
    ];

    try {
      for (const filters of cases) {
        const actualStart = d1.calls.length;
        const actual = await queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          filters,
          100,
          eventName,
        );
        const actualQuery = d1.calls[actualStart]!;
        const parent = await queryEventAnalyticsContextCardsParentOracleFromD1(
          env,
          siteId,
          window,
          filters,
          100,
          eventName,
        );
        const parentQuery = d1.calls[actualStart + 1]!;

        expect(actual).toEqual(parent);
        expect(d1.calls).toHaveLength(actualStart + 2);
        for (const query of [actualQuery, parentQuery]) {
          expect(Buffer.byteLength(query.sql, "utf8")).toBeLessThanOrEqual(
            100_000,
          );
          expect(query.bindings.length).toBeLessThanOrEqual(100);
        }
      }
    } finally {
      d1.close();
    }
  });

  it("matches Context results for prepared identities, previous windows, card subsets, and finite limits", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const insertVisit = d1.database.prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, pathname
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = d1.database.prepare(
      `INSERT INTO custom_events (
        event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count, ae_synced_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, 1, NULL)`,
    );
    const previousTime = window.startMs - 30 * 60 * 1000;
    insertVisit.run(
      "visit-previous-window",
      siteId,
      "visitor-previous",
      "session-previous",
      previousTime,
      "/previous-window",
    );
    insertEvent.run(
      200,
      "event-previous-window",
      siteId,
      "visit-previous-window",
      previousTime + 1,
      previousTime + 1,
    );

    try {
      const prepared = preparedEventRecordFilters(
        EMPTY_FILTER_DOCUMENT,
        "event",
      );
      const metadata = scopedFilterMetadata(prepared.filters!)!;
      const identityFilters = attachScopedFilterMetadata(prepared.filters!, {
        ...metadata,
        plan: {
          ...prepared.scopePlan!,
          advancedMatches: {
            eventIds: [
              { siteId, id: "event-1" },
              { siteId, id: "event-1" },
              { siteId, id: "event-other-name" },
              ...Array.from({ length: 125 }, (_unused, index) => ({
                siteId,
                id: `event-unmatched-${index}`,
              })),
            ],
          },
        },
      });
      const emptyIdentityFilters = attachScopedFilterMetadata(
        prepared.filters!,
        {
          ...metadata,
          plan: {
            ...prepared.scopePlan!,
            advancedMatches: { eventIds: [] },
          },
        },
      );
      for (const [label, filters] of [
        ["prepared-128", identityFilters],
        ["prepared-empty", emptyIdentityFilters],
      ] as const) {
        let offlineParentQuery:
          { sql: string; bindings: readonly Binding[] } | undefined;
        const actualStart = d1.calls.length;
        const actual = await queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          filters,
          100,
        );
        const actualQuery = d1.calls[actualStart]!;
        const parent = await queryEventAnalyticsContextCardsParentOracleFromD1(
          env,
          siteId,
          window,
          filters,
          100,
          undefined,
          undefined,
          async (sql, bindings) => {
            offlineParentQuery = { sql, bindings: [...bindings] };
            return d1.database.prepare(sql).all(...bindings) as Array<{
              cardType: string;
              value: string | null;
              label: string | null;
              views: number;
              sessions: number;
              visitors: number;
            }>;
          },
        );

        expect(actual, label).toEqual(parent);
        expect(d1.calls).toHaveLength(actualStart + 1);
        expect(offlineParentQuery).toBeDefined();
        expect(
          Buffer.byteLength(offlineParentQuery!.sql, "utf8"),
        ).toBeLessThanOrEqual(100_000);
        if (label === "prepared-128")
          expect(offlineParentQuery!.bindings.length).toBeGreaterThan(100);
        else
          expect(offlineParentQuery!.bindings.length).toBeLessThanOrEqual(100);
        expect(Buffer.byteLength(actualQuery.sql, "utf8")).toBeLessThanOrEqual(
          100_000,
        );
        expect(actualQuery.bindings.length).toBeLessThanOrEqual(100);
        if (label === "prepared-128")
          expect(actual.page.path).toContainEqual({
            value: "/posts/minecraft-meteor-guide",
            views: 2,
            sessions: 1,
            visitors: 1,
          });
        else
          expect(
            Object.values(actual).flatMap((group) =>
              Object.values(group).flat(),
            ),
          ).toEqual([]);
      }

      const previousFilters = preparedEventRecordFilters(
        filterFixture({ path: "/previous-window" }),
        "event",
      );
      const previousWindow: QueryWindow = {
        startMs: window.startMs - 60 * 60 * 1000,
        endExclusiveMs: window.startMs,
        nowMs: window.startMs,
        timeZone: window.timeZone,
      };
      const previousStart = d1.calls.length;
      const previousActual = await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        previousWindow,
        previousFilters.filters!,
        100,
        eventName,
      );
      const previousQuery = d1.calls[previousStart]!;
      const previousParent =
        await queryEventAnalyticsContextCardsParentOracleFromD1(
          env,
          siteId,
          previousWindow,
          previousFilters.filters!,
          100,
          eventName,
        );
      expect(previousActual).toEqual(previousParent);
      expect(previousActual.page.path).toContainEqual({
        value: "/previous-window",
        views: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(d1.calls).toHaveLength(previousStart + 2);
      expect(Buffer.byteLength(previousQuery.sql, "utf8")).toBeLessThanOrEqual(
        100_000,
      );
      expect(previousQuery.bindings.length).toBeLessThanOrEqual(100);

      for (const keys of [["path"], ["path", "sourceDomain"]] as const) {
        const selectedStart = d1.calls.length;
        const selectedActual = await queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          100,
          eventName,
          keys,
        );
        const selectedQuery = d1.calls[selectedStart]!;
        const selectedParent =
          await queryEventAnalyticsContextCardsParentOracleFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            100,
            eventName,
            keys,
          );
        expect(selectedActual).toEqual(selectedParent);
        expect(selectedActual.page.entry).toEqual([]);
        expect(selectedActual.page.exit).toEqual([]);
        expect(selectedQuery.sql).not.toContain("session_visit_edges");
        expect(d1.calls).toHaveLength(selectedStart + 2);
        expect(
          Buffer.byteLength(selectedQuery.sql, "utf8"),
        ).toBeLessThanOrEqual(100_000);
        expect(selectedQuery.bindings.length).toBeLessThanOrEqual(100);

        for (const limit of [0, -1, 1.5]) {
          const actualStart = d1.calls.length;
          const actual = await queryEventAnalyticsContextCardsFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            limit,
            eventName,
            keys,
          );
          const actualQuery = d1.calls[actualStart]!;
          const parent =
            await queryEventAnalyticsContextCardsParentOracleFromD1(
              env,
              siteId,
              window,
              EMPTY_FILTER_DOCUMENT,
              limit,
              eventName,
              keys,
            );
          expect(actual, `limit-${limit}-cards-${keys.join("-")}`).toEqual(
            parent,
          );
          if (limit <= 0) expect(actual.page.path).toEqual([]);
          expect(d1.calls).toHaveLength(actualStart + 2);
          expect(
            Buffer.byteLength(actualQuery.sql, "utf8"),
          ).toBeLessThanOrEqual(100_000);
          expect(actualQuery.bindings.length).toBeLessThanOrEqual(100);
        }
      }

      const noSelectionStart = d1.calls.length;
      const noSelection = await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        100,
        eventName,
        [],
      );
      expect(noSelection).toEqual({
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
      });
      expect(d1.calls).toHaveLength(noSelectionStart);
    } finally {
      d1.close();
    }
  });

  it("matches the frozen context oracle for legal 40- and 39-payload direct filters", async () => {
    const { env, d1 } = createSqliteEventEnv();
    d1.database
      .prepare(
        "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        2,
        "event-outbound-click-missing-one-payload",
        siteId,
        "visit-1",
        1,
        eventTime,
        eventTime,
        2,
        1,
        1,
        null,
      );
    const insertPath = d1.database.prepare(
      "INSERT INTO custom_event_json_paths (id, site_id, path) VALUES (?, ?, ?)",
    );
    const insertPayload = d1.database.prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, number_value, boolean_value
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'budget-value', NULL, NULL)`,
    );
    for (let index = 1; index <= 40; index += 1) {
      const pathId = index + 1;
      insertPath.run(pathId, siteId, overviewBudgetPayloadPath(index));
      insertPayload.run(1, 1_000 + pathId, siteId, 1, pathId, eventTime);
      if (index < 40)
        insertPayload.run(2, 2_000 + pathId, siteId, 1, pathId, eventTime);
    }

    try {
      for (const count of [40, 39]) {
        const filters = overviewBudgetPayloadFilters(count);
        const parentStart = d1.calls.length;
        const expected =
          await queryEventAnalyticsContextCardsParentOracleFromD1(
            env,
            siteId,
            window,
            filters,
            100,
            eventName,
          );
        const parentQuery = d1.calls[parentStart]!;
        expect(d1.calls).toHaveLength(parentStart + 1);
        expect(parentQuery.bindings.length).toBeLessThanOrEqual(100);
        expect(Buffer.byteLength(parentQuery.sql, "utf8")).toBeLessThanOrEqual(
          100_000,
        );
        const actualStart = d1.calls.length;
        const actual = await queryEventAnalyticsContextCardsFromD1(
          env,
          siteId,
          window,
          filters,
          100,
          eventName,
        );
        const actualQuery = d1.calls[actualStart]!;

        expect(actual, `payload-exists-${count}`).toEqual(expected);
        expect(actual.page.path).toMatchObject([
          {
            value: "/posts/minecraft-meteor-guide",
            views: count === 39 ? 2 : 1,
            sessions: 1,
            visitors: 1,
          },
        ]);
        expect(d1.calls).toHaveLength(actualStart + 1);
        for (const query of [actualQuery, parentQuery]) {
          expect(query.bindings.length).toBeLessThanOrEqual(100);
          expect(Buffer.byteLength(query.sql, "utf8")).toBeLessThanOrEqual(
            100_000,
          );
        }
      }
    } finally {
      d1.close();
    }
  });

  it("matches offset ordering with keyset pages for every event-record sort", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      d1.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, started_at, pathname
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "visit-2",
          siteId,
          "visitor-2",
          "session-2",
          eventTime,
          "/pricing",
        );
      d1.database
        .prepare(
          "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
        )
        .run(2, siteId, "Purchase");
      for (const [eventPk, eventId, visitId, eventNameId, occurredAt] of [
        [2, "event-2", "visit-1", 1, eventTime + 1],
        [3, "event-3", "visit-2", 2, eventTime + 1],
        [4, "event-4", "visit-2", 2, eventTime],
      ]) {
        d1.database
          .prepare(
            "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            eventPk,
            eventId,
            siteId,
            visitId,
            eventNameId,
            occurredAt,
            occurredAt,
            eventPk,
            1,
            1,
            null,
          );
      }

      for (const sort of [
        { key: "occurredAt", direction: "asc" },
        { key: "occurredAt", direction: "desc" },
        { key: "eventName", direction: "asc" },
        { key: "eventName", direction: "desc" },
        { key: "pathname", direction: "asc" },
        { key: "pathname", direction: "desc" },
      ] as const) {
        const expected = await queryEventRecordPageFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          {
            limit: 20,
            sort,
          },
        );
        const received = [];
        let cursor = null;
        do {
          const page = await queryEventRecordPageFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            {
              limit: 2,
              sort,
              cursor,
            },
          );
          received.push(...page.rows);
          cursor = page.nextCursor;
        } while (cursor);

        expect(received.map((row) => row.eventId)).toEqual(
          expected.rows.map((row) => row.eventId),
        );
      }

      const cursorQuery = d1.calls.at(-1);
      expect(cursorQuery?.sql).not.toContain("OFFSET");
      expect(cursorQuery?.sql).not.toContain("SELECT *");
      expect(cursorQuery?.sql).not.toContain("filtered_events AS");
      expect(cursorQuery?.sql).toContain('FROM "custom_events"');
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cursorQuery?.sql ?? "SELECT 1"}`)
        .all(...sqliteBindings(cursorQuery?.bindings ?? []));
      expect(plan.length).toBeGreaterThan(0);
    } finally {
      d1.close();
    }
  });

  it("uses the event-name index for filtered event records", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const records = await queryEventRecordPageFromD1(
        env,
        siteId,
        window,
        filterFixture({
          query: "",
          sourceLink: "https://www.google.com/",
          clientLanguage: "zh-CN",
          clientScreenSize: "1920x1080",
          geoContinent: "Asia",
          geoTimezone: "Asia/Shanghai",
          geoOrganization: "Example Networks",
        }),
        {
          limit: 25,
          sort: { key: "occurredAt", direction: "desc" },
          eventName: ` ${eventName} `,
        },
      );

      expect(records.rows.map((record) => record.eventId)).toEqual(["event-1"]);
      const query = d1.calls.at(-1);
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${query?.sql ?? "SELECT 1"}`)
        .all(...sqliteBindings(query?.bindings ?? [])) as Array<{
        detail: string;
      }>;
      const planDetails = plan.map((row) => row.detail).join("\n");
      expect(planDetails).toContain("idx_custom_events_site_pk_name_time");
      expect(query?.sql).toContain('"query_string"');
      expect(query?.sql).toContain('"referrer_url"');
      expect(query?.sql).toContain('"screen_width"');
      expect(query?.sql).toContain('"as_organization"');
    } finally {
      d1.close();
    }
  });

  it("executes the funnel plan as one staged SQLite statement", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const analysis = await queryFunnelAnalysis(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        funnelConfig([
          {
            id: "entry",
            filterDsl: 'page.path eq "/posts/minecraft-meteor-guide"',
          },
          { id: "click", filterDsl: `event.name eq "${eventName}"` },
        ]),
      );

      expect(analysis.progressionScope).toBe("session");
      expect(analysis.summary.totalProgressions).toBe(1);
      expect(analysis.summary.convertedProgressions).toBe(1);
      expect(d1.calls).toHaveLength(1);
      expect(
        new TextEncoder().encode(d1.calls[0]?.sql ?? "").byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(d1.calls[0]?.bindings.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    } finally {
      d1.close();
    }
  });

  it("applies page filters to the session scope without removing funnel steps", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const analysis = await queryFunnelAnalysis(
        env,
        siteId,
        window,
        filterFixture({ path: "/posts/minecraft-meteor-guide" }),
        funnelConfig([
          { id: "entry", filterDsl: 'page.path eq "/entry"' },
          {
            id: "guide",
            filterDsl: 'page.path eq "/posts/minecraft-meteor-guide"',
          },
          { id: "click", filterDsl: `event.name eq "${eventName}"` },
        ]),
      );

      expect(analysis.steps.map((step) => step.sessions)).toEqual([1, 1, 1]);
      expect(analysis.summary).toMatchObject({
        totalProgressions: 1,
        convertedProgressions: 1,
      });
      expect(d1.calls).toHaveLength(1);
    } finally {
      d1.close();
    }
  });

  it("feeds funnel progression from the final scoped relations", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const prepared = prepareScopedQuery("funnel-analysis", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      },
      filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
      scopePreference: "event",
    } as QueryInput & { time: QueryTime });

    try {
      const analysis = await queryFunnelAnalysis(
        env,
        siteId,
        window,
        prepared.filters!,
        funnelConfig([
          {
            id: "guide",
            filterDsl: 'page.path eq "/posts/minecraft-meteor-guide"',
          },
          { id: "click", filterDsl: `event.name eq "${eventName}"` },
        ]),
      );

      expect(analysis.steps.map((step) => step.sessions)).toEqual([1, 1]);
      expect(analysis.summary).toMatchObject({
        totalProgressions: 1,
        convertedProgressions: 1,
      });
      expect(d1.calls).toHaveLength(1);
    } finally {
      d1.close();
    }
  });

  it("uses event filters to select funnel sessions before loading page steps", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const filters = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "event.name" },
          operator: "eq",
          value: eventName,
        },
      },
      analyticsFilterRegistry,
    );

    try {
      const analysis = await queryFunnelAnalysis(
        env,
        siteId,
        window,
        filters,
        funnelConfig([
          { id: "entry", filterDsl: 'page.path eq "/entry"' },
          { id: "click", filterDsl: `event.name eq "${eventName}"` },
        ]),
      );

      expect(analysis.steps.map((step) => step.sessions)).toEqual([1, 1]);
      expect(d1.calls).toHaveLength(1);
    } finally {
      d1.close();
    }
  });

  it("queries only requested context cards without building session edges", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const cards = await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        100,
        eventName,
        ["path"],
      );

      expect(cards.page.path).toMatchObject([
        { value: "/posts/minecraft-meteor-guide", views: 1 },
      ]);
      expect(cards.page.entry).toEqual([]);
      expect(cards.source.domain).toEqual([]);
      const query = d1.calls.at(-1);
      expect(query?.sql).not.toContain("session_visit_edges");
      expect(query?.bindings).toContain("path");
      expect(query?.bindings).not.toContain("browser");
    } finally {
      d1.close();
    }
  });

  it("derives scoped event entry and exit from the final visit relation", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const prepared = prepareScopedQuery("event-context", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      },
      filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
      scopePreference: "event",
    } as QueryInput & { time: QueryTime });

    try {
      const cards = await queryEventAnalyticsContextCardsFromD1(
        env,
        siteId,
        window,
        prepared.filters!,
        100,
        eventName,
        ["entry", "exit"],
      );

      expect(cards.page.entry).toMatchObject([
        { value: "/posts/minecraft-meteor-guide" },
      ]);
      expect(cards.page.exit).toMatchObject([
        { value: "/posts/minecraft-meteor-guide" },
      ]);
      expect(d1.calls.at(-1)?.bindings).toContain(
        "/posts/minecraft-meteor-guide",
      );
    } finally {
      d1.close();
    }
  });

  it("keeps all four final relations aligned for Event and Visitor scopes", () => {
    const { env, d1 } = createSqliteEventEnv();
    const visitorPrepared = prepareScopedQuery("overview", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: {
        range: {
          startMs: window.startMs,
          endExclusiveMs: window.endExclusiveMs,
        },
        reportingTimeZone: "UTC",
        capturedAtMs: window.nowMs,
      },
      filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
      scopePreference: "visitor",
    } as QueryInput & { time: QueryTime });

    try {
      const visitorDataset = compileScopedDatasetSql({
        filters: visitorPrepared.filters!,
        plan: visitorPrepared.scopePlan!,
        siteIds: [siteId],
        window,
      });
      const visitorCounts = d1.database
        .prepare(
          `
          WITH ${visitorDataset.ctes}
          SELECT
            (SELECT count(*) FROM ${visitorDataset.visitRelation}) AS visits,
            (SELECT count(*) FROM ${visitorDataset.eventRelation}) AS events,
            (SELECT count(*) FROM ${visitorDataset.sessionRelation}) AS sessions,
            (SELECT count(*) FROM ${visitorDataset.visitorRelation}) AS visitors
        `,
        )
        .get(...visitorDataset.bindings.map(({ value }) => value)) as Record<
        string,
        number
      >;

      expect(visitorCounts).toEqual({
        visits: 3,
        events: 2,
        sessions: 1,
        visitors: 1,
      });

      const eventPrepared = prepareScopedQuery("overview", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time: {
          range: {
            startMs: window.startMs,
            endExclusiveMs: window.endExclusiveMs,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: window.nowMs,
        },
        filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
        scopePreference: "event",
      } as QueryInput & { time: QueryTime });
      const eventDataset = compileScopedDatasetSql({
        filters: eventPrepared.filters!,
        plan: eventPrepared.scopePlan!,
        siteIds: [siteId],
        window,
      });
      const eventCounts = d1.database
        .prepare(
          `
          WITH ${eventDataset.ctes}
          SELECT
            (SELECT count(*) FROM ${eventDataset.visitRelation}) AS visits,
            (SELECT count(*) FROM ${eventDataset.eventRelation}) AS events,
            (SELECT count(*) FROM ${eventDataset.sessionRelation}) AS sessions,
            (SELECT count(*) FROM ${eventDataset.visitorRelation}) AS visitors
        `,
        )
        .get(...eventDataset.bindings.map(({ value }) => value)) as Record<
        string,
        number
      >;

      expect(eventCounts).toEqual({
        visits: 1,
        events: 2,
        sessions: 1,
        visitors: 1,
      });
    } finally {
      d1.close();
    }
  });

  it("includes an entity represented only by an in-window custom event", () => {
    const { env, d1 } = createSqliteEventEnv();
    const eventOnlyVisitStart = window.startMs - 2 * 60 * 60 * 1000;
    d1.database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, visitor_id, session_id, started_at, pathname
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "visit-event-only",
        siteId,
        "visitor-event-only",
        "session-event-only",
        eventOnlyVisitStart,
        "/outside-window",
      );
    d1.database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
      )
      .run(100, siteId, "event_only_type");
    d1.database
      .prepare(
        "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        2,
        "event-only",
        siteId,
        "visit-event-only",
        100,
        eventTime,
        eventTime,
        1,
        1,
        1,
        null,
      );

    try {
      const prepared = prepareScopedQuery("overview", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time: {
          range: {
            startMs: window.startMs,
            endExclusiveMs: window.endExclusiveMs,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: window.nowMs,
        },
        filters: normalizeFilterDocument(
          {
            version: 1,
            root: {
              kind: "condition",
              target: { kind: "field", field: "event.name" },
              operator: "eq",
              value: "event_only_type",
            },
          },
          analyticsFilterRegistry,
        ),
        scopePreference: "visitor",
      } as QueryInput & { time: QueryTime });
      const dataset = compileScopedDatasetSql({
        filters: prepared.filters!,
        plan: prepared.scopePlan!,
        siteIds: [siteId],
        window,
      });
      const counts = d1.database
        .prepare(
          `
          WITH ${dataset.ctes}
          SELECT
            (SELECT count(*) FROM ${dataset.visitRelation}) AS visits,
            (SELECT count(*) FROM ${dataset.eventRelation}) AS events,
            (SELECT count(*) FROM ${dataset.sessionRelation}) AS sessions,
            (SELECT count(*) FROM ${dataset.visitorRelation}) AS visitors
        `,
        )
        .get(...dataset.bindings.map(({ value }) => value)) as Record<
        string,
        number
      >;

      expect(counts).toEqual({
        visits: 0,
        events: 1,
        sessions: 1,
        visitors: 1,
      });
    } finally {
      d1.close();
    }
  });

  it("skips unused event overview breakdowns without changing summary metrics", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      const overview = await queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        eventName,
        { includeBreakdowns: false },
      );

      expect(overview.summary).toMatchObject({
        events: 1,
        eventTypes: 1,
        shareOfAllEvents: 0.5,
      });
      expect(overview.breakdowns).toEqual({
        pages: [],
        countries: [],
        devices: [],
        browsers: [],
      });
      const query = d1.calls.at(-1);
      expect(query?.sql).not.toContain("'page' AS cardType");
      expect(query?.sql).not.toContain("'country' AS cardType");
    } finally {
      d1.close();
    }
  });

  it("matches legacy top-eight tie ordering with an explicit outer order", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const insertVisit = d1.database.prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, started_at, pathname,
        country, device_type, browser
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = d1.database.prepare(
      "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let index = 1; index <= 10; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const visitId = `ordered-visit-${suffix}`;
      insertVisit.run(
        visitId,
        siteId,
        `ordered-visitor-${suffix}`,
        `ordered-session-${suffix}`,
        eventTime + index,
        `/ordered-${suffix}`,
        `country-${suffix}`,
        `device-${suffix}`,
        `browser-${suffix}`,
      );
      insertEvent.run(
        100 + index,
        `ordered-event-${suffix}`,
        siteId,
        visitId,
        1,
        eventTime + index,
        eventTime + index,
        100 + index,
        1,
        1,
        null,
      );
    }

    try {
      const before = d1.calls.length;
      const actual = await queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        eventName,
      );
      const actualQuery = d1.calls[before];
      const expected = await queryLegacyEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        eventName,
      );
      expect(actual).toEqual(expected);
      expect(d1.calls).toHaveLength(before + 2);
      expect(actual.summary).toMatchObject({ events: 11, sessions: 11 });
      expect(actual.breakdowns.pages.map(({ value }) => value)).toEqual(
        Array.from(
          { length: 8 },
          (_, index) => `/ordered-${String(index + 1).padStart(2, "0")}`,
        ),
      );
      expect(actual.breakdowns.countries.map(({ value }) => value)).toEqual([
        "CN",
        ...Array.from(
          { length: 7 },
          (_, index) => `country-${String(index + 1).padStart(2, "0")}`,
        ),
      ]);
      expect(actual.breakdowns.devices.map(({ value }) => value)).toEqual([
        "desktop",
        ...Array.from(
          { length: 7 },
          (_, index) => `device-${String(index + 1).padStart(2, "0")}`,
        ),
      ]);
      expect(actual.breakdowns.browsers.map(({ value }) => value)).toEqual([
        "Edge",
        ...Array.from(
          { length: 7 },
          (_, index) => `browser-${String(index + 1).padStart(2, "0")}`,
        ),
      ]);

      expect(actualQuery).toBeDefined();
      const orderByIndex = actualQuery!.sql
        .toUpperCase()
        .lastIndexOf("ORDER BY");
      expect(orderByIndex).toBeGreaterThan(
        actualQuery!.sql.toUpperCase().lastIndexOf("UNION ALL"),
      );
      const terminalOrder = actualQuery!.sql.slice(orderByIndex);
      expect(terminalOrder).toMatch(
        /ORDER BY "[^"]+"\."_c0" ASC, "[^"]+"\."_c2" DESC, "[^"]+"\."_c4" DESC, "[^"]+"\."_c1" ASC/u,
      );
    } finally {
      d1.close();
    }
  });

  it("matches the frozen overview oracle across direct and prepared scopes", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const preparedEvent = preparedOverviewFilters(
      filterFixture({ path: "/posts/minecraft-meteor-guide" }),
      "event",
    );
    const preparedVisitor = preparedOverviewFilters(
      filterFixture({ path: "/posts/minecraft-meteor-guide" }),
      "visitor",
    );
    const cases = [
      {
        label: "direct-plain",
        filters: EMPTY_FILTER_DOCUMENT,
        eventName,
        includeBreakdowns: true,
      },
      {
        label: "direct-filtered",
        filters: filterFixture({ path: "/posts/minecraft-meteor-guide" }),
        eventName,
        includeBreakdowns: true,
      },
      {
        label: "prepared-observation",
        filters: preparedEvent.filters!,
        eventName,
        includeBreakdowns: true,
      },
      {
        label: "prepared-visitor-entity",
        filters: preparedVisitor.filters!,
        eventName,
        includeBreakdowns: true,
      },
      {
        label: "prepared-empty-name",
        filters: preparedEvent.filters!,
        eventName: "",
        includeBreakdowns: true,
      },
      {
        label: "direct-empty-name",
        filters: EMPTY_FILTER_DOCUMENT,
        eventName: "",
        includeBreakdowns: true,
      },
      {
        label: "breakdowns-disabled",
        filters: EMPTY_FILTER_DOCUMENT,
        eventName,
        includeBreakdowns: false,
      },
    ] as const;

    try {
      for (const testCase of cases) {
        const before = d1.calls.length;
        const options = { includeBreakdowns: testCase.includeBreakdowns };
        const actual = await queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          testCase.filters,
          testCase.eventName,
          options,
        );
        const actualQuery = d1.calls[before];
        const expected = await queryLegacyEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          testCase.filters,
          testCase.eventName,
          options,
        );
        const legacyQuery = d1.calls[before + 1];

        expect(actual, testCase.label).toEqual(expected);
        expect(
          actualQuery,
          `${testCase.label}:one typed statement`,
        ).toBeDefined();
        expect(
          legacyQuery,
          `${testCase.label}:one legacy statement`,
        ).toBeDefined();
        expect(d1.calls).toHaveLength(before + 2);
        for (const query of [actualQuery!, legacyQuery!]) {
          expect(query.bindings.length, testCase.label).toBeLessThanOrEqual(
            100,
          );
          expect(
            new TextEncoder().encode(query.sql).byteLength,
            testCase.label,
          ).toBeLessThan(100_000);
        }
        if (
          testCase.label === "direct-plain" ||
          testCase.label === "direct-filtered"
        ) {
          await recordOverviewPhysicalEvidence(
            testCase.label,
            testCase,
            { current: actualQuery!, legacy: legacyQuery! },
            d1.database,
          );
        }
      }
    } finally {
      d1.close();
    }
  });

  it("matches row-local payload overview filters and their bounded public SQL", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const insertPath = d1.database.prepare(
      "INSERT INTO custom_event_json_paths (id, site_id, path) VALUES (?, ?, ?)",
    );
    const insertPayload = d1.database.prepare(
      `INSERT INTO custom_event_json_values (
        event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
        value_type, string_value, number_value, boolean_value
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'budget-value', NULL, NULL)`,
    );
    for (let index = 1; index <= 46; index += 1) {
      const pathId = index + 1;
      insertPath.run(pathId, siteId, overviewBudgetPayloadPath(index));
      for (const [eventPk, eventNameId] of [
        [1, 1],
        [99, 99],
      ] as const)
        insertPayload.run(
          eventPk,
          eventPk * 1_000 + pathId,
          siteId,
          eventNameId,
          pathId,
          eventTime,
        );
    }

    const cases = [
      ...[0, 1, 7, 16].flatMap((count) =>
        [true, false].map((includeBreakdowns) => ({
          label: `payload-${count}-breakdowns-${includeBreakdowns}`,
          filters: overviewBudgetPayloadFilters(count),
          eventName,
          includeBreakdowns,
        })),
      ),
      ...[40, 46].map((count) => ({
        label: `payload-${count}-breakdowns-true`,
        filters: overviewBudgetPayloadFilters(count),
        eventName,
        includeBreakdowns: true,
      })),
      {
        label: "payload-40-and-country",
        filters: truthFilters({
          kind: "and",
          children: [
            ...Array.from({ length: 40 }, (_, index) =>
              overviewBudgetPayloadCondition(index + 1),
            ),
            truthCondition("geo.country", "CN"),
          ],
        }),
        eventName,
        includeBreakdowns: true,
      },
      {
        label: "payload-not",
        filters: truthFilters({
          kind: "not",
          child: overviewBudgetPayloadCondition(47),
        }),
        eventName,
        includeBreakdowns: true,
      },
      {
        label: "payload-or",
        filters: truthFilters({
          kind: "or",
          children: [
            overviewBudgetPayloadCondition(1),
            overviewBudgetPayloadCondition(2),
          ],
        }),
        eventName,
        includeBreakdowns: true,
      },
      {
        label: "payload-7-padded-raw-name",
        filters: overviewBudgetPayloadFilters(7),
        eventName: " outbound_click ",
        includeBreakdowns: true,
      },
      {
        label: "payload-1-empty-name",
        filters: overviewBudgetPayloadFilters(1),
        eventName: "",
        includeBreakdowns: false,
      },
    ] as const;

    try {
      for (const testCase of cases) {
        const before = d1.calls.length;
        const options = { includeBreakdowns: testCase.includeBreakdowns };
        const actual = await queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          testCase.filters,
          testCase.eventName,
          options,
        );
        const actualQuery = d1.calls[before];
        const expected = await queryLegacyEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          testCase.filters,
          testCase.eventName,
          options,
        );
        const legacyQuery = d1.calls[before + 1];

        expect(actual, testCase.label).toEqual(expected);
        const expectedNamedEvents =
          testCase.eventName === ""
            ? 2
            : testCase.label === "payload-7-padded-raw-name"
              ? 0
              : 1;
        expect(actual.summary.events, testCase.label).toBe(expectedNamedEvents);
        expect(actual.summary.shareOfAllEvents, testCase.label).toBe(
          testCase.eventName === ""
            ? 1
            : testCase.label === "payload-7-padded-raw-name"
              ? 0
              : 0.5,
        );
        expect(d1.calls).toHaveLength(before + 2);
        for (const query of [actualQuery!, legacyQuery!]) {
          expect(query.bindings.length, testCase.label).toBeLessThanOrEqual(
            100,
          );
          expect(
            new TextEncoder().encode(query.sql).byteLength,
            testCase.label,
          ).toBeLessThan(100_000);
        }
        console.info(
          `[Wave42 event-type overview public SQL budget] ${JSON.stringify({
            case: testCase.label,
            new: {
              sqlUtf8Bytes: new TextEncoder().encode(actualQuery!.sql)
                .byteLength,
              bindings: actualQuery!.bindings.length,
            },
            frozenLegacy: {
              sqlUtf8Bytes: new TextEncoder().encode(legacyQuery!.sql)
                .byteLength,
              bindings: legacyQuery!.bindings.length,
            },
          })}`,
        );
        if (
          testCase.label === "payload-40-breakdowns-true" ||
          testCase.label === "payload-46-breakdowns-true" ||
          testCase.label === "payload-40-and-country"
        ) {
          await recordOverviewPhysicalEvidence(
            testCase.label,
            testCase,
            { current: actualQuery!, legacy: legacyQuery! },
            d1.database,
          );
        }
      }

      const payloadAndSessionBoundary = truthFilters({
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "event-payload", path: "/href" as never },
            operator: "eq",
            value: "https://example.test/next",
          },
          recordFieldFilter("session.entryPath", "eq", "/entry").root!,
        ],
      });
      const actualPayloadAndSessionBoundary =
        await queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          payloadAndSessionBoundary,
          eventName,
          { includeBreakdowns: false },
        );
      const expectedPayloadAndSessionBoundary =
        await queryLegacyEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          payloadAndSessionBoundary,
          eventName,
          { includeBreakdowns: false },
        );
      expect(actualPayloadAndSessionBoundary).toEqual(
        expectedPayloadAndSessionBoundary,
      );
      expect(actualPayloadAndSessionBoundary.summary.events).toBe(1);

      const preparedFacts = preparedOverviewFilters(
        recordFieldFilter("session.events", "gte", 2),
        "event",
      );
      const preparedBoundary = preparedOverviewFilters(
        filterFixture({ entry: "/entry" }),
        "event",
      );
      for (const [label, filters] of [
        ["session-fact", preparedFacts.filters!],
        ["session-boundary", preparedBoundary.filters!],
      ] as const) {
        const actual = await queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          filters,
          eventName,
          { includeBreakdowns: false },
        );
        const expected = await queryLegacyEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          filters,
          eventName,
          { includeBreakdowns: false },
        );
        expect(actual, label).toEqual(expected);
      }
    } finally {
      d1.close();
    }
  });

  it("lowers logical NULL literals without changing their nullable SQL behavior", () => {
    const { d1 } = createSqliteEventEnv();
    const context = createEventReportSourceContext({
      siteId,
      queryTime: queryWindowToTime(window),
      filters: EMPTY_FILTER_DOCUMENT,
    });
    const builder = context.builder;
    const events = builder.source("event", {
      temporalDomain: "candidate",
      attributes: ["event.report.eventName"],
    });
    const eventNameValue = builder.slot(
      events,
      "attribute:event.report.eventName",
    );
    const nullString = builder.literal(null, {
      kind: "scalar",
      scalar: "string",
    });
    const direct = builder.project(events, {
      nullValue: nullString,
      comparisonNull: builder.compare("eq", nullString, nullString),
      caseValue: builder.caseWhen(
        [
          {
            when: builder.compare(
              "eq",
              eventNameValue,
              builder.literal(eventName, {
                kind: "scalar",
                scalar: "string",
              }),
            ),
            then: nullString,
          },
        ],
        builder.literal("other", { kind: "scalar", scalar: "string" }),
      ),
      coalesced: builder.coalesce(
        nullString,
        builder.literal("fallback", { kind: "scalar", scalar: "string" }),
      ),
    });
    builder.output("null-expression-contract", direct, [
      { name: "nullValue", slot: "nullValue" },
      { name: "comparisonNull", slot: "comparisonNull" },
      { name: "caseValue", slot: "caseValue" },
      { name: "coalesced", slot: "coalesced" },
    ]);
    const distinctNull = builder.aggregate(events, {}, [
      {
        name: "countNull",
        kind: "count-distinct",
        expression: nullString,
      },
    ]);
    builder.output("null-distinct-count", distinctNull, [
      { name: "countNull", slot: "countNull" },
    ]);
    const plan = builder.finish();
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId,
      time: plan.context.time,
    });
    const lowered = lowerer.lowerMany(plan.outputs);
    const [expressionOutput, countOutput] = plan.outputs;
    const expressionResult = lowerer.projectOutput(
      lowered[0]!,
      expressionOutput!.fields.map(({ name, slot }) => ({ name, slot })),
    );
    const countResult = lowerer.projectOutput(
      lowered[1]!,
      countOutput!.fields.map(({ name, slot }) => ({ name, slot })),
    );
    const expressionQuery = compileD1Query(lowerLogicalPlan(expressionResult));
    const countQuery = compileD1Query(lowerLogicalPlan(countResult));

    try {
      expect(
        plan.slots.find(({ id }) => id === direct.slots.nullValue)?.nullable,
      ).toBe(true);
      expect(expressionQuery.bindings).not.toContain(null);
      expect(countQuery.bindings).not.toContain(null);
      const expressionRows = d1.database
        .prepare(expressionQuery.sql)
        .all(...((expressionQuery.bindings ?? []) as SQLInputValue[]));
      expect(expressionRows).toHaveLength(2);
      expect(expressionRows).toContainEqual({
        nullValue: null,
        comparisonNull: null,
        caseValue: null,
        coalesced: "fallback",
      });
      expect(expressionRows).toContainEqual({
        nullValue: null,
        comparisonNull: null,
        caseValue: "other",
        coalesced: "fallback",
      });
      expect(
        d1.database
          .prepare(countQuery.sql)
          .get(...((countQuery.bindings ?? []) as SQLInputValue[])),
      ).toEqual({ countNull: 0 });
    } finally {
      d1.close();
    }
  });

  it("preserves raw, empty, and prepared event-name gates", async () => {
    const { env, d1 } = createSqliteEventEnv();
    d1.database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
      )
      .run(200, siteId, "   ");
    d1.database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name) VALUES (?, ?, ?)",
      )
      .run(201, siteId, " outbound_click ");
    const insert = d1.database.prepare(
      "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      200,
      "event-blank-name",
      siteId,
      "visit-1",
      200,
      eventTime,
      eventTime,
      3,
      1,
      1,
      null,
    );
    insert.run(
      201,
      "event-padded-name",
      siteId,
      "visit-1",
      201,
      eventTime,
      eventTime,
      4,
      1,
      1,
      null,
    );
    const prepared = preparedOverviewFilters(EMPTY_FILTER_DOCUMENT, "event");

    try {
      const scenarios = [
        { filters: EMPTY_FILTER_DOCUMENT, eventName: "" },
        { filters: EMPTY_FILTER_DOCUMENT, eventName: " outbound_click " },
        { filters: prepared.filters!, eventName: "" },
        { filters: prepared.filters!, eventName: " outbound_click " },
      ] as const;
      for (const scenario of scenarios) {
        const actual = await queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          scenario.filters,
          scenario.eventName,
        );
        const expected = await queryLegacyEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          scenario.filters,
          scenario.eventName,
        );
        expect(actual).toEqual(expected);
      }

      expect(
        await queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          "",
        ),
      ).toMatchObject({ summary: { events: 4, eventTypes: 4 } });
      expect(
        await queryEventTypeOverviewFromD1(
          env,
          siteId,
          window,
          prepared.filters!,
          "",
        ),
      ).toMatchObject({ summary: { events: 1, eventTypes: 1 } });
    } finally {
      d1.close();
    }
  });

  it("keeps the raw no-filter denominator and 128-identity prepared budget", async () => {
    const { env, d1 } = createSqliteEventEnv();
    d1.database
      .prepare(
        "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        300,
        "event-without-owner-or-name-row",
        siteId,
        "missing-visit",
        9999,
        eventTime,
        eventTime,
        5,
        1,
        1,
        null,
      );
    const overviewIdentityIds = [
      "event-1",
      ...Array.from({ length: 127 }, (_, index) => `event-advanced-${index}`),
    ];
    const advancedEvents = d1.database.prepare(
      "INSERT INTO custom_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    overviewIdentityIds
      .slice(1)
      .forEach((id, index) =>
        advancedEvents.run(
          1000 + index,
          id,
          siteId,
          "visit-1",
          1,
          eventTime,
          eventTime,
          10 + index,
          1,
          1,
          null,
        ),
      );

    try {
      const rawActual = await queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        eventName,
        { includeBreakdowns: false },
      );
      const rawExpected = await queryLegacyEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        EMPTY_FILTER_DOCUMENT,
        eventName,
        { includeBreakdowns: false },
      );
      expect(rawActual).toEqual(rawExpected);
      expect(rawActual.summary.shareOfAllEvents).toBe(128 / 130);

      const prepared = preparedEventRecordFilters(
        EMPTY_FILTER_DOCUMENT,
        "event",
      );
      const metadata = scopedFilterMetadata(prepared.filters!)!;
      const identityFilters = attachScopedFilterMetadata(prepared.filters!, {
        ...metadata,
        plan: {
          ...prepared.scopePlan!,
          advancedMatches: {
            eventIds: [...overviewIdentityIds.map((id) => ({ siteId, id }))],
          },
        },
      });
      const identityStart = d1.calls.length;
      const identityActual = await queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        identityFilters,
        eventName,
        { includeBreakdowns: false },
      );
      const identityQuery = d1.calls[identityStart];
      let legacyIdentityBindings = 0;
      let legacyIdentityStatement:
        { sql: string; bindings: Binding[] } | undefined;
      const identityExpected = await queryLegacyEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        identityFilters,
        eventName,
        { includeBreakdowns: false },
        async (sql, bindings) => {
          legacyIdentityBindings = bindings.length;
          legacyIdentityStatement = { sql, bindings: [...bindings] };
          return d1.database.prepare(sql).all(...bindings) as never;
        },
      );
      expect(identityActual).toEqual(identityExpected);
      expect(legacyIdentityBindings).toBeGreaterThan(100);
      expect(identityActual.summary).toMatchObject({
        events: 128,
        eventTypes: 1,
        shareOfAllEvents: 1,
      });
      expect(d1.calls).toHaveLength(identityStart + 1);
      expect(identityQuery?.bindings.length).toBeLessThanOrEqual(100);
      expect(
        new TextEncoder().encode(identityQuery!.sql).byteLength,
      ).toBeLessThan(100_000);
      expect(legacyIdentityStatement).toBeDefined();
      await recordOverviewPhysicalEvidence(
        "prepared-advanced-128-identities",
        { filters: identityFilters, eventName, includeBreakdowns: false },
        { current: identityQuery!, legacy: legacyIdentityStatement! },
        d1.database,
      );

      const emptyIdentities = attachScopedFilterMetadata(prepared.filters!, {
        ...metadata,
        plan: {
          ...prepared.scopePlan!,
          advancedMatches: { eventIds: [] },
        },
      });
      const emptyStart = d1.calls.length;
      const emptyActual = await queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        emptyIdentities,
        eventName,
        { includeBreakdowns: false },
      );
      const emptyQuery = d1.calls[emptyStart];
      const emptyExpected = await queryLegacyEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        emptyIdentities,
        eventName,
        { includeBreakdowns: false },
      );
      expect(emptyActual).toEqual(emptyExpected);
      expect(emptyActual.summary).toMatchObject({
        events: 0,
        shareOfAllEvents: 0,
      });
      expect(d1.calls).toHaveLength(emptyStart + 2);
      expect(emptyQuery?.bindings.length).toBeLessThanOrEqual(100);
    } finally {
      d1.close();
    }
  });

  it("keeps the scoped event source when overview filters affect share metrics", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      await queryEventTypeOverviewFromD1(
        env,
        siteId,
        window,
        filterFixture({ path: "/posts/minecraft-meteor-guide" }),
        eventName,
        { includeBreakdowns: false },
      );

      const query = d1.calls.at(-1);
      expect(query?.sql).toContain('"scopedEvents"');
      expect(query?.bindings).toEqual(
        expect.arrayContaining(["/posts/minecraft-meteor-guide"]),
      );
    } finally {
      d1.close();
    }
  });

  it("keeps complete journey aggregates after a visit filter matches", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      d1.database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, visitor_id, session_id, started_at, pathname
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "visit-other-session",
          siteId,
          "visitor-1",
          "session-2",
          eventTime + 2,
          "/other",
        );

      const filter = filterFixture({ path: "/posts/minecraft-meteor-guide" });
      const sessionFilters = preparedJourneyFilters("sessions", filter);
      const visitorFilters = preparedJourneyFilters("visitors", filter);
      const sessions = await querySessionsFromD1(
        env,
        siteId,
        window,
        sessionFilters,
        10,
      );
      const visitors = await queryVisitorsFromD1(
        env,
        siteId,
        window,
        visitorFilters,
        10,
      );
      const sessionPage = await querySessionListPageFromD1(
        env,
        siteId,
        window,
        sessionFilters,
        {
          limit: 10,
          sort: { key: "startedAt", direction: "asc" },
        },
      );
      const visitorPage = await queryVisitorListPageFromD1(
        env,
        siteId,
        window,
        visitorFilters,
        {
          limit: 10,
          sort: { key: "firstSeenAt", direction: "asc" },
        },
      );

      expect(sessions).toMatchObject([
        {
          sessionId: "session-1",
          views: 3,
          entryPath: "/entry",
          exitPath: "/exit",
        },
      ]);
      expect(visitors).toMatchObject([
        {
          visitorId: "visitor-1",
          views: 4,
          sessions: 2,
          firstSeenAt: eventTime - 2,
          lastSeenAt: eventTime + 2,
        },
      ]);
      expect(sessionPage.rows).toEqual(sessions);
      expect(visitorPage.rows).toEqual(visitors);
    } finally {
      d1.close();
    }
  });

  it("applies generic event filters to journey entities", async () => {
    const { env, d1 } = createSqliteEventEnv();
    const filters = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "and",
          children: [
            {
              kind: "condition",
              target: { kind: "field", field: "event.name" },
              operator: "eq",
              value: eventName,
            },
            {
              kind: "condition",
              target: { kind: "event-payload", path: "/href" },
              operator: "contains",
              value: "example.test",
            },
          ],
        },
      },
      analyticsFilterRegistry,
    );

    try {
      const sessionFilters = preparedJourneyFilters("sessions", filters);
      const visitorFilters = preparedJourneyFilters("visitors", filters);
      const [sessions, visitors] = await Promise.all([
        querySessionsFromD1(env, siteId, window, sessionFilters, 10),
        queryVisitorsFromD1(env, siteId, window, visitorFilters, 10),
      ]);

      expect(sessions).toMatchObject([{ sessionId: "session-1", views: 3 }]);
      expect(visitors).toMatchObject([
        { visitorId: "visitor-1", views: 3, sessions: 1 },
      ]);
      expect(d1.calls.every(({ sql }) => sql.includes("EXISTS ("))).toBe(true);
      expect(
        d1.calls.every(
          ({ sql }) =>
            sql.includes('FROM "custom_events"') &&
            sql.includes("event_name_id"),
        ),
      ).toBe(true);
      expect(
        d1.calls.every(
          ({ sql }) =>
            sql.includes('"custom_event_names"') && sql.includes("event_pk"),
        ),
      ).toBe(true);
      expect(
        d1.calls.every(
          ({ sql }) =>
            !sql.includes("event_filter_source") &&
            !sql.includes("visit_source.event_name"),
        ),
      ).toBe(true);
    } finally {
      d1.close();
    }
  });

  it("keeps the original journey aggregation path without filters", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      await querySessionsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 10);
      expect(d1.calls.at(-1)?.sql).not.toContain("matched_sessions AS");

      await queryVisitorsFromD1(env, siteId, window, EMPTY_FILTER_DOCUMENT, 10);
      expect(d1.calls.at(-1)?.sql).not.toContain("matched_visitors AS");
    } finally {
      d1.close();
    }
  });

  it("matches Journey offset ordering with keyset pages for every list sort", async () => {
    const { env, d1 } = createSqliteEventEnv();

    try {
      for (const [visitId, visitorId, sessionId, startedAt] of [
        ["visit-2", "visitor-2", "session-2", eventTime],
        ["visit-3", "visitor-2", "session-2", eventTime + 2],
        ["visit-4", "visitor-3", "session-3", eventTime + 2],
      ] as const) {
        d1.database
          .prepare(
            `INSERT INTO visits (
              visit_id, site_id, visitor_id, session_id, started_at, pathname
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(visitId, siteId, visitorId, sessionId, startedAt, "/pricing");
      }

      for (const sort of [
        { key: "firstSeenAt", direction: "asc" },
        { key: "firstSeenAt", direction: "desc" },
        { key: "lastSeenAt", direction: "asc" },
        { key: "lastSeenAt", direction: "desc" },
        { key: "sessions", direction: "asc" },
        { key: "sessions", direction: "desc" },
        { key: "views", direction: "asc" },
        { key: "views", direction: "desc" },
      ] as const) {
        const expected = await queryVisitorsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          20,
          undefined,
          sort,
        );
        const received = [];
        let cursor = null;
        do {
          const page = await queryVisitorListPageFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            { limit: 2, sort, cursor },
          );
          received.push(...page.rows);
          cursor = page.nextCursor;
        } while (cursor);
        expect(received.map((row) => row.visitorId)).toEqual(
          expected.map((row) => row.visitorId),
        );
      }

      for (const sort of [
        { key: "startedAt", direction: "asc" },
        { key: "startedAt", direction: "desc" },
        { key: "durationMs", direction: "asc" },
        { key: "durationMs", direction: "desc" },
        { key: "views", direction: "asc" },
        { key: "views", direction: "desc" },
      ] as const) {
        const expected = await querySessionsFromD1(
          env,
          siteId,
          window,
          EMPTY_FILTER_DOCUMENT,
          20,
          undefined,
          sort,
        );
        const received = [];
        let cursor = null;
        do {
          const page = await querySessionListPageFromD1(
            env,
            siteId,
            window,
            EMPTY_FILTER_DOCUMENT,
            { limit: 2, sort, cursor },
          );
          received.push(...page.rows);
          cursor = page.nextCursor;
        } while (cursor);
        expect(received.map((row) => row.sessionId)).toEqual(
          expected.map((row) => row.sessionId),
        );
      }

      const cursorQuery = d1.calls.at(-1);
      expect(cursorQuery?.sql).not.toContain("OFFSET");
      const plan = d1.database
        .prepare(`EXPLAIN QUERY PLAN ${cursorQuery?.sql ?? "SELECT 1"}`)
        .all(...sqliteBindings(cursorQuery?.bindings ?? []));
      expect(plan.length).toBeGreaterThan(0);
    } finally {
      d1.close();
    }
  });

  it("freezes the four final relations for cross-observation filter semantics", () => {
    const { d1 } = createSqliteEventEnv();
    seedFilterSemanticsTruthFixture(d1);

    const page = truthCondition("page.path", "/pricing");
    const purchase = truthCondition("event.name", "truth_purchase");
    const pageAndPurchase: FilterExpression = {
      kind: "and",
      children: [page, purchase],
    };
    const pageOrPurchase: FilterExpression = {
      kind: "or",
      children: [page, purchase],
    };
    const notPurchase: FilterExpression = {
      kind: "not",
      child: purchase,
    };
    const eventAndPro: FilterExpression = {
      kind: "and",
      children: [
        truthCondition("event.name", "truth_other"),
        truthPayload("pro"),
      ],
    };

    try {
      expect(readTruthRelationIds(d1, page, "event")).toEqual({
        visits: [
          "truth-cross-pricing",
          "truth-multi-pricing",
          "truth-pricing",
          "truth-visitor-pricing",
        ],
        events: ["truth-purchase-outside"],
        sessions: [
          "truth-session-cross",
          "truth-session-multi",
          "truth-session-outside",
          "truth-session-pricing",
          "truth-session-visitor-a",
        ],
        visitors: [
          "truth-visitor-a",
          "truth-visitor-d",
          "truth-visitor-e",
          "truth-visitor-f",
          "truth-visitor-g",
        ],
      });
      expect(readTruthRelationIds(d1, purchase, "event")).toEqual({
        visits: [
          "truth-checkout",
          "truth-cross-event",
          "truth-home",
          "truth-visitor-event",
        ],
        events: [
          "truth-purchase-cross",
          "truth-purchase-free",
          "truth-purchase-home",
          "truth-purchase-outside",
          "truth-purchase-visitor",
        ],
        sessions: [
          "truth-session-checkout",
          "truth-session-cross",
          "truth-session-home",
          "truth-session-outside",
          "truth-session-visitor-b",
        ],
        visitors: [
          "truth-visitor-b",
          "truth-visitor-c",
          "truth-visitor-d",
          "truth-visitor-e",
          "truth-visitor-f",
        ],
      });
      expect(readTruthRelationIds(d1, pageAndPurchase, "event")).toEqual({
        visits: [],
        events: ["truth-purchase-outside"],
        sessions: ["truth-session-outside"],
        visitors: ["truth-visitor-d"],
      });
      expect(readTruthRelationIds(d1, pageOrPurchase, "event")).toEqual({
        visits: [
          "truth-checkout",
          "truth-cross-event",
          "truth-cross-pricing",
          "truth-home",
          "truth-multi-pricing",
          "truth-pricing",
          "truth-visitor-event",
          "truth-visitor-pricing",
        ],
        events: [
          "truth-purchase-cross",
          "truth-purchase-free",
          "truth-purchase-home",
          "truth-purchase-outside",
          "truth-purchase-visitor",
        ],
        sessions: [
          "truth-session-checkout",
          "truth-session-cross",
          "truth-session-home",
          "truth-session-multi",
          "truth-session-outside",
          "truth-session-pricing",
          "truth-session-visitor-a",
          "truth-session-visitor-b",
        ],
        visitors: [
          "truth-visitor-a",
          "truth-visitor-b",
          "truth-visitor-c",
          "truth-visitor-d",
          "truth-visitor-e",
          "truth-visitor-f",
          "truth-visitor-g",
        ],
      });
      expect(readTruthRelationIds(d1, notPurchase, "event")).toEqual({
        visits: ["truth-checkout"],
        events: ["truth-other-pro"],
        sessions: ["truth-session-checkout"],
        visitors: ["truth-visitor-c"],
      });
      expect(readTruthRelationIds(d1, eventAndPro, "event")).toEqual({
        visits: ["truth-checkout"],
        events: ["truth-other-pro"],
        sessions: ["truth-session-checkout"],
        visitors: ["truth-visitor-c"],
      });

      expect(readTruthRelationIds(d1, pageAndPurchase, "session")).toEqual({
        visits: ["truth-cross-event", "truth-cross-pricing"],
        events: ["truth-purchase-cross", "truth-purchase-outside"],
        sessions: ["truth-session-cross", "truth-session-outside"],
        visitors: ["truth-visitor-d", "truth-visitor-e"],
      });
      expect(readTruthRelationIds(d1, page, "session")).toEqual({
        visits: [
          "truth-cross-event",
          "truth-cross-pricing",
          "truth-multi-home",
          "truth-multi-pricing",
          "truth-pricing",
          "truth-visitor-pricing",
        ],
        events: ["truth-purchase-cross", "truth-purchase-outside"],
        sessions: [
          "truth-session-cross",
          "truth-session-multi",
          "truth-session-outside",
          "truth-session-pricing",
          "truth-session-visitor-a",
        ],
        visitors: [
          "truth-visitor-a",
          "truth-visitor-d",
          "truth-visitor-e",
          "truth-visitor-f",
          "truth-visitor-g",
        ],
      });
      expect(readTruthRelationIds(d1, notPurchase, "session")).toEqual({
        visits: [
          "truth-multi-home",
          "truth-multi-pricing",
          "truth-pricing",
          "truth-visitor-pricing",
        ],
        events: [],
        sessions: [
          "truth-session-multi",
          "truth-session-pricing",
          "truth-session-visitor-a",
        ],
        visitors: ["truth-visitor-a", "truth-visitor-f", "truth-visitor-g"],
      });

      const neq = readTruthRelationIds(
        d1,
        {
          kind: "condition",
          target: { kind: "field", field: "page.path" as never },
          operator: "neq",
          value: "/home",
        },
        "session",
      );
      const notEq = readTruthRelationIds(
        d1,
        {
          kind: "not",
          child: truthCondition("page.path", "/home"),
        },
        "session",
      );
      expect(neq.visits).toContain("truth-multi-pricing");
      expect(neq.sessions).toContain("truth-session-multi");
      expect(notEq.visits).not.toContain("truth-multi-pricing");
      expect(notEq.sessions).not.toContain("truth-session-multi");

      expect(readTruthRelationIds(d1, pageAndPurchase, "visitor")).toEqual({
        visits: [
          "truth-cross-event",
          "truth-cross-pricing",
          "truth-visitor-event",
          "truth-visitor-pricing",
        ],
        events: [
          "truth-purchase-cross",
          "truth-purchase-outside",
          "truth-purchase-visitor",
        ],
        sessions: [
          "truth-session-cross",
          "truth-session-outside",
          "truth-session-visitor-a",
          "truth-session-visitor-b",
        ],
        visitors: ["truth-visitor-d", "truth-visitor-e", "truth-visitor-f"],
      });
      expect(readTruthRelationIds(d1, notPurchase, "visitor")).toEqual({
        visits: ["truth-multi-home", "truth-multi-pricing", "truth-pricing"],
        events: [],
        sessions: ["truth-session-multi", "truth-session-pricing"],
        visitors: ["truth-visitor-a", "truth-visitor-g"],
      });
    } finally {
      d1.close();
    }
  });

  it("keeps audience adapters in filter-result parity", () => {
    const { d1 } = createSqliteEventEnv();
    seedFilterSemanticsTruthFixture(d1);

    try {
      const pageResults = (
        ["private-dashboard", "api-v1", "public-share"] as const
      ).map((audience) =>
        readTruthRelationIds(
          d1,
          truthCondition("page.path", "/pricing"),
          "event",
          audience,
        ),
      );
      expect(pageResults[1]).toEqual(pageResults[0]);
      expect(pageResults[2]).toEqual(pageResults[0]);
      expect(
        pageResults.map(({ visits, events, sessions, visitors }) => ({
          visits: visits.length,
          events: events.length,
          sessions: sessions.length,
          visitors: visitors.length,
        })),
      ).toEqual([
        { visits: 4, events: 1, sessions: 5, visitors: 5 },
        { visits: 4, events: 1, sessions: 5, visitors: 5 },
        { visits: 4, events: 1, sessions: 5, visitors: 5 },
      ]);

      const privateEvent = readTruthRelationIds(
        d1,
        truthCondition("event.name", "truth_purchase"),
        "event",
        "private-dashboard",
      );
      expect(
        readTruthRelationIds(
          d1,
          truthCondition("event.name", "truth_purchase"),
          "event",
          "api-v1",
        ),
      ).toEqual(privateEvent);
    } finally {
      d1.close();
    }
  });
});
