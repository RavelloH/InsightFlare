import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type {
  QueryInput,
  QueryTime,
  ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  d1AdvancedFilterMiddleware,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type {
  FilterDocument,
  Interval,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryRetentionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import { compileRetentionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/retention-qualification-program";
import { executeRetentionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/retention-qualification-program";
import { deferredRetentionQualificationFromQuery } from "@/lib/edge/analytics/providers/d1/internal/retention-qualification-request";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE = "wave97p-retention-site";
const OTHER_SITE = "wave97p-retention-other-site";
const START = Date.UTC(2026, 9, 1);
const DAY = 24 * 60 * 60 * 1000;
const WINDOW: QueryWindow = {
  startMs: START,
  endExclusiveMs: START + 4 * DAY,
  nowMs: START + 5 * DAY,
  timeZone: "UTC",
};
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();

interface SiteRow {
  readonly id: string;
  readonly pk: number;
}

let database: DatabaseSync;
let site: SiteRow;
let otherSite: SiteRow;

function addSite(db: DatabaseSync, id: string): SiteRow {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  db.prepare(
    `INSERT INTO sites (id, team_id, name, domain, created_at)
     VALUES (?, 'wave97p-retention-team', ?, ?, 0)`,
  ).run(id, id, `${id}.test`);
  return { id, pk: Number(row.site_pk) };
}

function addPage(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly visitor: string;
    readonly session: string;
    readonly at: number;
    readonly path: string;
    readonly owner?: SiteRow;
  },
): void {
  const owner = input.owner ?? site;
  db.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'retention.test')`,
  ).run(
    input.id,
    owner.id,
    owner.pk,
    input.visitor,
    input.session,
    input.at,
    input.at,
    input.path,
  );
}

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function env(db: DatabaseSync, queryTrace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(db, queryTrace) } as unknown as Env;
}

function envWithRows(
  db: DatabaseSync,
  queryTrace: SqliteD1Trace,
  transform: (
    sql: string,
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[],
): Env {
  const base = createSqliteD1Database(db, queryTrace);
  return {
    DB: {
      prepare(sql: string) {
        const prepared = base.prepare(sql);
        return {
          bind(...values: SQLInputValue[]) {
            const bound = prepared.bind(...values);
            return {
              async all<Row>() {
                const result = await bound.all<Row>();
                const rows = result.results as unknown as Record<
                  string,
                  unknown
                >[];
                return {
                  ...result,
                  results: transform(sql, rows) as unknown as Row[],
                };
              },
              first: <Row>() => bound.first<Row>(),
              run: () => bound.run(),
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
      batch: (statements: D1PreparedStatement[]) => base.batch(statements),
    },
  } as unknown as Env;
}

function isRetentionEnvelopeSql(sql: string): boolean {
  return sql.includes('"rowKind"') && sql.includes('"outputId"');
}

function pathFilter(path: string): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "eq",
        value: path,
      },
    },
    analyticsFilterRegistry,
  );
}

function preparedFilter(
  scope: "session" | "visitor",
  filters: FilterDocument,
): FilterDocument {
  const time: QueryTime = createQueryTime(
    WINDOW.startMs,
    WINDOW.endExclusiveMs,
    WINDOW.timeZone,
    WINDOW.nowMs,
  );
  const prepared = prepareScopedQuery("retention", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("retention_prepared_scope_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("retention_prepared_metadata_missing");
  const entityId = scope === "session" ? "visitor-a-session-0" : "visitor-a";
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      advancedMatches: {
        entityIds: [{ siteId: SITE, id: entityId }],
      },
    },
  });
}

function seedPages(db: DatabaseSync): void {
  const pages = [
    ["a-match-0", "visitor-a", "visitor-a-session-0", 0, "/match"],
    ["a-match-0-duplicate", "visitor-a", "visitor-a-session-0", 0, "/match"],
    ["a-count-activity-page", "visitor-a", "visitor-a-session-0", 1, "/other"],
    ["a-return-1", "visitor-a", "visitor-a-session-1", 1, "/other"],
    ["a-match-2", "visitor-a", "visitor-a-session-2", 2, "/match"],
    ["a-return-3", "visitor-a", "visitor-a-session-3", 3, "/other"],
    ["b-other-0", "visitor-b", "visitor-b-session-0", 0, "/other"],
    ["b-match-1", "visitor-b", "visitor-b-session-1", 1, "/match"],
    ["b-return-2", "visitor-b", "visitor-b-session-2", 2, "/other"],
    ["empty-match", "", "empty-session", 0, "/match"],
    ["foreign-match", "foreign", "foreign-session", 0, "/match"],
    ["empty-match-end", "", "empty-end-session", 4, "/match"],
  ] as const;
  for (const [id, visitor, session, day, path] of pages)
    addPage(db, {
      id,
      visitor,
      session,
      at: START + day * DAY + 1_000,
      path,
      ...(id === "foreign-match" ? { owner: otherSite } : {}),
    });
  addRetentionEvent(
    db,
    "retention-qualifier",
    "a-count-activity-page",
    START + 1_010,
    site,
  );
  addRetentionEvent(
    db,
    "retention-qualifier",
    "foreign-match",
    START + 1_010,
    otherSite,
  );
  addRetentionEvent(
    db,
    "retention-qualifier",
    "empty-match",
    START + 1_010,
    site,
  );
  const dstCohortAt = Date.parse("2026-03-07T00:30:00-05:00");
  addPage(db, {
    id: "calendar-cohort",
    visitor: "visitor-calendar",
    session: "calendar-session-0",
    at: dstCohortAt,
    path: "/match",
  });
  addPage(db, {
    id: "calendar-return-dst-day",
    visitor: "visitor-calendar",
    session: "calendar-session-1",
    at: Date.parse("2026-03-08T03:30:00-04:00"),
    path: "/other",
  });
  addPage(db, {
    id: "calendar-return-next-day",
    visitor: "visitor-calendar",
    session: "calendar-session-2",
    at: Date.parse("2026-03-09T12:00:00-04:00"),
    path: "/other",
  });
  addRetentionEvent(
    db,
    "retention-qualifier",
    "calendar-cohort",
    dstCohortAt + 100,
    site,
  );
}

function addRetentionEvent(
  db: DatabaseSync,
  name: string,
  visitId: string,
  at: number,
  owner: SiteRow,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO custom_event_names (site_id, site_pk, name, last_seen_at)
     VALUES (?, ?, ?, ?)`,
  ).run(owner.id, owner.pk, name, at);
  const eventName = db
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(owner.pk, name) as { readonly id: number };
  db.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
  ).run(
    `retention-event-${owner.id}-${visitId}`,
    owner.id,
    owner.pk,
    visitId,
    eventName.id,
    at,
    at,
  );
}

