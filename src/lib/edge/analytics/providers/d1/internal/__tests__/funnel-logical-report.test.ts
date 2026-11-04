import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  type FunnelAnalysis,
  type FunnelConfigV2,
  scopedFilterMetadata,
  validateFunnelConfigForWrite,
} from "@/lib/edge/analytics/contract";
import {
  appendFunnelProgressionRelations,
  buildFunnelProgressionReportPlan,
  createFunnelProgressionSourceSelections,
  createJourneyFunnelProgressionSourceSelections,
} from "@/lib/edge/analytics/engine/funnel-progression-report-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import {
  buildFunnelMembershipSqlPlan,
  buildFunnelSqlPlan,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-funnel-oracle";
import { compileScopedDatasetSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core-types";
import { queryFunnelAnalysis } from "@/lib/edge/analytics/providers/d1/internal/funnels";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract/filter-dsl";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "funnel-logical-report-site";
const WINDOW: QueryWindow = {
  startMs: 0,
  endExclusiveMs: 100_000,
  nowMs: 100_000,
  timeZone: "UTC",
};

function configFor(
  stepCount: number,
  scope: "session" | "visitor",
  conversionWindowMs = scope === "visitor" ? 86_400_000 : null,
) {
  return {
    filterDslVersion: 1,
    progressionScope: scope,
    conversionWindowMs,
    steps: Array.from({ length: stepCount }, (_, index) => ({
      id: `step-${index}`,
      filterDsl:
        index % 2 === 0
          ? `page.path eq "/step-${index}"`
          : `event.name eq "action-${index}"`,
    })),
  } satisfies FunnelConfigV2;
}

function seed(database: DatabaseSync, count: number): void {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const { site_pk: sitePk } = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { site_pk: number };
  for (let index = 0; index < count; index += 1) {
    const visitId = `visit-${index}`;
    const startedAt = 1_000 + index * 1_000;
    database
      .prepare(
        `INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname
        ) VALUES (?, ?, ?, 'visitor-a', 'session-a', 'complete', ?, ?, ?, 'example.test')`,
      )
      .run(visitId, SITE_ID, sitePk, startedAt, startedAt, `/step-${index}`);
    if (index % 2 !== 1) continue;

    const eventName = `action-${index}`;
    database
      .prepare(
        "INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at) VALUES (?, ?, ?, ?)",
      )
      .run(SITE_ID, sitePk, eventName, startedAt + 10);
    const { id: nameId } = database
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(sitePk, eventName) as { id: number };
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, node_count, value_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        `event-${index}`,
        SITE_ID,
        sitePk,
        visitId,
        nameId,
        startedAt + 10,
        startedAt + 10,
      );
  }
}

function fixtureSite(database: DatabaseSync): number {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  return Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
}

function insertFixtureVisit(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly visitId: string;
    readonly sessionId: string;
    readonly visitorId: string;
    readonly startedAt: number;
    readonly pathname: string;
    readonly title?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, title, hostname
      ) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?, 'example.test')`,
    )
    .run(
      input.visitId,
      SITE_ID,
      sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.pathname,
      input.title ?? "",
    );
}

function insertFixtureEvent(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly eventId: string;
    readonly visitId: string;
    readonly eventName: string;
    readonly occurredAt: number;
    readonly sequence?: number;
    readonly payload?: Readonly<Record<string, string>>;
  },
): number {
  database
    .prepare(
      `INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(site_pk, name) DO NOTHING`,
    )
    .run(SITE_ID, sitePk, input.eventName, input.occurredAt);
  const nameId = Number(
    (
      database
        .prepare(
          "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
        )
        .get(sitePk, input.eventName) as { readonly id: number }
    ).id,
  );
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventId,
      SITE_ID,
      sitePk,
      input.visitId,
      nameId,
      input.occurredAt,
      input.occurredAt,
      input.sequence ?? 0,
      Object.keys(input.payload ?? {}).length,
      Object.keys(input.payload ?? {}).length,
    );
  const eventPk = Number(
    (
      database
        .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
        .get(input.eventId) as { readonly event_pk: number }
    ).event_pk,
  );
  for (const [index, [path, value]] of Object.entries(
    input.payload ?? {},
  ).entries()) {
    database
      .prepare(
        `INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(site_pk, path) DO NOTHING`,
      )
      .run(SITE_ID, sitePk, path, input.occurredAt);
    const pathId = Number(
      (
        database
          .prepare(
            "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
          )
          .get(sitePk, path) as { readonly id: number }
      ).id,
    );
    const nodeId = index + 1;
    database
      .prepare(
        `INSERT INTO custom_event_json_nodes (
          event_pk, node_id, path_id, value_type, depth
        ) VALUES (?, ?, ?, 1, 1)`,
      )
      .run(eventPk, nodeId, pathId);
    database
      .prepare(
        `INSERT INTO custom_event_json_values (
          event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
          value_type, string_value, site_pk
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        eventPk,
        nodeId,
        SITE_ID,
        nameId,
        pathId,
        input.occurredAt,
        value,
        sitePk,
      );
  }
  return eventPk;
}

function configFromDsl(
  scope: "session" | "visitor",
  filters: readonly string[],
  conversionWindowMs = scope === "visitor" ? 100 : null,
): FunnelConfigV2 {
  return {
    filterDslVersion: 1,
    progressionScope: scope,
    conversionWindowMs,
    steps: filters.map((filterDsl, index) => ({
      id: `step-${index}`,
      filterDsl,
    })),
  };
}

