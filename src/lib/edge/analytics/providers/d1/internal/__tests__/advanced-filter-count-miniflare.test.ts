import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

import {
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  type DatabaseQueryObservation,
  registerDatabaseQueryObserver,
} from "@/lib/db";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as countSupport from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-support";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as siteCoverageModule from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-site-coverage";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as filterEvaluator from "@/lib/filter-contract/filter-evaluator";

const SITE_ID = "wave75-count-miniflare-site";
const CAPTURED_AT_MS = 31_000;
const ACTIVITIES = 20_000;
const SCENARIOS = [
  {
    name: "small",
    startMs: 0,
    endExclusiveMs: 1_000,
    firstIndex: 0,
    count: 8,
    targetSessionId: "wave75-count-small-selected",
  },
  {
    name: "medium-selective",
    startMs: 1_000,
    endExclusiveMs: 3_000,
    firstIndex: 8,
    count: 1_024,
    targetSessionId: "wave75-count-medium-selected",
  },
  {
    name: "near-cap",
    startMs: 5_000,
    endExclusiveMs: 30_000,
    firstIndex: 1_032,
    count: ACTIVITIES - 1_032,
    targetSessionId: "wave75-count-near-cap-selected",
  },
] as const;
const ACTIVE_SCENARIOS =
  process.env.INSIGHTFLARE_WAVE77_SMALL_ONLY === "1"
    ? SCENARIOS.filter((scenario) => scenario.name === "small")
    : process.env.INSIGHTFLARE_WAVE78_MEDIUM_SELECTIVE_ONLY === "1"
      ? SCENARIOS.filter((scenario) => scenario.name === "medium-selective")
      : SCENARIOS;
const MEDIUM_DENSE_EVENT_COUNT =
  ACTIVE_SCENARIOS.find((scenario) => scenario.name === "medium-selective")
    ?.count ?? 0;

interface MiniflareRead {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly resultCount: number;
  readonly rowsRead: number | null;
  readonly rowsWritten: number | null;
  readonly dbDurationMs: number | null;
  readonly wallMs: number;
}

function tracedDatabase(database: D1Database) {
  const reads: MiniflareRead[] = [];
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
    bindings: readonly (string | number | null)[],
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind")
          return (...values: Array<string | number | null>) =>
            wrap(target.bind(...values), sql, values);
        if (property === "all")
          return async (...args: unknown[]) => {
            const startedAt = performance.now();
            const result = (await Reflect.apply(
              Reflect.get(target, property, target) as (
                ...input: unknown[]
              ) => unknown,
              target,
              args,
            )) as {
              readonly results?: readonly unknown[];
              readonly meta?: {
                readonly rows_read?: unknown;
                readonly rows_written?: unknown;
                readonly duration?: unknown;
                readonly timings?: { readonly sql_duration_ms?: unknown };
              };
            };
            const wallMs = performance.now() - startedAt;
            const sqlDuration = result.meta?.timings?.sql_duration_ms;
            const duration = result.meta?.duration;
            reads.push({
              sql,
              bindings,
              resultCount: result.results?.length ?? 0,
              rowsRead:
                typeof result.meta?.rows_read === "number"
                  ? result.meta.rows_read
                  : null,
              rowsWritten:
                typeof result.meta?.rows_written === "number"
                  ? result.meta.rows_written
                  : null,
              dbDurationMs:
                typeof sqlDuration === "number"
                  ? sqlDuration
                  : typeof duration === "number"
                    ? duration
                    : null,
              wallMs,
            });
            return result;
          };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const observedDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql), sql, []);
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: observedDatabase, reads };
}

async function applySchema(database: D1Database): Promise<void> {
  const schema = readFileSync(
    resolve(process.cwd(), "docs/schema.sql"),
    "utf8",
  );
  const statements = unstable_splitSqlQuery(schema).map((sql) =>
    database.prepare(sql),
  );
  for (let index = 0; index < statements.length; index += 50)
    await database.batch(statements.slice(index, index + 50));
}