function countQualifiedQuery(
  scope: "session" | "visitor",
  granularity: Interval = "day",
  countExpression = 'count(event { event.name eq "retention-qualifier" }) gte 1',
  window: QueryWindow = WINDOW,
) {
  const filters = parseFilterDsl(
    `page.path eq "/match" and ${countExpression}`,
    analyticsFilterRegistry,
  );
  const time = createQueryTime(
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    window.nowMs,
  );
  return prepareScopedQuery("retention", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time,
    filters,
    scopePreference: scope,
    granularity,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly time: QueryTime;
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
    readonly granularity: string;
  };
}

function retentionWholeFilterQuery(
  scope: "session" | "visitor",
  granularity: Interval,
  filterDsl: string,
): QueryInput & {
  readonly filters: FilterDocument;
  readonly granularity: Interval;
  readonly scopePreference: "session" | "visitor";
  readonly time: QueryTime;
} {
  const time = createQueryTime(
    WINDOW.startMs,
    WINDOW.endExclusiveMs,
    WINDOW.timeZone,
    WINDOW.nowMs,
  );
  const filters = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const query = {
    context: siteQueryContext(SITE, "private-dashboard"),
    time,
    filters,
    scopePreference: scope,
    granularity,
  } satisfies QueryInput & {
    readonly filters: FilterDocument;
    readonly granularity: Interval;
    readonly scopePreference: "session" | "visitor";
    readonly time: QueryTime;
  };
  return prepareScopedQuery("retention", query);
}

function writeEvidence(contents: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeEvidenceFile("provider-before.json", contents);
}

function writeEvidenceFile(filename: string, contents: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, filename),
    `${JSON.stringify(contents, null, 2)}\n`,
    "utf8",
  );
}

