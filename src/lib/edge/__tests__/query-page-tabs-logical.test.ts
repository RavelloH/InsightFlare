import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";
import {
  buildPageTabsPlan,
  PAGE_TAB_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import {
  buildVisitFilterSql,
  buildVisitSourceCte,
  type QueryWindow,
  scopedDatasetFor,
  scopedDatasetForUnpreparedReader,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryPageTabsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "page-tabs-logical-site";
const WINDOW: QueryWindow = {
  startMs: 1_000,
  endExclusiveMs: 2_000,
  nowMs: 2_500,
  timeZone: "UTC",
};
const TIME = createQueryTime(
  WINDOW.startMs,
  WINDOW.endExclusiveMs,
  WINDOW.timeZone,
  WINDOW.nowMs,
);
const PATH_FILTER = fieldFilter("page.path", "/hit");
const COUNTRY_FILTER = fieldFilter("geo.country", "US");

interface LegacyPageTabRow {
  readonly cardType: unknown;
  readonly value: unknown;
  readonly views: unknown;
  readonly sessions: unknown;
  readonly visitors: unknown;
}

function fieldFilter(field: string, value: string): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field },
        operator: "eq",
        value,
      },
    } as never,
    analyticsFilterRegistry,
  );
}

function makeUnpreparedPayloadFilters(count: number): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "and",
        children: Array.from({ length: count }, (_, index) => ({
          kind: "condition",
          target: { kind: "event-payload", path: `/page-tabs/${index}` },
          operator: "exists",
        })),
      },
    } as never,
    analyticsFilterRegistry,
  );
}

function preparedFilters(
  filters: FilterDocument,
  scopePreference: "event" | "session" | "visitor",
): FilterDocument {
  const prepared = prepareScopedQuery("pages", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: TIME,
    filters,
    scopePreference,
  } as never) as { readonly filters?: FilterDocument };
  if (!prepared.filters)
    throw new Error(`page_tabs_prepared_${scopePreference}_missing`);
  return prepared.filters;
}

function createFixture(): {
  readonly database: DatabaseSync;
  readonly trace: SqliteD1Trace;
  readonly env: Env;
  close(): void;
} {
  const database = createMigratedDatabase();
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  const insert = database.prepare(`
    INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, title, hostname, country
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?)
  `);
  const rows = [
    [
      "a-first",
      "visitor-first",
      "session-a",
      1_001,
      "/start",
      " Start ",
      " first.test ",
      "US",
    ],
    [
      "a-hit",
      "visitor-hit",
      "session-a",
      1_002,
      "/hit",
      "Hit",
      "hit.test",
      "US",
    ],
    [
      "a-last",
      "visitor-last",
      "session-a",
      1_003,
      "/finish",
      "Finish",
      "first.test",
      "CA",
    ],
    [
      "b-hit",
      "visitor-b",
      "session-b",
      1_004,
      "/hit",
      "Hit",
      "beta.test",
      "US",
    ],
    [
      "c-rank-a1",
      "visitor-c",
      "session-c",
      1_005,
      "/rank-a",
      "Rank A",
      "rank.test",
      "US",
    ],
    [
      "c-rank-a2",
      "visitor-c",
      "session-c",
      1_006,
      "/rank-a",
      "Rank A",
      "rank.test",
      "US",
    ],
    [
      "d-rank-z1",
      "visitor-d1",
      "session-d",
      1_007,
      "/rank-z",
      "Rank Z",
      "rank.test",
      "US",
    ],
    [
      "d-rank-z2",
      "visitor-d2",
      "session-d",
      1_008,
      "/rank-z",
      "Rank Z",
      "rank.test",
      "US",
    ],
    [
      "space-identity",
      " ",
      " ",
      1_009,
      "/space-id",
      "Space ID",
      "ids.test",
      "US",
    ],
    ["anonymous", "", "", 1_010, "/anonymous", "Anonymous", "anon.test", "US"],
    [
      "ascii-space-values",
      "visitor-space",
      "session-space",
      1_011,
      "   ",
      "   ",
      " ",
      "US",
    ],
    [
      "unicode-values",
      "visitor-unicode",
      "session-unicode",
      1_012,
      " \t ",
      "\u00a0Title\t",
      " \u00a0 ",
      "US",
    ],
    [
      "outside-window",
      "visitor-outside",
      "session-outside",
      2_000,
      "/outside",
      "Outside",
      "outside.test",
      "US",
    ],
  ] as const;
  for (const [
    id,
    visitorId,
    sessionId,
    startedAt,
    pathname,
    title,
    hostname,
    country,
  ] of rows) {
    insert.run(
      id,
      SITE_ID,
      sitePk,
      visitorId,
      sessionId,
      startedAt,
      startedAt,
      pathname,
      title,
      hostname,
      country,
    );
  }
  return {
    database,
    trace,
    env: { DB: createSqliteD1Database(database, trace) } as unknown as Env,
    close: () => database.close(),
  };
}

