import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createResourceApplicationService } from "@/lib/api-v1/resources/application-service";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { Env } from "@/lib/edge/types";

const databases = new Set<DatabaseSync>();

function createFixture() {
  const database = createMigratedDatabase();
  databases.add(database);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };

  database
    .prepare("INSERT INTO users (id, email, username) VALUES (?, ?, ?)")
    .run("owner-1", "owner@example.test", "owner");
  database
    .prepare(
      "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
    )
    .run("team-1", "Team", "team-1", "owner-1");

  const insertSite = database.prepare(
    "INSERT INTO sites (id, team_id, name, domain, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const id of ["site-a", "site-b", "site-c", "site-d"]) {
    insertSite.run(id, "team-1", id, `${id}.example.test`, 100, 100);
  }

  const insertDefinition = database.prepare(
    "INSERT INTO analysis_definitions (id, site_id, kind, name, config_json, config_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 100, 100)",
  );
  const funnelConfig = JSON.stringify({
    steps: [
      { type: "pageview", value: "/pricing" },
      { type: "event", value: "signup" },
    ],
  });
  const goalConfig = JSON.stringify({
    filterDslVersion: 1,
    filterDsl: 'event.name eq "purchase"',
  });
  for (const id of ["funnel-a", "funnel-b", "funnel-c"]) {
    insertDefinition.run(id, "site-a", "funnel", id, funnelConfig);
  }
  for (const id of ["goal-a", "goal-b", "goal-c"]) {
    insertDefinition.run(id, "site-a", "goal", id, goalConfig);
  }
  database.exec("ANALYZE");

  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "resource-dal-test-secret",
  } as unknown as Env;
  return { database, env, trace };
}

function tracedStatement(
  trace: SqliteD1Trace,
  table: string,
  occurrenceFromEnd = 0,
) {
  const matches = trace.preparedSql
    .map((sql, index) => ({
      sql,
      bindings: trace.bindings[index] ?? [],
      index,
    }))
    .filter(({ sql }) => sql.includes(`"${table}"`));
  const result = matches[matches.length - 1 - occurrenceFromEnd];
  if (!result) throw new Error(`missing_traced_query:${table}`);
  return result;
}

function expectIndexSearch(plan: readonly string[], indexName: string) {
  expect(
    plan.some(
      (detail) => detail.includes("SEARCH") && detail.includes(indexName),
    ),
    plan.join("\n"),
  ).toBe(true);
}

