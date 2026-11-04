import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { QuerySource } from "@/lib/db/query/plan";
import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type {
  LogicalOutput,
  LogicalPlan,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { appendOverviewAggregateReport } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import { appendQualifiedOverviewReportSource } from "@/lib/edge/analytics/engine/overview-report-source";
import { OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import { appendOverviewTrendReport } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import { splitPageDimensionNativeFilters } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  d1AdvancedFilterMiddleware,
  deferredOverviewTrendQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { AnalysisResultQualificationBinding } from "@/lib/edge/analytics/providers/d1/internal/lowering/comparison-page-admission";
import type { AnalyticsQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE_ID = "wave97a-analysis-result";
const BASE = Date.UTC(2026, 0, 1);
const HOUR = 60 * 60 * 1000;
const CURRENT_TIME = createQueryTime(
  BASE + HOUR,
  BASE + 2 * HOUR,
  "UTC",
  BASE + 2 * HOUR,
);
const PREVIOUS_TIME = createQueryTime(
  BASE,
  BASE + HOUR,
  "UTC",
  BASE + 2 * HOUR,
);
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const NUMERIC_INCOMPATIBILITY_FILTER_DSL = `${FILTER_DSL} and count(page { page.durationMs gt 5 }) eq 1`;
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const CONTROL_OUTPUT_ID = OVERVIEW_TREND_QUALIFICATION_CONTROL_OUTPUT;
const COHORT_OUTPUT_ID = "overview-current-count-cohort";
const SHARED_REPORT_OUTPUT_ORDERS = [
  {
    label: "cohort-first",
    outputIds: [COHORT_OUTPUT_ID, "overview-aggregate", "overview-trend"],
  },
  {
    label: "aggregate-first",
    outputIds: ["overview-aggregate", COHORT_OUTPUT_ID, "overview-trend"],
  },
  {
    label: "trend-first",
    outputIds: ["overview-trend", "overview-aggregate", COHORT_OUTPUT_ID],
  },
] as const;
const QUALIFICATION_CONTROL_POSITIONS = [
  "controls-first",
  "controls-last",
] as const;
const QUALIFICATION_CONTROL_SCENARIOS = [
  "legal",
  "cap-zero",
  "numeric-incompatible",
] as const;
const databases = new Set<DatabaseSync>();

const qualificationControlOrderCases = SHARED_REPORT_OUTPUT_ORDERS.flatMap(
  ({ label, outputIds }) =>
    QUALIFICATION_CONTROL_POSITIONS.flatMap((controlsPosition) =>
      QUALIFICATION_CONTROL_SCENARIOS.map((scenario) => ({
        controlsPosition,
        reportOrder: label,
        reportOutputIds: outputIds,
        scenario,
      })),
    ),
);

type Scope = "session" | "visitor";

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function makeFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  const sitePk = Number(identity.site_pk);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97a-team', 'Shared Analysis Result', 'wave97a.test', 0)`,
    )
    .run(SITE_ID);
  const pages = [
    [
      "shared-current",
      "shared-session",
      "shared-visitor",
      BASE + HOUR + 100,
      1000,
      "/current",
    ],
    [
      "current-only",
      "current-only-session",
      "current-only-visitor",
      BASE + HOUR + 200,
      2000,
      "/current-only",
    ],
    [
      "shared-previous",
      "shared-session",
      "shared-visitor",
      BASE + 500,
      5000,
      "/shared-previous",
    ],
    [
      "shared-excluded",
      "shared-session",
      "shared-visitor",
      BASE + 600,
      9000,
      "/excluded",
    ],
    [
      "visitor-previous",
      "visitor-previous-session",
      "shared-visitor",
      BASE + 700,
      4000,
      "/visitor-previous",
    ],
    [
      "previous-only",
      "previous-only-session",
      "previous-only-visitor",
      BASE + 800,
      3000,
      "/previous-only",
    ],
  ] as const;
  const insertPage = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, duration_ms, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 'wave97a.test')`,
  );
  for (const [
    visitId,
    sessionId,
    visitorId,
    startedAt,
    durationMs,
    pathname,
  ] of pages) {
    insertPage.run(
      visitId,
      SITE_ID,
      sitePk,
      visitorId,
      sessionId,
      startedAt,
      startedAt,
      durationMs,
      pathname,
    );
  }
  const insertEvent = (
    eventId: string,
    visitId: string,
    occurredAt: number,
  ) => {
    database
      .prepare(
        `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
         VALUES (?, 'qualifier', ?, ?)`,
      )
      .run(SITE_ID, occurredAt, sitePk);
    const eventName = database
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'qualifier'",
      )
      .get(sitePk) as { readonly id: number };
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
      )
      .run(
        eventId,
        SITE_ID,
        sitePk,
        visitId,
        eventName.id,
        occurredAt,
        occurredAt,
      );
  };
  insertEvent("shared-current-qualifier", "shared-current", BASE + HOUR + 300);
  insertEvent("current-only-qualifier", "current-only", BASE + HOUR + 400);
  insertEvent("previous-only-qualifier", "previous-only", BASE + 900);
  return database;
}

function testEnv(database: DatabaseSync, queryTrace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, queryTrace),
    MAIN_SECRET: "wave97a-shared-analysis-result-test-secret",
  } as unknown as Env;
}

function scopedQuery(
  scope: Scope,
  time = CURRENT_TIME,
  filterDsl = FILTER_DSL,
) {
  return {
    ...prepareScopedQuery("overview", {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      time,
      filters: parseFilterDsl(filterDsl, analyticsFilterRegistry),
      scopePreference: scope,
    } as QueryInput & { readonly time: QueryTime }),
    time,
  };
}

async function buildCurrentChild(scope: Scope, filterDsl = FILTER_DSL) {
  const database = makeFixture();
  const queryTrace = trace();
  const forwarded = (await d1AdvancedFilterMiddleware(
    testEnv(database, queryTrace),
    createD1ReadDiagnostics(),
    SITE_ID,
  )(
    "overview",
    scopedQuery(scope, CURRENT_TIME, filterDsl),
    async (value) => value,
  )) as ReturnType<typeof scopedQuery>;
  if (!forwarded.filters) throw new Error("wave97a_forwarded_filters_missing");
  const deferred = deferredOverviewTrendQualificationFromQuery(
    forwarded,
    "overview",
  );
  if (!deferred) throw new Error("wave97a_overview_count_deferred_missing");

  const source = appendQualifiedOverviewReportSource({
    semanticOperation: "overview",
    siteId: SITE_ID,
    queryTime: deferred.qualification.requestTime,
    filters: deferred.qualification.filters,
    scopePlan: deferred.qualification.metadata.plan,
    count: deferred.qualification.countInput,
    pageAttributes: [
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.startedAt",
      "page.report.durationMs",
    ],
    pageRelationships: ["page.session", "page.visitor"],
    eventAttributes: [
      "event.report.ownerSessionId",
      "event.report.ownerVisitorId",
      "event.report.occurredAt",
    ],
    eventRelationships: ["event.session", "event.visitor"],
  });
  const matches = source.qualification.matches;
  source.builder.output(COHORT_OUTPUT_ID, matches, [
    { name: "siteId", slot: "siteId" },
    { name: "entityId", slot: "entityId" },
  ]);
  appendOverviewAggregateReport(source.builder, {
    pages: source.pages,
    events: source.events,
    scoped: true,
  });
  appendOverviewTrendReport(source.builder, {
    pages: source.pages,
    events: source.events,
    scoped: true,
    interval: "hour",
  });
  source.builder.output(
    CONTROL_OUTPUT_ID,
    source.qualification.controls,
    Object.keys(source.qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );
  const childPlan = source.builder.finish();
  return { database, childPlan, deferred, queryTrace, source, forwarded };
}

const PAGE_ATTRIBUTES = [
  "page.report.sessionId",
  "page.report.visitorId",
  "page.report.startedAt",
  "page.report.durationMs",
] as const;
const PAGE_RELATIONSHIPS = ["page.session", "page.visitor"] as const;
const EVENT_ATTRIBUTES = [
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
  "event.report.occurredAt",
] as const;
const EVENT_RELATIONSHIPS = ["event.session", "event.visitor"] as const;

function admissionPolicy(
  childPlan: LogicalPlan,
  source: Awaited<ReturnType<typeof buildCurrentChild>>["source"],
): AnalyticsQualificationAdmissionPolicy {
  const reportOutputIds = [
    COHORT_OUTPUT_ID,
    "overview-aggregate",
    "overview-trend",
  ];
  return {
    primaryReportSourceRelationId: source.reportSourceRelations[0]!.relationId,
    reportSourceRelations: source.reportSourceRelations,
    reportRelationIds: [
      ...new Set(
        reportOutputIds.map(
          (outputId) =>
            childPlan.outputs.find((output) => output.id === outputId)!
              .relation,
        ),
      ),
    ],
    controlsRelationId: source.qualification.controls.id,
    controlSlots: childPlan.outputs
      .find((output) => output.id === CONTROL_OUTPUT_ID)!
      .fields.map(({ name, slot }) => ({ name, slot })),
    scope: source.qualification.scope,
    maximumActivities: 20_000,
    numericCompatibilityControlNames:
      source.qualification.numericCompatibilityFields.map(
        ({ invalidCountOutput }) => invalidCountOutput,
      ),
  };
}

function createPreviousParent(
  childPlan: ValidatedLogicalPlan,
  filters: NonNullable<ReturnType<typeof scopedQuery>["filters"]>,
  scope: Scope,
) {
  const split = splitPageDimensionNativeFilters(filters);
  if (split.kind === "unsupported")
    throw new Error("wave97a_native_filter_split_unsupported");
  const scopePlan = createScopedFilterPlan("overview", split.filters, scope);
  if (!scopePlan) throw new Error("wave97a_native_scope_plan_missing");
  if (!scopedFilterMetadata(filters))
    throw new Error("wave97a_scoped_filter_metadata_missing");
  const nativeFilters = attachScopedFilterMetadata(split.filters, {
    requestedScope: scope,
    resolvedScope: scope,
    plan: scopePlan,
    time: PREVIOUS_TIME,
    siteIds: [SITE_ID],
  });
  const time = semanticTemporalDomainsFromQueryTime(PREVIOUS_TIME);
  const builder = new LogicalPlanBuilder({
    subject: childPlan.context.subject,
    time,
    scope: childPlan.context.scope,
  });
  const selection = createSemanticScopedSourceSelection({
    profile: "prepared-scoped-v1",
    filters: nativeFilters,
    subject: builder.context.subject,
    time: builder.context.time,
    expectedPlan: scopePlan,
    preparedPlanOperation: "overview",
  });
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: PAGE_ATTRIBUTES,
    relationships: PAGE_RELATIONSHIPS,
    selection,
  });
  const events = builder.source("event", {
    temporalDomain: "candidate",
    attributes: EVENT_ATTRIBUTES,
    relationships: EVENT_RELATIONSHIPS,
    selection,
  });
  const imported = new Map<
    string,
    ReturnType<typeof builder.importAnalysisResult>
  >();
  for (const outputId of [
    COHORT_OUTPUT_ID,
    "overview-aggregate",
    "overview-trend",
    CONTROL_OUTPUT_ID,
  ]) {
    const childOutput = childPlan.outputs.find(
      (output) => output.id === outputId,
    );
    if (!childOutput)
      throw new Error(`wave97a_child_output_missing:${outputId}`);
    const relation = builder.importAnalysisResult(
      childPlan,
      outputId,
      childOutput.fields.map(({ name }) => ({ field: name })),
    );
    imported.set(outputId, relation);
    builder.output(
      `imported-${outputId}`,
      relation,
      childOutput.fields.map(({ name }) => ({ name, slot: name })),
    );
  }
  const cohort = imported.get(COHORT_OUTPUT_ID)!;
  const owner = scope === "session" ? "sessionId" : "visitorId";
  const qualifiedPages = builder.semiJoin(pages, cohort, [
    { left: `attribute:page.report.${owner}`, right: "entityId" },
  ]);
  const qualifiedEvents = events
    ? builder.semiJoin(events, cohort, [
        {
          left: `attribute:event.report.owner${owner[0]!.toUpperCase()}${owner.slice(1)}`,
          right: "entityId",
        },
      ])
    : undefined;
  appendOverviewAggregateReport(builder, {
    pages: qualifiedPages,
    ...(qualifiedEvents ? { events: qualifiedEvents } : {}),
    scoped: true,
  });
  appendOverviewTrendReport(builder, {
    pages: qualifiedPages,
    ...(qualifiedEvents ? { events: qualifiedEvents } : {}),
    scoped: true,
    interval: "hour",
  });
  const plan = builder.finish();
  const childSnapshot = plan.nodes.find(
    (node) => node.kind === "analysis-result",
  );
  if (!childSnapshot || childSnapshot.kind !== "analysis-result")
    throw new Error("wave97a_imported_child_snapshot_missing");
  return {
    plan,
    childSnapshot: childSnapshot.childPlan,
  };
}

function compileOutput(
  database: DatabaseSync,
  lowerer: AnalyticsLogicalToDbLowerer,
  plan: ValidatedLogicalPlan,
  outputId: string,
) {
  return compileOutputFromLowered(
    database,
    lowerer,
    plan,
    lowerer.lowerMany(plan.outputs),
    outputId,
  );
}

function compileOutputFromLowered(
  database: DatabaseSync,
  lowerer: AnalyticsLogicalToDbLowerer,
  plan: ValidatedLogicalPlan,
  loweredOutputs: ReturnType<AnalyticsLogicalToDbLowerer["lowerMany"]>,
  outputId: string,
) {
  const index = plan.outputs.findIndex((output) => output.id === outputId);
  const output = plan.outputs[index];
  if (!output) throw new Error(`wave97a_parent_output_missing:${outputId}`);
  const lowered = loweredOutputs[index]!;
  return compileLogicalOutputFromLowered(database, lowerer, output, lowered);
}

function compileLogicalOutputFromLowered(
  database: DatabaseSync,
  lowerer: AnalyticsLogicalToDbLowerer,
  output: LogicalOutput,
  lowered: ReturnType<AnalyticsLogicalToDbLowerer["lowerMany"]>[number],
) {
  const query = compileD1Query(
    lowerLogicalPlan(
      lowerer.projectOutput(
        lowered,
        output.fields.map(({ name, slot }) => ({ name, slot })),
      ),
    ),
  );
  const rows = database
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]));
  return {
    sql: query.sql,
    bindings: query.bindings ?? [],
    sqlBytes: Buffer.byteLength(query.sql, "utf8"),
    rows,
  };
}

function canonicalRows(rows: readonly Record<string, unknown>[]) {
  return rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function parentBinding(
  childPlan: LogicalPlan,
  source: Awaited<ReturnType<typeof buildCurrentChild>>["source"],
  reportOutputIds: readonly string[],
  controlsOutputId = CONTROL_OUTPUT_ID,
): AnalysisResultQualificationBinding {
  const policy = admissionPolicy(childPlan, source);
  const reportRelationIds = [
    ...new Set(
      reportOutputIds.map(
        (outputId) =>
          childPlan.outputs.find((output) => output.id === outputId)!.relation,
      ),
    ),
  ];
  const controlsOutput = childPlan.outputs.find(
    (output) => output.id === controlsOutputId,
  )!;
  return {
    childPlan,
    reportOutputIds,
    controlsOutputId,
    policy: {
      ...policy,
      reportRelationIds,
      controlsRelationId: controlsOutput.relation,
    },
  };
}

function createImportedOnlyParent(
  childPlan: ValidatedLogicalPlan,
  time = PREVIOUS_TIME,
) {
  const builder = new LogicalPlanBuilder({
    subject: childPlan.context.subject,
    time: semanticTemporalDomainsFromQueryTime(time),
    scope: childPlan.context.scope,
  });
  for (const outputId of ["overview-aggregate", CONTROL_OUTPUT_ID]) {
    const output = childPlan.outputs.find(
      (candidate) => candidate.id === outputId,
    )!;
    const imported = builder.importAnalysisResult(
      childPlan,
      outputId,
      output.fields.map(({ name }) => ({ field: name })),
    );
    builder.output(
      `parent-${outputId}`,
      imported,
      output.fields.map(({ name }) => ({ name, slot: name })),
    );
  }
  const plan = builder.finish();
  const firstImport = plan.nodes.find(
    (node) => node.kind === "analysis-result",
  );
  if (!firstImport || firstImport.kind !== "analysis-result")
    throw new Error("wave97a_imported_child_snapshot_missing");
  return { plan, childSnapshot: firstImport.childPlan };
}

function overviewDto(row: Record<string, unknown>) {
  return {
    views: Number(row.views),
    sessions: Number(row.sessions),
    visitors: Number(row.visitors),
    bounces: Number(row.bounces),
    totalDurationMs: Number(row.totalDuration),
    durationViews: Number(row.durationViews),
  };
}

function trendDto(rows: readonly Record<string, unknown>[]) {
  return rows.map((row) => ({
    bucket: Number(row.bucket),
    views: Number(row.views),
    visitors: Number(row.visitors),
    sessions: Number(row.sessions),
    bounces: Number(row.bounces),
    totalDuration: Number(row.totalDuration),
    durationViews: Number(row.durationViews),
  }));
}

function genericQueryNodes(root: QuerySource): ReadonlySet<object> {
  const nodes = new Set<object>();
  const visit = (source: QuerySource): void => {
    const node = source.node;
    if (nodes.has(node)) return;
    nodes.add(node);
    switch (node.kind) {
      case "scan":
      case "values-relation":
      case "json-scalar-array":
        return;
      case "filter":
      case "project":
      case "aggregate":
      case "distinct":
      case "window":
      case "sort":
      case "limit":
        visit(node.input);
        return;
      case "join":
      case "semi-join":
      case "anti-join":
      case "union":
        visit(node.left);
        visit(node.right);
        return;
      case "recursive-closure":
        visit(node.seed);
        visit(node.candidates);
        return;
    }
  };
  visit(root);
  return nodes;
}

function outputShape(plan: LogicalPlan, outputId: string) {
  const output = plan.outputs.find((item) => item.id === outputId);
  if (!output) throw new Error(`wave97a_output_missing:${outputId}`);
  const relation = plan.nodes.find((node) => node.id === output.relation);
  if (!relation) throw new Error(`wave97a_relation_missing:${outputId}`);
  const slots = new Map(plan.slots.map((slot) => [slot.id, slot] as const));
  const keySlots =
    relation.grain.kind === "keyed"
      ? relation.grain.keys
      : relation.grain.kind === "entity"
        ? [relation.grain.key]
        : [];
  return {
    outputId,
    relationId: output.relation,
    grain: relation.grain,
    keyFieldNames: output.fields
      .filter(({ slot }) => keySlots.includes(slot))
      .map(({ name }) => name),
    fields: output.fields.map(({ name, slot }) => ({
      name,
      type: slots.get(slot)?.type,
      nullable: slots.get(slot)?.nullable,
    })),
  };
}

function writeShapeEvidence(scope: Scope, value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, `analysis-result-public-shape-${scope}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: "w" },
  );
}

