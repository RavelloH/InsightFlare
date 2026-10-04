import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  queryD1All,
  scopedDatasetFor,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeReferrersCursor,
  queryReferrersPageFromD1,
  queryReferrerSummaryFromD1,
  queryTopReferrersFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

import { filterFixture } from "./filter-fixtures";

type Binding = string | number | null;
type Row = Record<string, unknown>;
interface QueryCall {
  readonly sql: string;
  readonly bindings: Binding[];
}
interface ReferrerRow {
  referrer: string;
  views: number;
  sessions: number;
  visitors: number;
}
interface AggregateCursor {
  primary: number;
  secondary: number;
  referrer: string;
}
type SortKey = "views" | "visitors";
const siteId = "wave44-referrers";
const startMs = Date.UTC(2026, 5, 14);
const queryWindow: QueryWindow = {
  startMs,
  endExclusiveMs: startMs + 24 * 60 * 60 * 1000,
  nowMs: startMs + 2 * 24 * 60 * 60 * 1000,
  timeZone: "UTC",
};

function createSqliteEnv(): {
  env: Env;
  database: DatabaseSync;
  calls: QueryCall[];
  close: () => void;
} {
  const database = createMigratedDatabase();
  const calls: QueryCall[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: Binding[]) => ({
          all: async () => {
            calls.push({ sql, bindings });
            return {
              results: database.prepare(sql).all(...bindings) as Row[],
            };
          },
        }),
      }),
    },
    DAILY_SALT_SECRET: "wave44-test-secret",
    INGEST_DO: {} as DurableObjectNamespace,
  } as unknown as Env;
  return { env, database, calls, close: () => database.close() };
}

