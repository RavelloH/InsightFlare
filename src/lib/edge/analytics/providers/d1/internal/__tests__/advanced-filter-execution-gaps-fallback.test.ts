import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE = "gap-fallback-site";
const TIME = createQueryTime(120, 130, "UTC", 500);
const OTHER_TIME = createQueryTime(121, 130, "UTC", 500);
const QUALIFIED_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';
/** A mixed OR tree cannot be split into a native part and a Count part. */
const MIXED_OR_FILTER =
  'page.path eq "/native-only" or count(event { event.name eq "qualifier" }) gte 1';

const databases = new Set<DatabaseSync>();
afterAll(() => {
  for (const database of databases) database.close();
});

function createEnv(): Env {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'gap-team', 'Gap fallback', 'gap.test', 0)`,
    )
    .run(SITE);
  return {
    DB: createSqliteD1Database(database),
    MAIN_SECRET: "gap-fallback-secret",
  } as unknown as Env;
}

type Request = Record<string, unknown>;
type Audience = "private-dashboard" | "api-v1";

function buildQuery(input: {
  readonly operation: string;
  readonly extra?: Request;
  readonly scope?: "event" | "session" | "visitor";
  readonly filter?: string;
  readonly audience?: Audience;
}): Request {
  const prepared = prepareScopedQuery(
    input.operation as never,
    {
      context: siteQueryContext(SITE, input.audience ?? "private-dashboard"),
      time: TIME,
      filters: parseFilterDsl(
        input.filter ?? QUALIFIED_FILTER,
        analyticsFilterRegistry,
      ),
      scopePreference: input.scope ?? "event",
    } as never,
  ) as unknown as Request;
  return { ...prepared, ...input.extra };
}

interface FallbackCase {
  readonly name: string;
  readonly operation: string;
  readonly extra?: Request;
  readonly scope?: "event" | "session" | "visitor";
  readonly filter?: string;
  readonly audience?: Audience;
}

/** Requests whose shape the qualified path refuses, so the whole legacy
 * evaluation must run and attach a prepared membership instead. */
const fallbackCases: readonly FallbackCase[] = [
  {
    name: "pages aggregate with a non-string variant",
    operation: "pages",
    extra: { variant: 5 },
  },
  {
    name: "pages aggregate with a zero limit",
    operation: "pages",
    extra: { limit: 0 },
  },
  {
    name: "pages aggregate with a zero page limit",
    operation: "pages",
    extra: { page: { limit: 0 } },
  },
  {
    name: "pages tabs with a zero limit",
    operation: "pages",
    extra: { variant: "tabs", limit: 0 },
  },
  {
    name: "pages tabs with a primitive page",
    operation: "pages",
    extra: { includeTabs: true, page: 5 },
  },
  {
    name: "pages tabs with a zero page limit",
    operation: "pages",
    extra: { includeTabs: true, page: { limit: 0 } },
  },
  {
    name: "pages tabs with a zero request limit",
    operation: "pages",
    extra: { includeTabs: true, limit: 0 },
  },
  {
    name: "pages tabs with a non-boolean details flag",
    operation: "pages",
    extra: { variant: "tabs", includeDetails: "x" },
  },
  {
    name: "pages tabs with a non-string variant",
    operation: "pages",
    extra: { variant: 5, includeTabs: true },
  },
  {
    name: "pages tabs with a non-boolean tabs flag",
    operation: "pages",
    extra: { variant: "tabs", includeTabs: "x" },
  },
  {
    name: "referrers summary with a negative top-N",
    operation: "referrers",
    extra: { variant: "summary", topN: -1 },
  },
  {
    name: "referrers page with a negative limit",
    operation: "referrers",
    extra: { limit: -1 },
  },
  {
    name: "channel list with a zero limit",
    operation: "channels",
    extra: { mode: "list", limit: 0 },
  },
  {
    name: "channel overview with a zero limit",
    operation: "channels",
    extra: { mode: "overview-tab", tab: "source.channel", limit: 0 },
  },
  {
    name: "session boundary overview with a zero limit",
    operation: "dimension",
    extra: { mode: "overview-tab", tab: "page.entry", limit: 0 },
  },
  {
    name: "session boundary dimension with a zero limit",
    operation: "dimension",
    extra: { mode: "breakdown", dimension: "session.entryPath", limit: 0 },
  },
  {
    name: "event name dimension with a zero limit",
    operation: "dimension",
    extra: { mode: "breakdown", dimension: "event.name", limit: 0 },
  },
  {
    name: "retention with a different request time",
    operation: "retention",
    extra: { granularity: "week", time: OTHER_TIME },
    scope: "session",
  },
  {
    name: "sessions with a different request time",
    operation: "sessions",
    extra: { time: OTHER_TIME },
    scope: "session",
  },
  {
    name: "visitors with a different request time",
    operation: "visitors",
    extra: { time: OTHER_TIME },
    scope: "visitor",
  },
  {
    name: "visitor events with a different request time",
    operation: "visitor-events",
    extra: { visitorId: "visitor", time: OTHER_TIME },
    scope: "session",
  },
  {
    name: "performance with a different request time",
    operation: "performance",
    extra: { mode: "summary", time: OTHER_TIME },
    scope: "session",
  },
  {
    name: "mixed OR performance for a non-private audience",
    operation: "performance",
    extra: { mode: "summary" },
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR geo points for a non-private audience",
    operation: "geo-points",
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR retention for a non-private audience",
    operation: "retention",
    extra: { granularity: "week" },
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR share trend for a non-private audience",
    operation: "share-trend",
    extra: { variant: "browser", interval: "day" },
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR radar for a non-private audience",
    operation: "radar",
    extra: { variant: "browser" },
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR cross dimension for a non-private audience",
    operation: "cross-dimension",
    extra: { variant: "browser" },
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR filter values for a non-private audience",
    operation: "filter-values",
    extra: { field: "page.path" },
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR sessions for a non-private audience",
    operation: "sessions",
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR visitors for a non-private audience",
    operation: "visitors",
    scope: "visitor",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR visitor events for a non-private audience",
    operation: "visitor-events",
    extra: { visitorId: "visitor" },
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
  {
    name: "mixed OR visitor sessions for a non-private audience",
    operation: "visitor-sessions",
    extra: { visitorId: "visitor" },
    scope: "session",
    filter: MIXED_OR_FILTER,
    audience: "api-v1",
  },
];

describe("advanced filter execution legacy fallback routing", () => {
  const env = createEnv();

  it.each(fallbackCases)(
    "routes $name to the complete legacy evaluation",
    async ({ operation, extra, scope, filter, audience }) => {
      const request = buildQuery({ operation, extra, scope, filter, audience });
      const forwarded = (await d1AdvancedFilterMiddleware(env, undefined, SITE)(
        operation as never,
        request as never,
        async (value) => value,
      )) as unknown as Request;
      expect(Object.getOwnPropertySymbols(forwarded)).toHaveLength(0);
      const metadata = scopedFilterMetadata(forwarded.filters as never);
      expect(metadata?.plan.preparedMembership).toBeDefined();
    },
  );
});