function writeSupplementalEvidence(name: string, value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, `${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: "w" },
  );
}

afterAll(() => {
  for (const database of databases) database.close();
});

describe("shared AnalysisResult qualification outputs", () => {
  it.each(qualificationControlOrderCases)(
    "preserves the complete raw controls for $scenario with $reportOrder reports and $controlsPosition parent roots",
    async ({ controlsPosition, reportOrder, reportOutputIds, scenario }) => {
      const filterDsl =
        scenario === "numeric-incompatible"
          ? NUMERIC_INCOMPATIBILITY_FILTER_DSL
          : FILTER_DSL;
      const { childPlan, database, forwarded, source } =
        await buildCurrentChild("session", filterDsl);
      try {
        if (scenario === "numeric-incompatible") {
          const update = database
            .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
            .run("invalid-duration", "shared-current");
          expect(Number(update.changes)).toBe(1);
        }

        const rawLowerer = new AnalyticsLogicalToDbLowerer(childPlan, {
          siteId: SITE_ID,
          time: childPlan.context.time,
        });
        const rawChildOutputs = rawLowerer.lowerMany(childPlan.outputs);
        const rawChildResults = new Map(
          childPlan.outputs.map((output, index) => [
            output.id,
            compileLogicalOutputFromLowered(
              database,
              rawLowerer,
              output,
              rawChildOutputs[index]!,
            ),
          ]),
        );
        const rawControls = rawChildResults.get(CONTROL_OUTPUT_ID);
        if (!rawControls) throw new Error("wave97a_raw_controls_missing");
        expect(rawControls.rows).toHaveLength(1);
        const rawControlRow = rawControls.rows[0] as Record<string, unknown>;
        const controlOutput = childPlan.outputs.find(
          ({ id }) => id === CONTROL_OUTPUT_ID,
        )!;
        expect(Object.keys(rawControlRow).sort()).toEqual(
          controlOutput.fields.map(({ name }) => name).sort(),
        );
        expect(Number(rawControlRow.rawCount)).toBeGreaterThan(0);
        expect(Number(rawControlRow.nullActivityIdCount)).toBe(0);
        expect(Number(rawControlRow.siteIdentityMismatchCount)).toBe(0);
        expect(String(rawControlRow.entityKind)).toBe("session");
        expect(Number(rawControlRow.invalidIdentityCount)).toBe(0);
        expect(Number(rawControlRow.duplicateIdentityCount)).toBe(0);

        const numericControlNames =
          source.qualification.numericCompatibilityFields.map(
            ({ invalidCountOutput }) => invalidCountOutput,
          );
        const rawNumericCounts = Object.fromEntries(
          numericControlNames.map((name) => [
            name,
            Number(rawControlRow[name]),
          ]),
        );
        if (scenario === "numeric-incompatible") {
          expect(numericControlNames.length).toBeGreaterThan(0);
          expect(Math.max(...Object.values(rawNumericCounts))).toBeGreaterThan(
            0,
          );
        } else {
          expect(
            Object.values(rawNumericCounts).every((count) => count === 0),
          ).toBe(true);
        }

        const parent = createPreviousParent(
          childPlan,
          forwarded.filters!,
          "session",
        );
        const originalBinding = parentBinding(
          parent.childSnapshot,
          source,
          reportOutputIds,
        );
        const maximumActivities = scenario === "cap-zero" ? 0 : 20_000;
        const binding: AnalysisResultQualificationBinding = {
          ...originalBinding,
          policy: { ...originalBinding.policy, maximumActivities },
        };
        const importedOutputById = new Map(
          parent.plan.outputs
            .filter(({ id }) => id.startsWith("imported-"))
            .map((output) => [output.id, output] as const),
        );
        const orderedReportRoots = reportOutputIds.map((outputId) => {
          const output = importedOutputById.get(`imported-${outputId}`);
          if (!output)
            throw new Error(`wave97a_imported_report_missing:${outputId}`);
          return output;
        });
        const importedControlsRoot = importedOutputById.get(
          `imported-${CONTROL_OUTPUT_ID}`,
        );
        if (!importedControlsRoot)
          throw new Error("wave97a_imported_controls_root_missing");
        const orderedParentRoots =
          controlsPosition === "controls-first"
            ? [importedControlsRoot, ...orderedReportRoots]
            : [...orderedReportRoots, importedControlsRoot];
        const lowerer = new AnalyticsLogicalToDbLowerer(
          parent.plan,
          { siteId: SITE_ID, time: parent.plan.context.time },
          { analysisResultQualificationBindings: [binding] },
        );
        const loweredParentRoots = lowerer.lowerMany(orderedParentRoots);
        const parentResults = new Map(
          orderedParentRoots.map((output, index) => [
            output.id,
            compileLogicalOutputFromLowered(
              database,
              lowerer,
              output,
              loweredParentRoots[index]!,
            ),
          ]),
        );
        const admittedControls = parentResults.get(
          `imported-${CONTROL_OUTPUT_ID}`,
        );
        if (!admittedControls)
          throw new Error("wave97a_admitted_controls_missing");
        expect(admittedControls.rows).toHaveLength(1);
        expect(admittedControls.rows).toEqual(rawControls.rows);
        expect(Object.keys(admittedControls.rows[0] as object).sort()).toEqual(
          controlOutput.fields.map(({ name }) => name).sort(),
        );

        const importedReports = reportOutputIds.map((outputId) => {
          const raw = rawChildResults.get(outputId);
          const imported = parentResults.get(`imported-${outputId}`);
          if (!raw || !imported)
            throw new Error(`wave97a_ordered_report_missing:${outputId}`);
          return { outputId, raw, imported };
        });
        let admissionReason: "accepted" | "activity-cap" | "numeric-domain";
        if (scenario === "legal") {
          admissionReason = "accepted";
          expect(Number(rawControlRow.rawCount)).toBeLessThanOrEqual(
            maximumActivities,
          );
          for (const { imported, raw } of importedReports)
            expect(canonicalRows(imported.rows)).toEqual(
              canonicalRows(raw.rows),
            );
        } else {
          if (scenario === "cap-zero") {
            admissionReason = "activity-cap";
            expect(Number(rawControlRow.rawCount)).toBeGreaterThan(
              maximumActivities,
            );
          } else {
            admissionReason = "numeric-domain";
            expect(Number(rawControlRow.rawCount)).toBeLessThanOrEqual(
              maximumActivities,
            );
            expect(
              Math.max(...Object.values(rawNumericCounts)),
            ).toBeGreaterThan(0);
          }
          for (const { imported } of importedReports)
            expect(imported.rows).toEqual([]);
        }

        writeSupplementalEvidence(
          `ordering-${scenario}-${reportOrder}-${controlsPosition}`,
          {
            scenario,
            reportOrder,
            reportOutputIds,
            controlsPosition,
            parentRootOrder: orderedParentRoots.map(({ id }) => id),
            maximumActivities,
            admissionReason,
            numericControlNames,
            rawNumericCounts,
            rawControls: {
              sql: rawControls.sql,
              bindings: rawControls.bindings,
              rows: rawControls.rows,
            },
            admittedControls: {
              sql: admittedControls.sql,
              bindings: admittedControls.bindings,
              rows: admittedControls.rows,
              exactlyMatchesRawOracle: true,
            },
            reports: importedReports.map(({ outputId, raw, imported }) => ({
              outputId,
              raw: { sql: raw.sql, bindings: raw.bindings, rows: raw.rows },
              imported: {
                sql: imported.sql,
                bindings: imported.bindings,
                rows: imported.rows,
              },
            })),
          },
        );
      } finally {
        database.close();
        databases.delete(database);
      }
    },
  );

  it.each(["session", "visitor"] as const)(
    "smokes public Count cohort, aggregate, trend, controls and different-time imports (%s)",
    async (scope) => {
      const { childPlan, database, queryTrace } =
        await buildCurrentChild(scope);
      try {
        const expectedOutputIds = [
          COHORT_OUTPUT_ID,
          "overview-aggregate",
          "overview-trend",
          CONTROL_OUTPUT_ID,
        ];
        expect(childPlan.outputs.map(({ id }) => id)).toEqual(
          expectedOutputIds,
        );

        const shapes = expectedOutputIds.map((outputId) =>
          outputShape(childPlan, outputId),
        );
        const parentBuilder = new LogicalPlanBuilder({
          subject: childPlan.context.subject,
          time: semanticTemporalDomainsFromQueryTime(PREVIOUS_TIME),
          scope: childPlan.context.scope,
        });
        const imports = expectedOutputIds.map((outputId) => {
          const childOutput = childPlan.outputs.find(
            (output) => output.id === outputId,
          )!;
          const imported = parentBuilder.importAnalysisResult(
            childPlan,
            outputId,
            childOutput.fields.map(({ name }) => ({ field: name })),
          );
          parentBuilder.output(
            `parent-${outputId}`,
            imported,
            childOutput.fields.map(({ name }) => ({ name, slot: name })),
          );
          return imported;
        });
        const parentPlan = parentBuilder.finish();
        expect(parentPlan.context.time.candidate.startMs).toBe(
          PREVIOUS_TIME.range.startMs,
        );
        expect(
          parentPlan.nodes.filter((node) => node.kind === "analysis-result"),
        ).toHaveLength(expectedOutputIds.length);
        const importedChildSnapshots = parentPlan.nodes.flatMap((node) =>
          node.kind === "analysis-result" ? [node.childPlan] : [],
        );
        expect(new Set(importedChildSnapshots).size).toBe(1);
        expect(imports).toHaveLength(expectedOutputIds.length);

        const evidence = {
          scope,
          countInputSource:
            "d1AdvancedFilterMiddleware/deferredOverviewTrendQualificationFromQuery",
          childOutputIds: expectedOutputIds,
          childOutputs: shapes,
          parentTime: PREVIOUS_TIME,
          childTime: childPlan.context.time,
          publicImportResults: expectedOutputIds.map((outputId) => ({
            outputId,
            imported: true,
          })),
          queryPreparationStatements: queryTrace.preparedSql.map(
            (sql, index) => ({ sql, bindings: queryTrace.bindings[index] }),
          ),
        };
        writeShapeEvidence(scope, evidence);
        expect(
          shapes.find(({ outputId }) => outputId === COHORT_OUTPUT_ID),
        ).toMatchObject({
          grain: { kind: "keyed" },
          keyFieldNames: ["siteId", "entityId"],
        });
        expect(
          shapes.find(({ outputId }) => outputId === COHORT_OUTPUT_ID)?.fields,
        ).toEqual([
          {
            name: "siteId",
            type: { kind: "scalar", scalar: "string" },
            nullable: false,
          },
          {
            name: "entityId",
            type: { kind: "scalar", scalar: "string" },
            nullable: false,
          },
        ]);
        expect(
          shapes
            .find(({ outputId }) => outputId === "overview-aggregate")
            ?.fields.every(({ type }) => type?.kind === "scalar"),
        ).toBe(true);
        expect(
          shapes
            .find(({ outputId }) => outputId === "overview-trend")
            ?.fields.every(({ type }) => type?.kind === "scalar"),
        ).toBe(true);
        expect(
          shapes
            .find(({ outputId }) => outputId === "overview-trend")
            ?.fields.find(({ name }) => name === "bucket")?.type,
        ).toEqual({ kind: "scalar", scalar: "number" });
      } finally {
        database.close();
        databases.delete(database);
      }
    },
  );

  it.each(["session", "visitor"] as const)(
    "imports the current %s cohort into a previous Overview and Trend with native filters preserved",
    async (scope) => {
      const { childPlan, database, deferred, forwarded, source, queryTrace } =
        await buildCurrentChild(scope);
      try {
        const parent = createPreviousParent(
          childPlan,
          forwarded.filters!,
          scope,
        );
        const binding = parentBinding(parent.childSnapshot, source, [
          COHORT_OUTPUT_ID,
          "overview-aggregate",
          "overview-trend",
        ]);
        const lowerer = new AnalyticsLogicalToDbLowerer(
          parent.plan,
          { siteId: SITE_ID, time: parent.plan.context.time },
          { analysisResultQualificationBindings: [binding] },
        );
        const lowered = lowerer.lowerMany(parent.plan.outputs);
        const loweredByOutputId = (outputId: string) => {
          const index = parent.plan.outputs.findIndex(
            (output) => output.id === outputId,
          );
          if (index < 0)
            throw new Error(`wave97a_parent_output_missing:${outputId}`);
          return lowered[index]!;
        };
        const cohortNodes = genericQueryNodes(
          loweredByOutputId(`imported-${COHORT_OUTPUT_ID}`).relation,
        );
        const aggregateNodes = genericQueryNodes(
          loweredByOutputId("imported-overview-aggregate").relation,
        );
        const trendNodes = genericQueryNodes(
          loweredByOutputId("imported-overview-trend").relation,
        );
        const sharedGenericNodeCount = [...cohortNodes].filter(
          (node) => aggregateNodes.has(node) && trendNodes.has(node),
        ).length;
        expect(sharedGenericNodeCount).toBeGreaterThan(0);
        const importedCohort = compileOutputFromLowered(
          database,
          lowerer,
          parent.plan,
          lowered,
          `imported-${COHORT_OUTPUT_ID}`,
        );
        const currentAggregate = compileOutputFromLowered(
          database,
          lowerer,
          parent.plan,
          lowered,
          "imported-overview-aggregate",
        );
        const currentTrend = compileOutputFromLowered(
          database,
          lowerer,
          parent.plan,
          lowered,
          "imported-overview-trend",
        );
        const controls = compileOutputFromLowered(
          database,
          lowerer,
          parent.plan,
          lowered,
          `imported-${CONTROL_OUTPUT_ID}`,
        );
        const previousAggregate = compileOutputFromLowered(
          database,
          lowerer,
          parent.plan,
          lowered,
          "overview-aggregate",
        );
        const previousTrend = compileOutputFromLowered(
          database,
          lowerer,
          parent.plan,
          lowered,
          "overview-trend",
        );
        const legacyTrace = trace();
        const legacyDiagnostics = createD1ReadDiagnostics();
        const legacyForwarded = await d1AdvancedFilterMiddleware(
          testEnv(database, legacyTrace),
          legacyDiagnostics,
          SITE_ID,
        )("performance", scopedQuery(scope), async (value) => value);
        const legacyFilters = (
          legacyForwarded as { readonly filters?: typeof forwarded.filters }
        ).filters;
        if (!legacyFilters)
          throw new Error("wave97a_legacy_prepared_filters_missing");
        if (!scopedFilterMetadata(legacyFilters)?.plan.advancedMatches)
          throw new Error("wave97a_legacy_prepared_matches_missing");
        const legacyReader = createOverviewReader(
          testEnv(database, legacyTrace),
          SITE_ID,
          legacyDiagnostics,
        );
        const legacyOverview = await legacyReader.readOverview({
          time: PREVIOUS_TIME,
          filters: legacyFilters,
        });
        const legacyTrend = await legacyReader.readTrend({
          time: PREVIOUS_TIME,
          interval: "hour",
          filters: legacyFilters,
        });
        const expected =
          scope === "session"
            ? {
                views: 2,
                sessions: 1,
                visitors: 1,
                bounces: 0,
                totalDurationMs: 14000,
                durationViews: 2,
              }
            : {
                views: 3,
                sessions: 2,
                visitors: 1,
                bounces: 1,
                totalDurationMs: 18000,
                durationViews: 3,
              };
        expect(previousAggregate.rows).toHaveLength(1);
        const actual = overviewDto(
          previousAggregate.rows[0] as Record<string, unknown>,
        );
        expect(actual).toEqual(expected);

        const expectedCohort =
          scope === "session"
            ? ["current-only-session", "shared-session"]
            : ["current-only-visitor", "shared-visitor"];
        expect(
          importedCohort.rows
            .map((row) => String((row as { entityId: unknown }).entityId))
            .sort(),
        ).toEqual(expectedCohort);
        expect(currentAggregate.rows).toHaveLength(1);
        expect(currentTrend.rows.length).toBeGreaterThan(0);
        expect(controls.rows).toHaveLength(1);
        expect(
          Number((controls.rows[0] as { rawCount: unknown }).rawCount),
        ).toBeGreaterThan(0);

        expect(actual).toEqual(legacyOverview.value);
        const legacyTrendMetrics = legacyTrend.value.map((row) => ({
          bucket: row.bucket,
          views: row.views,
          visitors: row.visitors,
          sessions: row.sessions,
          bounces: row.bounces,
          totalDuration: row.totalDurationMs,
          durationViews: row.durationViews,
        }));
        expect(
          trendDto(previousTrend.rows as Record<string, unknown>[]),
        ).toEqual(legacyTrendMetrics);
        expect(previousAggregate.sql.toLowerCase().includes("pathname")).toBe(
          true,
        );
        expect(
          legacyTrace.preparedSql.some((sql) => /pathname/i.test(sql)),
        ).toBe(true);

        const previousOnlyMatches = database
          .prepare(
            `SELECT COUNT(*) AS count FROM custom_events AS event
             INNER JOIN visits AS page ON page.visit_id = event.visit_id
             WHERE page.site_id = ? AND page.session_id = 'previous-only-session'
               AND event.occurred_at >= ? AND event.occurred_at < ?`,
          )
          .get(
            SITE_ID,
            PREVIOUS_TIME.range.startMs,
            PREVIOUS_TIME.range.endExclusiveMs,
          ) as {
          readonly count: number;
        };
        expect(Number(previousOnlyMatches.count)).toBeGreaterThan(0);
        expect(
          importedCohort.rows.some(
            (row) =>
              (row as { entityId: unknown }).entityId ===
              (scope === "session"
                ? "previous-only-session"
                : "previous-only-visitor"),
          ),
        ).toBe(false);

        writeShapeEvidence(`execution-${scope}` as Scope, {
          scenario: "current-child-cohort-imported-into-previous-window",
          scope,
          currentQualificationSource:
            "real D1 advanced Count middleware and deferred qualification input",
          currentWindow: CURRENT_TIME,
          previousWindow: PREVIOUS_TIME,
          outputIds: [
            COHORT_OUTPUT_ID,
            "overview-aggregate",
            "overview-trend",
            CONTROL_OUTPUT_ID,
          ],
          childOutputShapes: [
            outputShape(childPlan, COHORT_OUTPUT_ID),
            outputShape(childPlan, "overview-aggregate"),
            outputShape(childPlan, "overview-trend"),
            outputShape(childPlan, CONTROL_OUTPUT_ID),
          ],
          admittedCurrentCohort: importedCohort.rows,
          currentAggregate: currentAggregate.rows,
          currentTrend: currentTrend.rows,
          sharedGenericGraph: {
            sharedNodeCountAcrossCohortAggregateTrend: sharedGenericNodeCount,
            childOutputIds: [
              COHORT_OUTPUT_ID,
              "overview-aggregate",
              "overview-trend",
            ],
          },
          controls: controls.rows,
          newPreviousAggregate: {
            dto: actual,
            sql: previousAggregate.sql,
            bindings: previousAggregate.bindings,
            sqlBytes: previousAggregate.sqlBytes,
          },
          newPreviousTrend: {
            dto: trendDto(previousTrend.rows as Record<string, unknown>[]),
            sql: previousTrend.sql,
            bindings: previousTrend.bindings,
            sqlBytes: previousTrend.sqlBytes,
          },
          oldPreparedIdPath: {
            overview: legacyOverview.value,
            trend: legacyTrend.value,
            preparedSql: legacyTrace.preparedSql,
            bindings: legacyTrace.bindings,
            nativePathPredicateObserved: legacyTrace.preparedSql.some((sql) =>
              /pathname/i.test(sql),
            ),
            nativeFilterSemanticsObserved:
              "page.path qualifies scoped entities; every previous page for a qualifying entity remains in the report",
          },
          currentCountPreparation: {
            preparedSql: queryTrace.preparedSql,
            bindings: queryTrace.bindings,
            deferredInput: deferred.qualification.countInput,
          },
          previousOnlyMatchRows: Number(previousOnlyMatches.count),
          manualExpected: expected,
        });
      } finally {
        database.close();
        databases.delete(database);
      }
    },
  );

  it("preserves an empty previous result and applies the failed Count gate before exposing child aggregates", async () => {
    const currentOnlyDsl =
      'page.path eq "/current-only" and count(event { event.name eq "qualifier" }) gte 1';
    const { childPlan, database, forwarded, source } = await buildCurrentChild(
      "session",
      currentOnlyDsl,
    );
    try {
      const parent = createPreviousParent(
        childPlan,
        forwarded.filters!,
        "session",
      );
      const binding = parentBinding(parent.childSnapshot, source, [
        COHORT_OUTPUT_ID,
        "overview-aggregate",
        "overview-trend",
      ]);
      const passingLowerer = new AnalyticsLogicalToDbLowerer(
        parent.plan,
        { siteId: SITE_ID, time: parent.plan.context.time },
        { analysisResultQualificationBindings: [binding] },
      );
      const passingOutputs = passingLowerer.lowerMany(parent.plan.outputs);
      const currentCohort = compileOutputFromLowered(
        database,
        passingLowerer,
        parent.plan,
        passingOutputs,
        `imported-${COHORT_OUTPUT_ID}`,
      );
      expect(currentCohort.rows).toHaveLength(1);
      const previous = compileOutputFromLowered(
        database,
        passingLowerer,
        parent.plan,
        passingOutputs,
        "overview-aggregate",
      );
      expect(previous.rows).toHaveLength(1);
      expect(overviewDto(previous.rows[0] as Record<string, unknown>)).toEqual({
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        durationViews: 0,
      });

      const failingBinding: AnalysisResultQualificationBinding = {
        ...binding,
        policy: { ...binding.policy, maximumActivities: 0 },
      };
      const failingLowerer = new AnalyticsLogicalToDbLowerer(
        parent.plan,
        { siteId: SITE_ID, time: parent.plan.context.time },
        { analysisResultQualificationBindings: [failingBinding] },
      );
      const failingOutputs = failingLowerer.lowerMany(parent.plan.outputs);
      const failedReport = compileOutputFromLowered(
        database,
        failingLowerer,
        parent.plan,
        failingOutputs,
        "imported-overview-aggregate",
      );
      const retainedControls = compileOutputFromLowered(
        database,
        failingLowerer,
        parent.plan,
        failingOutputs,
        `imported-${CONTROL_OUTPUT_ID}`,
      );
      expect(
        Number((retainedControls.rows[0] as { rawCount: unknown }).rawCount),
      ).toBeGreaterThan(0);
      expect(failedReport.rows).toEqual([]);
      writeShapeEvidence("execution-cap-failure" as Scope, {
        scenario:
          "current-only-cohort-has-no-previous-pages-and-failed-cap-does-not-return-zero-report",
        currentCohort: currentCohort.rows,
        emptyPreviousAggregate: previous.rows,
        failingGate: {
          maximumActivities: 0,
          rawControls: retainedControls.rows,
          gatedChildAggregateRows: failedReport.rows,
          gatedChildAggregateSql: failedReport.sql,
          bindings: failedReport.bindings,
          sqlBytes: failedReport.sqlBytes,
        },
      });
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("keeps the existing one-report comparison binding shape equivalent", async () => {
    const { childPlan, database, source } = await buildCurrentChild("session");
    try {
      const parent = createImportedOnlyParent(childPlan);
      const binding = parentBinding(parent.childSnapshot, source, [
        "overview-aggregate",
      ]);
      const lowerer = new AnalyticsLogicalToDbLowerer(
        parent.plan,
        { siteId: SITE_ID, time: parent.plan.context.time },
        { analysisResultQualificationBindings: [binding] },
      );
      const lowered = lowerer.lowerMany(parent.plan.outputs);
      const report = compileOutputFromLowered(
        database,
        lowerer,
        parent.plan,
        lowered,
        "parent-overview-aggregate",
      );
      const childReport = parent.childSnapshot.outputs.find(
        (output) => output.id === "overview-aggregate",
      )!;
      const childControls = parent.childSnapshot.outputs.find(
        (output) => output.id === CONTROL_OUTPUT_ID,
      )!;
      const legacySingletonLowerer = new AnalyticsLogicalToDbLowerer(
        parent.childSnapshot as ValidatedLogicalPlan,
        { siteId: SITE_ID, time: parent.childSnapshot.context.time },
        { analyticsQualificationAdmissionPolicy: binding.policy },
      );
      const legacySingletonOutputs = legacySingletonLowerer.lowerMany([
        childReport,
        childControls,
      ]);
      const legacySingletonQuery = compileD1Query(
        lowerLogicalPlan(
          legacySingletonLowerer.projectOutput(
            legacySingletonOutputs[0]!,
            childReport.fields.map(({ name, slot }) => ({ name, slot })),
          ),
        ),
      );
      const legacySingletonRows = database
        .prepare(legacySingletonQuery.sql)
        .all(...((legacySingletonQuery.bindings ?? []) as SQLInputValue[]));
      const controls = compileOutputFromLowered(
        database,
        lowerer,
        parent.plan,
        lowered,
        `parent-${CONTROL_OUTPUT_ID}`,
      );
      expect(report.rows).toHaveLength(1);
      expect(overviewDto(report.rows[0] as Record<string, unknown>)).toEqual({
        views: 2,
        sessions: 2,
        visitors: 2,
        bounces: 2,
        totalDurationMs: 3000,
        durationViews: 2,
      });
      expect(
        overviewDto(legacySingletonRows[0] as Record<string, unknown>),
      ).toEqual(overviewDto(report.rows[0] as Record<string, unknown>));
      expect(report.rows).toEqual(legacySingletonRows);
      expect(report.bindings).toEqual(legacySingletonQuery.bindings ?? []);
      expect(report.sqlBytes).toBe(Buffer.byteLength(report.sql, "utf8"));
      expect(report.sqlBytes).toBeLessThanOrEqual(100_000);
      expect(report.bindings.length).toBeLessThanOrEqual(100);
      expect(controls.rows).toHaveLength(1);
      writeShapeEvidence("comparison-singleton" as Scope, {
        scenario: "existing-single-report-plus-controls-lowering-path",
        reportOutputIds: binding.reportOutputIds,
        controlsOutputId: binding.controlsOutputId,
        reportRelationIds: binding.policy.reportRelationIds,
        dto: overviewDto(report.rows[0] as Record<string, unknown>),
        legacyLowerManySingletonPath: {
          logicalOutputIds: [childReport.id, childControls.id],
          dto: overviewDto(legacySingletonRows[0] as Record<string, unknown>),
          sql: legacySingletonQuery.sql,
          bindings: legacySingletonQuery.bindings ?? [],
          sqlBytes: Buffer.byteLength(legacySingletonQuery.sql, "utf8"),
        },
        importedBindingPath: {
          sql: report.sql,
          bindings: report.bindings,
          sqlBytes: report.sqlBytes,
        },
        sql: report.sql,
        bindings: report.bindings,
        sqlBytes: report.sqlBytes,
        controls: controls.rows,
      });
    } finally {
      database.close();
      databases.delete(database);
    }
  });

  it("rejects invalid finite bindings while permitting repeated alias consumers and snapshots mutable binding arrays", async () => {
    const { childPlan, database, forwarded, source } =
      await buildCurrentChild("session");
    try {
      const parent = createPreviousParent(
        childPlan,
        forwarded.filters!,
        "session",
      );
      const approved = parentBinding(parent.childSnapshot, source, [
        COHORT_OUTPUT_ID,
        "overview-aggregate",
        "overview-trend",
      ]);
      const lowererFor = (
        bindings: readonly AnalysisResultQualificationBinding[],
      ) =>
        new AnalyticsLogicalToDbLowerer(
          parent.plan,
          { siteId: SITE_ID, time: parent.plan.context.time },
          { analysisResultQualificationBindings: bindings },
        );
      const invalidBinding = (
        reportOutputIds: readonly string[],
        overrides: Partial<AnalysisResultQualificationBinding> = {},
      ): AnalysisResultQualificationBinding => ({
        ...approved,
        reportOutputIds,
        ...overrides,
      });

      expect(() => lowererFor([invalidBinding([])])).toThrow(
        "approve imported report outputs",
      );
      expect(() =>
        lowererFor([invalidBinding([COHORT_OUTPUT_ID, COHORT_OUTPUT_ID])]),
      ).toThrow("approve imported report outputs");
      expect(() =>
        lowererFor([invalidBinding([COHORT_OUTPUT_ID, CONTROL_OUTPUT_ID])]),
      ).toThrow("approve imported report outputs");
      expect(() =>
        lowererFor([invalidBinding([COHORT_OUTPUT_ID, "unknown-output"])]),
      ).toThrow("approve imported report outputs");
      expect(() =>
        lowererFor([invalidBinding([COHORT_OUTPUT_ID, "overview-aggregate"])]),
      ).toThrow("approve imported report outputs");
      expect(() =>
        lowererFor([
          invalidBinding(
            [COHORT_OUTPUT_ID, "overview-aggregate", "overview-trend"],
            {
              policy: {
                ...approved.policy,
                reportRelationIds: [999 as never],
              },
            },
          ),
        ]),
      ).toThrow("approve imported report outputs");
      expect(() =>
        lowererFor([
          invalidBinding(
            [COHORT_OUTPUT_ID, "overview-aggregate", "overview-trend"],
            { controlsOutputId: "not-imported-controls" },
          ),
        ]),
      ).toThrow("approve imported report outputs");
      expect(() => lowererFor([approved, approved])).toThrow(
        "one qualification binding",
      );

      const wrongChild = { ...parent.childSnapshot } as LogicalPlan;
      expect(() =>
        lowererFor([
          {
            ...approved,
            childPlan: wrongChild,
          },
        ]),
      ).toThrow("exact child snapshot");

      const aliasBuilder = new LogicalPlanBuilder({
        subject: childPlan.context.subject,
        time: semanticTemporalDomainsFromQueryTime(PREVIOUS_TIME),
        scope: childPlan.context.scope,
      });
      const aggregateOutput = childPlan.outputs.find(
        (output) => output.id === "overview-aggregate",
      )!;
      const firstAlias = aliasBuilder.importAnalysisResult(
        childPlan,
        aggregateOutput.id,
        aggregateOutput.fields.map(({ name }) => ({ field: name })),
      );
      const secondAlias = aliasBuilder.importAnalysisResult(
        childPlan,
        aggregateOutput.id,
        aggregateOutput.fields.map(({ name }) => ({
          field: name,
          as: `alias-${name}`,
        })),
      );
      aliasBuilder.output(
        "aggregate-first-alias",
        firstAlias,
        aggregateOutput.fields.map(({ name }) => ({ name, slot: name })),
      );
      aliasBuilder.output(
        "aggregate-second-alias",
        secondAlias,
        aggregateOutput.fields.map(({ name }) => ({
          name: `alias-${name}`,
          slot: `alias-${name}`,
        })),
      );
      const controlsOutput = childPlan.outputs.find(
        (output) => output.id === CONTROL_OUTPUT_ID,
      )!;
      const importedControls = aliasBuilder.importAnalysisResult(
        childPlan,
        CONTROL_OUTPUT_ID,
        controlsOutput.fields.map(({ name }) => ({ field: name })),
      );
      aliasBuilder.output(
        "aggregate-alias-controls",
        importedControls,
        controlsOutput.fields.map(({ name }) => ({ name, slot: name })),
      );
      const aliasPlan = aliasBuilder.finish();
      const aliasSnapshot = aliasPlan.nodes.find(
        (node) => node.kind === "analysis-result",
      );
      if (!aliasSnapshot || aliasSnapshot.kind !== "analysis-result")
        throw new Error("wave97a_alias_child_snapshot_missing");
      const rawChildLowerer = new AnalyticsLogicalToDbLowerer(childPlan, {
        siteId: SITE_ID,
        time: childPlan.context.time,
      });
      const rawChildOutputs = rawChildLowerer.lowerMany(childPlan.outputs);
      const rawAggregateIndex = childPlan.outputs.findIndex(
        ({ id }) => id === aggregateOutput.id,
      );
      const rawControlsIndex = childPlan.outputs.findIndex(
        ({ id }) => id === CONTROL_OUTPUT_ID,
      );
      const rawAggregate = compileLogicalOutputFromLowered(
        database,
        rawChildLowerer,
        aggregateOutput,
        rawChildOutputs[rawAggregateIndex]!,
      );
      const rawControls = compileLogicalOutputFromLowered(
        database,
        rawChildLowerer,
        controlsOutput,
        rawChildOutputs[rawControlsIndex]!,
      );
      const mutableReportOutputIds = ["overview-aggregate"];
      const aggregateRelation = aggregateOutput.relation;
      const mutableReportRelationIds = [aggregateRelation];
      const mutableBinding = parentBinding(
        aliasSnapshot.childPlan,
        source,
        mutableReportOutputIds,
      );
      const mutablePolicy = {
        ...mutableBinding.policy,
        reportRelationIds: mutableReportRelationIds,
      };
      const aliasLowerer = new AnalyticsLogicalToDbLowerer(
        aliasPlan,
        { siteId: SITE_ID, time: aliasPlan.context.time },
        {
          analysisResultQualificationBindings: [
            {
              ...mutableBinding,
              reportOutputIds: mutableReportOutputIds,
              policy: mutablePolicy,
            },
          ],
        },
      );
      mutableReportOutputIds[0] = CONTROL_OUTPUT_ID;
      mutableReportRelationIds[0] = 10_000 as never;
      const aliasOutputIds = [
        "aggregate-first-alias",
        "aggregate-second-alias",
        "aggregate-alias-controls",
      ] as const;
      const aliasOutputs = new Map(
        aliasPlan.outputs.map((output) => [output.id, output] as const),
      );
      const compileAliasesInOrder = (ids: readonly string[]) => {
        const outputs = ids.map((id) => {
          const output = aliasOutputs.get(id);
          if (!output) throw new Error(`wave97a_alias_output_missing:${id}`);
          return output;
        });
        const lowered = aliasLowerer.lowerMany(outputs);
        return new Map(
          outputs.map((output, index) => [
            output.id,
            compileLogicalOutputFromLowered(
              database,
              aliasLowerer,
              output,
              lowered[index]!,
            ),
          ]),
        );
      };
      const firstAliasOrder = compileAliasesInOrder(aliasOutputIds);
      const reversedAliasOrder = compileAliasesInOrder([
        "aggregate-second-alias",
        "aggregate-alias-controls",
        "aggregate-first-alias",
      ]);
      const firstAliasResult = firstAliasOrder.get("aggregate-first-alias")!;
      const secondAliasResult = firstAliasOrder.get("aggregate-second-alias")!;
      const restoredSecondAliasRows = secondAliasResult.rows.map((row) =>
        Object.fromEntries(
          aggregateOutput.fields.map(({ name }) => [
            name,
            (row as Record<string, unknown>)[`alias-${name}`],
          ]),
        ),
      );
      expect(firstAliasResult.rows).toHaveLength(1);
      expect(canonicalRows(firstAliasResult.rows)).toEqual(
        canonicalRows(rawAggregate.rows),
      );
      expect(canonicalRows(restoredSecondAliasRows)).toEqual(
        canonicalRows(rawAggregate.rows),
      );
      expect(firstAliasOrder.get("aggregate-alias-controls")?.rows).toEqual(
        rawControls.rows,
      );
      for (const outputId of aliasOutputIds)
        expect(canonicalRows(reversedAliasOrder.get(outputId)!.rows)).toEqual(
          canonicalRows(firstAliasOrder.get(outputId)!.rows),
        );
    } finally {
      database.close();
      databases.delete(database);
    }
  });
});