function insertReferrerVisit(
  database: DatabaseSync,
  input: {
    readonly key: string;
    readonly visitId: string | null;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly country?: string;
    readonly host: string | null;
    readonly url: string | null;
  },
): void {
  database
    .prepare("INSERT OR IGNORE INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { site_pk: number };
  database
    .prepare(
      `
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, title, query_string,
        hash_fragment, country, site_pk
      ) VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, 'example.test', '', '', '', ?, ?)
    `,
    )
    .run(
      input.visitId,
      siteId,
      input.visitorId,
      input.sessionId,
      startMs,
      startMs,
      `/wave44/${input.key}`,
      input.country ?? "US",
      identity.site_pk,
    );
  database
    .prepare(
      "UPDATE visits SET referrer_host = ?, referrer_url = ? WHERE site_id = ? AND pathname = ?",
    )
    .run(input.host ?? "", input.url ?? "", siteId, `/wave44/${input.key}`);
}

function seedReferrers(database: DatabaseSync, includeNulKey = true): void {
  const values: Parameters<typeof insertReferrerVisit>[1][] = [
    {
      key: "null-a",
      visitId: null,
      visitorId: " ",
      sessionId: " ",
      host: null,
      url: null,
    },
    {
      key: "null-b",
      visitId: "r-empty-ids",
      visitorId: "",
      sessionId: "",
      host: null,
      url: null,
    },
    {
      key: "empty",
      visitId: "r-empty",
      visitorId: "v-empty",
      sessionId: "s-empty",
      host: "",
      url: "",
    },
    {
      key: "spaces",
      visitId: "r-spaces",
      visitorId: "v-spaces",
      sessionId: "s-spaces",
      host: "   ",
      url: " ",
    },
    {
      key: "tab",
      visitId: "r-tab",
      visitorId: "v-tab",
      sessionId: "s-tab",
      host: "\t",
      url: "\t",
    },
    {
      key: "nbsp",
      visitId: "r-nbsp",
      visitorId: "v-nbsp",
      sessionId: "s-nbsp",
      host: "\u00a0",
      url: "\u00a0",
    },
    {
      key: "google-upper",
      visitId: "r-google-upper",
      visitorId: "v-shared",
      sessionId: "s-shared",
      host: "Google.COM",
      url: "https://Google.COM/Upper",
    },
    {
      key: "google-lower-a",
      visitId: "r-google-lower-a",
      visitorId: "v-shared",
      sessionId: "s-google",
      host: "google.com",
      url: "https://google.com/a",
    },
    {
      key: "google-lower-b",
      visitId: "r-google-lower-b",
      visitorId: "v-google-b",
      sessionId: "s-google",
      host: "google.com",
      url: "https://google.com/b",
    },
    {
      key: "special",
      visitId: "r-special",
      visitorId: "v-special",
      sessionId: "s-special",
      host: "literal-%_\\ω",
      url: "https://search.example/literal-%_\\ω",
    },
    {
      key: "nul",
      visitId: "r-nul",
      visitorId: "v-nul",
      sessionId: "s-nul",
      host: "x\u0000y",
      url: "https://nul.example/x\u0000y",
    },
    {
      key: "news-a",
      visitId: "r-news-a",
      visitorId: "v-news-a",
      sessionId: "s-news-a",
      host: "news.example",
      url: "https://news.example/a",
    },
    {
      key: "news-b",
      visitId: "r-news-b",
      visitorId: "v-news-b",
      sessionId: "s-news-b",
      host: "news.example",
      url: "https://news.example/b",
    },
    {
      key: "trimmed",
      visitId: "r-trimmed",
      visitorId: "v-trimmed",
      sessionId: "s-trimmed",
      host: "  edge.example  ",
      url: " https://edge.example/path ",
    },
    {
      key: "country-ca",
      visitId: "r-country-ca",
      visitorId: "v-country-ca",
      sessionId: "s-country-ca",
      country: "CA",
      host: "canada.example",
      url: "https://canada.example/",
    },
    {
      key: "event-owner",
      visitId: "r-event-owner",
      visitorId: "v-event-owner",
      sessionId: "s-event-owner",
      country: "CA",
      host: "purchase.example",
      url: "https://purchase.example/",
    },
  ];
  for (const value of values) {
    if (includeNulKey || value.key !== "nul")
      insertReferrerVisit(database, value);
  }
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(siteId) as { site_pk: number };
  database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (44, ?, 'purchase', ?, ?)",
    )
    .run(siteId, startMs, identity.site_pk);
  database
    .prepare(
      `
      INSERT INTO custom_events (
        event_pk, event_id, site_id, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count, site_pk
      ) VALUES (44, 'wave44-purchase', ?, 'r-event-owner', 44, ?, ?, 1, 1, 1, ?)
    `,
    )
    .run(siteId, startMs + 10, startMs + 10, identity.site_pk);
}

function bindingsFor(
  targetSiteId: string,
  targetWindow: QueryWindow,
  filters: FilterDocument,
) {
  const dataset = scopedDatasetFor(targetSiteId, targetWindow, filters);
  const filter = dataset
    ? null
    : buildVisitFilterSql(filters, "visit_source", {
        window: targetWindow,
      });
  return {
    dataset,
    filter,
    ctes: dataset?.ctes ?? buildVisitSourceCte(),
    source: dataset?.visitRelation ?? "visit_source",
    values: dataset
      ? dataset.bindings.map((binding) => binding.value)
      : [
          ...visitSourceBindings(targetSiteId, targetWindow),
          ...(filter?.bindings ?? []),
        ],
  };
}

