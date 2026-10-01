import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
} from "@/lib/edge/analytics/contract/types";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type {
  LogicalOutput,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { LogicalPlanError } from "@/lib/edge/analytics/engine/logical/validator";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import {
  AnalyticsLogicalToDbLowerer,
  AnalyticsRelationalLoweringError,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const SITE_A = "scalar-aggregation-a";
const SITE_B = "scalar-aggregation-b";
const EVENT_WINDOW = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 220,
  timeZone: "UTC",
} as const;
const PAGE_WINDOW = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 220,
  timeZone: "UTC",
} as const;
const STRING = { kind: "scalar", scalar: "string" } as const;
const NUMBER_MS = { kind: "scalar", scalar: "number", unit: "ms" } as const;

interface Site {
  readonly id: string;
  readonly pk: number;
}

let db: DatabaseSync;
let siteA: Site;
let siteB: Site;

function addSite(database: DatabaseSync, id: string): Site {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: Number(row.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  site: Site,
  input: {
    readonly id: string;
    readonly session: string;
    readonly visitor: string;
    readonly startedAt: number;
    readonly pathname: string;
    readonly title?: string;
    readonly hostname?: string;
    readonly durationMs?: number | null;
    readonly perfTtfbMs?: number | null;
    readonly perfCls?: number | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, duration_ms, pathname, hostname, title,
        perf_ttfb_ms, perf_cls, site_pk
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      site.id,
      input.visitor,
      input.session,
      input.startedAt,
      input.startedAt + 1,
      input.durationMs ?? null,
      input.pathname,
      input.hostname ?? "analytics.test",
      input.title ?? "",
      input.perfTtfbMs ?? null,
      input.perfCls ?? null,
      site.pk,
    );
}

function addName(
  database: DatabaseSync,
  site: Site,
  id: number,
  name: string,
): void {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(id, site.id, name, site.pk);
}

function addEvent(
  database: DatabaseSync,
  site: Site,
  input: {
    readonly id: string;
    readonly visitId: string;
    readonly nameId: number;
    readonly occurredAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, visit_id, event_name_id, occurred_at, received_at,
        node_count, value_count, site_pk
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
    )
    .run(
      input.id,
      site.id,
      input.visitId,
      input.nameId,
      input.occurredAt,
      input.occurredAt + 1,
      site.pk,
    );
}

function sqliteEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

function createBuilder(
  siteId: string,
  range: { readonly startMs: number; readonly endExclusiveMs: number },
): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [siteId as SiteId],
    }),
    time: createSemanticTemporalDomains({
      candidate: {
        startMs: range.startMs as EpochMs,
        endExclusiveMs: range.endExclusiveMs as EpochMs,
      },
      read: {
        kind: "bounded",
        range: {
          startMs: range.startMs as EpochMs,
          endExclusiveMs: range.endExclusiveMs as EpochMs,
        },
      },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 220 as EpochMs,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function eventReportAttribute(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  name: string,
) {
  return builder.slot(relation, `attribute:event.report.${name}`);
}

function pageReportAttribute(
  builder: LogicalPlanBuilder,
  relation: Parameters<LogicalPlanBuilder["slot"]>[0],
  name: string,
) {
  return builder.slot(relation, `attribute:page.report.${name}`);
}

function eventEligibility(builder: LogicalPlanBuilder) {
  const source = builder.source("event", {
    temporalDomain: "candidate",
    relationships: ["event.observation"],
    attributes: [
      "event.report.localId",
      "event.report.eventName",
      "event.report.occurredAt",
      "event.report.ownerPresent",
      "event.report.ownerSessionId",
      "event.report.ownerVisitorId",
      "event.report.ownerPathname",
      "event.report.ownerTitle",
      "event.report.ownerHostname",
    ],
  });
  const filtered = builder.filter(
    source,
    builder.and(
      eventReportAttribute(builder, source, "ownerPresent"),
      builder.isNull(eventReportAttribute(builder, source, "eventName"), true),
    ),
  );
  return filtered;
}

function addEventSummaryOutput(
  builder: LogicalPlanBuilder,
  source: ReturnType<typeof eventEligibility>,
  outputId: string,
  groupedBy?: { readonly name: string; readonly attribute: string },
): void {
  const empty = builder.literal("", STRING);
  const nullText = builder.literal(null, STRING);
  const eventName = eventReportAttribute(builder, source, "eventName");
  const sessionId = eventReportAttribute(builder, source, "ownerSessionId");
  const visitorId = eventReportAttribute(builder, source, "ownerVisitorId");
  const distinctSession = builder.caseWhen(
    [{ when: builder.compare("neq", sessionId, empty), then: sessionId }],
    nullText,
  );
  const distinctVisitor = builder.caseWhen(
    [{ when: builder.compare("neq", visitorId, empty), then: visitorId }],
    nullText,
  );
  const measures = groupedBy
    ? [
        { name: "views", kind: "count-rows" as const },
        {
          name: "sessions",
          kind: "count-distinct" as const,
          expression: distinctSession,
        },
        {
          name: "visitors",
          kind: "count-distinct" as const,
          expression: distinctVisitor,
        },
      ]
    : [
        { name: "views", kind: "count-rows" as const },
        {
          name: "eventTypes",
          kind: "count-distinct" as const,
          expression: eventName,
        },
        {
          name: "sessions",
          kind: "count-distinct" as const,
          expression: distinctSession,
        },
        {
          name: "visitors",
          kind: "count-distinct" as const,
          expression: distinctVisitor,
        },
      ];
  const groups = groupedBy
    ? {
        [groupedBy.name]: eventReportAttribute(
          builder,
          source,
          groupedBy.attribute,
        ),
      }
    : {};
  const aggregate = builder.aggregate(source, groups, measures);
  if (groupedBy) {
    builder.output(outputId, aggregate, [
      { name: "value", slot: groupedBy.name },
      { name: "views", slot: "views" },
      { name: "sessions", slot: "sessions" },
      { name: "visitors", slot: "visitors" },
    ]);
  } else {
    builder.output(outputId, aggregate, [
      { name: "events", slot: "views" },
      { name: "eventTypes", slot: "eventTypes" },
      { name: "sessions", slot: "sessions" },
      { name: "visitors", slot: "visitors" },
    ]);
  }
}

function buildEventSummaryPlan(): ValidatedLogicalPlan {
  const builder = createBuilder(SITE_A, EVENT_WINDOW);
  const source = eventEligibility(builder);
  addEventSummaryOutput(builder, source, "event-summary");
  return builder.finish();
}

function buildEventGroupPlan(
  group: "event" | "path" | "title" | "hostname",
): ValidatedLogicalPlan {
  const attributes = {
    event: "eventName",
    path: "ownerPathname",
    title: "ownerTitle",
    hostname: "ownerHostname",
  } as const;
  const builder = createBuilder(SITE_A, EVENT_WINDOW);
  const eligible = eventEligibility(builder);
  const field = eventReportAttribute(builder, eligible, attributes[group]);
  const nonBlank = builder.filter(
    eligible,
    builder.compare("neq", field, builder.literal("", STRING), "trim"),
  );
  const grouped = builder.aggregate(
    nonBlank,
    { value: eventReportAttribute(builder, nonBlank, attributes[group]) },
    [
      { name: "views", kind: "count-rows" },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: builder.caseWhen(
          [
            {
              when: builder.compare(
                "neq",
                eventReportAttribute(builder, nonBlank, "ownerSessionId"),
                builder.literal("", STRING),
              ),
              then: eventReportAttribute(builder, nonBlank, "ownerSessionId"),
            },
          ],
          builder.literal(null, STRING),
        ),
      },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: builder.caseWhen(
          [
            {
              when: builder.compare(
                "neq",
                eventReportAttribute(builder, nonBlank, "ownerVisitorId"),
                builder.literal("", STRING),
              ),
              then: eventReportAttribute(builder, nonBlank, "ownerVisitorId"),
            },
          ],
          builder.literal(null, STRING),
        ),
      },
    ],
  );
  builder.output(`event-group-${group}`, grouped, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}

function buildEventTuplePlan(): ValidatedLogicalPlan {
  const builder = createBuilder(SITE_A, EVENT_WINDOW);
  const source = eventEligibility(builder);
  const empty = builder.literal("", STRING);
  const nullText = builder.literal(null, STRING);
  const sessionId = eventReportAttribute(builder, source, "ownerSessionId");
  const visitorId = eventReportAttribute(builder, source, "ownerVisitorId");
  const grouped = builder.aggregate(
    source,
    {
      eventName: eventReportAttribute(builder, source, "eventName"),
      pathname: eventReportAttribute(builder, source, "ownerPathname"),
      title: eventReportAttribute(builder, source, "ownerTitle"),
      hostname: eventReportAttribute(builder, source, "ownerHostname"),
    },
    [
      { name: "views", kind: "count-rows" },
      {
        name: "sessions",
        kind: "count-distinct",
        expression: builder.caseWhen(
          [{ when: builder.compare("neq", sessionId, empty), then: sessionId }],
          nullText,
        ),
      },
      {
        name: "visitors",
        kind: "count-distinct",
        expression: builder.caseWhen(
          [{ when: builder.compare("neq", visitorId, empty), then: visitorId }],
          nullText,
        ),
      },
    ],
  );
  builder.output("event-tuple-primary", grouped, [
    { name: "value", slot: "eventName" },
    { name: "views", slot: "views" },
  ]);
  builder.output("event-tuple-context", grouped, [
    { name: "path", slot: "pathname" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}

const LEGACY_EVENT_FROM = `
FROM custom_events ce
INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
INNER JOIN visits v ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
WHERE ce.site_pk = ? AND ce.occurred_at >= ? AND ce.occurred_at < ?`;

const LEGACY_EVENT_SUMMARY_SQL = `
SELECT
  count(*) AS events,
  count(DISTINCT cen.name) AS eventTypes,
  count(DISTINCT CASE WHEN v.session_id != '' THEN v.session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN v.visitor_id != '' THEN v.visitor_id ELSE NULL END) AS visitors
${LEGACY_EVENT_FROM}`;

function legacyEventGroupRows(
  attribute: "eventName" | "pathname" | "title" | "hostname",
): Record<string, unknown>[] {
  const groupColumn = {
    eventName: "cen.name",
    pathname: "v.pathname",
    title: "v.title",
    hostname: "v.hostname",
  }[attribute];
  return db
    .prepare(
      `SELECT
         ${groupColumn} AS value,
         count(*) AS views,
         count(DISTINCT CASE WHEN v.session_id != '' THEN v.session_id ELSE NULL END) AS sessions,
         count(DISTINCT CASE WHEN v.visitor_id != '' THEN v.visitor_id ELSE NULL END) AS visitors
       ${LEGACY_EVENT_FROM}
       AND TRIM(COALESCE(${groupColumn}, '')) != ''
       GROUP BY ${groupColumn}
       ORDER BY value ASC`,
    )
    .all(siteA.pk, EVENT_WINDOW.startMs, EVENT_WINDOW.endExclusiveMs) as Record<
    string,
    unknown
  >[];
}

function legacyEventTupleRows(): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT
         cen.name AS eventName,
         v.pathname AS pathname,
         v.title AS title,
         v.hostname AS hostname,
         count(*) AS views,
         count(DISTINCT CASE WHEN v.session_id != '' THEN v.session_id ELSE NULL END) AS sessions,
         count(DISTINCT CASE WHEN v.visitor_id != '' THEN v.visitor_id ELSE NULL END) AS visitors
       ${LEGACY_EVENT_FROM}
       GROUP BY cen.name, v.pathname, v.title, v.hostname
       ORDER BY eventName, pathname, title, hostname`,
    )
    .all(siteA.pk, EVENT_WINDOW.startMs, EVENT_WINDOW.endExclusiveMs) as Record<
    string,
    unknown
  >[];
}

function buildPageNumericPlan(
  range: { readonly startMs: number; readonly endExclusiveMs: number },
  grouped: boolean,
): ValidatedLogicalPlan {
  const builder = createBuilder(SITE_A, range);
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: [
      "page.report.pathname",
      "page.report.durationMs",
      "page.report.perfTtfbMs",
      "page.report.perfCls",
    ],
  });
  const pathname = pageReportAttribute(builder, pages, "pathname");
  const duration = pageReportAttribute(builder, pages, "durationMs");
  const ttfb = pageReportAttribute(builder, pages, "perfTtfbMs");
  const cls = pageReportAttribute(builder, pages, "perfCls");
  const zeroMs = builder.literal(0, NUMBER_MS);
  const durationOrZero = builder.coalesce(duration, zeroMs);
  const nonEmptyPathDuration = builder.caseWhen(
    [
      {
        when: builder.compare("neq", pathname, builder.literal("", STRING)),
        then: durationOrZero,
      },
    ],
    zeroMs,
  );
  const aggregate = builder.aggregate(
    pages,
    grouped ? { path: pathname } : {},
    [
      { name: "views", kind: "count-rows" },
      { name: "sumDuration", kind: "sum", expression: duration },
      { name: "avgDuration", kind: "avg", expression: duration },
      { name: "minDuration", kind: "min", expression: duration },
      { name: "maxDuration", kind: "max", expression: duration },
      { name: "sumTtfb", kind: "sum", expression: ttfb },
      { name: "avgTtfb", kind: "avg", expression: ttfb },
      { name: "minCls", kind: "min", expression: cls },
      { name: "maxCls", kind: "max", expression: cls },
      {
        name: "sumPathDuration",
        kind: "sum",
        expression: nonEmptyPathDuration,
      },
    ],
  );
  builder.output(
    grouped ? "page-numeric-grouped" : "page-numeric-summary",
    aggregate,
    [
      ...(grouped ? [{ name: "path", slot: "path" }] : []),
      { name: "views", slot: "views" },
      { name: "sumDuration", slot: "sumDuration" },
      { name: "avgDuration", slot: "avgDuration" },
      { name: "minDuration", slot: "minDuration" },
      { name: "maxDuration", slot: "maxDuration" },
      { name: "sumTtfb", slot: "sumTtfb" },
      { name: "avgTtfb", slot: "avgTtfb" },
      { name: "minCls", slot: "minCls" },
      { name: "maxCls", slot: "maxCls" },
      { name: "sumPathDuration", slot: "sumPathDuration" },
    ],
  );
  return builder.finish();
}

function buildDurationGroupPlan(range: {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}): ValidatedLogicalPlan {
  const builder = createBuilder(SITE_A, range);
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: ["page.report.durationMs"],
  });
  const grouped = builder.aggregate(
    pages,
    { duration: pageReportAttribute(builder, pages, "durationMs") },
    [{ name: "views", kind: "count-rows" }],
  );
  builder.output("page-duration-groups", grouped, [
    { name: "duration", slot: "duration" },
    { name: "views", slot: "views" },
  ]);
  return builder.finish();
}

function buildScalarJoinPlan(
  range: { readonly startMs: number; readonly endExclusiveMs: number },
  filterNullSum = false,
): ValidatedLogicalPlan {
  const builder = createBuilder(SITE_A, range);
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: ["page.report.durationMs"],
  });
  const duration = pageReportAttribute(builder, pages, "durationMs");
  const leftAggregate = builder.aggregate(pages, {}, [
    { name: "sumDuration", kind: "sum", expression: duration },
    { name: "leftRows", kind: "count-rows" },
  ]);
  const rightAggregate = builder.aggregate(pages, {}, [
    { name: "avgDuration", kind: "avg", expression: duration },
    { name: "rightRows", kind: "count-rows" },
  ]);
  const left = filterNullSum
    ? builder.filter(
        leftAggregate,
        builder.isNull(builder.slot(leftAggregate, "sumDuration"), true),
      )
    : leftAggregate;
  const joined = builder.join(left, rightAggregate, []);
  builder.output("keyless-nullable-scalar-join", joined, [
    { name: "sumDuration", slot: "sumDuration" },
    { name: "leftRows", slot: "leftRows" },
    { name: "avgDuration", slot: "right.avgDuration" },
    { name: "rightRows", slot: "right.rightRows" },
  ]);
  return builder.finish();
}

function buildEntityAggregatePlan(
  kind: "group" | "count-distinct",
): ValidatedLogicalPlan {
  const builder = createBuilder(SITE_A, PAGE_WINDOW);
  const pages = builder.source("page", { temporalDomain: "candidate" });
  const entity = builder.slot(pages, "entity");
  const aggregate = builder.aggregate(
    pages,
    kind === "group" ? { page: entity } : {},
    kind === "count-distinct"
      ? [{ name: "pages", kind, expression: entity }]
      : [{ name: "pages", kind: "count-rows" }],
  );
  builder.output(
    `entity-${kind}`,
    aggregate,
    kind === "group"
      ? [{ name: "page", slot: "page" }]
      : [{ name: "pages", slot: "pages" }],
  );
  return builder.finish();
}

function buildUnknownMinPlan(): ValidatedLogicalPlan {
  const builder = createBuilder(SITE_A, PAGE_WINDOW);
  const pages = builder.source("page", { temporalDomain: "candidate" });
  const opaque = builder.literal("opaque", {
    kind: "scalar",
    scalar: "unknown",
  });
  const aggregate = builder.aggregate(pages, {}, [
    { name: "minimum", kind: "min", expression: opaque },
  ]);
  builder.output("unknown-minimum", aggregate, [
    { name: "minimum", slot: "minimum" },
  ]);
  return builder.finish();
}

function buildTextSumPlan(): ValidatedLogicalPlan {
  const builder = createBuilder(SITE_A, PAGE_WINDOW);
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: ["page.report.pathname"],
  });
  const pathname = pageReportAttribute(builder, pages, "pathname");
  const aggregate = builder.aggregate(pages, {}, [
    { name: "sumPath", kind: "sum", expression: pathname },
  ]);
  builder.output("text-sum", aggregate, [{ name: "sumPath", slot: "sumPath" }]);
  return builder.finish();
}

function outputById(
  plan: ValidatedLogicalPlan,
  outputId: string,
): LogicalOutput {
  const output = plan.outputs.find((candidate) => candidate.id === outputId);
  if (!output) throw new Error(`test_output_missing:${outputId}`);
  return output;
}

function compileOutput(
  plan: ValidatedLogicalPlan,
  outputId: string,
  lowerer: AnalyticsLogicalToDbLowerer,
) {
  const output = outputById(plan, outputId);
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  return compileD1Query(lowerLogicalPlan(relation), {
    tag: `test.wave23.${outputId}`,
  });
}

async function executeCompiled(
  database: DatabaseSync,
  query: ReturnType<typeof compileOutput>,
): Promise<Record<string, unknown>[]> {
  const result = await createD1DatabaseClient(
    createSqliteD1Database(database),
  ).all(query);
  return result.results.map((row) => Object.fromEntries(Object.entries(row)));
}

function sorted(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

async function measureOutput(
  plan: ValidatedLogicalPlan,
  outputId: string,
  operation: string,
): Promise<{
  readonly rows: Record<string, unknown>[];
  readonly trace: SqliteD1Trace;
  readonly observation: Record<string, unknown>;
}> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  const env = instrumentEnv(sqliteEnv(db, trace), logger);
  const rows = await runWithInvocationLogger(logger, () =>
    runWithD1Operation(operation, () =>
      queryAnalyticsReportOutputRowsFromD1(env, plan, outputId),
    ),
  );
  const emitted = await logger.emitWhenComplete();
  const entry = emitted.logs.find(
    (item) =>
      item.message === "db.query.v1.all.success" &&
      item.data?.tag === operation,
  );
  if (!entry?.data) throw new Error(`test_observation_missing:${operation}`);
  return { rows, trace, observation: entry.data as Record<string, unknown> };
}

function legacyPageNumericRows(
  range: { readonly startMs: number; readonly endExclusiveMs: number },
  grouped: boolean,
): Record<string, unknown>[] {
  const groupBy = grouped ? " GROUP BY pathname" : "";
  const pathProjection = grouped ? "pathname AS path, " : "";
  return db
    .prepare(
      `SELECT
         ${pathProjection}
         count(*) AS views,
         sum(duration_ms) AS sumDuration,
         avg(duration_ms) AS avgDuration,
         min(duration_ms) AS minDuration,
         max(duration_ms) AS maxDuration,
         sum(perf_ttfb_ms) AS sumTtfb,
         avg(perf_ttfb_ms) AS avgTtfb,
         min(perf_cls) AS minCls,
         max(perf_cls) AS maxCls,
         sum(CASE WHEN pathname != '' THEN COALESCE(duration_ms, 0) ELSE 0 END) AS sumPathDuration
       FROM visits
       WHERE site_pk = ? AND started_at >= ? AND started_at < ?${groupBy}
       ${grouped ? "ORDER BY path" : ""}`,
    )
    .all(siteA.pk, range.startMs, range.endExclusiveMs) as Record<
    string,
    unknown
  >[];
}

function seed(database: DatabaseSync): {
  readonly siteA: Site;
  readonly siteB: Site;
} {
  const a = addSite(database, SITE_A);
  const b = addSite(database, SITE_B);
  addName(database, a, 1, "Open");
  addName(database, a, 2, "open");
  addName(database, a, 3, "雪");
  addName(database, a, 4, "   ");
  addName(database, b, 100, "Foreign dictionary name");

  addVisit(database, a, {
    id: "event-owner-a",
    session: " S ",
    visitor: "User",
    startedAt: 10,
    pathname: "/same",
    title: "Shared title",
    hostname: "same.test",
  });
  addVisit(database, a, {
    id: "event-owner-b",
    session: "s",
    visitor: "user",
    startedAt: 11,
    pathname: "/same",
    title: "Shared title",
    hostname: "same.test",
  });
  addVisit(database, a, {
    id: "event-owner-c",
    session: "S",
    visitor: "User",
    startedAt: 12,
    pathname: "/case",
    title: "Case title",
    hostname: "case.test",
  });
  addVisit(database, a, {
    id: "event-owner-d",
    session: "雪",
    visitor: "用户",
    startedAt: 13,
    pathname: "/雪",
    title: "雪 title",
    hostname: "雪.test",
  });
  addVisit(database, a, {
    id: "event-owner-e",
    session: "",
    visitor: " ",
    startedAt: 14,
    pathname: "   ",
    title: "   ",
    hostname: "   ",
  });
  addVisit(database, a, {
    id: "event-owner-f",
    session: " ",
    visitor: "Visitor",
    startedAt: 15,
    pathname: "/foreign-name",
    title: "Foreign title",
    hostname: "foreign.test",
  });
  addVisit(database, b, {
    id: "foreign-owner",
    session: "foreign-session",
    visitor: "foreign-visitor",
    startedAt: 16,
    pathname: "/foreign-owner",
  });

  addEvent(database, a, {
    id: "event-open-first",
    visitId: "event-owner-a",
    nameId: 1,
    occurredAt: 100,
  });
  addEvent(database, a, {
    id: "event-open-repeat",
    visitId: "event-owner-a",
    nameId: 1,
    occurredAt: 110,
  });
  addEvent(database, a, {
    id: "event-open-second-session",
    visitId: "event-owner-b",
    nameId: 1,
    occurredAt: 120,
  });
  addEvent(database, a, {
    id: "event-case-name",
    visitId: "event-owner-c",
    nameId: 2,
    occurredAt: 130,
  });
  addEvent(database, a, {
    id: "event-unicode-name",
    visitId: "event-owner-d",
    nameId: 3,
    occurredAt: 140,
  });
  addEvent(database, a, {
    id: "event-whitespace-name",
    visitId: "event-owner-e",
    nameId: 4,
    occurredAt: 150,
  });
  addEvent(database, a, {
    id: "event-foreign-dictionary",
    visitId: "event-owner-f",
    nameId: 100,
    occurredAt: 160,
  });
  addEvent(database, a, {
    id: "event-missing-dictionary",
    visitId: "event-owner-a",
    nameId: 999,
    occurredAt: 170,
  });
  addEvent(database, a, {
    id: "event-orphan-owner",
    visitId: "missing-owner",
    nameId: 1,
    occurredAt: 175,
  });
  addEvent(database, a, {
    id: "event-cross-site-owner",
    visitId: "foreign-owner",
    nameId: 1,
    occurredAt: 180,
  });
  addEvent(database, a, {
    id: "event-at-end",
    visitId: "event-owner-a",
    nameId: 1,
    occurredAt: 200,
  });

  addVisit(database, a, {
    id: "page-numeric-zero",
    session: "page-session",
    visitor: "page-visitor",
    startedAt: 120,
    pathname: "/numeric/a",
    durationMs: 0,
    perfTtfbMs: 0,
    perfCls: 0,
  });
  addVisit(database, a, {
    id: "page-numeric-positive",
    session: "page-session",
    visitor: "page-visitor",
    startedAt: 130,
    pathname: "/numeric/a",
    durationMs: 50,
    perfTtfbMs: 10,
    perfCls: 0.5,
  });
  addVisit(database, a, {
    id: "page-numeric-negative",
    session: "page-session-negative",
    visitor: "page-visitor-negative",
    startedAt: 140,
    pathname: "/numeric/b",
    durationMs: -5,
    perfTtfbMs: -2,
    perfCls: -0.2,
  });
  addVisit(database, a, {
    id: "page-numeric-null-a",
    session: "page-session-null",
    visitor: "page-visitor-null",
    startedAt: 150,
    pathname: "/all-null",
  });
  addVisit(database, a, {
    id: "page-numeric-null-b",
    session: "page-session-null",
    visitor: "page-visitor-null",
    startedAt: 160,
    pathname: "/all-null",
  });
  addVisit(database, a, {
    id: "page-numeric-empty-path",
    session: "page-session-empty-path",
    visitor: "page-visitor-empty-path",
    startedAt: 170,
    pathname: "",
    durationMs: 5,
    perfTtfbMs: 1,
    perfCls: 0.1,
  });
  addVisit(database, a, {
    id: "page-at-end",
    session: "page-session-end",
    visitor: "page-visitor-end",
    startedAt: 200,
    pathname: "/end",
    durationMs: 999,
    perfTtfbMs: 999,
    perfCls: 9,
  });

  database.exec("ANALYZE");
  return { siteA: a, siteB: b };
}

beforeAll(() => {
  db = createMigratedDatabase();
  db.exec("PRAGMA foreign_keys = OFF");
  ({ siteA, siteB } = seed(db));
});

afterAll(() => db.close());

describe("shared scalar aggregate lowering", () => {
  it("matches Event summary and each production card grouping shape", async () => {
    const summary = await measureOutput(
      buildEventSummaryPlan(),
      "event-summary",
      "analytics.wave23.event-summary",
    );
    const legacySummary = db
      .prepare(LEGACY_EVENT_SUMMARY_SQL)
      .get(siteA.pk, EVENT_WINDOW.startMs, EVENT_WINDOW.endExclusiveMs);
    expect(summary.rows).toEqual([legacySummary]);
    expect(summary.trace.preparedSql).toHaveLength(1);
    expect(summary.observation).toMatchObject({
      tag: "analytics.wave23.event-summary",
      operation: "all",
      status: "success",
      sqlBytes: new TextEncoder().encode(summary.trace.preparedSql[0]!)
        .byteLength,
      bindings: summary.trace.bindings[0]!.length,
      physicalPlanHash: expect.stringMatching(/^v1:/u),
    });
    expect(summary.trace.preparedSql).toHaveLength(1);
    expect(summary.trace.bindings).toHaveLength(1);
    expect(summary.trace.bindings[0]).toHaveLength(
      summary.observation.bindings as number,
    );
    expect(summary.observation.sqlBytes as number).toBeLessThanOrEqual(
      D1_MAX_SQL_UTF8_BYTES,
    );
    expect(summary.observation.bindings as number).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const summaryExplain = explainQueryPlan(db, {
      sql: summary.trace.preparedSql[0]!,
      bindings: summary.trace.bindings[0]!,
    }).join("\n");
    expect(summaryExplain).toContain("idx_custom_events_site_pk_time");
    expect(summaryExplain).toContain(
      "SEARCH t2 USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN",
    );
    expect(summaryExplain).toContain("sqlite_autoindex_visits_1");

    const groups = [
      ["event", "eventName"],
      ["path", "pathname"],
      ["title", "title"],
      ["hostname", "hostname"],
    ] as const;
    for (const [group, column] of groups) {
      const result = await measureOutput(
        buildEventGroupPlan(group),
        `event-group-${group}`,
        `analytics.wave23.event-group.${group}`,
      );
      expect(sorted(result.rows)).toEqual(sorted(legacyEventGroupRows(column)));
      expect(result.trace.preparedSql).toHaveLength(1);
      expect(
        new TextEncoder().encode(result.trace.preparedSql[0]!).byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(result.trace.bindings[0]!.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    }
  });

  it("keeps tuple grain and output-specific measure layouts across outputs", async () => {
    const plan = buildEventTuplePlan();
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE_A,
      time: plan.context.time,
    });
    const firstQuery = compileOutput(plan, "event-tuple-primary", lowerer);
    const firstRows = await executeCompiled(db, firstQuery);
    const secondQuery = compileOutput(plan, "event-tuple-context", lowerer);
    const secondRows = await executeCompiled(db, secondQuery);
    const legacy = legacyEventTupleRows();
    expect(sorted(firstRows)).toEqual(
      sorted(
        legacy.map(({ eventName, views }) => ({ value: eventName, views })),
      ),
    );
    expect(sorted(secondRows)).toEqual(
      sorted(
        legacy.map(({ pathname, sessions, visitors }) => ({
          path: pathname,
          sessions,
          visitors,
        })),
      ),
    );
    expect(firstQuery.sql).not.toBe(secondQuery.sql);
    expect(
      new TextEncoder().encode(firstQuery.sql).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(
      new TextEncoder().encode(secondQuery.sql).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
  });

  it("matches Page SUM/AVG/MIN/MAX, nullable groups, zero/negative values and empty inputs", async () => {
    const groupedPlan = buildPageNumericPlan(PAGE_WINDOW, true);
    const grouped = await measureOutput(
      groupedPlan,
      "page-numeric-grouped",
      "analytics.wave23.page-numeric-grouped",
    );
    expect(sorted(grouped.rows)).toEqual(
      sorted(legacyPageNumericRows(PAGE_WINDOW, true)),
    );
    expect(grouped.trace.preparedSql).toHaveLength(1);
    expect(grouped.observation).toMatchObject({
      tag: "analytics.wave23.page-numeric-grouped",
      operation: "all",
      status: "success",
      sqlBytes: new TextEncoder().encode(grouped.trace.preparedSql[0]!)
        .byteLength,
      bindings: grouped.trace.bindings[0]!.length,
      physicalPlanHash: expect.stringMatching(/^v1:/u),
    });
    expect(grouped.trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(grouped.observation.sqlBytes as number).toBeLessThanOrEqual(
      D1_MAX_SQL_UTF8_BYTES,
    );
    const pageExplain = explainQueryPlan(db, {
      sql: grouped.trace.preparedSql[0]!,
      bindings: grouped.trace.bindings[0]!,
    }).join("\n");
    expect(pageExplain).toContain("idx_visits_site_pk_started_at");

    const summaryPlan = buildPageNumericPlan(PAGE_WINDOW, false);
    const summary = await measureOutput(
      summaryPlan,
      "page-numeric-summary",
      "analytics.wave23.page-numeric-summary",
    );
    expect(summary.rows).toEqual(legacyPageNumericRows(PAGE_WINDOW, false));
    expect(summary.rows[0]).toMatchObject({
      views: 6,
      sumDuration: 50,
      avgDuration: 12.5,
      minDuration: -5,
      maxDuration: 50,
      sumPathDuration: 45,
    });

    const durationPlan = buildDurationGroupPlan(PAGE_WINDOW);
    const durationOutput = outputById(durationPlan, "page-duration-groups");
    const durationLowerer = new AnalyticsLogicalToDbLowerer(durationPlan, {
      siteId: SITE_A,
      time: durationPlan.context.time,
    });
    const durationQuery = compileOutput(
      durationPlan,
      durationOutput.id,
      durationLowerer,
    );
    const durationRows = await executeCompiled(db, durationQuery);
    const legacyDurationRows = db
      .prepare(
        `SELECT duration_ms AS duration, count(*) AS views
         FROM visits
         WHERE site_pk = ? AND started_at >= ? AND started_at < ?
         GROUP BY duration_ms
         ORDER BY duration_ms`,
      )
      .all(siteA.pk, PAGE_WINDOW.startMs, PAGE_WINDOW.endExclusiveMs) as Record<
      string,
      unknown
    >[];
    expect(sorted(durationRows)).toEqual(sorted(legacyDurationRows));
    expect(durationRows).toContainEqual({ duration: null, views: 2 });

    const allNullRange = { startMs: 150, endExclusiveMs: 165 };
    const allNull = await measureOutput(
      buildPageNumericPlan(allNullRange, false),
      "page-numeric-summary",
      "analytics.wave23.page-all-null",
    );
    expect(allNull.rows[0]).toMatchObject({
      views: 2,
      sumDuration: null,
      avgDuration: null,
      minDuration: null,
      maxDuration: null,
      sumTtfb: null,
      avgTtfb: null,
      minCls: null,
      maxCls: null,
    });

    const emptyRange = { startMs: 1000, endExclusiveMs: 1100 };
    const emptySummary = await measureOutput(
      buildPageNumericPlan(emptyRange, false),
      "page-numeric-summary",
      "analytics.wave23.page-empty-summary",
    );
    expect(emptySummary.rows).toEqual([
      {
        views: 0,
        sumDuration: null,
        avgDuration: null,
        minDuration: null,
        maxDuration: null,
        sumTtfb: null,
        avgTtfb: null,
        minCls: null,
        maxCls: null,
        sumPathDuration: null,
      },
    ]);
    const emptyGroups = await measureOutput(
      buildDurationGroupPlan(emptyRange),
      "page-duration-groups",
      "analytics.wave23.page-empty-groups",
    );
    expect(emptyGroups.rows).toEqual([]);
  });

  it("cross joins nullable scalar aggregates without dropping their NULL rows", async () => {
    const emptyRange = { startMs: 1000, endExclusiveMs: 1100 };
    const plan = buildScalarJoinPlan(emptyRange);
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: SITE_A,
      time: plan.context.time,
    });
    const query = compileOutput(plan, "keyless-nullable-scalar-join", lowerer);
    expect(await executeCompiled(db, query)).toEqual([
      {
        sumDuration: null,
        leftRows: 0,
        avgDuration: null,
        rightRows: 0,
      },
    ]);

    const emptyAfterAggregate = buildScalarJoinPlan(emptyRange, true);
    const filteredLowerer = new AnalyticsLogicalToDbLowerer(
      emptyAfterAggregate,
      { siteId: SITE_A, time: emptyAfterAggregate.context.time },
    );
    expect(
      await executeCompiled(
        db,
        compileOutput(
          emptyAfterAggregate,
          "keyless-nullable-scalar-join",
          filteredLowerer,
        ),
      ),
    ).toEqual([]);
  });

  it("keeps composite entity group and DISTINCT unsupported with located errors", () => {
    for (const kind of ["group", "count-distinct"] as const) {
      const plan = buildEntityAggregatePlan(kind);
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_A,
        time: plan.context.time,
      });
      let error: unknown;
      try {
        lowerer.lower(plan.outputs[0]!);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AnalyticsRelationalLoweringError);
      if (!(error instanceof AnalyticsRelationalLoweringError)) return;
      expect(error.message).toMatch(
        /Scalar aggregation requires a scalar Logical value\./u,
      );
      expect(error.node).toContain(
        kind === "group" ? ".groups[0].expression" : ".measures[0].input",
      );
    }

    const unknownMin = buildUnknownMinPlan();
    const minLowerer = new AnalyticsLogicalToDbLowerer(unknownMin, {
      siteId: SITE_A,
      time: unknownMin.context.time,
    });
    let error: unknown;
    try {
      minLowerer.lower(unknownMin.outputs[0]!);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AnalyticsRelationalLoweringError);
    if (error instanceof AnalyticsRelationalLoweringError) {
      expect(error.message).toContain(
        "MIN and MAX require a comparable scalar",
      );
      expect(error.node).toContain(".measures[0].input");
    }

    let sumError: unknown;
    try {
      buildTextSumPlan();
    } catch (caught) {
      sumError = caught;
    }
    expect(sumError).toBeInstanceOf(LogicalPlanError);
    if (sumError instanceof LogicalPlanError) {
      expect(sumError.issues).toContainEqual(
        expect.objectContaining({
          code: "invalid-expression",
          path: expect.stringContaining(".measures[0].input"),
          message: "SUM and AVG require numeric values.",
        }),
      );
    }
  });
});
