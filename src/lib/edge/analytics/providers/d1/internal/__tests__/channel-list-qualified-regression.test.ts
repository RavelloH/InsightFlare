import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { buildChannelListQualificationPlan } from "@/lib/edge/analytics/engine/channel-list-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredChannelListQualificationFromQuery,
  deferredChannelOverviewQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compileChannelListQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { queryChannelsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/channels";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE = "wave95u-channel-list";
const TIME = createQueryTime(120, 130, "UTC", 500);
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const SECRET = "wave95u-channel-list-test-secret";
const FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';
const databases = new Set<DatabaseSync>();
const supplementalEvidence: Array<Record<string, unknown>> = [];
const wholeBooleanEvidence: Array<Record<string, unknown>> = [];
const WHOLE_BOOLEAN_OR_FILTER =
  'page.path eq "/native-only" or count(event { event.name eq "qualifier" }) gte 1';
const WHOLE_BOOLEAN_NOT_FILTER =
  'not count(event { event.name eq "qualifier" }) gte 1';

type ChannelQuery = QueryInput & {
  readonly time: QueryTime;
  readonly mode: string;
  readonly limit?: number;
  readonly page?: { readonly limit?: number; readonly cursor?: string | null };
  readonly search?: string;
  readonly sort?: unknown;
  readonly cursor?: string | null;
};

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function addSite(database: DatabaseSync): TestSite {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave95u-team', 'Channel list qualification', 'channels.test', 0)`,
    )
    .run(SITE);
  return { id: SITE, pk: Number(identity.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  site: TestSite,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly visitorId: string;
    readonly path: string;
    readonly startedAt: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'channels.test', 10)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.path,
    );
}