function escapedContains(search: string): string {
  return `%${search
    .trim()
    .toLowerCase()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

async function legacyTopReferrersOracle(
  env: Env,
  targetSiteId: string,
  targetWindow: QueryWindow,
  limit: number,
  includeFullUrl: boolean,
  filters: FilterDocument,
  search?: string,
): Promise<ReferrerRow[]> {
  const { dataset, filter, ctes, source, values } = bindingsFor(
    targetSiteId,
    targetWindow,
    filters,
  );
  const keyExpr = includeFullUrl ? "referrer_url" : "referrer_host";
  const rows = await queryD1All<Row>(
    env,
    `
WITH
${ctes},
filtered_visits AS (
  SELECT * FROM ${source} ${filter?.clause ?? ""}
)
SELECT
  COALESCE(${keyExpr}, '') AS referrer,
  count(*) AS views,
  count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM filtered_visits
GROUP BY referrer
${search ? "HAVING LOWER(referrer) LIKE ? ESCAPE '\\'" : ""}
ORDER BY views DESC, sessions DESC, referrer ASC
LIMIT ?
`,
    [...values, ...(search ? [escapedContains(search)] : []), limit],
  );
  void dataset;
  return rows.map((row) => ({
    referrer: String(row.referrer ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
}

async function legacyReferrersPageOracle(
  env: Env,
  targetSiteId: string,
  targetWindow: QueryWindow,
  filters: FilterDocument,
  limit: number,
  includeFullUrl: boolean,
  sortBy: SortKey,
  sortDirection: "asc" | "desc",
  cursor?: AggregateCursor | null,
  search?: string,
): Promise<{ items: ReferrerRow[]; hasMore: boolean }> {
  const { filter, ctes, source, values } = bindingsFor(
    targetSiteId,
    targetWindow,
    filters,
  );
  const keyExpr = includeFullUrl ? "referrer_url" : "referrer_host";
  const primary = sortBy === "visitors" ? "visitors" : "views";
  const secondary = sortBy === "visitors" ? "views" : "sessions";
  const operator = sortDirection === "asc" ? ">" : "<";
  const cursorClause = cursor
    ? `WHERE ${primary} ${operator} ?
   OR (${primary} = ? AND ${secondary} ${operator} ?)
   OR (${primary} = ? AND ${secondary} = ? AND referrer > ?)`
    : "";
  const rows = await queryD1All<Row>(
    env,
    `
WITH
${ctes},
filtered_visits AS (
  SELECT * FROM ${source} ${filter?.clause ?? ""}
),
rollup AS (
  SELECT
    COALESCE(${keyExpr}, '') AS referrer,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_visits
  GROUP BY referrer
  ${search ? "HAVING LOWER(referrer) LIKE ? ESCAPE '\\'" : ""}
)
SELECT referrer, views, sessions, visitors
FROM rollup
${cursorClause}
ORDER BY ${primary} ${sortDirection}, ${secondary} ${sortDirection}, referrer ASC
LIMIT ?
`,
    [
      ...values,
      ...(search ? [escapedContains(search)] : []),
      ...(cursor
        ? [
            cursor.primary,
            cursor.primary,
            cursor.secondary,
            cursor.primary,
            cursor.secondary,
            cursor.referrer,
          ]
        : []),
      limit + 1,
    ],
  );
  const mapped = rows.map((row) => ({
    referrer: String(row.referrer ?? ""),
    views: Number(row.views ?? 0),
    sessions: Number(row.sessions ?? 0),
    visitors: Number(row.visitors ?? 0),
  }));
  return { items: mapped.slice(0, limit), hasMore: mapped.length > limit };
}

async function legacyReferrerSummaryOracle(
  env: Env,
  targetSiteId: string,
  targetWindow: QueryWindow,
  filters: FilterDocument,
  topN: number,
) {
  const { filter, ctes, source, values } = bindingsFor(
    targetSiteId,
    targetWindow,
    filters,
  );
  const rows = await queryD1All<Row>(
    env,
    `
WITH
${ctes},
filtered_visits AS MATERIALIZED (
  SELECT referrer_host, referrer_url
  FROM ${source}
  ${filter?.clause ?? ""}
),
summary_row AS (
  SELECT
    'summary' AS rowType,
    '' AS referrer,
    count(*) AS totalViews,
    SUM(CASE WHEN TRIM(COALESCE(referrer_host, '')) = '' THEN 1 ELSE 0 END) AS directViews,
    SUM(CASE WHEN TRIM(COALESCE(referrer_host, '')) != '' THEN 1 ELSE 0 END) AS externalViews,
    count(DISTINCT NULLIF(TRIM(COALESCE(referrer_host, '')), '')) AS uniqueDomains,
    count(DISTINCT NULLIF(TRIM(COALESCE(referrer_url, '')), '')) AS uniqueLinks,
    0 AS views,
    0 AS rowRank
  FROM filtered_visits
),
top_rollup AS (
  SELECT TRIM(COALESCE(referrer_host, '')) AS referrer, count(*) AS views
  FROM filtered_visits
  WHERE TRIM(COALESCE(referrer_host, '')) != ''
  GROUP BY referrer
),
top_rows AS (
  SELECT 'top' AS rowType, referrer, NULL AS totalViews, NULL AS directViews,
    NULL AS externalViews, NULL AS uniqueDomains, NULL AS uniqueLinks, views,
    ROW_NUMBER() OVER (ORDER BY views DESC, referrer ASC) AS rowRank
  FROM top_rollup
)
SELECT rowType, referrer, totalViews, directViews, externalViews,
  uniqueDomains, uniqueLinks, views, rowRank
FROM (SELECT * FROM summary_row UNION ALL SELECT * FROM top_rows)
WHERE rowType = 'summary' OR rowRank <= ?
ORDER BY CASE rowType WHEN 'summary' THEN 0 ELSE 1 END, rowRank ASC
`,
    [...values, topN + 1],
  );
  const summary = rows.find((row) => row.rowType === "summary") ?? {};
  const topRows = rows.filter((row) => row.rowType === "top");
  return {
    totalViews: Number(summary.totalViews ?? 0),
    directViews: Number(summary.directViews ?? 0),
    externalViews: Number(summary.externalViews ?? 0),
    uniqueDomains: Number(summary.uniqueDomains ?? 0),
    uniqueLinks: Number(summary.uniqueLinks ?? 0),
    truncated: topRows.length > topN,
    topSources: topRows.slice(0, topN).map((row) => ({
      referrer: String(row.referrer ?? ""),
      views: Number(row.views ?? 0),
    })),
  };
}

function normalizedFilters(root: unknown): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function eventNameFilter(): FilterDocument {
  return normalizedFilters({
    kind: "condition",
    target: { kind: "field", field: "event.name" },
    operator: "eq",
    value: "purchase",
  });
}

function preparedFilters(
  scopePreference: "event" | "session" | "visitor",
  advancedMatches?: {
    readonly visitIds?: readonly { siteId: string; id: string }[];
    readonly entityIds?: readonly { siteId: string; id: string }[];
  },
): FilterDocument {
  const context = siteQueryContext(siteId, "private-dashboard");
  const time = createQueryTime(
    queryWindow.startMs,
    queryWindow.endExclusiveMs,
    "UTC",
    queryWindow.nowMs,
  );
  const prepared = prepareScopedQuery("pages", {
    context,
    time,
    filters: filterFixture({ country: "US" }),
    scopePreference,
  } as never) as { filters?: FilterDocument };
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!prepared.filters || !metadata)
    throw new Error(`wave44_prepared_${scopePreference}_incomplete`);
  return advancedMatches
    ? attachScopedFilterMetadata(prepared.filters, {
        ...metadata,
        plan: { ...metadata.plan, advancedMatches },
      })
    : prepared.filters;
}

describe("Wave44 referrer report migration", () => {
  it("matches frozen referrer readers across direct, event, and prepared scopes", async () => {
    const { env, database, close } = createSqliteEnv();
    seedReferrers(database);
    const observationFilters = preparedFilters("event", {
      visitIds: [{ siteId, id: "r-google-lower-a" }],
    });
    const sessionFilters = preparedFilters("session");
    const visitorFilters = preparedFilters("visitor");
    const advancedSessionFilters = preparedFilters("session", {
      entityIds: [{ siteId, id: "s-shared" }],
    });
    const advancedVisitorFilters = preparedFilters("visitor", {
      entityIds: [{ siteId, id: "v-shared" }],
    });
    const emptyObservationFilters = preparedFilters("event", {
      visitIds: [],
    });
    const filtersToCompare = [
      EMPTY_FILTER_DOCUMENT,
      filterFixture({ country: "CA" }),
      eventNameFilter(),
      preparedFilters("event"),
      observationFilters,
      sessionFilters,
      visitorFilters,
      advancedSessionFilters,
      advancedVisitorFilters,
      emptyObservationFilters,
    ];

    try {
      for (const filters of filtersToCompare) {
        expect(
          await queryTopReferrersFromD1(
            env,
            siteId,
            queryWindow,
            filters,
            100,
            false,
          ),
        ).toEqual(
          await legacyTopReferrersOracle(
            env,
            siteId,
            queryWindow,
            100,
            false,
            filters,
          ),
        );
        const page = await queryReferrersPageFromD1(
          env,
          siteId,
          queryWindow,
          filters,
          100,
          false,
        );
        const expectedPage = await legacyReferrersPageOracle(
          env,
          siteId,
          queryWindow,
          filters,
          100,
          false,
          "views",
          "desc",
        );
        expect(page.items).toEqual(expectedPage.items);
        expect(page.pagination.hasMore).toBe(expectedPage.hasMore);
        expect(
          await queryReferrerSummaryFromD1(
            env,
            siteId,
            queryWindow,
            filters,
            20,
          ),
        ).toEqual(
          await legacyReferrerSummaryOracle(
            env,
            siteId,
            queryWindow,
            filters,
            20,
          ),
        );
      }
    } finally {
      close();
    }
  });

  it("preserves raw grouping, escaped searches, and selected full URL keys", async () => {
    const { env, database, close } = createSqliteEnv();
    seedReferrers(database);
    try {
      for (const includeFullUrl of [false, true]) {
        for (const search of [" %_\\ω ", " GOOGLE.com ", "\t", "\u0000"]) {
          expect(
            await queryTopReferrersFromD1(
              env,
              siteId,
              queryWindow,
              EMPTY_FILTER_DOCUMENT,
              100,
              includeFullUrl,
              undefined,
              search,
            ),
          ).toEqual(
            await legacyTopReferrersOracle(
              env,
              siteId,
              queryWindow,
              100,
              includeFullUrl,
              EMPTY_FILTER_DOCUMENT,
              search,
            ),
          );
        }
        expect(
          await queryTopReferrersFromD1(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            100,
            includeFullUrl,
          ),
        ).toEqual(
          await legacyTopReferrersOracle(
            env,
            siteId,
            queryWindow,
            100,
            includeFullUrl,
            EMPTY_FILTER_DOCUMENT,
          ),
        );
      }
      for (const limit of [0, -1]) {
        expect(
          await queryTopReferrersFromD1(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            limit,
            false,
          ),
        ).toEqual(
          await legacyTopReferrersOracle(
            env,
            siteId,
            queryWindow,
            limit,
            false,
            EMPTY_FILTER_DOCUMENT,
          ),
        );
      }
      const summary = await queryReferrerSummaryFromD1(
        env,
        siteId,
        queryWindow,
        EMPTY_FILTER_DOCUMENT,
        0,
      );
      expect(summary).toEqual(
        await legacyReferrerSummaryOracle(
          env,
          siteId,
          queryWindow,
          EMPTY_FILTER_DOCUMENT,
          0,
        ),
      );
      for (const topN of [0, -1, 1.5]) {
        expect(
          await queryReferrerSummaryFromD1(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            topN,
          ),
        ).toEqual(
          await legacyReferrerSummaryOracle(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            topN,
          ),
        );
      }
      const emptyWindow = {
        ...queryWindow,
        startMs: queryWindow.endExclusiveMs + 1000,
        endExclusiveMs: queryWindow.endExclusiveMs + 2000,
      };
      expect(
        await queryReferrerSummaryFromD1(
          env,
          siteId,
          emptyWindow,
          EMPTY_FILTER_DOCUMENT,
          3,
        ),
      ).toEqual(
        await legacyReferrerSummaryOracle(
          env,
          siteId,
          emptyWindow,
          EMPTY_FILTER_DOCUMENT,
          3,
        ),
      );
    } finally {
      close();
    }
  });

  it("paginates every supported keyset order without gaps or duplicates", async () => {
    const { env, database, close } = createSqliteEnv();
    seedReferrers(database, false);
    try {
      for (const [sortBy, sortDirection] of [
        ["views", "desc"],
        ["visitors", "desc"],
        ["views", "asc"],
      ] as const) {
        const expectedAll: ReferrerRow[] = [];
        let cursor: AggregateCursor | null = null;
        let pageNumber = 0;
        while (pageNumber++ < 20) {
          const expected = await legacyReferrersPageOracle(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            2,
            false,
            sortBy,
            sortDirection,
            cursor,
          );
          const actual = await queryReferrersPageFromD1(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            2,
            false,
            undefined,
            cursor,
            undefined,
            "private-dashboard",
            sortBy,
            sortDirection,
          );
          expect(actual.items).toEqual(expected.items);
          expect(actual.pagination.hasMore).toBe(expected.hasMore);
          expectedAll.push(...expected.items);
          if (!actual.pagination.nextCursor) break;
          cursor = await decodeReferrersCursor(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            false,
            undefined,
            actual.pagination.nextCursor,
            "private-dashboard",
            sortBy,
            sortDirection,
          );
          expect(cursor).not.toBeNull();
        }
        expect(pageNumber).toBeLessThan(20);
        const all = await legacyTopReferrersOracle(
          env,
          siteId,
          queryWindow,
          100,
          false,
          EMPTY_FILTER_DOCUMENT,
        );
        const expectedSorted = [...all].sort((left, right) => {
          const primary = sortBy === "visitors" ? "visitors" : "views";
          const secondary = sortBy === "visitors" ? "views" : "sessions";
          const delta = left[primary] - right[primary];
          if (delta !== 0) return sortDirection === "asc" ? delta : -delta;
          const secondaryDelta = left[secondary] - right[secondary];
          if (secondaryDelta !== 0)
            return sortDirection === "asc" ? secondaryDelta : -secondaryDelta;
          return left.referrer < right.referrer
            ? -1
            : left.referrer > right.referrer
              ? 1
              : 0;
        });
        expect(expectedAll).toEqual(expectedSorted);
        expect(new Set(expectedAll.map((row) => row.referrer)).size).toBe(
          expectedAll.length,
        );
      }
    } finally {
      close();
    }
  });

  it("passes diagnostics through one-output and multi-output D1 reads", async () => {
    const makeEnv = (withMeta: boolean) => {
      const rows: Row[][] = [
        [{ referrer: "google.com", views: 2, sessions: 1, visitors: 1 }],
      ];
      const prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({
            results: rows.shift() ?? [],
            ...(withMeta ? { meta: { rows_read: 7 } } : {}),
          })),
        })),
      }));
      return {
        env: {
          DB: { prepare },
          DAILY_SALT_SECRET: "test-secret",
          INGEST_DO: {} as DurableObjectNamespace,
        } as unknown as Env,
        prepare,
      };
    };
    const success = makeEnv(true);
    const successDiagnostics = createD1ReadDiagnostics();
    await queryTopReferrersFromD1(
      success.env,
      siteId,
      queryWindow,
      EMPTY_FILTER_DOCUMENT,
      5,
      false,
      successDiagnostics,
    );
    expect(successDiagnostics).toMatchObject({
      rowsRead: 7,
      rowsReadAvailable: true,
    });

    const unavailable = makeEnv(false);
    const unavailableDiagnostics: D1ReadDiagnostics = createD1ReadDiagnostics();
    await queryReferrersPageFromD1(
      unavailable.env,
      siteId,
      queryWindow,
      EMPTY_FILTER_DOCUMENT,
      5,
      false,
      undefined,
      null,
      unavailableDiagnostics,
    );
    expect(unavailableDiagnostics.rowsReadAvailable).toBe(false);

    const summaryEnv = makeEnv(true);
    const summaryDiagnostics = createD1ReadDiagnostics();
    await queryReferrerSummaryFromD1(
      summaryEnv.env,
      siteId,
      queryWindow,
      EMPTY_FILTER_DOCUMENT,
      1,
      summaryDiagnostics,
    );
    expect(summaryEnv.prepare).toHaveBeenCalledTimes(1);
    expect(summaryDiagnostics).toMatchObject({
      rowsRead: 7,
      rowsReadAvailable: true,
    });
  });

  it("keeps plain, searched cursor, payload, and 128-ID plans within compact budgets", async () => {
    const { env, database, calls, close } = createSqliteEnv();
    seedReferrers(database);
    const deepPath = `/${Array.from({ length: 40 }, () => "x").join("/")}`;
    const payloadFilter = normalizedFilters({
      kind: "condition",
      target: { kind: "event-payload", path: deepPath },
      operator: "eq",
      value: "value",
    });
    const prepared = prepareScopedQuery("pages", {
      context: siteQueryContext(siteId, "private-dashboard"),
      time: createQueryTime(
        queryWindow.startMs,
        queryWindow.endExclusiveMs,
        "UTC",
        queryWindow.nowMs,
      ),
      filters: filterFixture({ country: "US" }),
      scopePreference: "event",
    } as never) as { filters?: FilterDocument };
    const metadata = scopedFilterMetadata(prepared.filters);
    if (!prepared.filters || !metadata)
      throw new Error("wave44_budget_preparation_failed");
    const widePrepared = attachScopedFilterMetadata(prepared.filters, {
      ...metadata,
      plan: {
        ...metadata.plan,
        advancedMatches: {
          visitIds: Array.from({ length: 128 }, (_, index) => ({
            siteId,
            id: `wide-referrer-visit-${index}`,
          })),
        },
      },
    });

    const requestCases = [
      {
        name: "plain",
        run: () =>
          queryTopReferrersFromD1(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            10,
            false,
          ),
      },
      {
        name: "searched-cursor",
        run: () =>
          queryReferrersPageFromD1(
            env,
            siteId,
            queryWindow,
            EMPTY_FILTER_DOCUMENT,
            10,
            true,
            " news ",
            { primary: 2, secondary: 1, referrer: "https://news.example/a" },
          ),
      },
      {
        name: "event-payload-40",
        run: () =>
          queryTopReferrersFromD1(
            env,
            siteId,
            queryWindow,
            payloadFilter,
            10,
            false,
          ),
      },
      {
        name: "prepared-128-visit-ids",
        run: () =>
          queryTopReferrersFromD1(
            env,
            siteId,
            queryWindow,
            widePrepared,
            10,
            false,
          ),
      },
    ];
    const evidence: Array<Record<string, unknown>> = [];
    try {
      for (const request of requestCases) {
        const before = calls.length;
        await request.run();
        expect(calls).toHaveLength(before + 1);
        const call = calls.at(-1)!;
        const bytes = Buffer.byteLength(call.sql, "utf8");
        expect(bytes).toBeLessThanOrEqual(100_000);
        expect(call.bindings.length).toBeLessThanOrEqual(100);
        evidence.push({
          name: request.name,
          statements: 1,
          sqlBytes: bytes,
          bindings: call.bindings.length,
          sqlSha256Prefix: createHash("sha256")
            .update(call.sql)
            .digest("hex")
            .slice(0, 16),
        });
        if (request.name === "plain" || request.name === "searched-cursor") {
          const explanation = database
            .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
            .all(...call.bindings) as Array<{ detail?: string }>;
          expect(explanation.length).toBeGreaterThan(0);
          evidence.at(-1)!.sqliteExplainSteps = explanation.length;
        }
      }
      console.info(
        `[Wave44 referrer report budget] ${JSON.stringify(evidence)}`,
      );
    } finally {
      close();
    }
  });
});
