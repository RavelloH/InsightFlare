import type { DatabaseSync } from "node:sqlite";
import { type SQLInputValue } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createDatabaseClient, createDatabaseRuntime } from "@/lib/db";
import {
  add,
  aggregate,
  and,
  antiJoin,
  avg,
  callFunction,
  caseWhen,
  coalesce,
  compileD1Mutation,
  compileD1Query,
  countDistinct,
  deleteFrom,
  distinct,
  eq,
  excluded,
  filter,
  gt,
  insert,
  insertFromQuery,
  insertOrIgnore,
  inSubquery,
  isNotNull,
  join,
  limit,
  lowerLogicalPlan,
  max,
  onConflictDoNothing,
  onConflictDoUpdate,
  param,
  project,
  scalar,
  scan,
  semiJoin,
  sort,
  sum,
  union,
  unixepoch,
  update,
} from "@/lib/db";
import { compileD1Expression } from "@/lib/db/query/compiler";
import { schema } from "@/lib/db/schema";
import type { DatabaseRuntime } from "@/lib/db/types";

function executeAll(
  db: DatabaseSync,
  query: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]));
}

function executeRun(
  db: DatabaseSync,
  mutation: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(mutation.sql)
    .run(...((mutation.bindings ?? []) as SQLInputValue[]));
}

