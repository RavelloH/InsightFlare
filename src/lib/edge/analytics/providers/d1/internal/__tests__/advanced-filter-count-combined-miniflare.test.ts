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
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import {
  buildAdvancedCountFilterCombinedPlan,
  buildAdvancedCountFilterGuardPlan,
  buildAdvancedCountFilterMatchPlan,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { classifyAdvancedCountFilter } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import {
  type AdvancedCountNumberSelectorField,
  advancedCountSelectorField,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  preparedMembershipFromIds,
  preparedMembershipIdentities,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import {
  compileAdvancedFilterCountCombinedQuery,
  compileAdvancedFilterCountGuardQuery,
  compileAdvancedFilterCountMatchesQuery,
  queryAdvancedFilterCountGuard,
  queryAdvancedFilterCountMatches,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-query";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { siteCoverage } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-site-coverage";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as filterEvaluator from "@/lib/filter-contract/filter-evaluator";

const SITE_ID = "wave89-count-miniflare-site" as SiteId;
const FILTER_DSL =
  'count(page) gte 1 AND count(event { event.name eq "purchase" }) gte 1 AND sum(page.durationMs) gte 0';
const CAPTURED_AT_MS = 31_000;
const SCENARIOS = [
  {
    name: "small",
    startMs: 0,
    endExclusiveMs: 1_000,
    count: 8,
    events: 1,
    selectedSessionId: "wave89-count-small-selected",
    pagePrefix: "wave89-count-small-page-",
    sessionPrefix: "wave89-count-small-session-",
    eventPrefix: "wave89-count-small-event-",
  },
  {
    name: "medium",
    startMs: 1_000,
    endExclusiveMs: 3_000,
    count: 1_024,
    events: 1_024,
    selectedSessionId: "wave89-count-medium-selected",
    pagePrefix: "wave89-count-medium-page-",
    sessionPrefix: "wave89-count-medium-session-",
    eventPrefix: "wave89-count-medium-event-",
  },
] as const;

interface MiniflareRead {
  readonly sql: string;
  readonly bindings: readonly (string | number | null)[];
  readonly results: readonly unknown[];
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
              results: result.results ?? [],
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
        readonly operation: string;
        readonly statementCount: number;
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

async function seedRows(database: D1Database): Promise<void> {
  await database.batch([
    database
      .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
      .bind("wave89-count-user", "wave89-count@example.test"),
    database
      .prepare(
        "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
      )
      .bind(
        "wave89-count-team",
        "Wave89 test",
        "wave89-count-team",
        "wave89-count-user",
      ),
    database
      .prepare("INSERT INTO site_identities (site_pk, site_id) VALUES (?, ?)")
      .bind(1, SITE_ID),
    database
      .prepare(
        "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(SITE_ID, "wave89-count-team", "Wave89 test", "example.test", 0),
    database
      .prepare(
        "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(1, SITE_ID, "purchase", CAPTURED_AT_MS, 1),
  ]);

  for (const scenario of SCENARIOS) {
    await database
      .prepare(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 0
           UNION ALL SELECT n + 1 FROM sequence WHERE n + 1 < ?
         )
         INSERT INTO visits (
           visit_id, site_id, visitor_id, session_id, status, started_at,
           duration_ms,
           last_activity_at, pathname, hostname, site_pk
         )
         SELECT
           ? || n, ?, ? || n,
           CASE WHEN n = 0 THEN ? ELSE ? || n END,
           'closed', ? + 100 + n, 1, ? + 100 + n, '/wave89-count',
           'example.test', 1
         FROM sequence`,
      )
      .bind(
        scenario.count,
        scenario.pagePrefix,
        SITE_ID,
        `${scenario.name}-visitor-`,
        scenario.selectedSessionId,
        scenario.sessionPrefix,
        scenario.startMs,
        scenario.startMs,
      )
      .run();

    await database
      .prepare(
        `WITH RECURSIVE sequence(n) AS (
           SELECT 0
           UNION ALL SELECT n + 1 FROM sequence WHERE n + 1 < ?
         )
         INSERT INTO custom_events (
           event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
           received_at, node_count, value_count, site_pk
         )
         SELECT
           ? + n, ? || n, ?, ?, 1,
           ? + 101 + n, ? + 102 + n, 0, 0, 1
         FROM sequence`,
      )
      .bind(
        scenario.events,
        scenario.name === "small" ? 1 : 2,
        scenario.eventPrefix,
        SITE_ID,
        `${scenario.pagePrefix}0`,
        scenario.startMs,
        scenario.startMs,
      )
      .run();
  }
}

function requestInput(time: QueryTime) {
  const document = parseFilterDsl(FILTER_DSL, analyticsFilterRegistry);
  const plan = createScopedFilterPlan("overview", document, "session");
  if (!plan) throw new Error("wave89c_combined_scope_plan_missing");
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

function countMeasurements(
  reads: readonly MiniflareRead[],
  observations: readonly DatabaseQueryObservation[],
) {
  return reads.map((read, index) => {
    const observation = observations[index];
    return {
      tag: observation?.tag ?? null,
      sql: read.sql,
      bindings: read.bindings,
      sqlSha256: createHash("sha256").update(read.sql).digest("hex"),
      physicalPlanHash: observation?.physicalPlanHash ?? null,
      sqlBytes: Buffer.byteLength(read.sql, "utf8"),
      bindingCount: read.bindings.length,
      rowsRead: read.rowsRead,
      rowsWritten: read.rowsWritten,
      resultRows: read.resultCount,
      durationMs: read.dbDurationMs,
      wallMs: read.wallMs,
    };
  });
}

describe("advanced count combined production path on Miniflare D1", () => {
  it("proves numeric combined and split costs at 8 and 1024 pages with one site", async () => {
    const preflightDocument = parseFilterDsl(
      FILTER_DSL,
      analyticsFilterRegistry,
    );
    const preflightSupport = classifyAdvancedCountFilter(
      preflightDocument,
      "session",
    );
    if (preflightSupport.kind !== "supported")
      throw new Error("wave89d_numeric_support_fixture_rejected");
    const preflightRange = createQueryTime(
      SCENARIOS[0].startMs,
      SCENARIOS[0].endExclusiveMs,
      "UTC",
      CAPTURED_AT_MS,
    ).range;
    const preflightSubject = createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE_ID],
    });
    const preflightPlan = buildAdvancedCountFilterCombinedPlan({
      subject: preflightSubject,
      candidateRange: preflightRange,
      readRange: preflightRange,
      expressionRange: preflightRange,
      expressionUsesExplicitRange: false,
      lowerBounds: [{ siteId: SITE_ID, startMs: preflightRange.startMs }],
      scope: "session",
      reportingTimeZone: "UTC",
      capturedAtMs: CAPTURED_AT_MS,
      analysis: preflightSupport.analysis,
      numericCompatibilityRequirements:
        preflightSupport.numericCompatibilityRequirements,
    });
    const combinedPreflight =
      compileAdvancedFilterCountCombinedQuery(preflightPlan);
    if (!combinedPreflight)
      throw new Error("wave89d_numeric_combined_preflight_not_materialized");

    const configDirectory = mkdtempSync(
      join(tmpdir(), "advanced-count-combined-miniflare-"),
    );
    const configPath = join(configDirectory, "wrangler.toml");
    writeFileSync(
      configPath,
      [
        'name = "advanced-count-combined-miniflare-test"',
        'compatibility_date = "2026-03-01"',
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "advanced_count_combined_test"',
        'database_id = "local-test"',
        "",
      ].join("\n"),
    );
    let disposePlatform: (() => Promise<void>) | undefined;
    const evaluatorSpy = vi.spyOn(filterEvaluator, "evaluateFilterDocument");
    try {
      const platform = await getPlatformProxy<Env>({
        configPath,
        envFiles: [],
        persist: false,
        remoteBindings: false,
      });
      disposePlatform = platform.dispose;
      await applySchema(platform.env.DB);
      await seedRows(platform.env.DB);
      const trace = tracedDatabase(platform.env.DB);
      const runtimeTrace = observeRuntimeQueries();
      registerDatabaseQueryObserver(trace.database, runtimeTrace.observer);
      const env = {
        ...platform.env,
        DB: trace.database,
        DAILY_SALT_SECRET: "wave89c-combined-secret",
        INGEST_DO: {} as DurableObjectNamespace,
      } as unknown as Env;
      const evidence: Array<Record<string, unknown>> = [];
      const evidencePath = process.env.INSIGHTFLARE_WAVE89D_EVIDENCE_PATH;
      const schemaSha256 = createHash("sha256")
        .update(readFileSync(resolve(process.cwd(), "docs/schema.sql"), "utf8"))
        .digest("hex");
      const saveEvidence = () => {
        if (evidencePath)
          writeFileSync(
            evidencePath,
            `${JSON.stringify(
              {
                phase: "Wave89D combined numeric proof production comparison",
                schemaSha256,
                evidence,
              },
              null,
              2,
            )}\n`,
            "utf8",
          );
      };

      for (const scenario of SCENARIOS) {
        const time = createQueryTime(
          scenario.startMs,
          scenario.endExclusiveMs,
          "UTC",
          CAPTURED_AT_MS,
        );
        const range = {
          startMs: time.range.startMs,
          endExclusiveMs: time.range.endExclusiveMs,
        };
        const subject = createSemanticSubjectDomain({
          origin: "site",
          siteIds: [SITE_ID],
        });
        const document = parseFilterDsl(FILTER_DSL, analyticsFilterRegistry);
        const support = classifyAdvancedCountFilter(document, "session");
        if (support.kind !== "supported")
          throw new Error("wave89c_combined_support_fixture_rejected");
        if (
          support.numericCompatibilityRequirements.length !== 1 ||
          support.numericCompatibilityRequirements[0]?.fieldId !==
            "page.durationMs" ||
          support.numericCompatibilityRequirements[0]?.proof !==
            "exact-aggregate"
        )
          throw new Error("wave89d_combined_fixture_numeric_profile_mismatch");

        trace.reads.length = 0;
        runtimeTrace.reset();
        const combinedDiagnostics = createD1ReadDiagnostics();
        const combinedStartedAt = performance.now();
        const prepared = (await d1AdvancedFilterMiddleware(
          env,
          combinedDiagnostics,
        )(
          "performance",
          requestInput(time),
          async (input) => input,
        )) as ReturnType<typeof requestInput>;
        const combinedWallMs = performance.now() - combinedStartedAt;
        await runtimeTrace.settle();
        const combinedStatements = countMeasurements(
          trace.reads,
          runtimeTrace.observations,
        );
        const combinedMatches = (
          preparedMembershipIdentities(prepared.scopePlan?.preparedMembership)
            .entityIds ?? []
        )
          .map(({ id }) => id)
          .sort();
        const combinedStatement = combinedStatements.find(
          ({ tag }) => tag === "analytics.advanced_filter.count_combined",
        );
        const coverageRowsRead = combinedStatements
          .filter(({ tag }) => tag === "analytics.query.all")
          .reduce(
            (total, statement) => total + (statement.rowsRead as number),
            0,
          );
        const combinedDataRowsRead = combinedStatements
          .filter(
            ({ tag }) => tag === "analytics.advanced_filter.count_combined",
          )
          .reduce(
            (total, statement) => total + (statement.rowsRead as number),
            0,
          );
        const combinedRead = trace.reads.find((read) =>
          read.sql.includes('"rowKind"'),
        );
        const combinedGuardRow = combinedRead?.results.find(
          (row) =>
            !!row &&
            typeof row === "object" &&
            (row as Record<string, unknown>).rowKind === "guard",
        ) as Record<string, unknown> | undefined;
        const combinedRawCount = combinedGuardRow?.rawCount;

        trace.reads.length = 0;
        runtimeTrace.reset();
        const splitDiagnostics = createD1ReadDiagnostics();
        const splitStartedAt = performance.now();
        const coverage = await siteCoverage(env, [SITE_ID], splitDiagnostics);
        const guardPlan = buildAdvancedCountFilterGuardPlan({
          subject,
          range,
          reportingTimeZone: "UTC",
          numericCompatibilityRequirements:
            support.numericCompatibilityRequirements,
        });
        const matchPlan = buildAdvancedCountFilterMatchPlan({
          subject,
          candidateRange: range,
          readRange: range,
          expressionRange: range,
          expressionUsesExplicitRange: false,
          lowerBounds: [{ siteId: SITE_ID, startMs: range.startMs }],
          scope: "session",
          reportingTimeZone: "UTC",
          capturedAtMs: CAPTURED_AT_MS,
          analysis: support.analysis,
          numericCompatibilityRequirements:
            support.numericCompatibilityRequirements,
        });
        const guardQuery = compileAdvancedFilterCountGuardQuery(guardPlan);
        const matchQuery = compileAdvancedFilterCountMatchesQuery(matchPlan);
        const numericCompatibilityFields: AdvancedCountNumberSelectorField[] =
          support.numericCompatibilityRequirements.map(({ fieldId }) => {
            const field = advancedCountSelectorField(fieldId);
            if (!field || field.kind !== "number")
              throw new Error("wave89d_split_numeric_field_missing");
            return field;
          });
        const guard = await queryAdvancedFilterCountGuard({
          env,
          query: guardQuery,
          numericCompatibilityFields,
          diagnostics: splitDiagnostics,
        });
        const splitResult = await queryAdvancedFilterCountMatches({
          env,
          query: matchQuery,
          numericCompatibilityFields,
          diagnostics: splitDiagnostics,
        });
        const splitWallMs = performance.now() - splitStartedAt;
        await runtimeTrace.settle();
        const splitStatements = countMeasurements(
          trace.reads,
          runtimeTrace.observations,
        );
        const splitMatches = splitResult.matches
          .map(({ entityId }) => entityId)
          .sort();
        const historicalCountStatements = splitStatements.filter(
          ({ tag }) =>
            tag === "analytics.advanced_filter.count_guard" ||
            tag === "analytics.advanced_filter.count_match",
        );
        const actualSqlHashes = historicalCountStatements.map(
          ({ sqlSha256 }) => sqlSha256,
        );
        const actualPhysicalHashes = historicalCountStatements.map(
          ({ physicalPlanHash }) => physicalPlanHash?.replace(/^v1:/u, ""),
        );
        const numericSplitSignaturesRecorded =
          actualSqlHashes.length === 2 &&
          actualSqlHashes.every((hash) => typeof hash === "string") &&
          actualPhysicalHashes.length === 2 &&
          actualPhysicalHashes.every((hash) => typeof hash === "string");
        const splitDataRowsRead = historicalCountStatements.reduce(
          (total, statement) => total + (statement.rowsRead as number),
          0,
        );
        const splitCoverageRowsRead = splitStatements
          .filter(({ tag }) => tag === "analytics.query.all")
          .reduce(
            (total, statement) => total + (statement.rowsRead as number),
            0,
          );
        const splitTotalRowsRead = splitDiagnostics.rowsRead;
        const coveredStatement = combinedStatements.find(
          ({ tag }) => tag === "analytics.query.all",
        );
        const combinedReadStatement = combinedStatements.find(
          ({ tag }) => tag === "analytics.advanced_filter.count_combined",
        );
        evidence.push({
          fixture: {
            scenario: scenario.name,
            pages: scenario.count,
            events: scenario.events,
            rawActivities: scenario.count + scenario.events,
            range,
            scope: "session",
            authorizedSites: [SITE_ID],
            filterDsl: FILTER_DSL,
          },
          matches: combinedMatches,
          combined: {
            kind: "production-combined",
            dataRowsRead: combinedDataRowsRead,
            coverageRowsRead,
            totalRowsRead: combinedDiagnostics.rowsRead,
            operationWallMs: combinedWallMs,
            statements: combinedStatements,
            combinedRawCount,
            combinedGuardRow,
            statement: combinedReadStatement,
            coverageStatement: coveredStatement,
          },
          split: {
            kind: "historical-split-helper",
            dataRowsRead: splitDataRowsRead,
            coverageRowsRead: splitCoverageRowsRead,
            totalRowsRead: splitTotalRowsRead,
            operationWallMs: splitWallMs,
            statements: splitStatements,
          },
          historicalSplitSignature: {
            actualSqlHashes,
            actualPhysicalHashes,
          },
          numericSplitSignaturesRecorded,
          semanticEqual:
            JSON.stringify(splitMatches) === JSON.stringify(combinedMatches),
          rowsReadDelta: splitDataRowsRead - combinedDataRowsRead,
        });
        saveEvidence();

        expect(combinedStatement).toBeDefined();
        expect(combinedMatches).toEqual([scenario.selectedSessionId]);
        expect(combinedRawCount).toBe(scenario.count + scenario.events);
        expect(combinedGuardRow?.invalidContextPageDurationMsCount).toBe(0);
        expect(combinedDiagnostics.advancedCountSqlFallbackReason).toBe(
          undefined,
        );
        expect(combinedDiagnostics.rowsReadAvailable).toBe(true);
        expect(coverage.get(SITE_ID)).toBe(0);
        expect(guard.rawCount).toBe(scenario.count + scenario.events);
        expect(guard.nullActivityIdCount).toBe(0);
        expect(guard.siteIdentityMismatchCount).toBe(0);
        expect(guard.numericCompatibilityFieldIds).toEqual([]);
        expect(guard.rawCount).toBeLessThanOrEqual(
          ADVANCED_FILTER_MAX_ACTIVITIES,
        );
        expect(splitMatches).toEqual(combinedMatches);
        expect(historicalCountStatements).toHaveLength(2);
        expect(numericSplitSignaturesRecorded).toBe(true);
        expect(
          combinedStatements.filter(
            ({ tag }) => tag === "analytics.advanced_filter.count_combined",
          ),
        ).toHaveLength(1);
        expect(
          combinedStatements.some(({ tag }) =>
            [
              "analytics.advanced_filter.count_guard",
              "analytics.advanced_filter.count_match",
            ].includes(tag as string),
          ),
        ).toBe(false);
        expect(combinedDataRowsRead).toBeLessThanOrEqual(splitDataRowsRead);
        if (scenario.name === "medium")
          expect(combinedDataRowsRead).toBeLessThan(splitDataRowsRead);
        for (const statement of [...combinedStatements, ...splitStatements]) {
          expect(statement.rowsRead).not.toBeNull();
          expect(statement.rowsWritten).toBe(0);
          expect(statement.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(statement.bindingCount).toBeLessThanOrEqual(100);
        }
      }
      expect(evaluatorSpy).not.toHaveBeenCalled();
      console.info(
        "Wave89D combined numeric proof Miniflare evidence",
        JSON.stringify(
          evidence.map((entry) => ({
            fixture: entry.fixture,
            combined: (entry.combined as { dataRowsRead: number }).dataRowsRead,
            split: (entry.split as { dataRowsRead: number }).dataRowsRead,
            semanticEqual: entry.semanticEqual,
          })),
        ),
      );
    } finally {
      evaluatorSpy.mockRestore();
      await disposePlatform?.();
      unlinkSync(configPath);
      rmdirSync(configDirectory);
    }
  }, 120_000);
});