function addEvent(
  database: DatabaseSync,
  site: TestSite,
  input: { readonly id: string; readonly visitId: string; readonly at: number },
): void {
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(site.id, input.at, site.pk);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 0)`,
    )
    .run(input.id, site.id, site.pk, input.visitId, input.at, input.at);
}

function createFixture(): {
  readonly database: DatabaseSync;
  readonly site: TestSite;
} {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const visits = [
    ["organic", "session-shared", "visitor-shared", "/organic", 121],
    ["social", "session-shared", "visitor-shared", "/social", 122],
    ["email-other-session", "session-email", "visitor-shared", "/email", 123],
    ["paid", "session-paid", "visitor-paid", "/paid", 124],
    ["direct", "session-direct", "visitor-direct", "/direct", 125],
    ["referral-a", "session-referral", "visitor-referral", "/referral-a", 126],
    ["referral-b", "session-referral", "visitor-referral", "/referral-b", 127],
    ["campaign", "session-campaign", "visitor-campaign", "/campaign", 128],
    ["excluded", "session-shared", "visitor-shared", "/excluded", 129],
    ["no-owner", "session-no-owner", "visitor-no-owner", "/unqualified", 129],
  ] as const;
  for (const [id, sessionId, visitorId, path, startedAt] of visits)
    addVisit(database, site, { id, sessionId, visitorId, path, startedAt });

  const attribution = database.prepare(
    `UPDATE visits SET utm_source = ?, utm_medium = ?, utm_campaign = ?, referrer_host = ? WHERE visit_id = ?`,
  );
  for (const row of [
    ["", "", "", "www.google.com", "organic"],
    ["", "", "", "m.facebook.com", "social"],
    ["newsletter", "email", "spring", "", "email-other-session"],
    ["search-ad", "cpc", "spring", "", "paid"],
    ["", "", "", "", "direct"],
    ["", "", "", "publisher.example", "referral-a"],
    ["", "", "", "publisher.example", "referral-b"],
    ["partner", "sponsorship", "winter", "", "campaign"],
  ] as const)
    attribution.run(...row);

  for (const [id, visitId, at] of [
    ["event-organic", "organic", 121],
    ["event-paid", "paid", 124],
    ["event-direct", "direct", 125],
    ["event-referral", "referral-a", 126],
    ["event-campaign", "campaign", 128],
  ] as const)
    addEvent(database, site, { id, visitId, at });
  return { database, site };
}

function seedWholeBooleanChannelCases(
  database: DatabaseSync,
  site: TestSite,
): void {
  addVisit(database, site, {
    id: "native-only",
    sessionId: "session-native-only",
    visitorId: "visitor-native-only",
    path: "/native-only",
    startedAt: 122,
  });
  database
    .prepare(
      "UPDATE visits SET utm_source = 'newsletter', utm_medium = 'email' WHERE visit_id = ?",
    )
    .run("native-only");
  database
    .prepare(
      "UPDATE visits SET utm_source = 'unclassified', utm_medium = 'unclassified' WHERE visit_id = ?",
    )
    .run("no-owner");
}

function independentChannelRows(
  database: DatabaseSync,
  scope: "session" | "visitor",
  branch: "or" | "not",
): readonly {
  readonly channel: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}[] {
  const countOwners =
    scope === "session"
      ? new Set([
          "session-shared",
          "session-paid",
          "session-direct",
          "session-referral",
          "session-campaign",
        ])
      : new Set([
          "visitor-shared",
          "visitor-paid",
          "visitor-direct",
          "visitor-referral",
          "visitor-campaign",
        ]);
  const channelByVisit: Readonly<Record<string, string>> = {
    organic: "organic_search",
    social: "social",
    "email-other-session": "email",
    paid: "paid_search",
    direct: "direct",
    "referral-a": "referral",
    "referral-b": "referral",
    campaign: "campaign",
    excluded: "direct",
    "no-owner": "other",
    "native-only": "email",
  };
  const visits = database
    .prepare(
      `SELECT visit_id, session_id, visitor_id, pathname
       FROM visits WHERE site_id = ? AND started_at >= ? AND started_at < ?`,
    )
    .all(SITE, WINDOW.startMs, WINDOW.endExclusiveMs) as Array<{
    readonly visit_id: string;
    readonly session_id: string;
    readonly visitor_id: string;
    readonly pathname: string;
  }>;
  const grouped = new Map<
    string,
    { views: number; sessions: Set<string>; visitors: Set<string> }
  >();
  for (const visit of visits) {
    const owner = scope === "session" ? visit.session_id : visit.visitor_id;
    const countMatch = countOwners.has(owner);
    const nativeMatch = visit.pathname === "/native-only";
    if (branch === "or" ? !nativeMatch && !countMatch : countMatch) continue;
    const channel = channelByVisit[visit.visit_id];
    if (!channel)
      throw new Error(`wave97dh_channel_expectation_missing:${visit.visit_id}`);
    const group = grouped.get(channel) ?? {
      views: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    group.views += 1;
    group.sessions.add(visit.session_id);
    group.visitors.add(visit.visitor_id);
    grouped.set(channel, group);
  }
  return [...grouped.entries()]
    .map(([channel, totals]) => ({
      channel,
      views: totals.views,
      sessions: totals.sessions.size,
      visitors: totals.visitors.size,
    }))
    .sort(
      (left, right) =>
        right.views - left.views ||
        right.sessions - left.sessions ||
        left.channel.localeCompare(right.channel),
    );
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: SECRET,
  } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor" | "event",
  options: {
    readonly audience?: "private-dashboard" | "api-v1" | "public-share";
    readonly filter?: string;
    readonly limit?: number;
    readonly mode?: string;
    readonly operation?: "channels" | "dimension";
  } = {},
): ChannelQuery {
  const prepared = prepareScopedQuery(options.operation ?? "channels", {
    context: siteQueryContext(SITE, options.audience ?? "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(options.filter ?? FILTER, analyticsFilterRegistry),
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    mode: options.mode ?? "list",
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  } as ChannelQuery;
}

async function oldListDto(
  database: DatabaseSync,
  query: ChannelQuery,
  trace: SqliteD1Trace,
): Promise<{ readonly items: readonly unknown[] }> {
  const env = testEnv(database, trace);
  const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
  // The old channels-list route used generic Count preparation before its
  // existing channel reader. "pages" selects that same generic middleware.
  const eventCandidate = query.scopePlan?.scope === "event";
  const forwarded = (await middleware(
    eventCandidate ? "channels" : "pages",
    query,
    async (value) => value,
  )) as ChannelQuery;
  const deferred = eventCandidate
    ? deferredChannelListQualificationFromQuery(forwarded)
    : undefined;
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : forwarded.filters;
  if (!filters) throw new Error("wave95u_legacy_channel_list_filters_missing");
  const metadata = scopedFilterMetadata(filters);
  const matches = metadata?.plan.advancedMatches;
  const entityIds = matches?.entityIds?.map(({ id }) => id) ?? [];
  const serializedFilters = JSON.stringify(query.filters);
  const checksEventOwner =
    serializedFilters.includes("event.name") &&
    !serializedFilters.includes('"kind":"not"');
  if (checksEventOwner && entityIds.length > 0)
    expect(entityIds).not.toContain(
      metadata?.plan.scope === "visitor"
        ? "visitor-no-owner"
        : "session-no-owner",
    );
  recordEvidence("legacy-count-preparation", {
    scope: metadata?.plan.scope,
    matches,
    emptyOwnerExcluded: checksEventOwner
      ? entityIds.length === 0 ||
        !entityIds.includes(
          metadata?.plan.scope === "visitor"
            ? "visitor-no-owner"
            : "session-no-owner",
        )
      : null,
    nativeFilter: filters.root,
    sql: trace.preparedSql,
  });
  const rows = await queryChannelsFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    query.limit ?? 100,
  );
  return {
    items: rows.map((row) => ({
      channel: row.channel,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
  };
}

async function actualListDto(
  database: DatabaseSync,
  query: ChannelQuery,
  trace: SqliteD1Trace,
  diagnostics = createD1ReadDiagnostics(),
) {
  const provider = createD1SiteProviderRegistry({
    env: testEnv(database, trace),
    siteId: SITE,
    diagnostics,
  }).resolve("channels");
  if (!provider) throw new Error("wave95u_channel_provider_missing");
  const execution = await provider.execute(query as never);
  return { value: execution.value, diagnostics };
}

async function compileListEvidence(
  database: DatabaseSync,
  query: ChannelQuery,
) {
  const env = testEnv(database, traceFor());
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "channels",
    query,
    async (value) => value,
  );
  const deferred = deferredChannelListQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("wave95u_channel_list_brand_missing");
  const limit = query.limit ?? 100;
  const sourceLimit = typeof query.limit === "number" ? query.limit : undefined;
  const request = {
    env,
    siteId: SITE,
    queryTime: query.time,
    filters: query.filters!,
    ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
    mode: "list" as const,
    limit,
    sourceLimit,
    audience: query.context.policy.audience,
    hasComparison: false,
    hasCurrent: false,
    hasReference: false,
  };
  const compiled = compileChannelListQualificationProgram({
    deferred,
    query: request,
  });
  if (compiled.kind !== "compiled")
    throw new Error("wave95u_channel_list_compile_unavailable");
  const logical = buildChannelListQualificationPlan({
    siteId: SITE,
    queryTime: query.time,
    filters: query.filters!,
    scopePlan: query.scopePlan ?? deferred.metadata.plan,
    count: deferred.countInput,
    limit,
    ...("eventCandidateReportProjection" in deferred &&
    deferred.eventCandidateReportProjection === "page-visits"
      ? { eventCandidateReportProjection: "page-visits" as const }
      : {}),
    ...(deferred.channelListFilterMode === "allow-whole-filter"
      ? { filterMode: "allow-whole-filter" as const }
      : {}),
  });
  return {
    compiled: compiled.evidence,
    logical: logical.plan,
    logicalPlan: logical,
  };
}

type D1Behavior =
  | "missing-control"
  | "duplicate-control"
  | "wrong-control-scope"
  | "malformed-report"
  | "sqlite-failure"
  | "observe";

function testEnvWithBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior: D1Behavior,
  observed?: {
    rawCount?: unknown;
    reportRows?: number;
    controlRows?: number;
  },
): Env {
  const baseDatabase = createSqliteD1Database(database, trace);
  let prepareCount = 0;
  const DB = {
    prepare(sql: string) {
      prepareCount += 1;
      const statement = baseDatabase.prepare(sql);
      if (prepareCount !== 2) return statement;
      const replacement = Object.create(statement) as D1PreparedStatement;
      Object.defineProperty(replacement, "bind", {
        value: (...values: SQLInputValue[]) => {
          statement.bind(...values);
          return replacement;
        },
      });
      const originalAll = statement.all.bind(statement);
      Object.defineProperty(replacement, "all", {
        value: async () => {
          if (behavior === "sqlite-failure")
            throw new Error("wave95u_sqlite_report_failure");
          const result = await originalAll<Record<string, unknown>>();
          const control = result.results.find(
            (row) => row.rowKind === "control",
          );
          const controls = result.results.filter(
            (row) => row.rowKind === "control",
          );
          const reportRows = result.results.filter(
            (row) => row.rowKind === "report",
          );
          if (observed) {
            observed.rawCount = control?.rawCount;
            observed.reportRows = reportRows.length;
            observed.controlRows = controls.length;
          }
          if (behavior === "missing-control")
            return {
              ...result,
              results: result.results.filter(
                (row) => row.rowKind !== "control",
              ),
            };
          if (behavior === "duplicate-control" && control)
            return { ...result, results: [...result.results, control] };
          if (behavior === "wrong-control-scope")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "control"
                  ? { ...row, entityKind: "visitor" }
                  : row,
              ),
            };
          if (behavior === "malformed-report")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "report" ? { ...row, channel: null } : row,
              ),
            };
          return result;
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: SECRET } as unknown as Env;
}

async function executeWithEnv(
  env: Env,
  query: ChannelQuery,
  options?: { readonly signal?: AbortSignal },
) {
  const provider = createD1SiteProviderRegistry({
    env,
    siteId: SITE,
  }).resolve("channels");
  if (!provider) throw new Error("wave95u_channel_provider_missing");
  return provider.execute(query as never, options);
}

function recordEvidence(
  recordType: string,
  fields: Record<string, unknown>,
): void {
  supplementalEvidence.push({ recordType, ...fields });
}

afterAll(async () => {
  for (const database of databases) database.close();
  const directory = process.env.WAVE95U_ARTIFACT_DIR;
  const wholeBooleanDirectory = process.env.WAVE97DH_ARTIFACT_DIR;
  if (!directory && !wholeBooleanDirectory) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/channel-list-regression-evidence.json`,
      JSON.stringify({ evidence: supplementalEvidence }, null, 2),
      "utf8",
    );
  }
  if (wholeBooleanDirectory) {
    await mkdir(wholeBooleanDirectory, { recursive: true });
    await writeFile(
      `${wholeBooleanDirectory}/channel-list-whole-boolean-evidence.json`,
      JSON.stringify({ evidence: wholeBooleanEvidence }, null, 2),
      "utf8",
    );
  }
});