function queryWindowFromTime(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

async function captureLegacy(
  label: string,
  filters: FilterDocument,
  granularity: Interval = "day",
) {
  const queryTrace = trace();
  const dto = await queryRetentionFromD1(
    env(database, queryTrace),
    SITE,
    WINDOW,
    filters,
    granularity,
  );
  expect(queryTrace.preparedSql).toHaveLength(1);
  expect(queryTrace.bindings).toHaveLength(1);
  return {
    label,
    dto,
    sql: queryTrace.preparedSql[0],
    bindings: queryTrace.bindings[0],
  };
}

describe("Retention qualified relationalization baseline and regression", () => {
  beforeAll(() => {
    database = createMigratedDatabase();
    database.exec("PRAGMA foreign_keys = OFF");
    site = addSite(database, SITE);
    otherSite = addSite(database, OTHER_SITE);
    seedPages(database);
  });

  afterAll(() => database.close());

  it("captures current provider DTO, SQL, and bindings before route changes", async () => {
    const baseline = [
      await captureLegacy("ordinary-week", { version: 1, root: null }, "week"),
      await captureLegacy("direct-page-filter-day", pathFilter("/match")),
      await captureLegacy(
        "prepared-session-count-match-day",
        preparedFilter("session", pathFilter("/match")),
      ),
      await captureLegacy(
        "prepared-visitor-count-match-day",
        preparedFilter("visitor", pathFilter("/match")),
      ),
    ];
    writeEvidence({
      capturedAt: new Date().toISOString(),
      state: "legacy-direct-provider-control-reference",
      note: "Direct queryRetentionFromD1 captures the existing legacy report implementation; prepared advancedMatches represent upstream Count identities. The new Count-fused route is checked separately against this reader result.",
      site: SITE,
      otherSite: OTHER_SITE,
      window: WINDOW,
      records: baseline,
    });
    expect(baseline.map(({ label }) => label)).toEqual([
      "ordinary-week",
      "direct-page-filter-day",
      "prepared-session-count-match-day",
      "prepared-visitor-count-match-day",
    ]);
  });

  it("keeps direct SEM050 tracking reader-wide and prepared tracking scoped", async () => {
    const direct = await queryRetentionFromD1(
      env(database, trace()),
      SITE,
      WINDOW,
      pathFilter("/match"),
      "day",
    );
    expect(direct).toEqual({
      granularity: "day",
      cohorts: [
        {
          bucket: START,
          size: 1,
          periods: [
            { index: 0, visitors: 1, rate: 1 },
            { index: 1, visitors: 1, rate: 1 },
            { index: 2, visitors: 1, rate: 1 },
            { index: 3, visitors: 1, rate: 1 },
          ],
        },
        {
          bucket: START + DAY,
          size: 1,
          periods: [
            { index: 0, visitors: 1, rate: 1 },
            { index: 1, visitors: 1, rate: 1 },
          ],
        },
      ],
    });
    const query = countQualifiedQuery("visitor");
    const provider = createD1SiteProviderRegistry({
      env: env(database, trace()),
      siteId: SITE,
    }).resolve("retention");
    if (!provider) throw new Error("retention_provider_missing");
    const prepared = await provider.execute(query as never);
    expect(prepared.value).toEqual({
      granularity: "day",
      cohorts: [
        {
          bucket: START,
          size: 1,
          periods: [
            { index: 0, visitors: 1, rate: 1 },
            { index: 1, visitors: 1, rate: 1 },
            { index: 2, visitors: 1, rate: 1 },
            { index: 3, visitors: 1, rate: 1 },
          ],
        },
      ],
    });
    expect(prepared.value).not.toEqual(direct);
  });

  it.each([
    {
      name: "or-session-day",
      scope: "session" as const,
      granularity: "day" as const,
      filterDsl:
        'page.path eq "/match" or count(event { event.name eq "retention-qualifier" }) eq 1',
      expectedIds: ["visitor-a-session-0", "visitor-b-session-1"],
      excludedIds: [] as string[],
    },
    {
      name: "not-visitor-week",
      scope: "visitor" as const,
      granularity: "week" as const,
      filterDsl:
        'not (page.path eq "/match" and count(event { event.name eq "retention-qualifier" }) eq 1)',
      expectedIds: ["visitor-b", "visitor-97dr-count-only"],
      excludedIds: ["visitor-a"],
    },
  ])(
    "97DR Retention $name preserves the full legacy cohort DTO",
    async (item) => {
      const countOnlyPage = "wave97dr-count-only-page";
      addPage(database, {
        id: countOnlyPage,
        visitor: "visitor-97dr-count-only",
        session: "session-97dr-count-only",
        at: START + 1_500,
        path: "/other",
      });
      addRetentionEvent(
        database,
        "retention-qualifier",
        countOnlyPage,
        START + 1_510,
        site,
      );
      try {
        const query = retentionWholeFilterQuery(
          item.scope,
          item.granularity,
          item.filterDsl,
        );
        const preflight = await d1AdvancedFilterMiddleware(
          env(database, trace()),
          undefined,
          SITE,
        )("retention", query, async (next) => next);
        const request = deferredRetentionQualificationFromQuery(preflight);
        expect(request).toBeDefined();
        if (!request)
          throw new Error(`wave97dr_retention_request_missing:${item.name}`);
        expect(request.filterMode).toBe("allow-whole-filter");
        expect(request.qualification.metadata.plan.advancedMatches).toBe(
          undefined,
        );
        if (item.name === "or-session-day") {
          const nonCanonical = {
            ...query,
            analysis: { kind: "unsupported-context" },
          };
          const rejected = await d1AdvancedFilterMiddleware(
            env(database, trace()),
            undefined,
            SITE,
          )("retention", nonCanonical, async (next) => next);
          expect(
            deferredRetentionQualificationFromQuery(rejected),
          ).toBeUndefined();
        }

        const compilation = compileRetentionQualificationProgram({
          query: preflight as QueryInput & Record<string, unknown>,
          deferred: request,
        });
        expect(compilation.kind).toBe("compiled");
        if (compilation.kind !== "compiled") return;
        expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
        expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
        expect(compilation.evidence.groupedSummaryProof).toMatchObject({
          source: "local-plan",
          groupKeyCount: 2,
          matchingSharedRelationCount: 1,
          materialization: "materialized",
        });

        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          request.qualification,
        );
        const fallbackMetadata = scopedFilterMetadata(fallbackFilters);
        const advancedMatches = fallbackMetadata?.plan.advancedMatches;
        if (!fallbackMetadata || !advancedMatches)
          throw new Error(`wave97dr_retention_fallback_missing:${item.name}`);
        const matchingIds =
          advancedMatches.entityIds?.map(({ id }) => id) ?? [];
        const expectedIds =
          item.name === "or-session-day"
            ? [...item.expectedIds, "session-97dr-count-only"]
            : item.expectedIds;
        for (const id of expectedIds) expect(matchingIds).toContain(id);
        for (const id of item.excludedIds)
          expect(matchingIds).not.toContain(id);
        const legacyFilters = attachScopedFilterMetadata(
          EMPTY_FILTER_DOCUMENT,
          fallbackMetadata,
        );
        const legacyTrace = trace();
        const legacy = await queryRetentionFromD1(
          env(database, legacyTrace),
          SITE,
          queryWindowFromTime(request.qualification.requestTime),
          legacyFilters,
          item.granularity,
        );

        const runtimeTrace = trace();
        const provider = createD1SiteProviderRegistry({
          env: env(database, runtimeTrace),
          siteId: SITE,
        }).resolve("retention");
        if (!provider) throw new Error("wave97dr_retention_provider_missing");
        const actual = await provider.execute(query as never);
        expect(actual.value).toEqual(legacy);
        expect(
          runtimeTrace.preparedSql.filter(isRetentionEnvelopeSql),
        ).toHaveLength(1);
        writeEvidenceFile(`wave97dr-retention-${item.name}.json`, {
          operation: "retention",
          name: item.name,
          scope: item.scope,
          granularity: item.granularity,
          filterDsl: item.filterDsl,
          filterMode: request.filterMode,
          matchingIds,
          actualDto: actual.value,
          legacyDto: legacy,
          compiledSql: compilation.query.sql,
          compiledBindings: compilation.query.bindings,
          sqlBytes: compilation.evidence.sqlBytes,
          bindingCount: compilation.evidence.bindingCount,
          groupedSummaryProof: compilation.evidence.groupedSummaryProof,
          runtimeStatements: runtimeTrace.preparedSql.map((sql, index) => ({
            sql,
            bindings: runtimeTrace.bindings[index],
          })),
          legacyStatements: legacyTrace.preparedSql.map((sql, index) => ({
            sql,
            bindings: legacyTrace.bindings[index],
          })),
        });
      } finally {
        database
          .prepare("DELETE FROM custom_events WHERE event_id = ?")
          .run(`retention-event-${SITE}-${countOnlyPage}`);
        database
          .prepare("DELETE FROM visits WHERE visit_id = ?")
          .run(countOnlyPage);
      }
    },
  );

  it.each([
    [
      "session",
      {
        granularity: "day",
        cohorts: [
          {
            bucket: START,
            size: 1,
            periods: [
              { index: 0, visitors: 1, rate: 1 },
              { index: 1, visitors: 1, rate: 1 },
            ],
          },
        ],
      },
    ],
    [
      "visitor",
      {
        granularity: "day",
        cohorts: [
          {
            bucket: START,
            size: 1,
            periods: [
              { index: 0, visitors: 1, rate: 1 },
              { index: 1, visitors: 1, rate: 1 },
              { index: 2, visitors: 1, rate: 1 },
              { index: 3, visitors: 1, rate: 1 },
            ],
          },
        ],
      },
    ],
  ] as const)(
    "runs Count-qualified retention for %s scope",
    async (scope, expected) => {
      const query = countQualifiedQuery(scope);
      const preflightTrace = trace();
      const forwarded = await d1AdvancedFilterMiddleware(
        env(database, preflightTrace),
        undefined,
        SITE,
      )("retention", query, async (next) => next);
      const deferred = deferredRetentionQualificationFromQuery(forwarded);
      expect(deferred).toBeDefined();
      if (!deferred) throw new Error("retention_qualification_request_missing");
      const compilation = compileRetentionQualificationProgram({
        query: forwarded as QueryInput & Record<string, unknown>,
        deferred,
      });
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled") return;
      expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
      expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
      expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
      expect(compilation.evidence.groupedSummaryProof).toMatchObject({
        source: "local-plan",
        nodeKind: "aggregate",
        groupKeyCount: 2,
        matchingSharedRelationCount: 1,
        materialization: "materialized",
      });

      const runtimeTrace = trace();
      const envelopeRows: Record<string, unknown>[][] = [];
      const provider = createD1SiteProviderRegistry({
        env: envWithRows(database, runtimeTrace, (sql, rows) => {
          if (isRetentionEnvelopeSql(sql)) envelopeRows.push([...rows]);
          return rows;
        }),
        siteId: SITE,
      }).resolve("retention");
      if (!provider) throw new Error("retention_provider_missing");
      const result = await provider.execute(query as never);
      expect(result.value).toEqual(expected);
      const reportSql = runtimeTrace.preparedSql.filter(isRetentionEnvelopeSql);
      expect(reportSql).toHaveLength(1);
      expect(envelopeRows).toHaveLength(1);
      expect(envelopeRows[0]!.some((row) => row.rowKind === "control")).toBe(
        true,
      );
      writeEvidenceFile(`qualified-after-${scope}.json`, {
        scope,
        dto: result.value,
        sql: compilation.query.sql,
        bindings: compilation.query.bindings,
        envelopeRows: envelopeRows[0],
        controlOutputId: compilation.evidence.controlOutputId,
        controlFields: compilation.evidence.controlFields,
        compatibilityFields: compilation.evidence.compatibilityFields,
        sqlBytes: compilation.evidence.sqlBytes,
        bindingCount: compilation.evidence.bindingCount,
        groupWidth: compilation.evidence.groupWidth,
        groupedSummaryProof: compilation.evidence.groupedSummaryProof,
        reportReadCount: reportSql.length,
      });
    },
  );

  it.each([
    ["minute", 5 * 60_000],
    ["hour", 5 * 60 * 60_000],
    ["day", 5 * DAY],
    ["week", 28 * DAY],
    ["month", 124 * DAY],
  ] as const)(
    "matches the legacy reader-window result for both scopes at %s granularity",
    async (granularity, duration) => {
      const window: QueryWindow = {
        startMs: START,
        endExclusiveMs: START + duration,
        nowMs: START + duration + DAY,
        timeZone: "UTC",
      };
      const evidence: unknown[] = [];
      for (const scope of ["session", "visitor"] as const) {
        const query = countQualifiedQuery(
          scope,
          granularity,
          undefined,
          window,
        );
        const forwarded = await d1AdvancedFilterMiddleware(
          env(database, trace()),
          undefined,
          SITE,
        )("retention", query, async (next) => next);
        const deferred = deferredRetentionQualificationFromQuery(forwarded);
        expect(deferred).toBeDefined();
        if (!deferred)
          throw new Error("retention_qualification_request_missing");
        const compilation = compileRetentionQualificationProgram({
          query: forwarded as QueryInput & Record<string, unknown>,
          deferred,
        });
        expect(compilation.kind).toBe("compiled");
        if (compilation.kind !== "compiled") continue;
        expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
        expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
        expect(compilation.evidence.groupedSummaryProof).toMatchObject({
          source: "local-plan",
          nodeKind: "aggregate",
          groupKeyCount: 2,
          matchingSharedRelationCount: 1,
          materialization: "materialized",
        });
        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          deferred.qualification,
        );
        const expected = await queryRetentionFromD1(
          env(database, trace()),
          SITE,
          queryWindowFromTime(deferred.qualification.requestTime),
          fallbackFilters,
          granularity,
        );
        const provider = createD1SiteProviderRegistry({
          env: env(database, trace()),
          siteId: SITE,
        }).resolve("retention");
        if (!provider) throw new Error("retention_provider_missing");
        const actual = await provider.execute(query as never);
        expect(actual.value).toEqual(expected);
        evidence.push({
          scope,
          granularity,
          dto: actual.value,
          sqlBytes: compilation.evidence.sqlBytes,
          bindings: compilation.evidence.bindingCount,
          groupWidth: compilation.evidence.groupWidth,
          groupedSummaryProof: compilation.evidence.groupedSummaryProof,
        });
      }
      writeEvidenceFile(`calendar-${granularity}.json`, {
        window,
        records: evidence,
      });
    },
  );

  it("preserves local-day buckets across the New York daylight-saving transition", async () => {
    const window: QueryWindow = {
      startMs: Date.parse("2026-03-07T00:00:00-05:00"),
      endExclusiveMs: Date.parse("2026-03-11T00:00:00-04:00"),
      nowMs: Date.parse("2026-03-12T00:00:00-04:00"),
      timeZone: "America/New_York",
    };
    const records: unknown[] = [];
    for (const scope of ["session", "visitor"] as const) {
      const query = countQualifiedQuery(scope, "day", undefined, window);
      const forwarded = await d1AdvancedFilterMiddleware(
        env(database, trace()),
        undefined,
        SITE,
      )("retention", query, async (next) => next);
      const deferred = deferredRetentionQualificationFromQuery(forwarded);
      expect(deferred).toBeDefined();
      if (!deferred) throw new Error("retention_qualification_request_missing");
      const compilation = compileRetentionQualificationProgram({
        query: forwarded as QueryInput & Record<string, unknown>,
        deferred,
      });
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled") continue;
      const filters = await prepareDeferredEventQualificationFallback(
        deferred.qualification,
      );
      const expected = await queryRetentionFromD1(
        env(database, trace()),
        SITE,
        window,
        filters,
        "day",
      );
      const provider = createD1SiteProviderRegistry({
        env: env(database, trace()),
        siteId: SITE,
      }).resolve("retention");
      if (!provider) throw new Error("retention_provider_missing");
      const actual = await provider.execute(query as never);
      expect(actual.value).toEqual(expected);
      records.push({
        scope,
        dto: actual.value,
        sqlBytes: compilation.evidence.sqlBytes,
        bindings: compilation.evidence.bindingCount,
        groupedSummaryProof: compilation.evidence.groupedSummaryProof,
      });
    }
    expect(records).toHaveLength(2);
    writeEvidenceFile("calendar-new-york-dst.json", { window, records });
  });

  it.each([
    [
      "invalid control number",
      "retention_qualification_control_invalid:rawCount",
    ],
    ["unknown envelope kind", "retention_qualification_envelope_kind_invalid"],
    [
      "unknown envelope kind with fallback control",
      "retention_qualification_envelope_kind_invalid",
    ],
    ["unknown output id", "retention_qualification_report_row_invalid"],
    ["out of range bucket", "retention_qualification_report_value_invalid"],
    ["nonpositive count", "retention_qualification_report_value_invalid"],
    [
      "duplicate bucket pair",
      "retention_qualification_report_order_or_pair_invalid",
    ],
    [
      "report leaked through control gate",
      "retention_qualification_gate_violation",
    ],
  ] as const)(
    "rejects %s from the report adapter",
    async (scenario, expectedError) => {
      const query = countQualifiedQuery("visitor");
      const forwarded = await d1AdvancedFilterMiddleware(
        env(database, trace()),
        undefined,
        SITE,
      )("retention", query, async (next) => next);
      const deferred = deferredRetentionQualificationFromQuery(forwarded);
      expect(deferred).toBeDefined();
      if (!deferred) throw new Error("retention_qualification_request_missing");
      const queryTrace = trace();
      let transformed = false;
      const badEnv = envWithRows(database, queryTrace, (sql, rows) => {
        if (!isRetentionEnvelopeSql(sql)) return rows;
        transformed = true;
        const report = rows.find((row) => row.rowKind === "report");
        const control = rows.find((row) => row.rowKind === "control");
        if (!report || !control)
          throw new Error("retention_test_report_or_control_missing");
        switch (scenario) {
          case "invalid control number":
            return rows.map((row) =>
              row.rowKind === "control" ? { ...row, rawCount: "0" } : row,
            );
          case "unknown envelope kind":
            return rows.map((row) =>
              row.rowKind === "report" ? { ...row, rowKind: "unknown" } : row,
            );
          case "unknown envelope kind with fallback control":
            return rows.map((row) =>
              row.rowKind === "control"
                ? { ...row, nullActivityIdCount: 1 }
                : { ...row, rowKind: "unknown" },
            );
          case "unknown output id":
            return rows.map((row) =>
              row.rowKind === "report"
                ? { ...row, outputId: "unknown-retention-output" }
                : row,
            );
          case "out of range bucket":
            return rows.map((row) =>
              row.rowKind === "report" ? { ...row, cohortBucket: 99_999 } : row,
            );
          case "nonpositive count":
            return rows.map((row) =>
              row.rowKind === "report" ? { ...row, visitors: 0 } : row,
            );
          case "duplicate bucket pair":
            return [...rows, { ...report }];
          case "report leaked through control gate":
            return rows.map((row) =>
              row.rowKind === "control"
                ? { ...row, nullActivityIdCount: 1 }
                : row,
            );
        }
      });
      await expect(
        executeRetentionQualificationProgram({
          env: badEnv,
          query: forwarded as QueryInput & Record<string, unknown>,
          deferred,
        }),
      ).rejects.toThrow(expectedError);
      expect(transformed).toBe(true);
      expect(
        queryTrace.preparedSql.filter(isRetentionEnvelopeSql),
      ).toHaveLength(1);
    },
  );

  it("refuses copied, mutated, accessor-backed, aborted, and failed report requests without retry", async () => {
    const prepareForwarded = async (signal?: AbortSignal) => {
      const query = countQualifiedQuery("session");
      const forwarded = await d1AdvancedFilterMiddleware(
        env(database, trace()),
        undefined,
        SITE,
      )(
        "retention",
        query,
        async (next) => next,
        signal ? { signal } : undefined,
      );
      const deferred = deferredRetentionQualificationFromQuery(forwarded);
      if (!deferred) throw new Error("retention_qualification_request_missing");
      return {
        forwarded: forwarded as QueryInput & Record<string, unknown>,
        deferred,
      };
    };
    const assertNoReportRead = async (
      action: (
        query: QueryInput & Record<string, unknown>,
        deferred: NonNullable<
          ReturnType<typeof deferredRetentionQualificationFromQuery>
        >,
        queryTrace: SqliteD1Trace,
      ) => Promise<unknown>,
    ) => {
      const { forwarded, deferred } = await prepareForwarded();
      const queryTrace = trace();
      await action(forwarded, deferred, queryTrace);
      expect(
        queryTrace.preparedSql.filter(isRetentionEnvelopeSql),
      ).toHaveLength(0);
    };

    await assertNoReportRead(async (forwarded, deferred, queryTrace) => {
      const clone = Object.create(Object.getPrototypeOf(forwarded)) as object;
      for (const key of Reflect.ownKeys(forwarded)) {
        const descriptor = Object.getOwnPropertyDescriptor(forwarded, key);
        if (descriptor) Object.defineProperty(clone, key, descriptor);
      }
      await expect(
        executeRetentionQualificationProgram({
          env: env(database, queryTrace),
          query: clone as QueryInput & Record<string, unknown>,
          deferred,
        }),
      ).rejects.toThrow("retention_qualification_request_changed");
    });
    await assertNoReportRead(async (forwarded, deferred, queryTrace) => {
      forwarded.granularity = "month";
      await expect(
        executeRetentionQualificationProgram({
          env: env(database, queryTrace),
          query: forwarded,
          deferred,
        }),
      ).rejects.toThrow("retention_qualification_request_changed");
    });
    let getterCalls = 0;
    await assertNoReportRead(async (forwarded, deferred, queryTrace) => {
      Object.defineProperty(forwarded, "granularity", {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls += 1;
          return "day";
        },
      });
      await expect(
        executeRetentionQualificationProgram({
          env: env(database, queryTrace),
          query: forwarded,
          deferred,
        }),
      ).rejects.toThrow("retention_qualification_request_changed");
    });
    expect(getterCalls).toBe(0);

    const controller = new AbortController();
    const { forwarded, deferred } = await prepareForwarded(controller.signal);
    controller.abort();
    const abortedTrace = trace();
    await expect(
      executeRetentionQualificationProgram({
        env: env(database, abortedTrace),
        query: forwarded,
        deferred,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      abortedTrace.preparedSql.filter(isRetentionEnvelopeSql),
    ).toHaveLength(0);

    const failedTrace = trace();
    const failedProvider = createD1SiteProviderRegistry({
      env: envWithRows(database, failedTrace, (sql, rows) => {
        if (isRetentionEnvelopeSql(sql))
          throw new Error("retention_report_d1_failed");
        return rows;
      }),
      siteId: SITE,
    }).resolve("retention");
    if (!failedProvider) throw new Error("retention_provider_missing");
    await expect(
      failedProvider.execute(countQualifiedQuery("session") as never),
    ).rejects.toThrow("retention_report_d1_failed");
    expect(failedTrace.preparedSql.filter(isRetentionEnvelopeSql)).toHaveLength(
      1,
    );
    expect(
      failedTrace.preparedSql.filter(
        (sql) =>
          sql.includes('AS "cohortBucket"') &&
          sql.includes('AS "visitBucket"') &&
          !sql.includes('AS "rowKind"'),
      ),
    ).toHaveLength(0);
  });

  it.each(["session", "visitor"] as const)(
    "reads the %s entity membership instead of the legacy ID bridge for a numeric fallback",
    async (scope) => {
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "a-match-0");
      const query = countQualifiedQuery(
        scope,
        "day",
        "count(page { page.durationMs gt 5 }) eq 0",
      );
      const queryTrace = trace();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: env(database, queryTrace),
        siteId: SITE,
        diagnostics,
      }).resolve("retention");
      if (!provider) throw new Error("retention_provider_missing");
      const result = await provider.execute(query as never);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });

      const legacyTrace = trace();
      const legacyEnv = env(database, legacyTrace);
      const forwarded = await d1AdvancedFilterMiddleware(
        legacyEnv,
        undefined,
        SITE,
      )("retention", query, async (next) => next);
      const deferred = deferredRetentionQualificationFromQuery(forwarded);
      if (!deferred) throw new Error("retention_legacy_deferred_missing");
      const legacy = await queryRetentionFromD1(
        legacyEnv,
        SITE,
        WINDOW,
        await prepareDeferredEventQualificationFallback(deferred.qualification),
        "day",
      );
      expect(legacy.cohorts.length).toBeGreaterThan(0);
      expect(result.value).toEqual(legacy);
      // The legacy ID bridge binds the entity kind next to every identity;
      // the request-private entity membership binds only (site, id) pairs.
      expect(legacyTrace.bindings.at(-1) ?? []).toContain(scope);
      expect(queryTrace.bindings.at(-1) ?? []).not.toContain(scope);
    },
  );

  it("falls back once for real text numeric duration data", async () => {
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "a-match-0");
    const query = countQualifiedQuery(
      "session",
      "day",
      "count(page { page.durationMs gt 5 }) eq 1",
    );
    const queryTrace = trace();
    const diagnostics = createD1ReadDiagnostics();
    const envelopeRows: Record<string, unknown>[][] = [];
    const provider = createD1SiteProviderRegistry({
      env: envWithRows(database, queryTrace, (sql, rows) => {
        if (isRetentionEnvelopeSql(sql)) envelopeRows.push([...rows]);
        return rows;
      }),
      siteId: SITE,
      diagnostics,
    }).resolve("retention");
    if (!provider) throw new Error("retention_provider_missing");
    const result = await provider.execute(query as never);
    expect(result.value).toEqual({ granularity: "day", cohorts: [] });
    expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    expect(
      queryTrace.preparedSql.filter(
        (sql) => sql.includes('"rowKind"') && sql.includes('"outputId"'),
      ),
    ).toHaveLength(1);
    expect(
      queryTrace.preparedSql.filter(
        (sql) =>
          sql.includes('AS "cohortBucket"') &&
          sql.includes('AS "visitBucket"') &&
          !sql.includes('AS "rowKind"'),
      ),
    ).toHaveLength(1);
    const fallbackReportSql = queryTrace.preparedSql.filter(
      (sql) =>
        sql.includes('AS "cohortBucket"') &&
        sql.includes('AS "visitBucket"') &&
        !isRetentionEnvelopeSql(sql),
    );
    expect(envelopeRows).toHaveLength(1);
    const controlRow = envelopeRows[0]!.find(
      (row) => row.rowKind === "control",
    );
    expect(controlRow).toBeDefined();
    expect(envelopeRows[0]!.some((row) => row.rowKind === "report")).toBe(
      false,
    );
    writeEvidenceFile("numeric-text-fallback-after.json", {
      dto: result.value,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      controlRow,
      envelopeReportRowCount: envelopeRows[0]!.filter(
        (row) => row.rowKind === "report",
      ).length,
      fusedReportReadCount: queryTrace.preparedSql.filter(
        isRetentionEnvelopeSql,
      ).length,
      fallbackReportSql,
      allPreparedSql: queryTrace.preparedSql,
      bindings: queryTrace.bindings,
    });
  });
});