function expectEquivalentIndexes(
  legacy: readonly string[],
  typed: readonly string[],
) {
  const indexNames = (plan: readonly string[]) =>
    plan.flatMap((detail) => {
      const match = detail.match(/USING (?:COVERING )?INDEX ([^\s(]+)/);
      return match ? [match[1]] : [];
    });
  expect(indexNames(typed)).toEqual(indexNames(legacy));
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("API v1 resource Typed DAL differential", () => {
  it("preserves site and definition keyset order and their indexed access paths", async () => {
    const fixture = createFixture();
    const service = createResourceApplicationService(fixture.env);
    const context = { teamId: "team-1", siteIds: [] };

    const site = await service.execute(
      context,
      "sites.get",
      { siteId: "site-b" },
      {},
    );
    expect(site).toMatchObject({ ok: true, value: { id: "site-b" } });
    const siteLookup = tracedStatement(fixture.trace, "sites");
    const typedSiteLookupPlan = explainQueryPlan(fixture.database, siteLookup);
    const legacySiteLookupPlan = explainQueryPlan(fixture.database, {
      sql: "SELECT id, team_id AS teamId, name, domain, public_enabled AS publicEnabled, public_slug AS publicSlug, created_at AS createdAt, updated_at AS updatedAt FROM sites WHERE id=? AND team_id=? LIMIT 1",
      bindings: ["site-b", "team-1"],
    });
    expectIndexSearch(typedSiteLookupPlan, "sqlite_autoindex_sites_1");
    expectEquivalentIndexes(legacySiteLookupPlan, typedSiteLookupPlan);

    const firstSites = await service.execute(
      context,
      "sites.list",
      { page: { limit: 2 } },
      {},
    );
    expect(firstSites).toMatchObject({
      ok: true,
      value: { items: [{ id: "site-a" }, { id: "site-b" }] },
    });
    if (!firstSites.ok) throw new Error("expected_first_site_page");
    const siteList = tracedStatement(fixture.trace, "sites");
    const legacySites = fixture.database
      .prepare(
        "SELECT id FROM sites WHERE team_id=? ORDER BY created_at DESC, id ASC LIMIT ?",
      )
      .all("team-1", 3) as Array<{ id: string }>;
    expect(firstSites.value.items.map((row) => row.id)).toEqual(
      legacySites.slice(0, 2).map((row) => row.id),
    );
    const typedSiteListPlan = explainQueryPlan(fixture.database, siteList);
    const legacySiteListPlan = explainQueryPlan(fixture.database, {
      sql: "SELECT id FROM sites WHERE team_id=? ORDER BY created_at DESC, id ASC LIMIT ?",
      bindings: ["team-1", 3],
    });
    expectEquivalentIndexes(legacySiteListPlan, typedSiteListPlan);

    const nextSites = await service.execute(
      context,
      "sites.list",
      {
        page: { limit: 2, cursor: firstSites.value.pagination.nextCursor },
      },
      {},
    );
    expect(nextSites).toMatchObject({
      ok: true,
      value: {
        items: [{ id: "site-c" }, { id: "site-d" }],
        pagination: { hasMore: false },
      },
    });

    const firstFunnels = await service.execute(
      context,
      "funnels.get",
      { siteId: "site-a", funnelId: "funnel-a" },
      {},
    );
    expect(firstFunnels).toMatchObject({
      ok: true,
      value: { id: "funnel-a" },
    });
    const typedDefinitionLookup = tracedStatement(
      fixture.trace,
      "analysis_definitions",
    );
    const typedDefinitionPlan = explainQueryPlan(
      fixture.database,
      typedDefinitionLookup,
    );
    const legacyDefinitionPlan = explainQueryPlan(fixture.database, {
      sql: "SELECT id, site_id, name, config_json, config_version, created_at, updated_at FROM analysis_definitions WHERE id=? AND site_id=? AND kind='funnel' AND archived_at IS NULL LIMIT 1",
      bindings: ["funnel-a", "site-a"],
    });
    expectIndexSearch(
      typedDefinitionPlan,
      "sqlite_autoindex_analysis_definitions_1",
    );
    expectEquivalentIndexes(legacyDefinitionPlan, typedDefinitionPlan);

    const firstFunnelsPage = await service.execute(
      context,
      "funnels.list",
      { siteId: "site-a", page: { limit: 2 } },
      {},
    );
    expect(firstFunnelsPage).toMatchObject({
      ok: true,
      value: { items: [{ id: "funnel-a" }, { id: "funnel-b" }] },
    });
    if (!firstFunnelsPage.ok) throw new Error("expected_first_funnel_page");
    const funnelList = tracedStatement(fixture.trace, "analysis_definitions");
    const legacyFunnels = fixture.database
      .prepare(
        "SELECT id FROM analysis_definitions WHERE site_id=? AND kind='funnel' AND archived_at IS NULL ORDER BY created_at DESC, id ASC LIMIT ?",
      )
      .all("site-a", 3) as Array<{ id: string }>;
    expect(firstFunnelsPage.value.items.map((row) => row.id)).toEqual(
      legacyFunnels.slice(0, 2).map((row) => row.id),
    );
    const typedFunnelPlan = explainQueryPlan(fixture.database, funnelList);
    const legacyFunnelPlan = explainQueryPlan(fixture.database, {
      sql: "SELECT id FROM analysis_definitions WHERE site_id=? AND kind='funnel' AND archived_at IS NULL ORDER BY created_at DESC, id ASC LIMIT ?",
      bindings: ["site-a", 3],
    });
    expectEquivalentIndexes(legacyFunnelPlan, typedFunnelPlan);

    const nextFunnels = await service.execute(
      context,
      "funnels.list",
      {
        siteId: "site-a",
        page: {
          limit: 2,
          cursor: firstFunnelsPage.value.pagination.nextCursor,
        },
      },
      {},
    );
    expect(nextFunnels).toMatchObject({
      ok: true,
      value: { items: [{ id: "funnel-c" }], pagination: { hasMore: false } },
    });

    const firstGoals = await service.execute(
      context,
      "goals.list",
      { siteId: "site-a", page: { limit: 2 } },
      {},
    );
    expect(firstGoals).toMatchObject({
      ok: true,
      value: { items: [{ id: "goal-c" }, { id: "goal-b" }] },
    });
    if (!firstGoals.ok) throw new Error("expected_first_goal_page");
    const nextGoals = await service.execute(
      context,
      "goals.list",
      {
        siteId: "site-a",
        page: { limit: 2, cursor: firstGoals.value.pagination.nextCursor },
      },
      {},
    );
    expect(nextGoals).toMatchObject({
      ok: true,
      value: { items: [{ id: "goal-a" }], pagination: { hasMore: false } },
    });
  });

  it("preserves API resource create/update/archive state through typed mutations", async () => {
    const fixture = createFixture();
    const service = createResourceApplicationService(fixture.env);
    const context = { teamId: "team-1", siteIds: [] };

    const createdFunnel = await service.execute(
      context,
      "funnels.create",
      {
        siteId: "site-a",
        name: "New funnel",
        filterDslVersion: 1,
        progressionScope: "session",
        conversionWindowMs: null,
        steps: [
          { id: "start", filterDsl: 'page.path eq "/"' },
          { id: "signup", filterDsl: 'event.name eq "signup"' },
        ],
      },
      {},
    );
    expect(createdFunnel).toMatchObject({
      ok: true,
      value: { name: "New funnel" },
    });
    if (!createdFunnel.ok) throw new Error("expected_funnel_create");
    expect(fixture.trace.preparedSql).toHaveLength(2);
    const funnelId = createdFunnel.value.id;

    const updatedFunnel = await service.execute(
      context,
      "funnels.update",
      {
        siteId: "site-a",
        funnelId,
        name: "Updated funnel",
      },
      {},
    );
    expect(updatedFunnel).toMatchObject({
      ok: true,
      value: { id: funnelId, name: "Updated funnel" },
    });
    expect(fixture.trace.preparedSql).toHaveLength(5);
    expect(
      fixture.database
        .prepare("SELECT name FROM analysis_definitions WHERE id=?")
        .get(funnelId),
    ).toEqual({ name: "Updated funnel" });

    const archivedFunnel = await service.execute(
      context,
      "funnels.delete",
      { siteId: "site-a", funnelId },
      {},
    );
    expect(archivedFunnel).toEqual({ ok: true, value: undefined });
    expect(fixture.trace.preparedSql).toHaveLength(8);
    expect(
      fixture.database
        .prepare(
          "SELECT kind, archived_at FROM analysis_definitions WHERE id=?",
        )
        .get(funnelId),
    ).toMatchObject({ kind: "funnel", archived_at: expect.any(Number) });

    const createdGoal = await service.execute(
      context,
      "goals.create",
      {
        siteId: "site-a",
        name: "New goal",
        filterDslVersion: 1,
        filterDsl: 'event.name eq "purchase"',
      },
      {},
    );
    expect(createdGoal).toMatchObject({
      ok: true,
      value: { name: "New goal" },
    });
    if (!createdGoal.ok) throw new Error("expected_goal_create");
    expect(fixture.trace.preparedSql).toHaveLength(11);
    const goalId = createdGoal.value.id;

    const updatedGoal = await service.execute(
      context,
      "goals.update",
      {
        siteId: "site-a",
        goalId,
        name: "Updated goal",
        filterDsl: 'event.name eq "checkout"',
      },
      {},
    );
    expect(updatedGoal).toMatchObject({
      ok: true,
      value: { id: goalId, name: "Updated goal" },
    });
    expect(fixture.trace.preparedSql).toHaveLength(14);
    expect(
      fixture.database
        .prepare("SELECT name FROM analysis_definitions WHERE id=?")
        .get(goalId),
    ).toEqual({ name: "Updated goal" });

    const archivedGoal = await service.execute(
      context,
      "goals.delete",
      { siteId: "site-a", goalId },
      {},
    );
    expect(archivedGoal).toEqual({ ok: true, value: undefined });
    expect(fixture.trace.preparedSql).toHaveLength(17);
    expect(
      fixture.database
        .prepare(
          "SELECT kind, archived_at FROM analysis_definitions WHERE id=?",
        )
        .get(goalId),
    ).toMatchObject({ kind: "goal", archived_at: expect.any(Number) });
  });
});