function seedPayloadEvent(
  database: DatabaseSync,
  paths: readonly string[],
): void {
  const siteIdentity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  const sitePk = Number(siteIdentity.site_pk);
  database
    .prepare(
      `INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at)
       VALUES (?, ?, 'page_tabs_probe', 1)`,
    )
    .run(SITE_ID, sitePk);
  const eventName = database
    .prepare(
      "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'page_tabs_probe'",
    )
    .get(sitePk) as { readonly id: number };
  const resolvedEventNameId = Number(eventName.id);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES ('page-tabs-probe-event', ?, ?, 'a-hit', ?, 1002, 1002, 1, ?, ?)`,
    )
    .run(SITE_ID, sitePk, resolvedEventNameId, paths.length, paths.length);
  const event = database
    .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
    .get("page-tabs-probe-event") as { readonly event_pk: number };
  const insertPath = database.prepare(`
    INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at)
    VALUES (?, ?, ?, 1)
  `);
  const insertNode = database.prepare(`
    INSERT INTO custom_event_json_nodes (
      event_pk, node_id, path_id, value_type, depth
    ) VALUES (?, ?, ?, 1, 1)
  `);
  const insertValue = database.prepare(`
    INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, site_pk, event_name_id, path_id,
      occurred_at, value_type, string_value
    ) VALUES (?, ?, ?, ?, ?, ?, 1002, 1, 'present')
  `);
  for (const [index, path] of paths.entries()) {
    insertPath.run(SITE_ID, sitePk, path);
    const pathRow = database
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(sitePk, path) as { readonly id: number };
    const pathId = Number(pathRow.id);
    const nodeId = index + 1;
    insertNode.run(event.event_pk, nodeId, pathId);
    insertValue.run(
      event.event_pk,
      nodeId,
      SITE_ID,
      sitePk,
      resolvedEventNameId,
      pathId,
    );
  }
}

/** Frozen full-SQL Page tabs reader used only as the migration oracle. */
async function legacyPageTabsOracle(
  database: DatabaseSync,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  limit: number,
  onStatement?: (statement: {
    sql: string;
    bindings: readonly unknown[];
  }) => void,
) {
  const preparedDataset = scopedDatasetFor(siteId, window, filters);
  const expandedDataset =
    preparedDataset ??
    scopedDatasetForUnpreparedReader(
      "pages",
      siteId,
      window,
      filters,
      "session",
    );
  const scopedDataset = preparedDataset ?? expandedDataset;
  const filter = preparedDataset
    ? null
    : buildVisitFilterSql(filters, "rv", { window });
  const observationVisitRelation = preparedDataset
    ? preparedDataset.visitRelation
    : expandedDataset
      ? "scope_raw_visits"
      : "visit_source";
  const edgeVisitRelation =
    preparedDataset || !expandedDataset
      ? "filtered_visits"
      : expandedDataset.visitRelation;
  const sql = `