function oldAnalysis(
  config: FunnelConfigV2,
  rows: readonly Record<string, unknown>[],
): FunnelAnalysis {
  const number = (value: unknown) => {
    const result = Number(value ?? 0);
    return Number.isFinite(result) && result > 0 ? Math.floor(result) : 0;
  };
  const counts = config.steps.map((step, index) => {
    const row = rows.find((candidate) => Number(candidate.stepIndex) === index);
    const sessions = number(row?.sessions);
    const visitors = number(row?.visitors);
    return {
      step,
      index,
      sessions,
      visitors,
      count: config.progressionScope === "session" ? sessions : visitors,
    };
  });
  const firstCount = counts[0]?.count ?? 0;
  const convertedCount = counts.at(-1)?.count ?? 0;
  let largestDropOffStepIndex: number | null = null;
  let largestDropOff = 0;
  const steps = counts.map((entry, index) => {
    const previous =
      index === 0 ? entry.count : (counts[index - 1]?.count ?? 0);
    const dropOffCount = index === 0 ? 0 : Math.max(0, previous - entry.count);
    if (index > 0 && dropOffCount > largestDropOff) {
      largestDropOff = dropOffCount;
      largestDropOffStepIndex = index;
    }
    return {
      stepId: entry.step.id,
      index,
      sessions: entry.sessions,
      visitors: entry.visitors,
      progression: {
        count: entry.count,
        conversionRate: firstCount > 0 ? entry.count / firstCount : 0,
        stepConversionRate: previous > 0 ? entry.count / previous : 0,
        dropOffCount,
        dropOffRate: previous > 0 ? dropOffCount / previous : 0,
      },
    };
  });
  return {
    progressionScope: config.progressionScope,
    steps,
    summary: {
      totalProgressions: firstCount,
      convertedProgressions: convertedCount,
      overallConversionRate: firstCount > 0 ? convertedCount / firstCount : 0,
      largestDropOffStepIndex,
    },
  };
}

function oldRows(
  database: DatabaseSync,
  config: FunnelConfigV2,
  filters: FilterDocument = EMPTY_FILTER_DOCUMENT,
  scope: "event" | "session" | "visitor" = "event",
  window: QueryWindow = WINDOW,
) {
  const plan =
    scopedFilterMetadata(filters)?.plan ??
    createScopedFilterPlan("funnel-analysis", filters, scope);
  if (!plan) throw new Error("funnel_test_empty_scope_unavailable");
  const dataset = compileScopedDatasetSql({
    filters,
    plan,
    siteIds: [SITE_ID],
    window,
  });
  const statement = buildFunnelSqlPlan(config, dataset, {
    allowHistoricalOverLimit: true,
  });
  return database
    .prepare(statement.sql)
    .all(...statement.bindings.map((binding) => binding.value)) as Record<
    string,
    unknown
  >[];
}

function oldRowsWithOfflinePreparedIdentityLiterals(
  database: DatabaseSync,
  config: FunnelConfigV2,
  filters: FilterDocument,
  window: QueryWindow,
): Record<string, unknown>[] {
  const metadata = scopedFilterMetadata(filters);
  const matches = metadata?.plan.advancedMatches;
  if (!metadata || !matches)
    throw new Error("funnel_test_prepared_matches_missing");
  const basePlan = createScopedFilterPlan(
    "funnel-analysis",
    EMPTY_FILTER_DOCUMENT,
    "event",
  );
  if (!basePlan) throw new Error("funnel_test_empty_scope_unavailable");
  const base = compileScopedDatasetSql({
    filters: EMPTY_FILTER_DOCUMENT,
    plan: basePlan,
    siteIds: [SITE_ID],
    window,
  });
  const inList = (
    ids: readonly { readonly siteId: string; readonly id: string }[],
  ) => {
    const unique = [
      ...new Set(
        ids.filter((item) => item.siteId === SITE_ID).map((item) => item.id),
      ),
    ];
    return unique.length === 0
      ? "SELECT CAST(NULL AS TEXT) WHERE 0"
      : unique.map((id) => `'${id.replaceAll("'", "''")}'`).join(", ");
  };
  const visitIds = inList(matches.visitIds ?? []);
  const eventIds = inList(matches.eventIds ?? []);
  const visitRelation = "funnel_test_prepared_visits";
  const eventRelation = "funnel_test_prepared_events";
  const sessionRelation = "funnel_test_prepared_sessions";
  const visitorRelation = "funnel_test_prepared_visitors";
  const ctes = `${base.ctes.trim()},
${visitRelation} AS (
  SELECT * FROM ${base.visitRelation}
  WHERE visit_id IN (${visitIds})
),
${eventRelation} AS (
  SELECT * FROM ${base.eventRelation}
  WHERE event_id IN (${eventIds})
),
${sessionRelation} AS (
  SELECT DISTINCT site_pk, session_id FROM ${visitRelation}
  WHERE TRIM(COALESCE(session_id, '')) != ''
  UNION
  SELECT DISTINCT site_pk, session_id FROM ${eventRelation}
  WHERE TRIM(COALESCE(session_id, '')) != ''
),
${visitorRelation} AS (
  SELECT DISTINCT site_pk, visitor_id FROM ${visitRelation}
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
  UNION
  SELECT DISTINCT site_pk, visitor_id FROM ${eventRelation}
  WHERE TRIM(COALESCE(visitor_id, '')) != ''
)`;
  const dataset = {
    ...base,
    ctes,
    visitRelation,
    eventRelation,
    sessionRelation,
    visitorRelation,
  };
  const statement = buildFunnelSqlPlan(config, dataset, {
    allowHistoricalOverLimit: true,
  });
  return database
    .prepare(statement.sql)
    .all(...statement.bindings.map((binding) => binding.value)) as Record<
    string,
    unknown
  >[];
}