describe("typed D1 query compiler", () => {
  it("implements ECMAScript trim semantics for text expressions", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "trim-test",
      );
      const sites = scan(schema.site_identities);
      const whitespace = [
        0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000,
        0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
        0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
      ];

      for (const codePoint of whitespace) {
        const character = String.fromCodePoint(codePoint);
        const query = compileD1Query(
          project(sites, {
            value: callFunction("trim", param(`${character}value${character}`)),
          }),
        );
        expect(query.sql).toContain("char(9, 10, 11, 12, 13, 32, 160");
        expect(executeAll(db, query)).toEqual([{ value: "value" }]);
      }
    } finally {
      db.close();
    }
  });

  it("compiles excluded values and rejects columns without a SQL scope", () => {
    expect(
      compileD1Expression(
        excluded(schema.site_identities.columns.site_id),
        new Map(),
      ).text,
    ).toBe('"excluded"."site_id"');

    const relation = scan(schema.site_identities);
    expect(() =>
      compileD1Expression(relation.columns.site_id, new Map()),
    ).toThrowError(/No SQL scope is available/);
  });

  it("compiles representative query IR nodes with stable SQL and bindings", () => {
    const users = scan(schema.users);
    const lookup = limit(filter(users, eq(users.columns.id, param("u-1"))), 1);
    const query = compileD1Query(lookup, { tag: "users.lookup" });
    expect(query.sql).toContain('FROM "users"');
    expect(query.sql).toContain('WHERE ("q0"."_c0" = ?)');
    expect(query.bindings).toEqual(["u-1", 1]);
    expect(query.tag).toBe("users.lookup");
    expect(compileD1Query(lookup)).toEqual(compileD1Query(lookup));
    expect(compileD1Query(lowerLogicalPlan(lookup)).sql).toBe(query.sql);

    const visits = scan(schema.visits);
    const range = filter(
      visits,
      and(
        eq(visits.columns.site_pk, param(7)),
        gt(visits.columns.started_at, param(100)),
      ),
    );
    const rangeQuery = compileD1Query(range);
    expect(rangeQuery.sql).toContain('"site_pk"');
    expect(rangeQuery.bindings).toEqual([7, 100]);

    const totals = aggregate(visits, {
      groupBy: { country: visits.columns.country },
      aggregates: {
        visitors: countDistinct(visits.columns.visitor_id),
        averageDuration: avg(visits.columns.duration_ms),
        latestVisit: max(visits.columns.started_at),
      },
    });
    const aggregateQuery = compileD1Query(totals);
    expect(aggregateQuery.sql).toContain("COUNT(DISTINCT");
    expect(aggregateQuery.sql).toContain("GROUP BY");

    const events = scan(schema.custom_events);
    const names = scan(schema.custom_event_names);
    const joined = join(
      events,
      names,
      eq(events.columns.event_name_id, names.columns.id),
    );
    expect(compileD1Query(joined).sql).toContain("INNER JOIN");
    expect(
      compileD1Query(
        semiJoin(
          events,
          names,
          eq(events.columns.event_name_id, names.columns.id),
        ),
      ).sql,
    ).toContain("EXISTS");
    expect(
      compileD1Query(
        antiJoin(
          events,
          names,
          eq(events.columns.event_name_id, names.columns.id),
        ),
      ).sql,
    ).toContain("NOT EXISTS");

    const pages = project(visits, {
      item_id: visits.columns.visit_id,
      occurred_at: visits.columns.started_at,
    });
    const activity = project(events, {
      item_id: events.columns.event_id,
      occurred_at: events.columns.occurred_at,
    });
    expect(compileD1Query(union(pages, activity, true)).sql).toContain(
      "UNION ALL",
    );
    expect(compileD1Query(distinct(pages)).sql).toContain("SELECT DISTINCT");
    expect(
      compileD1Query(
        sort(pages, [
          { expression: pages.columns.occurred_at, direction: "DESC" },
        ]),
      ).sql,
    ).toContain("ORDER BY");

    const numeric = project(visits, {
      next_time: add(visits.columns.started_at, param(1)),
    });
    expect(compileD1Query(numeric).bindings).toEqual([1]);
  });

  it("executes compiled reads and writes against an in-memory migration database", () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const sites = scan(schema.site_identities);
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "site-a" }),
        ),
      );
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "site-b" }),
        ),
      );

      const selectedSiteRows = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const selectedSite = project(selectedSiteRows, {
        site_pk: selectedSiteRows.columns.site_pk,
      });
      const membershipProjection = () =>
        project(sites, {
          site_id: sites.columns.site_id,
          is_selected: inSubquery(sites.columns.site_pk, selectedSite),
        });
      const memberships = compileD1Query(membershipProjection());
      expect(memberships.sql).toContain(" IN (SELECT ");
      expect(memberships.bindings).toEqual(["site-a"]);
      expect(executeAll(db, memberships)).toEqual([
        { site_id: "site-a", is_selected: 1 },
        { site_id: "site-b", is_selected: 0 },
      ]);
      expect(memberships).toEqual(compileD1Query(membershipProjection()));

      const missingSiteRows = filter(
        sites,
        eq(sites.columns.site_id, param("missing")),
      );
      const emptySites = project(missingSiteRows, {
        site_pk: missingSiteRows.columns.site_pk,
      });
      const nullableMemberships = compileD1Query(
        project(sites, {
          site_id: sites.columns.site_id,
          null_lhs_in_empty: inSubquery(param(null), emptySites),
        }),
      );
      expect(executeAll(db, nullableMemberships)).toEqual([
        { site_id: "site-a", null_lhs_in_empty: 0 },
        { site_id: "site-b", null_lhs_in_empty: 0 },
      ]);

      const innerSites = scan(schema.site_identities);
      const matchingSites = filter(
        innerSites,
        eq(innerSites.columns.site_id, sites.columns.site_id),
      );
      const correlatedScalar = scalar(
        project(matchingSites, {
          matched_pk: matchingSites.columns.site_pk,
        }),
      );
      const correlatedProjection = project(sites, {
        site_id: sites.columns.site_id,
        matched_pk: correlatedScalar,
      });
      const correlatedQuery = compileD1Query(correlatedProjection);
      expect(correlatedQuery).toEqual(compileD1Query(correlatedProjection));
      expect(executeAll(db, correlatedQuery)).toEqual([
        { site_id: "site-a", matched_pk: 1 },
        { site_id: "site-b", matched_pk: 2 },
      ]);

      const innerIdentities = scan(schema.site_identities);
      const correlatedIdentities = filter(
        innerIdentities,
        eq(innerIdentities.columns.site_id, sites.columns.site_id),
      );
      const correlatedMembership = compileD1Query(
        project(sites, {
          site_id: sites.columns.site_id,
          contains_matching_id: inSubquery(
            sites.columns.site_id,
            project(correlatedIdentities, {
              site_id: correlatedIdentities.columns.site_id,
            }),
          ),
        }),
      );
      expect(correlatedMembership.sql).toContain('"q0"."_c1"');
      expect(executeAll(db, correlatedMembership)).toEqual([
        { site_id: "site-a", contains_matching_id: 1 },
        { site_id: "site-b", contains_matching_id: 1 },
      ]);

      const updateSubquerySource = scan(schema.site_identities);
      const correlatedUpdate = update(schema.site_identities, (columns) => {
        const matchingRow = filter(
          updateSubquerySource,
          eq(updateSubquerySource.columns.site_pk, columns.site_pk),
        );
        return {
          set: {
            site_id: coalesce(
              scalar(
                project(matchingRow, {
                  site_id: matchingRow.columns.site_id,
                }),
              ),
              param("site-a"),
            ),
          },
          where: eq(columns.site_pk, param(1)),
        };
      });
      const compiledCorrelatedUpdate = compileD1Mutation(correlatedUpdate);
      expect(compiledCorrelatedUpdate.sql).toContain('"t0"."site_pk"');
      executeRun(db, compiledCorrelatedUpdate);
      expect(
        db
          .prepare("SELECT site_id FROM site_identities WHERE site_pk = 1")
          .get(),
      ).toEqual({ site_id: "site-a" });

      const emptyScalarSource = scan(schema.site_identities);
      const missingSites = filter(
        emptyScalarSource,
        eq(emptyScalarSource.columns.site_id, param("missing")),
      );
      const emptyScalar = scalar(
        project(missingSites, { missing: missingSites.columns.site_id }),
      );
      expect(
        executeAll(
          db,
          compileD1Query(
            project(sites, {
              site_id: sites.columns.site_id,
              missing: emptyScalar,
            }),
          ),
        ),
      ).toEqual([
        { site_id: "site-a", missing: null },
        { site_id: "site-b", missing: null },
      ]);

      const find = limit(
        filter(sites, eq(sites.columns.site_id, param("site-a"))),
        1,
      );
      const compiled = compileD1Query(find);
      const actual = executeAll(db, compiled);
      const expected = db
        .prepare("SELECT * FROM site_identities WHERE site_id = ? LIMIT 1")
        .all("site-a");
      expect(actual).toEqual(expected);

      const selectedSites = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const copied = project(selectedSites, {
        site_id: selectedSites.columns.site_id,
      });
      const copyInsert = onConflictDoNothing(
        insertFromQuery(schema.site_identities, ["site_id"], copied),
        ["site_id"],
      );
      executeRun(db, compileD1Mutation(copyInsert));
      executeRun(
        db,
        compileD1Mutation(
          insertOrIgnore(schema.site_identities, { site_id: "site-a" }),
        ),
      );
      executeRun(
        db,
        compileD1Mutation(
          onConflictDoUpdate(
            insert(schema.site_identities, { site_id: "site-updated" }),
            ["site_id"],
            { site_id: "site-updated" },
          ),
        ),
      );

      const updatePlan = update(schema.site_identities, (columns) => ({
        set: { site_id: "site-renamed" },
        where: eq(columns.site_pk, param(2)),
      }));
      executeRun(db, compileD1Mutation(updatePlan));
      expect(
        db
          .prepare("SELECT site_id FROM site_identities WHERE site_pk = 2")
          .get(),
      ).toEqual({ site_id: "site-renamed" });

      const deletePlan = deleteFrom(schema.site_identities, (columns) =>
        eq(columns.site_pk, param(1)),
      );
      executeRun(db, compileD1Mutation(deletePlan));
      expect(
        db
          .prepare("SELECT site_id FROM site_identities WHERE site_pk = 1")
          .get(),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM site_identities").get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("executes searched CASE expressions in projections, functions, aggregates, and updates", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "site-a" }),
        ),
      );
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "site-b" }),
        ),
      );

      const sites = scan(schema.site_identities);
      const label = caseWhen(
        [
          {
            when: eq(sites.columns.site_id, param("site-a")),
            then: param("alpha"),
          },
          {
            when: eq(sites.columns.site_id, param("site-b")),
            then: param("beta"),
          },
        ],
        param("fallback"),
      );
      const nested = caseWhen(
        [
          {
            when: eq(sites.columns.site_id, param("site-a")),
            then: caseWhen(
              [
                {
                  when: isNotNull(sites.columns.site_id),
                  then: param("inner"),
                },
              ],
              param("inner-fallback"),
            ),
          },
        ],
        param("outer"),
      );
      const noElse = caseWhen([
        {
          when: eq(sites.columns.site_id, param("site-a")),
          then: param("only-a"),
        },
      ]);
      const functionArgument = callFunction(
        "lower",
        caseWhen(
          [
            {
              when: eq(sites.columns.site_id, param("site-a")),
              then: param("ALPHA"),
            },
          ],
          param("OTHER"),
        ),
      );
      const projection = project(sites, {
        site_id: sites.columns.site_id,
        label,
        no_else: noElse,
        nested,
        function_value: functionArgument,
      });
      const compiledProjection = compileD1Query(
        sort(projection, [
          { expression: projection.columns.site_id, direction: "ASC" },
        ]),
      );
      expect(compiledProjection.sql).toContain("CASE WHEN");
      expect(compiledProjection.sql).toContain("ELSE");
      expect(compiledProjection.bindings).toEqual([
        "site-a",
        "alpha",
        "site-b",
        "beta",
        "fallback",
        "site-a",
        "only-a",
        "site-a",
        "inner",
        "inner-fallback",
        "outer",
        "site-a",
        "ALPHA",
        "OTHER",
      ]);
      expect(executeAll(db, compiledProjection)).toEqual([
        {
          site_id: "site-a",
          label: "alpha",
          no_else: "only-a",
          nested: "inner",
          function_value: "alpha",
        },
        {
          site_id: "site-b",
          label: "beta",
          no_else: null,
          nested: "outer",
          function_value: "other",
        },
      ]);

      const totalMatched = aggregate(sites, {
        groupBy: {},
        aggregates: {
          matched: sum(
            caseWhen(
              [
                {
                  when: eq(sites.columns.site_id, param("site-a")),
                  then: param(1),
                },
              ],
              param(0),
            ),
          ),
        },
      });
      expect(executeAll(db, compileD1Query(totalMatched))).toEqual([
        { matched: 1 },
      ]);

      const updateStatement = compileD1Mutation(
        update(schema.site_identities, (columns) => ({
          set: {
            site_id: caseWhen(
              [
                {
                  when: eq(columns.site_id, param("site-a")),
                  then: param("site-renamed"),
                },
              ],
              columns.site_id,
            ),
          },
          where: eq(columns.site_id, param("site-a")),
        })),
      );
      expect(updateStatement.bindings).toEqual([
        "site-a",
        "site-renamed",
        "site-a",
      ]);
      executeRun(db, updateStatement);
      const renamedSites = scan(schema.site_identities);
      const renamed = compileD1Query(
        project(renamedSites, { site_id: renamedSites.columns.site_id }),
      );
      expect(executeAll(db, renamed)).toContainEqual({
        site_id: "site-renamed",
      });
    } finally {
      db.close();
    }
  });

  it("compiles and executes unixepoch in projections and mutations without binding it", () => {
    const db = createMigratedDatabase();
    try {
      const configs = scan(schema.configs);
      const clockProjection = compileD1Query(
        project(configs, { now: unixepoch() }),
      );
      expect(clockProjection.sql).toContain("unixepoch()");
      expect(clockProjection.bindings).toEqual([]);

      const insertPlan = insert(schema.configs, {
        config_key: "clock",
        value_json: "{}",
        created_at: unixepoch(),
        updated_at: unixepoch(),
      });
      const compiledInsert = compileD1Mutation(insertPlan);
      expect(compiledInsert.sql).toContain("unixepoch()");
      expect(compiledInsert.bindings).toEqual(["clock", "{}"]);
      executeRun(db, compiledInsert);

      const updatePlan = update(schema.configs, (columns) => ({
        set: { updated_at: unixepoch() },
        where: eq(columns.config_key, param("clock")),
      }));
      const compiledUpdate = compileD1Mutation(updatePlan);
      expect(compiledUpdate.sql).toContain('"updated_at" = unixepoch()');
      executeRun(db, compiledUpdate);

      const upsert = onConflictDoUpdate(
        insert(schema.configs, {
          config_key: "clock",
          value_json: '{"updated":true}',
        }),
        ["config_key"],
        {
          value_json: '{"updated":true}',
          updated_at: unixepoch(),
        },
      );
      const compiledUpsert = compileD1Mutation(upsert);
      expect(compiledUpsert.sql).toContain("unixepoch()");
      expect(compiledUpsert.bindings).toEqual([
        "clock",
        '{"updated":true}',
        '{"updated":true}',
      ]);
      executeRun(db, compiledUpsert);
      expect(
        db
          .prepare("SELECT value_json FROM configs WHERE config_key = ?")
          .get("clock"),
      ).toEqual({ value_json: '{"updated":true}' });

      const currentTime = db.prepare("SELECT unixepoch() AS now").get() as {
        now: number;
      };
      expect(
        db
          .prepare("SELECT updated_at FROM configs WHERE config_key = ?")
          .get("clock"),
      ).toEqual({ updated_at: currentTime.now });
    } finally {
      db.close();
    }
  });

  it("preserves compiled mutation order at the typed client batch boundary", async () => {
    const first = compileD1Mutation(
      insert(schema.site_identities, { site_id: "first" }),
    );
    const second = compileD1Mutation(
      insert(schema.site_identities, { site_id: "second" }),
    );
    const batch = vi.fn(async () => [] as D1Result[]);
    const runtime = { batch } as unknown as DatabaseRuntime;
    await createDatabaseClient(runtime).batch([first, second]);
    expect(batch).toHaveBeenCalledExactlyOnceWith([first, second]);
  });

  it("dispatches typed reads and writes through the unchanged runtime", async () => {
    const result = {
      success: true,
      results: [{ email: "user@example.test" }],
    } as D1Result<{ email: string }>;
    const users = scan(schema.users);
    const query = compileD1Query(
      project(users, { email: users.columns.email }),
    );
    const mutation = compileD1Mutation(
      insert(schema.site_identities, { site_id: "site-a" }),
    );
    const runtime = {
      all: vi.fn(async () => result),
      first: vi.fn(async () => result.results[0] ?? null),
      run: vi.fn(async () => result),
      batch: vi.fn(async () => [result]),
      exec: vi.fn(),
    } as unknown as DatabaseRuntime;
    const client = createDatabaseClient(runtime);

    await expect(client.all(query)).resolves.toBe(result);
    await expect(client.first(query)).resolves.toBe(result.results[0]);
    await expect(client.run(mutation)).resolves.toBe(result);
    expect(runtime.all).toHaveBeenCalledExactlyOnceWith(query);
    expect(runtime.first).toHaveBeenCalledExactlyOnceWith(query);
    expect(runtime.run).toHaveBeenCalledExactlyOnceWith(mutation);
  });

  it("compiles multi-row and default-value inserts and rejects inconsistent rows", () => {
    const multiple = compileD1Mutation(
      insert(schema.site_identities, [
        { site_id: "site-a" },
        { site_id: "site-b" },
      ]),
    );
    expect(multiple.sql).toContain("VALUES (?), (?)");
    expect(multiple.bindings).toEqual(["site-a", "site-b"]);

    const defaults = compileD1Mutation(
      insert(schema.site_identities, {} as never),
    );
    expect(defaults.sql).toContain("DEFAULT VALUES");

    expect(() => insert(schema.site_identities, [] as never)).toThrowError();
    expect(() =>
      insert(schema.site_identities, [
        { site_id: "a" },
        { site_id: "b", site_pk: 2 },
      ] as never),
    ).toThrowError();
    expect(() =>
      insert(schema.site_identities, { site_id: "a", missing: "b" } as never),
    ).toThrowError();
  });

  it("rejects references that do not come from the generated catalog", () => {
    const forged = { ...schema.site_identities };
    expect(() =>
      compileD1Query(scan(forged as typeof schema.site_identities)),
    ).toThrowError(expect.objectContaining({ code: "invalid_plan" }));
  });
});