WITH
${scopedDataset?.ctes ?? buildVisitSourceCte()},
filtered_visits AS MATERIALIZED (
  SELECT
    visitor_id,
    session_id,
    started_at,
    visit_id,
    TRIM(COALESCE(pathname, '')) AS pathname,
    TRIM(COALESCE(title, '')) AS title,
    TRIM(COALESCE(hostname, '')) AS hostname
  FROM ${observationVisitRelation} rv
  ${filter?.clause ?? ""}
),
ranked_session_visits AS (
  SELECT
    vs.session_id,
    vs.visitor_id,
    TRIM(COALESCE(vs.pathname, '')) AS pathname,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at ASC, vs.visit_id ASC
    ) AS first_rank,
    ROW_NUMBER() OVER (
      PARTITION BY vs.session_id
      ORDER BY vs.started_at DESC, vs.visit_id DESC
    ) AS latest_rank
  FROM ${edgeVisitRelation} vs
  WHERE vs.session_id != '' AND TRIM(COALESCE(vs.pathname, '')) != ''
),
session_edges AS (
  SELECT
    session_id,
    MAX(CASE WHEN first_rank = 1 THEN visitor_id END) AS visitor_id,
    MAX(CASE WHEN first_rank = 1 THEN pathname END) AS entry,
    MAX(CASE WHEN latest_rank = 1 THEN pathname END) AS exit
  FROM ranked_session_visits
  GROUP BY session_id
),
card_rows AS (
  SELECT 'path' AS card_type, pathname AS value, COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors
  FROM filtered_visits WHERE pathname != '' GROUP BY pathname
  UNION ALL
  SELECT 'title', title, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE title != '' GROUP BY title
  UNION ALL
  SELECT 'hostname', hostname, COUNT(*),
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM filtered_visits WHERE hostname != '' GROUP BY hostname
  UNION ALL
  SELECT 'entry', entry, COUNT(*), COUNT(*),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM session_edges WHERE entry != '' GROUP BY entry
  UNION ALL
  SELECT 'exit', exit, COUNT(*), COUNT(*),
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END)
  FROM session_edges WHERE exit != '' GROUP BY exit
),
ranked_cards AS (
  SELECT card_type, value, views, sessions, visitors,
    ROW_NUMBER() OVER (
      PARTITION BY card_type
      ORDER BY views DESC, sessions DESC, value ASC
    ) AS card_rank
  FROM card_rows
)
SELECT card_type AS cardType, value, views, sessions, visitors
FROM ranked_cards
WHERE card_rank <= ?
ORDER BY card_type ASC, card_rank ASC
`;
  const bindings = [
    ...(scopedDataset
      ? scopedDataset.bindings.map((binding) => binding.value)
      : [...visitSourceBindings(siteId, window)]),
    ...(filter?.bindings ?? []),
    limit,
  ];
  onStatement?.({ sql, bindings });
  const rows = database
    .prepare(sql)
    .all(...bindings) as unknown as LegacyPageTabRow[];
  const byCard = new Map<
    string,
    Array<{ value: string; views: number; sessions: number; visitors: number }>
  >();
  for (const row of rows) {
    const card = String(row.cardType ?? "");
    const values = byCard.get(card) ?? [];
    values.push({
      value: String(row.value ?? ""),
      views: Number(row.views ?? 0),
      sessions: Number(row.sessions ?? 0),
      visitors: Number(row.visitors ?? 0),
    });
    byCard.set(card, values);
  }
  return {
    path: byCard.get("path") ?? [],
    title: byCard.get("title") ?? [],
    hostname: byCard.get("hostname") ?? [],
    entry: byCard.get("entry") ?? [],
    exit: byCard.get("exit") ?? [],
  };
}

function clearTrace(trace: SqliteD1Trace): void {
  trace.preparedSql.length = 0;
  trace.bindings.length = 0;
}

describe("Logical Page tabs report", () => {
  it("keeps Page Source profiles local to their ordinary and boundary outputs", () => {
    const directPlan = buildPageTabsPlan({
      siteId: SITE_ID,
      queryTime: queryWindowToTime(WINDOW),
      filters: PATH_FILTER,
      limit: 10,
    });
    const directSources = directPlan.nodes.filter(
      (node): node is Extract<LogicalNode, { kind: "source" }> =>
        node.kind === "source" && node.entity === "page",
    );
    expect(directPlan.outputs.map(({ id }) => id)).toEqual(PAGE_TAB_OUTPUT_IDS);
    expect(directSources).toHaveLength(2);
    expect(directSources.map(({ selection }) => selection?.profile)).toEqual([
      "direct-page-analytics-v1",
      "direct-page-session-compat-v1",
    ]);
    expect(directSources[0]?.selection?.filter).toEqual(PATH_FILTER);
    expect(directSources[1]?.selection?.filter).toEqual(PATH_FILTER);
    expect(directSources[0]?.selection?.subject).toEqual(
      directSources[1]?.selection?.subject,
    );
    expect(directSources[0]?.selection?.time).toEqual(
      directSources[1]?.selection?.time,
    );

    const emptyPlan = buildPageTabsPlan({
      siteId: SITE_ID,
      queryTime: queryWindowToTime(WINDOW),
      filters: EMPTY_FILTER_DOCUMENT,
      limit: 10,
    });
    expect(
      emptyPlan.nodes.filter(
        (node) => node.kind === "source" && node.entity === "page",
      ),
    ).toHaveLength(1);

    const prepared = preparedFilters(COUNTRY_FILTER, "session");
    const metadata = scopedFilterMetadata(prepared);
    if (!metadata) throw new Error("page_tabs_prepared_metadata_missing");
    const preparedPlan = buildPageTabsPlan({
      siteId: SITE_ID,
      queryTime: metadata.time,
      filters: prepared,
      scopePlan: metadata.plan,
      limit: 10,
    });
    const preparedSources = preparedPlan.nodes.filter(
      (node): node is Extract<LogicalNode, { kind: "source" }> =>
        node.kind === "source" && node.entity === "page",
    );
    expect(preparedSources).toHaveLength(1);
    expect(preparedSources[0]?.selection?.profile).toBe("prepared-scoped-v1");
  });

  it("matches the frozen five-card SQL while retaining filtered Page and expanded Session bags", async () => {
    const fixture = createFixture();
    try {
      for (const filters of [EMPTY_FILTER_DOCUMENT, PATH_FILTER]) {
        clearTrace(fixture.trace);
        const actual = await queryPageTabsFromD1(
          fixture.env,
          SITE_ID,
          WINDOW,
          filters,
          20,
        );
        expect(actual).toEqual(
          await legacyPageTabsOracle(
            fixture.database,
            SITE_ID,
            WINDOW,
            filters,
            20,
          ),
        );
        expect(fixture.trace.preparedSql).toHaveLength(1);
      }

      const filtered = await queryPageTabsFromD1(
        fixture.env,
        SITE_ID,
        WINDOW,
        PATH_FILTER,
        20,
      );
      expect(filtered.path.map(({ value }) => value)).toEqual(["/hit"]);
      expect(filtered.entry).toContainEqual({
        value: "/start",
        views: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(filtered.exit).toContainEqual({
        value: "/finish",
        views: 1,
        sessions: 1,
        visitors: 1,
      });
    } finally {
      fixture.close();
    }
  });

  it("preserves prepared observation, Session, Visitor, and prepared Page identity scope", async () => {
    const fixture = createFixture();
    try {
      const observation = preparedFilters(COUNTRY_FILTER, "event");
      const session = preparedFilters(COUNTRY_FILTER, "session");
      const visitor = preparedFilters(COUNTRY_FILTER, "visitor");
      const observationMetadata = scopedFilterMetadata(observation);
      const sessionMetadata = scopedFilterMetadata(session);
      if (!observationMetadata || !sessionMetadata)
        throw new Error("page_tabs_prepared_scope_missing");
      const selectedPage = attachScopedFilterMetadata(observation, {
        ...observationMetadata,
        plan: {
          ...observationMetadata.plan,
          advancedMatches: {
            visitIds: [{ siteId: SITE_ID, id: "a-hit" }],
          },
        },
      });
      const selectedSessions = attachScopedFilterMetadata(session, {
        ...sessionMetadata,
        plan: {
          ...sessionMetadata.plan,
          advancedMatches: {
            entityIds: [{ siteId: SITE_ID, id: "session-a" }],
          },
        },
      });

      for (const filters of [
        observation,
        session,
        visitor,
        selectedPage,
        selectedSessions,
      ]) {
        clearTrace(fixture.trace);
        const actual = await queryPageTabsFromD1(
          fixture.env,
          SITE_ID,
          WINDOW,
          filters,
          20,
        );
        expect(actual).toEqual(
          await legacyPageTabsOracle(
            fixture.database,
            SITE_ID,
            WINDOW,
            filters,
            20,
          ),
        );
        expect(fixture.trace.preparedSql).toHaveLength(1);
      }

      expect(
        (
          await queryPageTabsFromD1(
            fixture.env,
            SITE_ID,
            WINDOW,
            observation,
            20,
          )
        ).exit.map(({ value }) => value),
      ).toContain("/hit");
      expect(
        (
          await queryPageTabsFromD1(fixture.env, SITE_ID, WINDOW, session, 20)
        ).exit.map(({ value }) => value),
      ).toContain("/finish");
    } finally {
      fixture.close();
    }
  });

  it("keeps per-card ROW_NUMBER cutoff semantics, whitespace values, and raw identity counting", async () => {
    const fixture = createFixture();
    try {
      for (const limit of [0, -1, 1, 1.5]) {
        clearTrace(fixture.trace);
        const actual = await queryPageTabsFromD1(
          fixture.env,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          limit,
        );
        expect(actual).toEqual(
          await legacyPageTabsOracle(
            fixture.database,
            SITE_ID,
            WINDOW,
            EMPTY_FILTER_DOCUMENT,
            limit,
          ),
        );
        expect(fixture.trace.preparedSql).toHaveLength(1);
      }

      const actual = await queryPageTabsFromD1(
        fixture.env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        100,
      );
      expect(actual.path).toContainEqual({
        value: "\t",
        views: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(actual.title).toContainEqual({
        value: "\u00a0Title\t",
        views: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(actual.hostname).toContainEqual({
        value: "\u00a0",
        views: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(actual.path).toContainEqual({
        value: "/space-id",
        views: 1,
        sessions: 1,
        visitors: 1,
      });
      expect(actual.path).toContainEqual({
        value: "/anonymous",
        views: 1,
        sessions: 0,
        visitors: 0,
      });
      expect(
        actual.path.findIndex(({ value }) => value === "/rank-a"),
      ).toBeLessThan(actual.path.findIndex(({ value }) => value === "/rank-z"));
      expect(actual.path).toContainEqual({
        value: "/rank-z",
        views: 2,
        sessions: 1,
        visitors: 2,
      });
      expect(actual.path.map(({ value }) => value)).not.toContain("");
      expect(actual.path.map(({ value }) => value)).not.toContain("/outside");
    } finally {
      fixture.close();
    }
  });

  it("rejects a prepared site authorization mismatch before issuing SQL", async () => {
    const fixture = createFixture();
    try {
      const filters = preparedFilters(COUNTRY_FILTER, "session");
      await expect(
        queryPageTabsFromD1(fixture.env, "another-site", WINDOW, filters, 10),
      ).rejects.toThrow("subject_outside_prepared_authorization");
      expect(fixture.trace.preparedSql).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it("keeps plain, 128-identity prepared, and 40-payload query budgets within D1 limits", async () => {
    const fixture = createFixture();
    try {
      const base = preparedFilters(COUNTRY_FILTER, "session");
      const metadata = scopedFilterMetadata(base);
      if (!metadata) throw new Error("page_tabs_budget_metadata_missing");
      const prepared128 = attachScopedFilterMetadata(base, {
        ...metadata,
        plan: {
          ...metadata.plan,
          advancedMatches: {
            entityIds: Array.from({ length: 128 }, (_, index) => ({
              siteId: SITE_ID,
              id: index === 0 ? "session-a" : `page-tabs-budget-${index}`,
            })),
          },
        },
      });
      const payload40 = makeUnpreparedPayloadFilters(40);
      const payloadPaths = Array.from(
        { length: 40 },
        (_, index) => `/page-tabs/${index}`,
      );
      seedPayloadEvent(fixture.database, payloadPaths);
      const requests = [
        { name: "plain", filters: EMPTY_FILTER_DOCUMENT },
        { name: "prepared-session-128", filters: prepared128 },
        { name: "event-payload-40", filters: payload40 },
      ] as const;
      const budgets: Array<{
        name: string;
        sqlBytes: number;
        bindings: number;
        statements: number;
        sha256: string;
      }> = [];
      for (const request of requests) {
        clearTrace(fixture.trace);
        const expected = await legacyPageTabsOracle(
          fixture.database,
          SITE_ID,
          WINDOW,
          request.filters,
          10,
        );
        const actual = await queryPageTabsFromD1(
          fixture.env,
          SITE_ID,
          WINDOW,
          request.filters,
          10,
        );
        expect(actual).toEqual(expected);
        if (request.name === "event-payload-40") {
          expect(actual.path.map(({ value }) => value)).toEqual(["/hit"]);
          expect(actual.entry.map(({ value }) => value)).toEqual(["/start"]);
          expect(actual.exit.map(({ value }) => value)).toEqual(["/finish"]);
        }
        const sql = fixture.trace.preparedSql[0] ?? "";
        const bindingCount = fixture.trace.bindings[0]?.length ?? 0;
        const sqlBytes = Buffer.byteLength(sql, "utf8");
        budgets.push({
          name: request.name,
          sqlBytes,
          bindings: bindingCount,
          statements: fixture.trace.preparedSql.length,
          sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
        });
        expect(fixture.trace.preparedSql).toHaveLength(1);
        expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(bindingCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
        if (request.name === "event-payload-40") {
          const payloadBindings = (fixture.trace.bindings[0] ?? []).filter(
            (binding): binding is string =>
              typeof binding === "string" && binding.startsWith("/page-tabs/"),
          );
          expect(payloadBindings).toHaveLength(40);
          expect([...payloadBindings].sort()).toEqual([...payloadPaths].sort());
        }
      }
      expect(budgets).toEqual([
        {
          name: "plain",
          sqlBytes: 12431,
          bindings: 16,
          statements: 1,
          sha256:
            "0634e5d74041b70d29b777f87ac24f89df70ab8b90e04e07a948a282fcb5e9f9",
        },
        {
          name: "prepared-session-128",
          sqlBytes: 14190,
          bindings: 18,
          statements: 1,
          sha256:
            "ec982fae63e0676197718270f2a30d3767c4954dc8b15c6cc712f650cbfb3288",
        },
        {
          name: "event-payload-40",
          sqlBytes: 86967,
          bindings: 76,
          statements: 1,
          sha256:
            "72fcb0a7b5673e278ad8d33376d344c7ee529bcce8aeb06937f46c2456653d3a",
        },
      ]);
    } finally {
      fixture.close();
    }
  });
});