function preparedPagePathFilters(
  scope: "event" | "session" | "visitor",
  siteIds: readonly string[] = [SITE_ID],
  source = 'page.path contains "/step-"',
  preparationWindow: QueryWindow = WINDOW,
) {
  const filter = parseFilterDsl(source, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("funnel-analysis", filter, scope);
  if (!plan) throw new Error("funnel_test_prepared_scope_unavailable");
  const time = createQueryTime(
    preparationWindow.startMs,
    preparationWindow.endExclusiveMs,
    preparationWindow.timeZone,
    preparationWindow.nowMs,
  );
  return attachScopedFilterMetadata(filter, {
    requestedScope: scope,
    resolvedScope: plan.scope,
    plan,
    time,
    siteIds,
  });
}

describe("Logical Funnel analysis report", () => {
  it("keeps the Journey no-fact compatibility base Page-only through progression", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    try {
      seed(database, 2);
      const filters = parseFilterDsl(
        'page.path eq "/step-0"',
        analyticsFilterRegistry,
      );
      expect(scopedFilterMetadata(filters)).toBeUndefined();
      const sources = createJourneyFunnelProgressionSourceSelections({
        siteId: SITE_ID,
        window: WINDOW,
        filters,
        entityScope: "visitor",
      });
      expect(sources.page.profile).toBe("direct-page-entity-only-compat-v1");
      const context = {
        subject: sources.page.subject,
        time: sources.page.time,
        scope: resolveAnalyticsScope(sources.page.scope),
        originOperation: "funnel-analysis" as const,
      };
      const builder = new LogicalPlanBuilder(context);
      const relations = appendFunnelProgressionRelations({
        builder,
        sources,
        config: configFor(2, "visitor", 5_000),
        throughStepIndex: 1,
      });
      const stepRows = relations.reachedSteps.map((relation, stepIndex) =>
        builder.project(relation, {
          stepIndex: builder.literal(stepIndex, {
            kind: "scalar",
            scalar: "number",
          }),
          identity: builder.slot(relation, "identity"),
        }),
      );
      const combined = builder.appendRows(stepRows, ["stepIndex", "identity"]);
      builder.output("journey-compatibility-reached", combined, [
        { name: "stepIndex", slot: "stepIndex" },
        { name: "identity", slot: "identity" },
      ]);
      const plan = builder.finish();
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_ID,
        time: plan.context.time,
      });
      const lowered = lowerer.lower(plan.outputs[0]!);
      const query = compileD1Query(
        lowerer.projectOutput(lowered, [
          { name: "stepIndex", slot: plan.outputs[0]!.fields[0]!.slot },
          { name: "identity", slot: plan.outputs[0]!.fields[1]!.slot },
        ]),
      );
      const actual = await createD1DatabaseClient(
        createSqliteD1Database(database, trace),
      ).all(query);
      expect(actual.results).toEqual([{ stepIndex: 0, identity: "visitor-a" }]);
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.bindings[0]?.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(
        new TextEncoder().encode(trace.preparedSql[0]!).length,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);

      const eventQualifiedTrace: SqliteD1Trace = {
        preparedSql: [],
        bindings: [],
      };
      const eventQualifiedSources =
        createJourneyFunnelProgressionSourceSelections({
          siteId: SITE_ID,
          window: WINDOW,
          filters: parseFilterDsl(
            'event.name eq "action-1"',
            analyticsFilterRegistry,
          ),
          entityScope: "visitor",
        });
      const eventQualifiedBuilder = new LogicalPlanBuilder({
        subject: eventQualifiedSources.page.subject,
        time: eventQualifiedSources.page.time,
        scope: resolveAnalyticsScope(eventQualifiedSources.page.scope),
        originOperation: "funnel-analysis",
      });
      const eventQualifiedProgression = appendFunnelProgressionRelations({
        builder: eventQualifiedBuilder,
        sources: eventQualifiedSources,
        config: configFor(2, "visitor", 5_000),
        throughStepIndex: 1,
      });
      const eventQualifiedStepRows = eventQualifiedProgression.reachedSteps.map(
        (relation, stepIndex) =>
          eventQualifiedBuilder.project(relation, {
            stepIndex: eventQualifiedBuilder.literal(stepIndex, {
              kind: "scalar",
              scalar: "number",
            }),
            identity: eventQualifiedBuilder.slot(relation, "identity"),
          }),
      );
      const eventQualifiedCombined = eventQualifiedBuilder.appendRows(
        eventQualifiedStepRows,
        ["stepIndex", "identity"],
      );
      eventQualifiedBuilder.output(
        "journey-event-qualified-compatibility",
        eventQualifiedCombined,
        [
          { name: "stepIndex", slot: "stepIndex" },
          { name: "identity", slot: "identity" },
        ],
      );
      const eventQualifiedPlan = eventQualifiedBuilder.finish();
      const eventQualifiedLowerer = new AnalyticsLogicalToDbLowerer(
        eventQualifiedPlan,
        { siteId: SITE_ID, time: eventQualifiedPlan.context.time },
      );
      const eventQualifiedOutput = eventQualifiedLowerer.lower(
        eventQualifiedPlan.outputs[0]!,
      );
      const eventQualifiedQuery = compileD1Query(
        eventQualifiedLowerer.projectOutput(eventQualifiedOutput, [
          {
            name: "stepIndex",
            slot: eventQualifiedPlan.outputs[0]!.fields[0]!.slot,
          },
          {
            name: "identity",
            slot: eventQualifiedPlan.outputs[0]!.fields[1]!.slot,
          },
        ]),
      );
      const eventQualifiedActual = await createD1DatabaseClient(
        createSqliteD1Database(database, eventQualifiedTrace),
      ).all(eventQualifiedQuery);
      expect(eventQualifiedActual.results).toEqual([
        { stepIndex: 0, identity: "visitor-a" },
      ]);
      expect(eventQualifiedTrace.preparedSql).toHaveLength(1);

      const factTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const factSources = createJourneyFunnelProgressionSourceSelections({
        siteId: SITE_ID,
        window: WINDOW,
        filters: parseFilterDsl("session.views gte 2", analyticsFilterRegistry),
        entityScope: "visitor",
      });
      expect(factSources.page.profile).toBe("prepared-scoped-reader-window-v1");
      const factBuilder = new LogicalPlanBuilder({
        subject: factSources.page.subject,
        time: factSources.page.time,
        scope: resolveAnalyticsScope(factSources.page.scope),
        originOperation: "funnel-analysis",
      });
      const factProgression = appendFunnelProgressionRelations({
        builder: factBuilder,
        sources: factSources,
        config: configFor(2, "visitor", 5_000),
        throughStepIndex: 1,
      });
      const factStepRows = factProgression.reachedSteps.map(
        (relation, stepIndex) =>
          factBuilder.project(relation, {
            stepIndex: factBuilder.literal(stepIndex, {
              kind: "scalar",
              scalar: "number",
            }),
            identity: factBuilder.slot(relation, "identity"),
          }),
      );
      const factCombined = factBuilder.appendRows(factStepRows, [
        "stepIndex",
        "identity",
      ]);
      factBuilder.output("journey-fact-progression", factCombined, [
        { name: "stepIndex", slot: "stepIndex" },
        { name: "identity", slot: "identity" },
      ]);
      const factPlan = factBuilder.finish();
      const factLowerer = new AnalyticsLogicalToDbLowerer(factPlan, {
        siteId: SITE_ID,
        time: factPlan.context.time,
      });
      const factOutput = factLowerer.lower(factPlan.outputs[0]!);
      const factQuery = compileD1Query(
        factLowerer.projectOutput(factOutput, [
          { name: "stepIndex", slot: factPlan.outputs[0]!.fields[0]!.slot },
          { name: "identity", slot: factPlan.outputs[0]!.fields[1]!.slot },
        ]),
      );
      const factActual = await createD1DatabaseClient(
        createSqliteD1Database(database, factTrace),
      ).all(factQuery);
      expect(factActual.results).toEqual([
        { stepIndex: 0, identity: "visitor-a" },
        { stepIndex: 1, identity: "visitor-a" },
      ]);
      expect(factTrace.preparedSql).toHaveLength(1);
      expect(factTrace.bindings[0]?.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(
        new TextEncoder().encode(factTrace.preparedSql[0]!).length,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      name: "missing steps",
      config: { ...configFor(2, "session"), steps: [] },
      error: "funnel_steps_required",
    },
    {
      name: "more than the historical step limit",
      config: configFor(13, "session"),
      error: "funnel_historical_step_limit_exceeded",
    },
    {
      name: "session conversion window",
      config: { ...configFor(2, "session"), conversionWindowMs: 1 },
      error: "session_funnel_conversion_window_must_be_null",
    },
    ...[null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((window) => ({
      name: `visitor conversion window ${String(window)}`,
      config: { ...configFor(2, "visitor"), conversionWindowMs: window },
      error: "visitor_funnel_conversion_window_must_be_positive",
    })),
    {
      name: "missing steps array",
      config: { ...configFor(2, "session"), steps: undefined },
      error: "funnel_steps_required",
    },
  ] as const)(
    "rejects invalid historical config: $name before SQL",
    async ({ config, error }) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      try {
        await expect(
          queryFunnelAnalysis(
            { DB: createSqliteD1Database(database, trace) } as unknown as Env,
            SITE_ID,
            WINDOW,
            EMPTY_FILTER_DOCUMENT,
            config as FunnelConfigV2,
          ),
        ).rejects.toThrow(error);
        expect(trace.preparedSql).toHaveLength(0);
      } finally {
        database.close();
      }
    },
  );

  it.each(["session", "visitor"] as const)(
    "keeps a one-step historical %s read legal without a reached witness",
    async (scope) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      try {
        seed(database, 1);
        const config = configFor(1, scope);
        const expected = oldAnalysis(config, oldRows(database, config));
        const actual = await queryFunnelAnalysis(
          { DB: createSqliteD1Database(database, trace) } as unknown as Env,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          config,
        );
        expect(actual).toEqual(expected);
        expect(actual.steps[0]?.progression.count).toBe(1);
        expect(trace.preparedSql).toHaveLength(1);
      } finally {
        database.close();
      }
    },
  );

  it("appends progression relations to a caller-owned builder and preserves legacy membership bags", async () => {
    const database = createMigratedDatabase();
    try {
      seed(database, 2);
      const config = configFor(2, "session");
      const sources = createFunnelProgressionSourceSelections({
        siteId: SITE_ID,
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
      });
      const context = {
        subject: sources.page.subject,
        time: sources.page.time,
        scope: resolveAnalyticsScope(sources.page.scope),
        originOperation: "funnel-analysis" as const,
      };
      const builder = new LogicalPlanBuilder(context);
      const relations = appendFunnelProgressionRelations({
        builder,
        sources,
        config,
        throughStepIndex: 1,
      });
      const reached = relations.reachedSteps[1]!;
      const membership = builder.project(reached, {
        identity: builder.slot(reached, "identity"),
        sessionId: builder.slot(reached, "sessionId"),
        visitorId: builder.slot(reached, "visitorId"),
      });
      builder.output("composed-funnel-membership", membership, [
        { name: "identity", slot: "identity" },
        { name: "sessionId", slot: "sessionId" },
        { name: "visitorId", slot: "visitorId" },
      ]);
      const plan = builder.finish();
      const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
        siteId: SITE_ID,
        time: plan.context.time,
      });
      const lowered = lowerer.lower(plan.outputs[0]!);
      const query = compileD1Query(
        lowerer.projectOutput(lowered, [
          { name: "identity", slot: plan.outputs[0]!.fields[0]!.slot },
          { name: "sessionId", slot: plan.outputs[0]!.fields[1]!.slot },
          { name: "visitorId", slot: plan.outputs[0]!.fields[2]!.slot },
        ]),
      );
      const actual = await createD1DatabaseClient(
        createSqliteD1Database(database),
      ).all(query);

      const oldDataset = compileScopedDatasetSql({
        filters: EMPTY_FILTER_DOCUMENT,
        plan: createScopedFilterPlan(
          "funnel-analysis",
          EMPTY_FILTER_DOCUMENT,
          "event",
        )!,
        siteIds: [SITE_ID],
        window: WINDOW,
      });
      const oldMembership = buildFunnelMembershipSqlPlan(
        config,
        oldDataset,
        1,
        { allowHistoricalOverLimit: true },
      );
      const oldSql = `WITH ${oldDataset.ctes.trim()},\n${oldMembership.ctes}\nSELECT ${oldMembership.identity} AS identity, session_id AS sessionId, visitor_id AS visitorId FROM ${oldMembership.relation}`;
      const expected = database
        .prepare(oldSql)
        .all(
          ...oldDataset.bindings
            .concat(oldMembership.bindings)
            .map((value) => value.value),
        ) as Array<Record<string, unknown>>;
      const sortRows = (rows: readonly Record<string, unknown>[]) =>
        [...rows].sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        );
      expect(
        sortRows(actual.results as Array<Record<string, unknown>>),
      ).toEqual(sortRows(expected));

      const wrongSubject = createSemanticSubjectDomain({
        origin: "site",
        siteIds: [`${SITE_ID}-other` as never],
      });
      const wrongBuilder = new LogicalPlanBuilder({
        ...context,
        subject: wrongSubject,
      });
      expect(() =>
        appendFunnelProgressionRelations({
          builder: wrongBuilder,
          sources,
          config,
          throughStepIndex: 1,
        }),
      ).toThrow("funnel_progression_builder_context_mismatch");

      const wrongTime = semanticTemporalDomainsFromQueryTime(
        createQueryTime(
          WINDOW.startMs + 1,
          WINDOW.endExclusiveMs,
          WINDOW.timeZone,
          WINDOW.nowMs,
        ),
      );
      const wrongTimeBuilder = new LogicalPlanBuilder({
        ...context,
        time: wrongTime,
      });
      expect(() =>
        appendFunnelProgressionRelations({
          builder: wrongTimeBuilder,
          sources,
          config,
          throughStepIndex: 1,
        }),
      ).toThrow("funnel_progression_builder_context_mismatch");

      const foreignBuilder = new LogicalPlanBuilder(context);
      expect(() => foreignBuilder.slot(reached, "identity")).toThrow(
        "logical_builder_foreign_relation_handle",
      );
    } finally {
      database.close();
    }
  });

  it("keeps Visitor anchoring greedy across sessions and enforces the exact conversion boundary", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    try {
      const sitePk = fixtureSite(database);
      insertFixtureVisit(database, sitePk, {
        visitId: "late-first",
        sessionId: "late-session-first",
        visitorId: "late-visitor",
        startedAt: 1_000,
        pathname: "/start",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "late-second",
        sessionId: "late-session-second",
        visitorId: "late-visitor",
        startedAt: 1_050,
        pathname: "/start",
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "late-advance",
        visitId: "late-second",
        eventName: "advance",
        occurredAt: 1_090,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "late-finish",
        visitId: "late-second",
        eventName: "finish",
        occurredAt: 1_101,
      });

      insertFixtureVisit(database, sitePk, {
        visitId: "boundary-visit",
        sessionId: "boundary-session",
        visitorId: "boundary-visitor",
        startedAt: 2_000,
        pathname: "/start",
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "boundary-advance",
        visitId: "boundary-visit",
        eventName: "advance",
        occurredAt: 2_050,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "boundary-finish",
        visitId: "boundary-visit",
        eventName: "finish",
        occurredAt: 2_100,
      });

      insertFixtureVisit(database, sitePk, {
        visitId: "cross-first",
        sessionId: "cross-session-first",
        visitorId: "cross-visitor",
        startedAt: 3_000,
        pathname: "/start",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "cross-second",
        sessionId: "cross-session-second",
        visitorId: "cross-visitor",
        startedAt: 3_020,
        pathname: "/event-owner",
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "cross-advance",
        visitId: "cross-second",
        eventName: "advance",
        occurredAt: 3_050,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "cross-finish",
        visitId: "cross-second",
        eventName: "finish",
        occurredAt: 3_100,
      });

      const config = configFromDsl("visitor", [
        'page.path eq "/start"',
        'event.name eq "advance"',
        'event.name eq "finish"',
      ]);
      const expected = oldAnalysis(config, oldRows(database, config));
      const actual = await queryFunnelAnalysis(
        { DB: createSqliteD1Database(database, trace) } as unknown as Env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        config,
      );
      expect(actual).toEqual(expected);
      expect(
        actual.steps.map(({ sessions, visitors, progression }) => [
          sessions,
          visitors,
          progression.count,
        ]),
      ).toEqual([
        [4, 3, 3],
        [3, 3, 3],
        [2, 2, 2],
      ]);
      expect(actual.summary.convertedProgressions).toBe(2);
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.bindings[0]?.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    } finally {
      database.close();
    }
  });

  it.each([
    {
      direction: "Page then Event",
      steps: ['page.path eq "/tie"', 'event.name eq "tie"'],
      conversions: 1,
    },
    {
      direction: "Event then Page",
      steps: ['event.name eq "tie"', 'page.path eq "/tie"'],
      conversions: 0,
    },
  ] as const)(
    "orders same-time Page and Event observations: $direction",
    async ({ steps, conversions }) => {
      const database = createMigratedDatabase();
      try {
        const sitePk = fixtureSite(database);
        insertFixtureVisit(database, sitePk, {
          visitId: "same-time-visit",
          sessionId: "same-time-session",
          visitorId: "same-time-visitor",
          startedAt: 1_000,
          pathname: "/tie",
        });
        insertFixtureEvent(database, sitePk, {
          eventId: "same-time-event",
          visitId: "same-time-visit",
          eventName: "tie",
          occurredAt: 1_000,
        });
        const config = configFromDsl("session", steps);
        const actual = await queryFunnelAnalysis(
          { DB: createSqliteD1Database(database) } as unknown as Env,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          config,
        );
        expect(actual).toEqual(oldAnalysis(config, oldRows(database, config)));
        expect(actual.steps[1]?.progression.count).toBe(conversions);
      } finally {
        database.close();
      }
    },
  );

  it("orders same-kind ties by Event sequence and source id without reusing one observation", async () => {
    const database = createMigratedDatabase();
    try {
      const sitePk = fixtureSite(database);
      for (const visitorId of ["sequence", "source", "single"]) {
        insertFixtureVisit(database, sitePk, {
          visitId: `${visitorId}-visit`,
          sessionId: `${visitorId}-session`,
          visitorId: `${visitorId}-visitor`,
          startedAt: 1_000,
          pathname: "/owner",
        });
      }
      insertFixtureEvent(database, sitePk, {
        eventId: "sequence-z",
        visitId: "sequence-visit",
        eventName: "repeat",
        occurredAt: 1_100,
        sequence: 8,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "sequence-a",
        visitId: "sequence-visit",
        eventName: "repeat",
        occurredAt: 1_100,
        sequence: 2,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "source-z",
        visitId: "source-visit",
        eventName: "repeat",
        occurredAt: 1_100,
        sequence: 7,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "source-a",
        visitId: "source-visit",
        eventName: "repeat",
        occurredAt: 1_100,
        sequence: 7,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "single-event",
        visitId: "single-visit",
        eventName: "repeat",
        occurredAt: 1_100,
        sequence: 1,
      });

      const config = configFromDsl("session", [
        'event.name eq "repeat"',
        'event.name eq "repeat"',
      ]);
      const actual = await queryFunnelAnalysis(
        { DB: createSqliteD1Database(database) } as unknown as Env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        config,
      );
      expect(actual).toEqual(oldAnalysis(config, oldRows(database, config)));
      expect(actual.steps.map((step) => step.progression.count)).toEqual([
        3, 2,
      ]);
    } finally {
      database.close();
    }
  });

  it("requires all payload predicates to match one Event and keeps global selection authoritative", async () => {
    const database = createMigratedDatabase();
    try {
      const sitePk = fixtureSite(database);
      insertFixtureVisit(database, sitePk, {
        visitId: "same-event-page",
        sessionId: "same-event-session",
        visitorId: "same-event-visitor",
        startedAt: 1_000,
        pathname: "/begin",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "split-event-page",
        sessionId: "split-event-session",
        visitorId: "split-event-visitor",
        startedAt: 2_000,
        pathname: "/begin",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "global-page",
        sessionId: "global-session",
        visitorId: "global-visitor",
        startedAt: 3_000,
        pathname: "/global",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "outside-page",
        sessionId: "global-session",
        visitorId: "global-visitor",
        startedAt: 3_010,
        pathname: "/outside",
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "same-event-payload",
        visitId: "same-event-page",
        eventName: "payload",
        occurredAt: 1_100,
        payload: { "/left": "yes", "/right": "yes" },
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "split-left-payload",
        visitId: "split-event-page",
        eventName: "payload",
        occurredAt: 2_100,
        payload: { "/left": "yes" },
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "split-right-payload",
        visitId: "split-event-page",
        eventName: "payload",
        occurredAt: 2_110,
        payload: { "/right": "yes" },
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "unselected-event",
        visitId: "outside-page",
        eventName: "blocked",
        occurredAt: 3_020,
      });

      const payloadConfig = configFromDsl("session", [
        'page.path eq "/begin"',
        'event.payload("/left") eq "yes" AND event.payload("/right") eq "yes"',
      ]);
      const payloadActual = await queryFunnelAnalysis(
        { DB: createSqliteD1Database(database) } as unknown as Env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        payloadConfig,
      );
      expect(payloadActual).toEqual(
        oldAnalysis(payloadConfig, oldRows(database, payloadConfig)),
      );
      expect(payloadActual.steps.map((step) => step.progression.count)).toEqual(
        [2, 1],
      );

      const prepared = preparedPagePathFilters(
        "event",
        [SITE_ID],
        'page.path eq "/global"',
      );
      const globalConfig = configFromDsl("session", [
        'page.path eq "/global"',
        'event.name eq "blocked"',
      ]);
      const globalActual = await queryFunnelAnalysis(
        { DB: createSqliteD1Database(database) } as unknown as Env,
        SITE_ID,
        WINDOW,
        prepared,
        globalConfig,
      );
      expect(globalActual).toEqual(
        oldAnalysis(
          globalConfig,
          oldRows(database, globalConfig, prepared, "event"),
        ),
      );
      expect(globalActual.steps.map((step) => step.progression.count)).toEqual([
        1, 0,
      ]);
    } finally {
      database.close();
    }
  });

  it("accepts a high-condition Funnel config within the compiled query budget", async () => {
    const database = createMigratedDatabase();
    try {
      const sitePk = fixtureSite(database);
      insertFixtureVisit(database, sitePk, {
        visitId: "high-condition-page",
        sessionId: "high-condition-session",
        visitorId: "high-condition-visitor",
        startedAt: 4_000,
        pathname: "/high-condition",
      });
      const payloadPaths = Array.from(
        { length: 24 },
        (_, index) => `/condition-${index}`,
      );
      insertFixtureEvent(database, sitePk, {
        eventId: "high-condition-event",
        visitId: "high-condition-page",
        eventName: "high-conditions",
        occurredAt: 4_100,
        payload: Object.fromEntries(payloadPaths.map((path) => [path, "yes"])),
      });
      const config = configFromDsl("session", [
        'page.path eq "/high-condition"',
        payloadPaths
          .map((path) => `event.payload(${JSON.stringify(path)}) eq "yes"`)
          .join(" AND "),
      ]);
      expect(() => validateFunnelConfigForWrite(config)).not.toThrow();

      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const actual = await queryFunnelAnalysis(
        { DB: createSqliteD1Database(database, trace) } as unknown as Env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        config,
      );
      expect(actual).toEqual(oldAnalysis(config, oldRows(database, config)));
      expect(actual.steps.map((step) => step.progression.count)).toEqual([
        1, 1,
      ]);
      expect(trace.preparedSql).toHaveLength(1);
      expect(
        new TextEncoder().encode(trace.preparedSql[0] ?? "").byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(trace.bindings[0]?.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    } finally {
      database.close();
    }
  });

  it("premerges distinct Page and Event-owner dependencies in either stage order", async () => {
    const database = createMigratedDatabase();
    try {
      const sitePk = fixtureSite(database);
      insertFixtureVisit(database, sitePk, {
        visitId: "entry-owner",
        sessionId: "dependency-session",
        visitorId: "dependency-visitor",
        startedAt: 1_000,
        pathname: "/entry",
        title: "owner",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "after-owner",
        sessionId: "dependency-session",
        visitorId: "dependency-visitor",
        startedAt: 2_000,
        pathname: "/after",
        title: "after",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "outside-window-owner",
        sessionId: "dependency-session",
        visitorId: "dependency-visitor",
        startedAt: -1_000,
        pathname: "/outside-window",
        title: "outside-owner",
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "checkout-entry",
        visitId: "entry-owner",
        eventName: "checkout",
        occurredAt: 1_500,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "checkout-after",
        visitId: "after-owner",
        eventName: "checkout",
        occurredAt: 2_010,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "checkout-outside-window-owner",
        visitId: "outside-window-owner",
        eventName: "outside-owner-event",
        occurredAt: 2_500,
      });

      const configs = [
        configFromDsl("session", [
          'page.path eq "/entry"',
          'event.name eq "checkout" AND page.title eq "owner"',
        ]),
        configFromDsl("session", [
          'event.name eq "checkout" AND page.title eq "owner"',
          'page.path eq "/after"',
        ]),
        configFromDsl("session", [
          'page.path eq "/entry"',
          'event.name eq "outside-owner-event" AND page.title eq "outside-owner"',
        ]),
      ];
      for (const config of configs) {
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const actual = await queryFunnelAnalysis(
          { DB: createSqliteD1Database(database, trace) } as unknown as Env,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          config,
        );
        expect(actual).toEqual(oldAnalysis(config, oldRows(database, config)));
        expect(actual.steps.map((step) => step.progression.count)).toEqual([
          1, 1,
        ]);
        expect(trace.preparedSql).toHaveLength(1);
        expect(trace.bindings[0]?.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      }
    } finally {
      database.close();
    }
  });

  it("supports mixed OR and NOT steps through the planned Page and Event domains", async () => {
    const database = createMigratedDatabase();
    try {
      const sitePk = fixtureSite(database);
      insertFixtureVisit(database, sitePk, {
        visitId: "mixed-first",
        sessionId: "mixed-session",
        visitorId: "mixed-visitor",
        startedAt: 1_000,
        pathname: "/mixed",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "mixed-next",
        sessionId: "mixed-session",
        visitorId: "mixed-visitor",
        startedAt: 1_100,
        pathname: "/later",
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "mixed-event",
        visitId: "mixed-first",
        eventName: "or-branch",
        occurredAt: 1_000,
      });
      const config = configFromDsl("session", [
        'page.path eq "/mixed" OR event.name eq "or-branch"',
        'NOT page.path eq "/excluded"',
      ]);
      const actual = await queryFunnelAnalysis(
        { DB: createSqliteD1Database(database) } as unknown as Env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        config,
      );
      expect(actual).toEqual(oldAnalysis(config, oldRows(database, config)));
      expect(actual.steps.map((step) => step.progression.count)).toEqual([
        1, 1,
      ]);
    } finally {
      database.close();
    }
  });

  it("evaluates legal Funnel entry and exit filters against the prepared Page bag", async () => {
    const database = createMigratedDatabase();
    try {
      const sitePk = fixtureSite(database);
      insertFixtureVisit(database, sitePk, {
        visitId: "raw-before",
        sessionId: "boundary-session",
        visitorId: "boundary-visitor",
        startedAt: 500,
        pathname: "/raw-before",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "selected-entry",
        sessionId: "boundary-session",
        visitorId: "boundary-visitor",
        startedAt: 1_000,
        pathname: "/selected-entry",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "selected-exit",
        sessionId: "boundary-session",
        visitorId: "boundary-visitor",
        startedAt: 2_000,
        pathname: "/selected-exit",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "raw-after",
        sessionId: "boundary-session",
        visitorId: "boundary-visitor",
        startedAt: 2_500,
        pathname: "/raw-after",
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "boundary-event",
        visitId: "selected-exit",
        eventName: "chosen",
        occurredAt: 2_100,
      });

      const prepared = preparedPagePathFilters(
        "event",
        [SITE_ID],
        'page.path eq "/selected-entry" OR page.path eq "/selected-exit"',
      );
      for (const boundary of ["entry", "exit"] as const) {
        const config = configFromDsl("session", [
          'page.path eq "/selected-entry"',
          `event.name eq "chosen" AND session.${boundary}Path eq "/selected-${boundary}"`,
        ]);
        const actual = await queryFunnelAnalysis(
          { DB: createSqliteD1Database(database) } as unknown as Env,
          SITE_ID,
          WINDOW,
          prepared,
          config,
        );
        expect(actual).toEqual(
          oldAnalysis(config, oldRows(database, config, prepared, "event")),
        );
        expect(actual.steps.map((step) => step.progression.count)).toEqual([
          1, 1,
        ]);
      }
    } finally {
      database.close();
    }
  });

  it("deduplicates prepared identities and uses the current report window with previous-window proof", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const previousWindow: QueryWindow = {
      startMs: -2_000,
      endExclusiveMs: 0,
      nowMs: 0,
      timeZone: "UTC",
    };
    try {
      const sitePk = fixtureSite(database);
      insertFixtureVisit(database, sitePk, {
        visitId: "prepared-current-hit",
        sessionId: "prepared-current-session",
        visitorId: "prepared-current-visitor",
        startedAt: 1_000,
        pathname: "/anchor",
      });
      insertFixtureVisit(database, sitePk, {
        visitId: "prepared-previous-only",
        sessionId: "prepared-previous-session",
        visitorId: "prepared-previous-visitor",
        startedAt: -1_000,
        pathname: "/anchor",
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "prepared-current-event",
        visitId: "prepared-current-hit",
        eventName: "finish",
        occurredAt: 1_100,
      });
      insertFixtureEvent(database, sitePk, {
        eventId: "prepared-previous-event",
        visitId: "prepared-previous-only",
        eventName: "finish",
        occurredAt: -900,
      });

      const plan = createScopedFilterPlan(
        "funnel-analysis",
        EMPTY_FILTER_DOCUMENT,
        "event",
      )!;
      const visitIds = Array.from({ length: 64 }, (_unused, index) => ({
        siteId: SITE_ID,
        id:
          index % 8 < 2
            ? "prepared-current-hit"
            : index % 8 === 2
              ? "prepared-previous-only"
              : `prepared-missing-${index % 4}`,
      }));
      const eventIds = Array.from({ length: 64 }, (_unused, index) => ({
        siteId: SITE_ID,
        id:
          index % 8 < 2
            ? "prepared-current-event"
            : index % 8 === 2
              ? "prepared-previous-event"
              : `prepared-missing-event-${index % 4}`,
      }));
      const filters = attachScopedFilterMetadata(EMPTY_FILTER_DOCUMENT, {
        requestedScope: "event",
        resolvedScope: plan.scope,
        plan: {
          ...plan,
          advancedMatches: { visitIds, eventIds },
        },
        time: createQueryTime(
          previousWindow.startMs,
          previousWindow.endExclusiveMs,
          previousWindow.timeZone,
          previousWindow.nowMs,
        ),
        siteIds: [SITE_ID],
      });
      const config = configFromDsl("session", [
        'page.path eq "/anchor"',
        'event.name eq "finish"',
      ]);
      const expected = oldAnalysis(
        config,
        oldRowsWithOfflinePreparedIdentityLiterals(
          database,
          config,
          filters,
          WINDOW,
        ),
      );
      const actual = await queryFunnelAnalysis(
        { DB: createSqliteD1Database(database, trace) } as unknown as Env,
        SITE_ID,
        WINDOW,
        filters,
        config,
      );
      expect(actual).toEqual(expected);
      expect(actual.steps.map((step) => step.progression.count)).toEqual([
        1, 1,
      ]);
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.bindings[0]?.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    } finally {
      database.close();
    }
  });

  it.each([
    ["session", 2],
    ["visitor", 2],
    ["session", 10],
    ["visitor", 10],
    ["session", 12],
    ["visitor", 12],
  ] as const)(
    "matches the frozen report for %s with %i steps",
    async (scope, count) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      try {
        seed(database, count);
        const config = configFor(count, scope);
        const expected = oldAnalysis(config, oldRows(database, config));
        const actual = await queryFunnelAnalysis(
          { DB: createSqliteD1Database(database, trace) } as unknown as Env,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          config,
        );
        expect(actual).toEqual(expected);
        expect(actual.steps).toHaveLength(count);
        expect(actual.steps.every((step) => step.progression.count > 0)).toBe(
          true,
        );
        expect(trace.preparedSql).toHaveLength(1);
        expect(
          new TextEncoder().encode(trace.preparedSql[0] ?? "").byteLength,
        ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(trace.bindings[0]?.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      } finally {
        database.close();
      }
    },
  );

  const preparedScopeCases = (["event", "session", "visitor"] as const).flatMap(
    (globalScope) =>
      (["session", "visitor"] as const).flatMap((progressionScope) =>
        [3, 10, 12].map((count) => ({
          globalScope,
          progressionScope,
          count,
        })),
      ),
  );
  const runPreparedScopeCase = async ({
    globalScope,
    progressionScope,
    count,
  }: (typeof preparedScopeCases)[number]) => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    try {
      seed(database, count);
      const config = configFor(count, progressionScope);
      const filters = preparedPagePathFilters(globalScope);
      const expected = oldAnalysis(
        config,
        oldRows(database, config, filters, globalScope),
      );
      const actual = await queryFunnelAnalysis(
        { DB: createSqliteD1Database(database, trace) } as unknown as Env,
        SITE_ID,
        WINDOW,
        filters,
        config,
      );

      expect(actual).toEqual(expected);
      expect(actual.steps).toHaveLength(count);
      expect(actual.steps.every((step) => step.progression.count > 0)).toBe(
        true,
      );
      expect(trace.preparedSql).toHaveLength(1);
      expect(
        new TextEncoder().encode(trace.preparedSql[0] ?? "").byteLength,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(trace.bindings[0]?.length).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
    } finally {
      database.close();
    }
  };
  const ordinaryPreparedScopeCases = preparedScopeCases.filter(
    ({ globalScope, count }) => globalScope !== "event" || count !== 12,
  );
  const measuredLargePreparedScopeCases = preparedScopeCases.filter(
    ({ globalScope, count }) => globalScope === "event" && count === 12,
  );

  it.each(ordinaryPreparedScopeCases)(
    "matches prepared $globalScope scope for $progressionScope progression with $count steps",
    async (testCase) => runPreparedScopeCase(testCase),
  );

  // These rows include both the frozen oracle and fresh query; under V8 they
  // take about 5.3–5.5s, so only these two cases use a 10s test budget.
  it.each(measuredLargePreparedScopeCases)(
    "matches prepared $globalScope scope for $progressionScope progression with $count steps",
    async (testCase) => runPreparedScopeCase(testCase),
    10_000,
  );

  it.each(["session", "visitor"] as const)(
    "keeps %s progression site-local when another authorized site reuses its identity",
    async (progressionScope) => {
      const database = createMigratedDatabase();
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const otherSiteId = `${SITE_ID}-other`;
      try {
        seed(database, 1);
        database
          .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
          .run(otherSiteId);
        const otherSitePk = Number(
          (
            database
              .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
              .get(otherSiteId) as { site_pk: number }
          ).site_pk,
        );
        database
          .prepare(
            `INSERT INTO visits (
              visit_id, site_id, site_pk, visitor_id, session_id, status,
              started_at, last_activity_at, pathname, hostname
            ) VALUES ('other-visit-1', ?, ?, 'visitor-a', 'session-a', 'complete', 2000, 2000, '/step-1', 'example.test')`,
          )
          .run(otherSiteId, otherSitePk);
        database
          .prepare(
            "INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at) VALUES (?, ?, 'action-1', 2010)",
          )
          .run(otherSiteId, otherSitePk);
        const nameId = Number(
          (
            database
              .prepare(
                "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'action-1'",
              )
              .get(otherSitePk) as { id: number }
          ).id,
        );
        database
          .prepare(
            `INSERT INTO custom_events (
              event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
              received_at, node_count, value_count
            ) VALUES ('other-event-1', ?, ?, 'other-visit-1', ?, 2010, 2010, 0, 0)`,
          )
          .run(otherSiteId, otherSitePk, nameId);

        const config = configFor(2, progressionScope);
        const filters = preparedPagePathFilters("event", [
          SITE_ID,
          otherSiteId,
        ]);
        const expected = oldAnalysis(
          config,
          oldRows(database, config, filters, "event"),
        );
        const actual = await queryFunnelAnalysis(
          { DB: createSqliteD1Database(database, trace) } as unknown as Env,
          SITE_ID,
          WINDOW,
          filters,
          config,
        );
        expect(actual).toEqual(expected);
        expect(actual.steps.map((step) => step.progression.count)).toEqual([
          1, 0,
        ]);
        expect(trace.bindings[0]?.length).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      } finally {
        database.close();
      }
    },
  );

  it("rejects a Funnel target site outside prepared authorization", async () => {
    const database = createMigratedDatabase();
    try {
      await expect(
        queryFunnelAnalysis(
          { DB: createSqliteD1Database(database) } as unknown as Env,
          SITE_ID,
          WINDOW,
          preparedPagePathFilters("event", [`${SITE_ID}-other`]),
          configFor(2, "session"),
        ),
      ).rejects.toThrow("subject_outside_prepared_authorization");
    } finally {
      database.close();
    }
  });
});