describe("qualified ordinary channels list", () => {
  it("matches the Core fallback for a private Event candidate list request", async () => {
    const { database, site } = createFixture();
    seedWholeBooleanChannelCases(database, site);
    const query = queryFor("event", {
      filter: WHOLE_BOOLEAN_OR_FILTER,
      limit: 100,
    });
    const deferred = await compileListEvidence(database, query);
    const legacyTrace = traceFor();
    const legacy = await oldListDto(database, query, legacyTrace);
    const actualTrace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await actualListDto(
      database,
      query,
      actualTrace,
      diagnostics,
    );

    expect(deferred.logicalPlan.scope).toBe("event");
    expect(deferred.logicalPlan.eventCandidateReportProjection).toBe(
      "page-visits",
    );
    if (!("items" in actual.value))
      throw new Error("wave95u_event_candidate_channel_list_dto_missing");
    expect(actual.value).toEqual(legacy);
    expect(actual.value.items.length).toBeGreaterThan(0);
    expect(actualTrace.preparedSql).toHaveLength(2);
    expect(actualTrace.preparedSql[1]).toBe(deferred.compiled.sql);
    expect(actualTrace.bindings[1]).toEqual(deferred.compiled.bindings);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    recordEvidence("event-candidate-core-fallback", {
      countScope: deferred.logicalPlan.scope,
      candidateGrain: deferred.logicalPlan.candidateGrain,
      reportProjection: deferred.logicalPlan.eventCandidateReportProjection,
      legacyDto: legacy,
      actualDto: actual.value,
      legacyStatements: legacyTrace.preparedSql.length,
      actualStatements: actualTrace.preparedSql.length,
    });
  });

  it.each([
    { scope: "session", branch: "or", filter: WHOLE_BOOLEAN_OR_FILTER },
    { scope: "visitor", branch: "or", filter: WHOLE_BOOLEAN_OR_FILTER },
    { scope: "session", branch: "not", filter: WHOLE_BOOLEAN_NOT_FILTER },
    { scope: "visitor", branch: "not", filter: WHOLE_BOOLEAN_NOT_FILTER },
  ] as const)(
    "qualifies private whole Boolean $branch filters for $scope owners",
    async ({ scope, branch, filter }) => {
      const { database, site } = createFixture();
      seedWholeBooleanChannelCases(database, site);
      const query = queryFor(scope, { filter });
      const compiled = await compileListEvidence(database, query);
      const legacyTrace = traceFor();
      const legacy = await oldListDto(database, query, legacyTrace);
      const actualTrace = traceFor();
      const observed: {
        rawCount?: unknown;
        reportRows?: number;
        controlRows?: number;
      } = {};
      const actual = await executeWithEnv(
        testEnvWithBehavior(database, actualTrace, "observe", observed),
        query,
      );
      const expected = {
        items: independentChannelRows(database, scope, branch),
      };

      expect(actual.value).toEqual(legacy);
      expect(actual.value).toEqual(expected);
      expect(actualTrace.preparedSql).toHaveLength(2);
      expect(actualTrace.bindings).toHaveLength(2);
      expect(actualTrace.preparedSql[1]).toBe(compiled.compiled.sql);
      expect(actualTrace.bindings[1]).toEqual(compiled.compiled.bindings);
      expect(observed.controlRows).toBe(1);
      expect(observed.reportRows).toBe(expected.items.length);
      expect(actualTrace.preparedSql.join("\n")).not.toMatch(
        /rowKind\s*=\s*'candidate'|count_id_scan/u,
      );
      if (branch === "or") {
        const labels = expected.items.map(({ channel }) => channel);
        expect(labels).toContain("email");
        expect(labels).toContain("paid_search");
        expect(labels).not.toContain("other");
        if (scope === "visitor")
          expect(
            expected.items.find(({ channel }) => channel === "email")?.sessions,
          ).toBe(2);
      }
      wholeBooleanEvidence.push({
        mode: "list",
        scope,
        branch,
        filter,
        oldSql: legacyTrace.preparedSql,
        oldBindings: legacyTrace.bindings,
        actualSql: actualTrace.preparedSql,
        actualBindings: actualTrace.bindings,
        oldDto: legacy,
        actualDto: actual.value,
        independentExpected: expected,
        observedControlRawCount: observed.rawCount,
        observedControlRows: observed.controlRows,
        observedReportRows: observed.reportRows,
        sqlBytes: compiled.compiled.sqlBytes,
        bindingCount: compiled.compiled.bindingCount,
        statementTag: compiled.compiled.statementTag,
        physicalScanKinds: compiled.compiled.physicalScanKinds,
        oneQualificationAndReportEnvelope: actualTrace.preparedSql.length === 2,
        oneControlNoFallback: observed.controlRows === 1,
      });
    },
  );

  it.each(["session", "visitor"] as const)(
    "matches the independent legacy Count preparation and channel reader for %s scope",
    async (scope) => {
      const { database } = createFixture();
      const query = queryFor(scope);
      const compiled = await compileListEvidence(database, query);
      const legacyTrace = traceFor();
      const legacy = await oldListDto(database, query, legacyTrace);
      const actualTrace = traceFor();
      const actual = await actualListDto(database, query, actualTrace);

      expect(actual.value).toEqual(legacy);
      expect(actualTrace.preparedSql).toHaveLength(2);
      expect(actualTrace.bindings).toHaveLength(2);
      expect(actualTrace.preparedSql[1]).toBe(compiled.compiled.sql);
      expect(actualTrace.bindings[1]).toEqual(compiled.compiled.bindings);
      expect(legacy.items).toEqual(
        [...legacy.items].sort((left, right) => {
          const a = left as {
            channel: string;
            views: number;
            sessions: number;
          };
          const b = right as {
            channel: string;
            views: number;
            sessions: number;
          };
          return (
            b.views - a.views ||
            b.sessions - a.sessions ||
            a.channel.localeCompare(b.channel)
          );
        }),
      );
      const channels = legacy.items.map(
        (row) => (row as { readonly channel: string }).channel,
      );
      expect(channels).toContain("organic_search");
      expect(channels).toContain("social");
      expect(channels).toContain("paid_search");
      expect(channels).toContain("referral");
      expect(channels).toContain("direct");
      expect(channels).toContain("campaign");
      expect(channels).not.toContain("/excluded");
      if (scope === "session") expect(channels).not.toContain("email");
      else expect(channels).toContain("email");
      recordEvidence("legacy-equivalence", {
        scope,
        oldSqlCount: legacyTrace.preparedSql.length,
        fusedSqlCount: actualTrace.preparedSql.length,
        fusedSql: actualTrace.preparedSql,
        bindings: actualTrace.bindings,
        compiled: {
          statementTag: compiled.compiled.statementTag,
          sqlBytes: compiled.compiled.sqlBytes,
          bindingCount: compiled.compiled.bindingCount,
          groupWidth: compiled.compiled.groupWidth,
          rootKind: compiled.compiled.rootKind,
          sharedRelationCount: compiled.compiled.sharedRelationCount,
          physicalScanKinds: compiled.compiled.physicalScanKinds,
          physicalPlanShape: compiled.compiled.physicalPlanShape,
          primaryReportSourceRelationId:
            compiled.logicalPlan.primaryReportSourceRelationId,
          reportOutputIds: compiled.logicalPlan.reportOutputIds,
          reportSourceRelations: compiled.logicalPlan.reportSourceRelations,
          outputs: compiled.logical.outputs,
          logicalPlan: compiled.logical,
        },
        dto: actual.value,
        diagnostics: actual.diagnostics,
      });
    },
  );

  it("keeps list limits and ignored controls on their existing contract", async () => {
    const { database } = createFixture();
    const query = {
      ...queryFor("visitor", { limit: 1 }),
      page: { limit: 2, cursor: "ignored-page-cursor" },
      search: "ignored-search",
      sort: { key: "visitors", direction: "asc" },
      cursor: "ignored-cursor",
    } as ChannelQuery;
    const expected = await oldListDto(database, query, traceFor());
    const trace = traceFor();
    const actual = await actualListDto(database, query, trace);
    expect(actual.value).toEqual(expected);
    expect((actual.value as { items: unknown[] }).items).toHaveLength(1);
    expect(trace.preparedSql).toHaveLength(2);

    const largerLimitQuery = queryFor("session", { limit: 500 });
    const largerExpected = await oldListDto(
      database,
      largerLimitQuery,
      traceFor(),
    );
    const largerTrace = traceFor();
    const largerActual = await actualListDto(
      database,
      largerLimitQuery,
      largerTrace,
    );
    expect(largerActual.value).toEqual(largerExpected);
    expect(largerTrace.preparedSql).toHaveLength(2);

    const emptyQuery = queryFor("visitor", {
      filter:
        'page.path eq "/missing" and count(event { event.name eq "qualifier" }) eq 1',
    });
    const emptyExpected = await oldListDto(database, emptyQuery, traceFor());
    const emptyTrace = traceFor();
    const emptyActual = await actualListDto(database, emptyQuery, emptyTrace);
    expect(emptyActual.value).toEqual(emptyExpected);
    expect(emptyActual.value).toEqual({ items: [] });
    expect(emptyTrace.preparedSql).toHaveLength(2);

    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidQuery = { ...queryFor("visitor", { limit }) };
      const forwarded = await d1AdvancedFilterMiddleware(
        testEnv(database, traceFor()),
        undefined,
        SITE,
      )("channels", invalidQuery, async (value) => value);
      expect(
        deferredChannelListQualificationFromQuery(forwarded),
      ).toBeUndefined();
    }
    for (const limit of [0, -1]) {
      const legacyLimitQuery = queryFor("visitor", { limit });
      const legacyLimitDto = await oldListDto(
        database,
        legacyLimitQuery,
        traceFor(),
      );
      const actualLimitDto = await actualListDto(
        database,
        legacyLimitQuery,
        traceFor(),
      );
      expect(actualLimitDto.value).toEqual(legacyLimitDto);
    }
    await expect(
      actualListDto(database, queryFor("visitor", { limit: 1.5 }), traceFor()),
    ).rejects.toThrow("channel_limit_must_be_integer");
    recordEvidence("list-controls", {
      topLevelLimitWins: true,
      ignored: ["page", "search", "sort", "cursor"],
      defaultLimit: 100,
      safePositiveLimit: 1,
      invalidLimitsRemainLegacy: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1],
      dto: actual.value,
    });
  });

  it("keeps native-only, overview, dimension, audience, and unsupported requests outside the list brand", async () => {
    const { database } = createFixture();
    const middleware = d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    );
    const nativeOnly = queryFor("session", {
      filter: 'page.path neq "/excluded"',
    });
    const overview = {
      ...queryFor("session", { mode: "overview-tab" }),
      tab: "source.channel",
      mode: "overview-tab",
    } as ChannelQuery;
    const dimensionAlias = queryFor("session", {
      operation: "dimension",
    });
    const publicShare = queryFor("session", { audience: "public-share" });
    const mixed = queryFor("session", {
      filter:
        'page.path neq "/excluded" or count(event { event.name eq "qualifier" }) eq 1',
    });
    const unsupportedNot = queryFor("session", {
      filter: 'not count(event { event.name eq "qualifier" }) eq 1',
    });
    const cases = [
      ["native-only", "channels", nativeOnly],
      ["overview", "channels", overview],
      ["dimension-alias", "dimension", dimensionAlias],
      ["public-share", "channels", publicShare],
      ["other-operation", "pages", queryFor("session")],
      ["other-mode", "channels", { ...queryFor("session"), mode: "breakdown" }],
    ] as const;
    const rejected: string[] = [];
    for (const [name, operation, query] of cases) {
      const forwarded = await middleware(
        operation,
        query,
        async (value) => value,
      );
      expect(
        deferredChannelListQualificationFromQuery(forwarded),
      ).toBeUndefined();
      if (name === "overview")
        expect(
          deferredChannelOverviewQualificationFromQuery(forwarded),
        ).toBeDefined();
      else rejected.push(name);
    }
    for (const supported of [mixed, unsupportedNot]) {
      const forwarded = await middleware(
        "channels",
        supported,
        async (value) => value,
      );
      expect(
        deferredChannelListQualificationFromQuery(forwarded),
      ).toBeDefined();
    }
    const accessorMode = { ...mixed } as ChannelQuery;
    Object.defineProperty(accessorMode, "mode", {
      enumerable: true,
      get: () => "list",
    });
    const accessorForwarded = await middleware(
      "channels",
      accessorMode,
      async (value) => value,
    );
    expect(
      deferredChannelListQualificationFromQuery(accessorForwarded),
    ).toBeUndefined();
    rejected.push("accessor-mode");
    for (const filter of [WHOLE_BOOLEAN_OR_FILTER, WHOLE_BOOLEAN_NOT_FILTER]) {
      const apiQuery = queryFor("session", {
        audience: "api-v1",
        filter,
      });
      const forwarded = await middleware(
        "channels",
        apiQuery,
        async (value) => value,
      );
      expect(
        deferredChannelListQualificationFromQuery(forwarded),
      ).toBeUndefined();
      rejected.push("api-v1-whole-boolean");
    }
    const apiConjunction = queryFor("session", {
      audience: "api-v1",
      filter: FILTER,
    });
    const apiConjunctionForwarded = await middleware(
      "channels",
      apiConjunction,
      async (value) => value,
    );
    expect(
      deferredChannelListQualificationFromQuery(apiConjunctionForwarded),
    ).toBeDefined();
    const nativeOld = await oldListDto(database, nativeOnly, traceFor());
    const nativeActual = await actualListDto(database, nativeOnly, traceFor());
    expect(nativeActual.value).toEqual(nativeOld);
    const empty = queryFor("session", {
      filter:
        'page.path eq "/missing" and count(event { event.name eq "qualifier" }) eq 1',
    });
    expect(await actualListDto(database, empty, traceFor())).toMatchObject({
      value: { items: [] },
    });
    for (const field of ["comparison", "current", "reference"] as const) {
      const comparisonQuery = {
        ...queryFor("session"),
        [field]: {},
      } as ChannelQuery & Record<string, unknown>;
      const forwarded = await middleware(
        "channels",
        comparisonQuery,
        async (value) => value,
      );
      expect(
        deferredChannelListQualificationFromQuery(forwarded),
      ).toBeUndefined();
      rejected.push(field);
    }
    recordEvidence("operation-gates", {
      channelListBrandRetainsConjunctionAndAddsPrivateWholeBoolean: true,
      overviewBrandRemainsSeparate: true,
      rejected,
    });
  });

  it("rejects mismatched compile requests and pre-aborts before any D1 read", async () => {
    const { database } = createFixture();
    const query = queryFor("session");
    const env = testEnv(database, traceFor());
    const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
      "channels",
      query,
      async (value) => value,
    );
    const deferred = deferredChannelListQualificationFromQuery(forwarded);
    if (!deferred) throw new Error("wave95u_channel_list_brand_missing");
    const compileQuery = {
      env,
      siteId: SITE,
      queryTime: query.time!,
      filters: query.filters!,
      ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
      mode: "list" as const,
      limit: 100,
      sourceLimit: undefined,
      audience: query.context.policy.audience,
      hasComparison: false,
      hasCurrent: false,
      hasReference: false,
    };
    let limitMismatch: unknown;
    try {
      compileChannelListQualificationProgram({
        deferred,
        query: { ...compileQuery, limit: 99 },
      });
    } catch (error) {
      limitMismatch = error;
    }
    expect(limitMismatch).toMatchObject({
      domainError: {
        issues: [{ code: "channel_list_request_context_mismatch" }],
      },
    });
    const tamperedTime = createQueryTime(121, 130, "UTC", 500);
    let timeMismatch: unknown;
    try {
      compileChannelListQualificationProgram({
        deferred,
        query: { ...compileQuery, queryTime: tamperedTime },
      });
    } catch (error) {
      timeMismatch = error;
    }
    expect(timeMismatch).toMatchObject({
      domainError: {
        issues: [{ code: "channel_list_request_context_mismatch" }],
      },
    });
    let flagMismatch: unknown;
    try {
      compileChannelListQualificationProgram({
        deferred,
        query: { ...compileQuery, hasReference: true },
      });
    } catch (error) {
      flagMismatch = error;
    }
    expect(flagMismatch).toMatchObject({
      domainError: {
        issues: [{ code: "channel_list_request_context_mismatch" }],
      },
    });

    const wrongSiteTrace = traceFor();
    let siteMismatch: unknown;
    try {
      await d1AdvancedFilterMiddleware(
        testEnv(database, wrongSiteTrace),
        undefined,
        "wave95u-wrong-site",
      )("channels", query, async (value) => value);
    } catch (error) {
      siteMismatch = error;
    }
    expect(siteMismatch).toMatchObject({
      domainError: {
        issues: [{ code: "channel_list_request_context_mismatch" }],
      },
    });
    expect(wrongSiteTrace.preparedSql).toHaveLength(0);

    const abortedTrace = traceFor();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeWithEnv(testEnv(database, abortedTrace), query, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedTrace.preparedSql).toHaveLength(0);
    recordEvidence("request-guards", {
      limitMismatchRejected: true,
      queryTimeMismatchRejected: true,
      featureFlagMismatchRejected: true,
      expectedSiteMismatchRejected: true,
      preAbortedSqlCount: abortedTrace.preparedSql.length,
    });
  });

  it.each([
    "missing-control",
    "duplicate-control",
    "wrong-control-scope",
    "malformed-report",
    "sqlite-failure",
  ] as const)(
    "does not fallback after malformed fused %s output",
    async (behavior) => {
      const { database } = createFixture();
      const trace = traceFor();
      await expect(
        executeWithEnv(
          testEnvWithBehavior(database, trace, behavior),
          queryFor("session"),
        ),
      ).rejects.toThrow();
      expect(trace.preparedSql).toHaveLength(2);
      recordEvidence("fused-output-rejection", {
        behavior,
        sqlCount: trace.preparedSql.length,
      });
    },
  );

  it("uses one complete legacy fallback for numeric compatibility", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "paid");
    const numericQuery = queryFor("session", {
      filter:
        'page.path neq "/excluded" and count(page { page.durationMs gt 5 }) eq 1',
    });
    const legacy = await oldListDto(database, numericQuery, traceFor());
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await actualListDto(
      database,
      numericQuery,
      trace,
      diagnostics,
    );
    expect(actual.value).toEqual(legacy);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(trace.preparedSql.length).toBeGreaterThan(2);
    recordEvidence("numeric-fallback", {
      fallback: diagnostics.advancedCountSqlFallbackReason,
      actualSqlCount: trace.preparedSql.length,
      dto: actual.value,
    });
  });

  it("binds the Event Page Source after a real numeric fallback for channel list", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "paid");
    const query = queryFor("event", {
      filter: `${FILTER} and count(page { page.durationMs gt 5 }) eq 1`,
    });
    const inspected = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("channels", query, async (value) => value);
    const deferred = deferredChannelListQualificationFromQuery(inspected);
    expect(deferred?.countInput.scope).toBe("event");
    expect(
      deferred?.countInput.numericCompatibilityRequirements,
    ).not.toHaveLength(0);
    const legacy = await oldListDto(database, query, traceFor());
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await actualListDto(database, query, trace, diagnostics);

    expect(actual.value).toEqual(legacy);
    if (!("items" in actual.value))
      throw new Error("wave95u_channel_list_result_expected");
    expect(actual.value.items).not.toHaveLength(0);
    const guardStatementIndex = trace.preparedSql.findIndex((sql) =>
      sql.includes("invalidContextPageDurationMsCount"),
    );
    expect(guardStatementIndex).toBeGreaterThanOrEqual(0);
    const guardRows = database
      .prepare(trace.preparedSql[guardStatementIndex]!)
      .all(...(trace.bindings[guardStatementIndex] ?? [])) as Array<
      Record<string, unknown>
    >;
    expect(guardRows).toHaveLength(1);
    expect(guardRows[0]).toMatchObject({
      rowKind: "control",
      invalidContextPageDurationMsCount: 1,
    });
    expect(guardRows.some((row) => row.rowKind === "report")).toBe(false);
    const reportSql = trace.preparedSql.at(-1);
    expect(reportSql).toMatch(/\bvisit_id\b/i);
    expect(reportSql).not.toMatch(/\bentity_id\b/i);
  });

  it("enforces the activity cap before numeric fallback and emits no report rows", async () => {
    const { database, site } = createFixture();
    const insert = database.prepare(
      "INSERT INTO visits (" +
        "visit_id, site_id, site_pk, visitor_id, session_id, status, " +
        "started_at, last_activity_at, pathname, hostname, duration_ms" +
        ") VALUES (?, ?, ?, ?, ?, 'closed', 121, 121, '/cap', 'channels.test', ?)",
    );
    for (let index = 0; index < ADVANCED_FILTER_MAX_ACTIVITIES + 1; index++) {
      insert.run(
        `cap-${index}`,
        site.id,
        site.pk,
        `cap-visitor-${index}`,
        `cap-session-${index}`,
        index === 0 ? "invalid-duration" : 10,
      );
    }
    const query = queryFor("session", {
      filter: "count(page { page.durationMs gt 5 }) eq 1",
    });
    const trace = traceFor();
    const observed: { rawCount?: unknown; reportRows?: number } = {};
    await expect(
      executeWithEnv(
        testEnvWithBehavior(database, trace, "observe", observed),
        query,
      ),
    ).rejects.toMatchObject({
      domainError: {
        issues: [{ code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(observed.rawCount).toBe(ADVANCED_FILTER_MAX_ACTIVITIES + 1);
    expect(observed.reportRows).toBe(0);
    expect(trace.preparedSql).toHaveLength(2);
    recordEvidence("activity-cap", {
      rawCount: observed.rawCount,
      maximum: ADVANCED_FILTER_MAX_ACTIVITIES,
      reportRows: observed.reportRows,
      sqlCount: trace.preparedSql.length,
    });
  });
});