async function seedFixture(database: D1Database): Promise<void> {
  await database.batch([
    database
      .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
      .bind("wave75-count-user", "wave75-count@example.test"),
    database
      .prepare(
        "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
      )
      .bind(
        "wave75-count-team",
        "Wave75 test",
        "wave75-count-team",
        "wave75-count-user",
      ),
    database
      .prepare("INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)")
      .bind(1, SITE_ID),
    database
      .prepare(
        "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(SITE_ID, "wave75-count-team", "Wave75 test", "example.test", 0),
  ]);

  const activityLimit = Math.max(
    ...ACTIVE_SCENARIOS.map((scenario) => scenario.firstIndex + scenario.count),
  );
  for (let offset = 0; offset < activityLimit; offset += 1_000) {
    const end = Math.min(activityLimit, offset + 1_000);
    const sql = `
      WITH RECURSIVE counter(n) AS (
        SELECT ${offset}
        UNION ALL
        SELECT n + 1 FROM counter WHERE n + 1 < ${end}
      ), activity AS (
        SELECT n,
          CASE
            WHEN n < 8 THEN 100 + n
            WHEN n < 1032 THEN 1000 + n - 8
            ELSE 5000 + n - 1032
          END AS started_at,
          CASE n
            WHEN 0 THEN 'wave75-count-small-selected'
            WHEN 8 THEN 'wave75-count-medium-selected'
            WHEN 1032 THEN 'wave75-count-near-cap-selected'
            ELSE 'wave75-count-session-' || n
          END AS session_id
        FROM counter
      )
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, site_pk
      )
      SELECT
        'wave75-count-visit-' || n,
        '${SITE_ID}',
        'wave75-count-visitor-' || n,
        session_id,
        'closed',
        started_at,
        started_at,
        CASE WHEN n = 0 THEN '/wave78-count-selected' ELSE '/wave75-count' END,
        'example.test',
        1
      FROM activity
    `;
    await database.prepare(sql).run();
  }

  await database.batch([
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(1, SITE_ID, "purchase", CAPTURED_AT_MS, 1),
  ]);
  const eventStatements = ACTIVE_SCENARIOS.map((scenario, eventIndex) => {
    const startedAt = scenario.startMs + (scenario.name === "small" ? 100 : 0);
    return database
      .prepare(
        "INSERT INTO custom_events (event_pk, event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        eventIndex + 1,
        `wave75-count-event-${scenario.name}`,
        SITE_ID,
        `wave75-count-visit-${scenario.firstIndex}`,
        1,
        startedAt + 1,
        startedAt + 2,
        0,
        0,
        1,
      );
  });
  await database.batch(eventStatements);

  const extraDenseEventCount = Math.max(0, MEDIUM_DENSE_EVENT_COUNT - 1);
  for (let offset = 0; offset < extraDenseEventCount; offset += 100) {
    const end = Math.min(extraDenseEventCount, offset + 100);
    const denseEvents = Array.from({ length: end - offset }, (_, index) => {
      const denseIndex = offset + index + 1;
      const occurredAt = 1_001 + denseIndex;
      return database
        .prepare(
          "INSERT INTO custom_events (event_pk, event_id, site_id, visit_id, event_name_id, occurred_at, received_at, node_count, value_count, site_pk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          ACTIVE_SCENARIOS.length + denseIndex,
          `wave75-count-event-medium-dense-${denseIndex}`,
          SITE_ID,
          "wave75-count-visit-8",
          1,
          occurredAt,
          occurredAt + 1,
          0,
          0,
          1,
        );
    });
    await database.batch(denseEvents);
  }
}

function requestInput(time: QueryTime, filterDsl: string) {
  const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("overview", document, "session");
  if (!plan) throw new Error("wave75_count_scope_plan_missing");
  const filters = attachScopedFilterMetadata(document, {
    requestedScope: "session",
    resolvedScope: "session",
    plan,
    time,
    siteIds: [SITE_ID],
  });
  return {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    filters,
    scopePreference: "session" as const,
    scopePlan: plan,
    time,
  };
}

function observeRuntimeQueries() {
  const observations: DatabaseQueryObservation[] = [];
  let completions: Promise<void>[] = [];
  return {
    observations,
    observer: {
      begin({
        operation,
        statementCount,
      }: {
        operation: string;
        statementCount: number;
      }) {
        let release!: () => void;
        completions.push(
          new Promise<void>((resolveCompletion) => {
            release = resolveCompletion;
          }),
        );
        return {
          statementIndexes:
            operation === "batch"
              ? Array.from(
                  { length: Math.min(statementCount, 32) },
                  (_, index) => index,
                )
              : [0],
          includeBatchSummary: false,
          record(event: DatabaseQueryObservation) {
            observations.push(event);
          },
          release,
        };
      },
    },
    reset() {
      observations.length = 0;
      completions = [];
    },
    async settle() {
      await Promise.all(completions);
      completions = [];
    },
  };
}

type AdvancedCountExecutionMode = "combined" | "split";

function expectAdvancedCountExecutionMode(
  result: { readonly observerTags: readonly string[] },
  expected: AdvancedCountExecutionMode,
): void {
  const combinedTags = result.observerTags.filter((tag) =>
    tag.endsWith("count_combined"),
  );
  const guardTags = result.observerTags.filter((tag) =>
    tag.endsWith("count_guard"),
  );
  const matchTags = result.observerTags.filter((tag) =>
    tag.endsWith("count_match"),
  );
  expect(combinedTags).toHaveLength(expected === "combined" ? 1 : 0);
  expect(guardTags).toHaveLength(expected === "split" ? 1 : 0);
  expect(matchTags).toHaveLength(expected === "split" ? 1 : 0);
}

function expectAdvancedCountRequestAccounting(
  result: {
    readonly observerTags: readonly string[];
    readonly statements: readonly {
      readonly tag: string | null;
      readonly rowsRead: number | null;
      readonly rowsWritten: number | null;
    }[];
    readonly siteCoverageRequests: readonly {
      readonly siteIds: readonly string[];
    }[];
    readonly siteCoverageStatementCount: number;
    readonly countMatcherStatementCount: number;
    readonly otherReadCount: number;
    readonly statementCount: number;
    readonly rowsRead: number;
  },
  expected: {
    readonly statementCount: number;
    readonly otherReadCount: number;
  },
): void {
  expectAdvancedCountExecutionMode(result, "combined");
  expect(result.siteCoverageRequests).toEqual([{ siteIds: [SITE_ID] }]);
  expect(result.siteCoverageStatementCount).toBe(1);
  expect(result.countMatcherStatementCount).toBe(1);
  expect(result.otherReadCount).toBe(expected.otherReadCount);
  expect(result.statementCount).toBe(expected.statementCount);
  expect(result.rowsRead).toBe(
    result.statements.reduce(
      (total, statement) => total + (statement.rowsRead ?? 0),
      0,
    ),
  );
  expect(result.statements.every(({ rowsWritten }) => rowsWritten === 0)).toBe(
    true,
  );
}

function advancedCountMatcher(
  result: {
    readonly statements: readonly {
      readonly tag: string | null;
      readonly sql: string;
      readonly bindingCount: number;
      readonly queryPlan?: readonly string[];
    }[];
  },
  expected: AdvancedCountExecutionMode,
) {
  const matcherStage =
    expected === "combined" ? "count_combined" : "count_match";
  return result.statements.find((statement) =>
    statement.tag?.endsWith(matcherStage),
  );
}

describe("advanced count SQL actual Miniflare D1 cost", () => {
  it("compares the SQL slice with the same-DSL JavaScript compatibility path on small, selective, and near-cap data", async () => {
    const configDirectory = mkdtempSync(
      join(tmpdir(), "advanced-count-miniflare-"),
    );
    const configPath = join(configDirectory, "wrangler.toml");
    writeFileSync(
      configPath,
      [
        'name = "advanced-count-miniflare-test"',
        'compatibility_date = "2026-03-01"',
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "advanced_count_cost_test"',
        'database_id = "local-test"',
        "",
      ].join("\n"),
    );
    let disposePlatform: (() => Promise<void>) | undefined;
    const originalClassifier = countSupport.classifyAdvancedCountFilter;
    let forceCompatibilityClassifier = false;
    let compatibilityClassifierOverrideCount = 0;
    const classifierSpy = vi
      .spyOn(countSupport, "classifyAdvancedCountFilter")
      .mockImplementation((document, scope) => {
        const support = originalClassifier(document, scope);
        if (!forceCompatibilityClassifier || support.kind !== "supported")
          return support;
        compatibilityClassifierOverrideCount += 1;
        return {
          kind: "unsupported",
          path: support.path,
          code: "wave92_compatibility_classifier_comparison",
          reason:
            "Test-only comparison routes the identical Filter document through the current JavaScript compatibility evaluator; it does not reproduce the historical classifier or historical SQL implementation.",
        };
      });
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    const siteCoverageSpy = vi.spyOn(siteCoverageModule, "siteCoverage");
    const measurements: Array<Record<string, unknown>> = [];
    const runEvidence: Array<Record<string, unknown>> = [];
    const growthPoints: Array<{
      readonly scenario: string;
      readonly activities: number;
      readonly rowsRead: number;
    }> = [];
    const evidencePath = process.env.INSIGHTFLARE_WAVE92D_EVIDENCE_PATH;
    let evidenceFileCreated = false;
    const persistEvidence = (failure?: unknown) => {
      if (!evidencePath) return;
      const serializedFailure =
        failure === undefined
          ? null
          : failure instanceof Error
            ? {
                name: failure.name,
                message: failure.message,
                stack: failure.stack,
              }
            : String(failure);
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            runEvidence,
            growthPoints,
            measurements,
            failure: serializedFailure,
          },
          null,
          2,
        ) + "\n",
        {
          encoding: "utf8",
          flag: evidenceFileCreated ? "w" : "wx",
        },
      );
      evidenceFileCreated = true;
    };
    try {
      const platform = await getPlatformProxy<Env>({
        configPath,
        envFiles: [],
        persist: false,
        remoteBindings: false,
      });
      disposePlatform = platform.dispose;
      await applySchema(platform.env.DB);
      await seedFixture(platform.env.DB);
      const nulPathname = "/café/😀%_\\Suffix\u0000tail";
      await platform.env.DB.prepare(
        "UPDATE visits SET pathname = ? WHERE visit_id = ?",
      )
        .bind(nulPathname, "wave75-count-visit-1")
        .run();
      const pageTitle = "\u2003Wave80 Café\u00a0";
      const pageQuery = "\u2003?utm=wave80\u00a0";
      const pageHash = "\u2003#Unicode\u00a0";
      await platform.env.DB.prepare(
        "UPDATE visits SET title = ?, query_string = ?, hash_fragment = ? WHERE visit_id = ?",
      )
        .bind(pageTitle, pageQuery, pageHash, "wave75-count-visit-1")
        .run();
      await platform.env.DB.prepare(
        "UPDATE visits SET pathname = ? WHERE visit_id = ?",
      )
        .bind("/wave78-count-medium-selected", "wave75-count-visit-8")
        .run();
      await platform.env.DB.prepare(
        "UPDATE visits SET duration_ms = ?, perf_cls = ? WHERE visit_id = ?",
      )
        .bind(10, 0.75, "wave75-count-visit-1")
        .run();

      const trace = tracedDatabase(platform.env.DB);
      const runtimeTrace = observeRuntimeQueries();
      registerDatabaseQueryObserver(trace.database, runtimeTrace.observer);
      const env = {
        ...platform.env,
        DB: trace.database,
        DAILY_SALT_SECRET: "wave75-count-miniflare-secret",
        INGEST_DO: {} as DurableObjectNamespace,
      } as unknown as Env;

      for (const scenario of ACTIVE_SCENARIOS) {
        const time = createQueryTime(
          scenario.startMs,
          scenario.endExclusiveMs,
          "UTC",
          CAPTURED_AT_MS,
        );
        const run = async (filterDsl: string, includeAllQueryPlans = false) => {
          trace.reads.length = 0;
          runtimeTrace.reset();
          const siteCoverageCallStart = siteCoverageSpy.mock.calls.length;
          const evaluatorCallStart = evaluatorSpy.mock.calls.length;
          const classifierOverrideStart = compatibilityClassifierOverrideCount;
          const comparisonMode = forceCompatibilityClassifier
            ? "same-dsl-compatibility-classifier-unsupported"
            : "current-classifier";
          const diagnostics = createD1ReadDiagnostics();
          const middlewareStartedAt = performance.now();
          let prepared: ReturnType<typeof requestInput>;
          try {
            prepared = (await d1AdvancedFilterMiddleware(env, diagnostics)(
              "performance",
              requestInput(time, filterDsl),
              async (input) => input,
            )) as ReturnType<typeof requestInput>;
          } catch (error) {
            let observerSettleError: unknown;
            try {
              await runtimeTrace.settle();
            } catch (settleError) {
              observerSettleError =
                settleError instanceof Error
                  ? {
                      name: settleError.name,
                      message: settleError.message,
                      stack: settleError.stack,
                    }
                  : String(settleError);
            }
            runEvidence.push({
              scenario: scenario.name,
              filterDsl,
              comparisonMode,
              classifierOverrideCount:
                compatibilityClassifierOverrideCount - classifierOverrideStart,
              evaluatorCallCount:
                evaluatorSpy.mock.calls.length - evaluatorCallStart,
              thrown:
                error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      stack: error.stack,
                    }
                  : String(error),
              observerSettleError: observerSettleError ?? null,
              statements: trace.reads.map((read, index) => ({
                ...read,
                observation: runtimeTrace.observations[index] ?? null,
              })),
              observations: [...runtimeTrace.observations],
            });
            persistEvidence(error);
            throw error;
          }
          const middlewareWallMs = performance.now() - middlewareStartedAt;
          await runtimeTrace.settle();
          const identities = (
            prepared.scopePlan?.advancedMatches?.entityIds ?? []
          )
            .map(({ id }) => id)
            .sort();
          const statementMeasurements = [];
          for (const [index, read] of trace.reads.entries()) {
            const observation = runtimeTrace.observations[index];
            const sqlBytes = Buffer.byteLength(read.sql, "utf8");
            const tag = observation?.tag ?? null;
            const queryPlan =
              tag?.endsWith("count_match") ||
              tag?.endsWith("count_combined") ||
              includeAllQueryPlans
                ? (
                    await platform.env.DB.prepare(
                      `EXPLAIN QUERY PLAN ${read.sql}`,
                    )
                      .bind(...read.bindings)
                      .all<{ readonly detail: string }>()
                  ).results.map(({ detail }) => detail)
                : undefined;
            statementMeasurements.push({
              tag: observation?.tag ?? null,
              sql: read.sql,
              bindings: read.bindings,
              sqlSha256: createHash("sha256").update(read.sql).digest("hex"),
              physicalPlanHash: observation?.physicalPlanHash ?? null,
              sqlBytes,
              bindingCount: read.bindings.length,
              rowsRead: read.rowsRead,
              rowsWritten: read.rowsWritten,
              resultRows: read.resultCount,
              durationMs: read.dbDurationMs,
              wallMs: read.wallMs,
              ...(queryPlan ? { queryPlan } : {}),
            });
          }
          const siteCoverageRequests = siteCoverageSpy.mock.calls
            .slice(siteCoverageCallStart)
            .map(([, siteIds]) => ({ siteIds: [...siteIds] }));
          // This fixture has one authorized site, so each nonempty request is
          // one siteCoverage SQL statement (siteCoverage chunks at 90 sites).
          const siteCoverageStatementCount = siteCoverageRequests.reduce(
            (total, { siteIds }) => total + (siteIds.length === 0 ? 0 : 1),
            0,
          );
          const observerTags = runtimeTrace.observations.map(
            ({ tag }) => tag ?? "",
          );
          const countMatcherStatementCount = observerTags.filter(
            (tag) =>
              tag.endsWith("count_guard") ||
              tag.endsWith("count_match") ||
              tag.endsWith("count_combined"),
          ).length;
          const otherReadCount =
            statementMeasurements.length -
            siteCoverageStatementCount -
            countMatcherStatementCount;
          const result = {
            identities,
            rowsRead: diagnostics.rowsRead,
            statementCount: statementMeasurements.length,
            returnedRows: statementMeasurements.reduce(
              (total, statement) => total + statement.resultRows,
              0,
            ),
            middlewareWallMs,
            fallbackReason: diagnostics.advancedCountSqlFallbackReason ?? null,
            statements: statementMeasurements,
            observerTags,
            siteCoverageRequests,
            siteCoverageStatementCount,
            countMatcherStatementCount,
            otherReadCount,
          };
          runEvidence.push({
            scenario: scenario.name,
            filterDsl,
            comparisonMode,
            classifierOverrideCount:
              compatibilityClassifierOverrideCount - classifierOverrideStart,
            evaluatorCallCount:
              evaluatorSpy.mock.calls.length - evaluatorCallStart,
            result,
          });
          persistEvidence();
          expect(diagnostics.rowsReadAvailable).toBe(true);
          expect(diagnostics.rowsRead).toBe(
            statementMeasurements.reduce(
              (total, statement) => total + (statement.rowsRead ?? 0),
              0,
            ),
          );
          for (const statement of statementMeasurements) {
            expect(statement.sqlBytes).toBeLessThanOrEqual(
              D1_MAX_SQL_UTF8_BYTES,
            );
            expect(statement.bindingCount).toBeLessThanOrEqual(
              D1_MAX_BOUND_PARAMETERS,
            );
            expect(statement.rowsWritten).toBe(0);
          }
          return result;
        };
        const runCompatibilityClassifierComparison = async (
          filterDsl: string,
          includeAllQueryPlans = false,
        ) => {
          const evaluatorCallStart = evaluatorSpy.mock.calls.length;
          const classifierOverrideStart = compatibilityClassifierOverrideCount;
          forceCompatibilityClassifier = true;
          try {
            const result = await run(filterDsl, includeAllQueryPlans);
            const evaluatorCallCount =
              evaluatorSpy.mock.calls.length - evaluatorCallStart;
            const classifierOverrideCount =
              compatibilityClassifierOverrideCount - classifierOverrideStart;
            expect(classifierOverrideCount).toBe(1);
            expect(evaluatorCallCount).toBe(1);
            return {
              ...result,
              comparisonMode: "same-dsl-compatibility-classifier-unsupported",
              classifierOverrideCount,
              evaluatorCallCount,
            };
          } finally {
            forceCompatibilityClassifier = false;
          }
        };

        evaluatorSpy.mockClear();
        const sql = await run("count(event) gte 1");
        expect(sql.identities).toEqual([scenario.targetSessionId]);
        expect(evaluatorSpy).not.toHaveBeenCalled();
        expectAdvancedCountExecutionMode(sql, "combined");
        if (scenario.name === "small") {
          const defaultMatcher = advancedCountMatcher(sql, "combined");
          expect(defaultMatcher).toBeDefined();
          expect(defaultMatcher!.sql).not.toMatch(/typeof\s*\(/iu);
        }
        let nearCapMatcherQueryPlan: readonly string[] | undefined;
        let nearCapMatcherCapture: Record<string, unknown> | undefined;
        if (scenario.name === "near-cap") {
          const matcherIndex = sql.observerTags.findIndex(
            (tag) =>
              tag.endsWith("count_match") || tag.endsWith("count_combined"),
          );
          const matcherStatement = trace.reads[matcherIndex];
          const matcherObservation = runtimeTrace.observations[matcherIndex];
          if (!matcherStatement)
            throw new Error("wave75_count_miniflare_matcher_statement_missing");
          const explain = await platform.env.DB.prepare(
            `EXPLAIN QUERY PLAN ${matcherStatement.sql}`,
          )
            .bind(...matcherStatement.bindings)
            .all<{ readonly detail: string }>();
          nearCapMatcherQueryPlan = explain.results.map(({ detail }) => detail);
          nearCapMatcherCapture = {
            sql: matcherStatement.sql,
            bindings: matcherStatement.bindings,
            sqlSha256: createHash("sha256")
              .update(matcherStatement.sql)
              .digest("hex"),
            physicalPlanHash: matcherObservation?.physicalPlanHash ?? null,
            sqlBytes: Buffer.byteLength(matcherStatement.sql, "utf8"),
            rowsRead: matcherStatement.rowsRead,
            rowsWritten: matcherStatement.rowsWritten,
            resultRows: matcherStatement.resultCount,
            durationMs: matcherStatement.dbDurationMs,
          };
        }

        evaluatorSpy.mockClear();
        const compatibility =
          await runCompatibilityClassifierComparison("count(event) gte 1");
        expect(compatibility.identities).toEqual(sql.identities);
        expect(evaluatorSpy).toHaveBeenCalledTimes(1);
        const activityCount =
          scenario.count +
          (scenario.name === "medium-selective" ? MEDIUM_DENSE_EVENT_COUNT : 1);
        growthPoints.push({
          scenario: scenario.name,
          activities: activityCount,
          rowsRead: sql.rowsRead,
        });
        measurements.push({
          scenario: scenario.name,
          rawPageCount: scenario.count,
          rawActivityCount: activityCount,
          sql,
          compatibility,
          ...(nearCapMatcherQueryPlan ? { nearCapMatcherQueryPlan } : {}),
          ...(nearCapMatcherCapture ? { nearCapMatcherCapture } : {}),
        });

        if (scenario.name === "small") {
          const selectorDsl =
            'count(page { page.path eq "/wave78-count-selected" }) eq 1 AND count(event { event.name eq "purchase" }) eq 1';
          evaluatorSpy.mockClear();
          const selector = await run(selectorDsl);
          expect(selector.identities).toEqual([scenario.targetSessionId]);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(selector, "combined");
          const selectorMatcher = advancedCountMatcher(selector, "combined");
          expect(selectorMatcher).toBeDefined();
          expect(selectorMatcher!.sql).toMatch(/typeof\s*\(/iu);
          expect(selectorMatcher!.sql.match(/\bGROUP BY\b/giu)).toHaveLength(1);
          expect(
            selectorMatcher!.queryPlan?.some((detail) =>
              /SCAN|SEARCH/iu.test(detail),
            ),
          ).toBe(true);

          evaluatorSpy.mockClear();
          const selectorCompatibility =
            await runCompatibilityClassifierComparison(selectorDsl);
          expect(selectorCompatibility.identities).toEqual(selector.identities);
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          measurements.push({
            scenario: "small-mixed-selector-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            selector,
            selectorCompatibility,
          });

          const nulSelectorDsl = `count(page { page.path eq ${JSON.stringify(nulPathname)} }) eq 1`;
          evaluatorSpy.mockClear();
          const nulSelector = await run(nulSelectorDsl);
          expect(nulSelector.identities).toEqual(["wave75-count-session-1"]);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          evaluatorSpy.mockClear();
          const nulSelectorCompatibility =
            await runCompatibilityClassifierComparison(nulSelectorDsl);
          expect(nulSelectorCompatibility.identities).toEqual(
            nulSelector.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          measurements.push({
            scenario: "small-nul-selector-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            nulSelector,
            nulSelectorCompatibility,
          });

          const mixedSelectorDsl = [
            `count(page { page.path startsWith ${JSON.stringify("/café/")} }) eq 1`,
            `count(page { page.path contains ${JSON.stringify("fé/😀%_\\Suffix\u0000")} }) eq 1`,
            `count(page { page.path endsWith ${JSON.stringify("\\Suffix\u0000tail")} }) eq 1`,
            'count(event { event.name contains "pur" }) eq 0',
          ].join(" AND ");
          evaluatorSpy.mockClear();
          const mixedSelector = await run(mixedSelectorDsl);
          expect(mixedSelector.identities).toEqual(["wave75-count-session-1"]);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(mixedSelector, "combined");
          const mixedSelectorMatcher = advancedCountMatcher(
            mixedSelector,
            "combined",
          );
          expect(mixedSelectorMatcher).toBeDefined();
          expect(mixedSelectorMatcher!.sql).toMatch(/typeof\s*\(/iu);
          expect(mixedSelectorMatcher!.sql).toMatch(/\bINSTR\s*\(/iu);
          expect(mixedSelectorMatcher!.sql).toMatch(/\bSUBSTR\s*\(/iu);
          expect(mixedSelectorMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const mixedSelectorCompatibility =
            await runCompatibilityClassifierComparison(mixedSelectorDsl);
          expect(mixedSelectorCompatibility.identities).toEqual(
            mixedSelector.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          measurements.push({
            scenario: "small-mixed-string-selector-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            mixedSelector,
            mixedSelectorCompatibility,
          });

          const pageTextSelectorDsl = `count(page { page.path contains ${JSON.stringify("😀")} AND page.title contains ${JSON.stringify("Wave80 Café")} AND page.query startsWith ${JSON.stringify("?utm=wave80")} AND page.hash endsWith ${JSON.stringify("Unicode")} }) eq 1`;
          evaluatorSpy.mockClear();
          const pageTextSelector = await run(pageTextSelectorDsl);
          expect(pageTextSelector.identities).toEqual([
            "wave75-count-session-1",
          ]);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(pageTextSelector, "combined");
          const pageTextMatcher = advancedCountMatcher(
            pageTextSelector,
            "combined",
          );
          expect(pageTextMatcher).toBeDefined();
          expect(pageTextMatcher!.sql).toMatch(/typeof\s*\(/iu);
          expect(pageTextMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const pageTextSelectorCompatibility =
            await runCompatibilityClassifierComparison(pageTextSelectorDsl);
          expect(pageTextSelectorCompatibility.identities).toEqual(
            pageTextSelector.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          const compatibilityPage = evaluatorSpy.mock.calls
            .flatMap(([, dataset]) => dataset.pages)
            .find(({ id }) => id === "wave75-count-visit-1");
          expect(compatibilityPage?.fields).toMatchObject({
            "page.path": nulPathname,
            "page.title": pageTitle,
            "page.query": pageQuery,
            "page.hash": pageHash,
          });
          measurements.push({
            scenario: "small-mixed-page-text-selector-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            pageTextSelector,
            pageTextSelectorCompatibility,
          });

          const presenceSelectorDsl = `count(page { page.path contains ${JSON.stringify("😀")} AND page.title notEmpty AND page.query exists AND page.hash notEmpty }) eq 1`;
          evaluatorSpy.mockClear();
          const presenceSelector = await run(presenceSelectorDsl);
          expect(presenceSelector.identities).toEqual([
            "wave75-count-session-1",
          ]);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(presenceSelector, "combined");
          const presenceMatcher = advancedCountMatcher(
            presenceSelector,
            "combined",
          );
          expect(presenceMatcher).toBeDefined();
          expect(presenceMatcher!.sql).toMatch(/typeof\s*\(/iu);
          expect(presenceMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const presenceSelectorCompatibility =
            await runCompatibilityClassifierComparison(presenceSelectorDsl);
          expect(presenceSelectorCompatibility.identities).toEqual(
            presenceSelector.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          const presenceCompatibilityPage = evaluatorSpy.mock.calls
            .flatMap(([, dataset]) => dataset.pages)
            .find(({ id }) => id === "wave75-count-visit-1");
          expect(presenceCompatibilityPage?.fields).toMatchObject({
            "page.title": pageTitle,
            "page.query": pageQuery,
            "page.hash": pageHash,
          });
          measurements.push({
            scenario: "small-mixed-page-presence-selector-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            presenceSelector,
            presenceSelectorCompatibility,
          });

          const numericSelectorDsl = `count(page { page.durationMs gt 5 AND performance.cls between [0.5, 0.8] AND page.path contains ${JSON.stringify("😀")} AND page.title contains ${JSON.stringify("Wave80 Café")} AND page.query startsWith ${JSON.stringify("?utm=wave80")} AND page.hash endsWith ${JSON.stringify("Unicode")} }) eq 1`;
          evaluatorSpy.mockClear();
          const numericSelector = await run(numericSelectorDsl);
          expect(numericSelector.identities).toEqual([
            "wave75-count-session-1",
          ]);
          expect(numericSelector.fallbackReason).toBeNull();
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountRequestAccounting(numericSelector, {
            statementCount: 2,
            otherReadCount: 0,
          });
          const numericMatcher = advancedCountMatcher(
            numericSelector,
            "combined",
          );
          expect(numericMatcher).toBeDefined();
          expect(numericMatcher!.sql).toMatch(/duration_ms/iu);
          expect(numericMatcher!.sql).toMatch(/perf_cls/iu);
          expect(numericMatcher!.sql).toMatch(/typeof\s*\(/iu);
          expect(numericMatcher!.sql).not.toMatch(
            /CAST\s*\([^)]*duration_ms/iu,
          );
          expect(numericMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const numericSelectorCompatibility =
            await runCompatibilityClassifierComparison(numericSelectorDsl);
          expect(numericSelectorCompatibility.identities).toEqual(
            numericSelector.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          const numericCompatibilityPage = evaluatorSpy.mock.calls
            .flatMap(([, dataset]) => dataset.pages)
            .find(({ id }) => id === "wave75-count-visit-1");
          expect(numericCompatibilityPage?.fields).toMatchObject({
            "page.durationMs": 10,
            "performance.cls": 0.75,
          });

          const bareMixedDsl = [
            "page.path notNull",
            "page.title isEmpty",
            "count(page { page.durationMs gt 5 }) eq 0",
            'count(event { event.name eq "purchase" }) eq 1',
          ].join(" AND ");
          evaluatorSpy.mockClear();
          const bareMixed = await run(bareMixedDsl, true);
          expect(bareMixed.identities).toEqual([scenario.targetSessionId]);
          expect(bareMixed.fallbackReason).toBeNull();
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountRequestAccounting(bareMixed, {
            statementCount: 2,
            otherReadCount: 0,
          });
          const bareMixedMatcher = advancedCountMatcher(bareMixed, "combined");
          expect(bareMixedMatcher).toBeDefined();
          expect(bareMixedMatcher!.sql).toMatch(/\bGROUP BY\b/iu);
          expect(bareMixedMatcher!.sql).toMatch(/\bSUM\s*\(/iu);
          expect(bareMixedMatcher!.sql).toMatch(/typeof\s*\(/iu);
          expect(bareMixedMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const bareMixedCompatibility =
            await runCompatibilityClassifierComparison(bareMixedDsl, true);
          expect(bareMixedCompatibility.identities).toEqual(
            bareMixed.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          measurements.push({
            scenario: "small-bare-string-mixed-selector-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            bareMixed,
            bareMixedCompatibility,
          });

          const bareNumericMixedDsl = [
            `page.path contains ${JSON.stringify("😀")}`,
            "page.durationMs eq 10",
            "performance.cls between [0.5, 0.8]",
            "count(page { page.durationMs gt 5 }) eq 1",
            "count(page) eq 1",
          ].join(" AND ");
          evaluatorSpy.mockClear();
          const bareNumericMixed = await run(bareNumericMixedDsl, true);
          expect(bareNumericMixed.identities).toEqual([
            "wave75-count-session-1",
          ]);
          expect(bareNumericMixed.fallbackReason).toBeNull();
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountRequestAccounting(bareNumericMixed, {
            statementCount: 2,
            otherReadCount: 0,
          });
          const bareNumericMatcher = advancedCountMatcher(
            bareNumericMixed,
            "combined",
          );
          expect(bareNumericMatcher).toBeDefined();
          expect(bareNumericMatcher!.sql).toMatch(/duration_ms/iu);
          expect(bareNumericMatcher!.sql).toMatch(/perf_cls/iu);
          expect(bareNumericMatcher!.sql).toMatch(/typeof\s*\(/iu);
          expect(bareNumericMatcher!.sql).not.toMatch(
            /CAST\s*\([^)]*duration_ms/iu,
          );
          expect(bareNumericMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const bareNumericMixedCompatibility =
            await runCompatibilityClassifierComparison(
              bareNumericMixedDsl,
              true,
            );
          expect(bareNumericMixedCompatibility.identities).toEqual(
            bareNumericMixed.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          measurements.push({
            scenario: "small-bare-numeric-mixed-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            bareNumericMixed,
            bareNumericMixedCompatibility,
          });

          await platform.env.DB.prepare(
            "UPDATE visits SET duration_ms = ? WHERE visit_id = ?",
          )
            .bind("0x10", "wave75-count-visit-2")
            .run();
          evaluatorSpy.mockClear();
          const numericAnomalyFallback = await run(
            "count(page { page.durationMs gt 5 }) eq 1",
          );
          expect(numericAnomalyFallback.identities).toEqual([
            "wave75-count-session-1",
            "wave75-count-session-2",
          ]);
          expect(numericAnomalyFallback.fallbackReason).toEqual({
            kind: "numeric-data-domain",
            fieldIds: ["page.durationMs"],
          });
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          expectAdvancedCountRequestAccounting(numericAnomalyFallback, {
            statementCount: 3,
            otherReadCount: 1,
          });
          const numericAnomalyCompatibilityPage = evaluatorSpy.mock.calls
            .flatMap(([, dataset]) => dataset.pages)
            .find(({ id }) => id === "wave75-count-visit-2");
          expect(
            numericAnomalyCompatibilityPage?.fields["page.durationMs"],
          ).toBe("0x10");
          measurements.push({
            scenario: "small-mixed-page-numeric-selector-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            numericSelector,
            numericSelectorCompatibility,
            numericAnomalyFallback,
          });

          evaluatorSpy.mockClear();
          const singletonSet = await run("count(event) in [1]");
          expect(singletonSet.identities).toEqual([scenario.targetSessionId]);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(singletonSet, "combined");

          const integerValues = Array.from(
            { length: 128 },
            (_, index) => index + 1,
          );
          evaluatorSpy.mockClear();
          const packedSet = await run(
            `count(event) in [${integerValues.join(",")}]`,
          );
          expect(packedSet.identities).toEqual(singletonSet.identities);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(packedSet, "combined");
          const packedSetMatcher = advancedCountMatcher(packedSet, "combined");
          expect(packedSetMatcher).toBeDefined();
          expect(packedSetMatcher!.sql).toMatch(/json_each/iu);
          expect(packedSetMatcher!.bindingCount).toBeLessThanOrEqual(
            D1_MAX_BOUND_PARAMETERS,
          );
          expect(
            packedSetMatcher!.queryPlan?.some((detail) =>
              /json_each/iu.test(detail),
            ),
          ).toBe(true);
          measurements.push({
            scenario: "small-numeric-set-cost",
            rawPageCount: scenario.count,
            singletonSet,
            packedSet,
          });

          const nearBudgetDsl = Array.from(
            { length: 90 },
            (_, index) => `count(event) gt ${index / 1_000}`,
          ).join(" AND ");
          evaluatorSpy.mockClear();
          const nearBudget = await run(nearBudgetDsl);
          expect(nearBudget.identities).toEqual([scenario.targetSessionId]);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(nearBudget, "combined");
          const nearBudgetMatcher = advancedCountMatcher(
            nearBudget,
            "combined",
          );
          expect(nearBudgetMatcher).toBeDefined();
          expect(nearBudgetMatcher!.bindingCount).toBeLessThanOrEqual(
            D1_MAX_BOUND_PARAMETERS,
          );
          growthPoints.push({
            scenario: "small-near-budget-ast",
            activities: activityCount,
            rowsRead: nearBudget.rowsRead,
          });
          measurements.push({
            scenario: "small-near-budget-ast",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            sql: nearBudget,
          });

          await platform.env.DB.prepare(
            "UPDATE visits SET session_id = ?, pathname = ?, duration_ms = ?, perf_cls = ? WHERE visit_id = ?",
          )
            .bind(
              scenario.targetSessionId,
              "/wave85-selected/number",
              10,
              0.75,
              "wave75-count-visit-1",
            )
            .run();
          await platform.env.DB.prepare(
            "UPDATE visits SET session_id = ?, pathname = ?, duration_ms = ?, perf_cls = ? WHERE visit_id = ?",
          )
            .bind(
              scenario.targetSessionId,
              "/wave85-selected/null",
              null,
              null,
              "wave75-count-visit-2",
            )
            .run();
          await platform.env.DB.prepare(
            "UPDATE visits SET session_id = ?, pathname = ?, duration_ms = ?, perf_cls = ? WHERE visit_id = ?",
          )
            .bind(
              scenario.targetSessionId,
              "/wave85-other",
              10,
              0.75,
              "wave75-count-visit-3",
            )
            .run();
          const scalarDistinctDsl = [
            "page.durationMs eq 10",
            "performance.cls gte 0.5",
            "count(page) eq 4",
            "count(page.durationMs) eq 4",
            "countDistinct(page.durationMs) eq 2",
            "countDistinct(page.performance.cls) eq 2",
            `count(page { page.path startsWith ${JSON.stringify("/wave85-selected/")} }.durationMs) eq 2`,
            `countDistinct(page { page.path startsWith ${JSON.stringify("/wave85-selected/")} }.performance.cls) eq 2`,
          ].join(" AND ");
          evaluatorSpy.mockClear();
          const scalarDistinct = await run(scalarDistinctDsl, true);
          expect(scalarDistinct.identities).toEqual([scenario.targetSessionId]);
          expect(scalarDistinct.fallbackReason).toBeNull();
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(scalarDistinct, "split");
          const scalarDistinctMatcher = advancedCountMatcher(
            scalarDistinct,
            "split",
          );
          expect(scalarDistinctMatcher).toBeDefined();
          expect(scalarDistinctMatcher!.sql).toMatch(/COUNT\s*\(\s*DISTINCT/iu);
          expect(scalarDistinctMatcher!.sql).toMatch(/SUM\s*\(/iu);
          expect(scalarDistinctMatcher!.sql).toMatch(/duration_ms/iu);
          expect(scalarDistinctMatcher!.sql).toMatch(/perf_cls/iu);
          expect(scalarDistinctMatcher!.sql).not.toMatch(
            /CAST\s*\([^)]*duration_ms/iu,
          );
          expect(scalarDistinctMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const scalarDistinctCompatibility =
            await runCompatibilityClassifierComparison(scalarDistinctDsl, true);
          expect(scalarDistinctCompatibility.identities).toEqual(
            scalarDistinct.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          growthPoints.push({
            scenario: "small-page-scalar-count-distinct",
            activities: activityCount,
            rowsRead: scalarDistinct.rowsRead,
          });
          measurements.push({
            scenario: "small-page-scalar-count-distinct-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            scalarDistinct,
            scalarDistinctCompatibility,
          });

          const scalarMinMaxDsl = [
            "min(page.durationMs) eq 10",
            "max(page.durationMs) eq 10",
            "countDistinct(page.durationMs) eq 2",
            "min(page.performance.cls) eq 0.75",
            "max(page.performance.cls) eq 0.75",
          ].join(" AND ");
          evaluatorSpy.mockClear();
          const scalarMinMax = await run(scalarMinMaxDsl, true);
          expect(scalarMinMax.identities).toEqual([scenario.targetSessionId]);
          expect(scalarMinMax.fallbackReason).toBeNull();
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(scalarMinMax, "combined");
          const scalarMinMaxMatcher = advancedCountMatcher(
            scalarMinMax,
            "combined",
          );
          expect(scalarMinMaxMatcher).toBeDefined();
          expect(scalarMinMaxMatcher!.sql).toMatch(/MIN\s*\(/iu);
          expect(scalarMinMaxMatcher!.sql).toMatch(/MAX\s*\(/iu);
          expect(scalarMinMaxMatcher!.sql).toMatch(/COUNT\s*\(\s*DISTINCT/iu);
          expect(scalarMinMaxMatcher!.sql).toMatch(/duration_ms/iu);
          expect(scalarMinMaxMatcher!.sql).toMatch(/perf_cls/iu);
          expect(
            scalarMinMaxMatcher!.sql.match(/\bGROUP BY\b/giu),
          ).toHaveLength(1);
          expect(scalarMinMaxMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const scalarMinMaxCompatibility =
            await runCompatibilityClassifierComparison(scalarMinMaxDsl, true);
          expect(scalarMinMaxCompatibility.identities).toEqual(
            scalarMinMax.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          growthPoints.push({
            scenario: "small-page-scalar-min-max",
            activities: activityCount,
            rowsRead: scalarMinMax.rowsRead,
          });
          measurements.push({
            scenario: "small-page-scalar-min-max-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            scalarMinMax,
            scalarMinMaxCompatibility,
          });

          const scalarSumAverageDsl = [
            "count(page) eq 4",
            'count(page { page.path startsWith "/wave85-selected/" }.durationMs) eq 2',
            'sum(page { page.path startsWith "/wave85-selected/" }.durationMs) eq 10',
            'avg(page { page.path startsWith "/wave85-selected/" }.durationMs) eq 10',
            'min(page { page.path startsWith "/wave85-selected/" }.durationMs) eq 10',
            'max(page { page.path startsWith "/wave85-selected/" }.durationMs) eq 10',
            'countDistinct(page { page.path startsWith "/wave85-selected/" }.durationMs) eq 2',
          ].join(" AND ");
          evaluatorSpy.mockClear();
          const scalarSumAverage = await run(scalarSumAverageDsl, true);
          expect(scalarSumAverage.identities).toEqual([
            scenario.targetSessionId,
          ]);
          expect(scalarSumAverage.fallbackReason).toBeNull();
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(scalarSumAverage, "combined");
          const scalarSumAverageMatcher = advancedCountMatcher(
            scalarSumAverage,
            "combined",
          );
          expect(scalarSumAverageMatcher).toBeDefined();
          expect(scalarSumAverageMatcher!.sql).toMatch(/SUM\s*\(/iu);
          expect(scalarSumAverageMatcher!.sql).toMatch(/AVG\s*\(/iu);
          expect(scalarSumAverageMatcher!.sql).toMatch(/MIN\s*\(/iu);
          expect(scalarSumAverageMatcher!.sql).toMatch(/MAX\s*\(/iu);
          expect(scalarSumAverageMatcher!.sql).toMatch(
            /COUNT\s*\(\s*DISTINCT/iu,
          );
          expect(
            scalarSumAverageMatcher!.sql.match(/\bGROUP BY\b/giu),
          ).toHaveLength(1);
          expect(scalarSumAverageMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const scalarSumAverageCompatibility =
            await runCompatibilityClassifierComparison(
              scalarSumAverageDsl,
              true,
            );
          expect(scalarSumAverageCompatibility.identities).toEqual(
            scalarSumAverage.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          growthPoints.push({
            scenario: "small-page-scalar-sum-average",
            activities: activityCount,
            rowsRead: scalarSumAverage.rowsRead,
          });
          measurements.push({
            scenario: "small-page-scalar-sum-average-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            scalarSumAverage,
            scalarSumAverageCompatibility,
          });

          const collectionCardinalityDsl = [
            "count(page.path) eq 4",
            "count(page.title) eq 4",
            "count(page.query) eq 4",
            "count(page.hash) eq 4",
            "count(event.name) eq 1",
            'count(page { page.path startsWith "/wave85-selected/" }.path) eq 2',
            'page { page.path startsWith "/wave85-selected/" }.path exists',
            'event { event.name eq "purchase" }.name exists',
          ].join(" AND ");
          evaluatorSpy.mockClear();
          const collectionCardinality = await run(
            collectionCardinalityDsl,
            true,
          );
          expect(collectionCardinality.identities).toEqual([
            scenario.targetSessionId,
          ]);
          expect(collectionCardinality.fallbackReason).toBeNull();
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(collectionCardinality, "combined");
          const collectionMatcher = advancedCountMatcher(
            collectionCardinality,
            "combined",
          );
          expect(collectionMatcher).toBeDefined();
          expect(collectionMatcher!.sql.match(/\bGROUP BY\b/giu)).toHaveLength(
            1,
          );
          expect(collectionMatcher!.queryPlan?.length).toBeGreaterThan(0);

          evaluatorSpy.mockClear();
          const collectionCardinalityCompatibility =
            await runCompatibilityClassifierComparison(
              collectionCardinalityDsl,
              true,
            );
          expect(collectionCardinalityCompatibility.identities).toEqual(
            collectionCardinality.identities,
          );
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          growthPoints.push({
            scenario: "small-collection-cardinality-presence",
            activities: activityCount,
            rowsRead: collectionCardinality.rowsRead,
          });
          measurements.push({
            scenario: "small-collection-cardinality-presence-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            collectionCardinality,
            collectionCardinalityCompatibility,
          });
        }

        if (scenario.name === "medium-selective") {
          const selectorDsl =
            'count(page { page.path eq "/wave78-count-medium-selected" }) eq 1 AND count(event { event.name eq "purchase" }) eq 1024 AND count(page) eq 1';
          evaluatorSpy.mockClear();
          const selector = await run(selectorDsl);
          expect(selector.identities).toEqual([scenario.targetSessionId]);
          expect(evaluatorSpy).not.toHaveBeenCalled();
          expectAdvancedCountExecutionMode(selector, "combined");
          const selectorMatcher = advancedCountMatcher(selector, "combined");
          expect(selectorMatcher).toBeDefined();
          expect(selectorMatcher!.sql).toMatch(/typeof\s*\(/iu);
          expect(selectorMatcher!.sql.match(/\bGROUP BY\b/giu)).toHaveLength(1);
          expect(
            selectorMatcher!.queryPlan?.some((detail) =>
              /SCAN|SEARCH/iu.test(detail),
            ),
          ).toBe(true);

          evaluatorSpy.mockClear();
          const selectorCompatibility =
            await runCompatibilityClassifierComparison(selectorDsl);
          expect(selectorCompatibility.identities).toEqual(selector.identities);
          expect(evaluatorSpy).toHaveBeenCalledTimes(1);
          growthPoints.push({
            scenario: "medium-selective-mixed-selector",
            activities: activityCount,
            rowsRead: selector.rowsRead,
          });
          measurements.push({
            scenario: "medium-selective-mixed-selector-cost",
            rawPageCount: scenario.count,
            rawActivityCount: activityCount,
            selector,
            selectorCompatibility,
          });

          const additionalPaths = [
            {
              name: "medium-dense-page-only",
              supported: "count(page) gte 1",
              expectedCount: scenario.count,
            },
            {
              name: "medium-dense-page-and-event",
              supported: "count(page) gte 1 AND count(event) gte 1",
              expectedCount: 1,
            },
          ] as const;
          for (const path of additionalPaths) {
            evaluatorSpy.mockClear();
            const supported = await run(path.supported);
            expect(supported.identities).toHaveLength(path.expectedCount);
            expect(evaluatorSpy).not.toHaveBeenCalled();
            expectAdvancedCountExecutionMode(supported, "combined");
            evaluatorSpy.mockClear();
            const compatibility = await runCompatibilityClassifierComparison(
              path.supported,
            );
            expect(compatibility.identities).toEqual(supported.identities);
            expect(evaluatorSpy).toHaveBeenCalledTimes(1);
            growthPoints.push({
              scenario: path.name,
              activities: activityCount,
              rowsRead: supported.rowsRead,
            });
            measurements.push({
              scenario: path.name,
              rawPageCount: scenario.count,
              rawActivityCount: activityCount,
              sql: supported,
              compatibility: compatibility,
            });
          }
        }
      }
      for (const point of growthPoints)
        expect(point.rowsRead).toBeLessThanOrEqual(
          point.activities * 16 + 1_024,
        );
      persistEvidence();
      console.info(
        "Wave92D advanced count Miniflare evidence saved",
        JSON.stringify({
          evidencePath: evidencePath ?? null,
          runEvidenceCount: runEvidence.length,
          measurementCount: measurements.length,
          growthPoints,
        }),
      );
    } catch (error) {
      persistEvidence(error);
      throw error;
    } finally {
      forceCompatibilityClassifier = false;
      classifierSpy.mockRestore();
      evaluatorSpy.mockRestore();
      siteCoverageSpy.mockRestore();
      await disposePlatform?.();
      unlinkSync(configPath);
      rmdirSync(configDirectory);
    }
  }, 120_000);
});
