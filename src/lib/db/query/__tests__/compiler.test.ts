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
  count,
  countDistinct,
  D1StatementBudgetError,
  deleteFrom,
  distinct,
  eq,
  excluded,
  filter,
  gt,
  inList,
  insert,
  insertFromQuery,
  insertOrIgnore,
  inSubquery,
  isNotNull,
  join,
  limit,
  lowerLogicalPlan,
  max,
  not,
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
import {
  compileD1Expression,
  compileD1QueryUnoptimizedForTest,
} from "@/lib/db/query/compiler";
import type { Relation } from "@/lib/db/query/plan";
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

  it("shares only repeated closed filtered relations and preserves row semantics", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, [
            { site_id: "site-a" },
            { site_id: "site-b" },
          ]),
        ),
      );

      const sites = scan(schema.site_identities);
      const selected = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const repeatedUnion = union(selected, selected, true);
      const physical = lowerLogicalPlan(repeatedUnion);
      expect(physical.sharedRelations).toHaveLength(1);
      expect(physical.sharedRelations[0]?.dependencies).toEqual([]);

      const query = compileD1Query(repeatedUnion);
      expect(query.sql).toContain('WITH "_d1_shared_0" AS (');
      expect(query.bindings).toEqual(["site-a"]);
      expect(compileD1Query(physical)).toEqual(query);
      expect(executeAll(db, query)).toEqual([
        { site_pk: 1, site_id: "site-a" },
        { site_pk: 1, site_id: "site-a" },
      ]);
      const unoptimized = compileD1QueryUnoptimizedForTest(repeatedUnion);
      expect(unoptimized.sql).not.toContain("WITH ");
      expect(unoptimized.bindings).toEqual(["site-a", "site-a"]);
      expect(executeAll(db, unoptimized)).toEqual(executeAll(db, query));

      const forged = { ...physical, sharedRelations: [] };
      expect(() => compileD1Query(forged)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );

      const separateLeft = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const separateRight = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const equivalentButDistinct = compileD1Query(
        union(separateLeft, separateRight, true),
      );
      expect(equivalentButDistinct.sql).not.toContain("WITH ");
      expect(equivalentButDistinct.bindings).toEqual(["site-a", "site-a"]);

      const siteA = filter(sites, eq(sites.columns.site_id, param("site-a")));
      const siteB = filter(sites, eq(sites.columns.site_id, param("site-b")));
      const separateParameters = compileD1Query(union(siteA, siteB, true));
      expect(separateParameters.sql).not.toContain("WITH ");
      expect(separateParameters.bindings).toEqual(["site-a", "site-b"]);
      expect(executeAll(db, separateParameters)).toEqual([
        { site_pk: 1, site_id: "site-a" },
        { site_pk: 2, site_id: "site-b" },
      ]);

      expect(compileD1Query(union(sites, sites, true)).sql).not.toContain(
        "WITH ",
      );
      const renamedFullScan = project(sites, {
        renamed_site_id: sites.columns.site_id,
      });
      expect(
        compileD1Query(union(renamedFullScan, renamedFullScan, true)).sql,
      ).not.toContain("WITH ");

      const correlatedRows = scan(schema.site_identities);
      const correlatedMatch = filter(
        correlatedRows,
        eq(correlatedRows.columns.site_id, sites.columns.site_id),
      );
      const correlatedTwice = compileD1Query(
        project(sites, {
          site_id: sites.columns.site_id,
          first_match: scalar(
            project(correlatedMatch, {
              site_pk: correlatedMatch.columns.site_pk,
            }),
          ),
          second_match: scalar(
            project(correlatedMatch, {
              site_pk: correlatedMatch.columns.site_pk,
            }),
          ),
        }),
      );
      expect(correlatedTwice.sql).not.toContain("WITH ");
      expect(executeAll(db, correlatedTwice)).toEqual([
        { site_id: "site-a", first_match: 1, second_match: 1 },
        { site_id: "site-b", first_match: 2, second_match: 2 },
      ]);

      const inner = filter(sites, eq(sites.columns.site_id, param("site-a")));
      const sharedDependency = union(inner, inner, true);
      const nestedShares = union(sharedDependency, sharedDependency, true);
      const nestedPhysical = lowerLogicalPlan(nestedShares);
      expect(
        nestedPhysical.sharedRelations.map(({ name, dependencies }) => ({
          name,
          dependencies,
        })),
      ).toEqual([
        { name: "_d1_shared_0", dependencies: [] },
        { name: "_d1_shared_1", dependencies: ["_d1_shared_0"] },
      ]);
      const nestedQuery = compileD1Query(nestedShares);
      expect(nestedQuery.bindings).toEqual(["site-a"]);
      expect(executeAll(db, nestedQuery)).toHaveLength(4);

      const selectedWithNull = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const nullProjection = project(selectedWithNull, { value: param(null) });
      const repeatedNulls = compileD1Query(
        union(nullProjection, nullProjection, true),
      );
      expect(repeatedNulls.sql).toContain("WITH ");
      expect(executeAll(db, repeatedNulls)).toEqual([
        { value: null },
        { value: null },
      ]);

      const selectedForMembership = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const matching = semiJoin(
        sites,
        selectedForMembership,
        eq(sites.columns.site_pk, selectedForMembership.columns.site_pk),
      );
      const unmatched = antiJoin(
        sites,
        selectedForMembership,
        eq(sites.columns.site_pk, selectedForMembership.columns.site_pk),
      );
      const matchingCount = aggregate(matching, {
        groupBy: {},
        aggregates: { rows: count() },
      });
      const unmatchedCount = aggregate(unmatched, {
        groupBy: {},
        aggregates: { rows: count() },
      });
      const membershipCounts = join(
        matchingCount,
        unmatchedCount,
        eq(param(1), param(1)),
      );
      const membershipQuery = compileD1Query(membershipCounts);
      expect(membershipQuery.sql).toContain('"_d1_shared_0"');
      expect(membershipQuery.bindings).toEqual(["site-a", 1, 1]);
      expect(executeAll(db, membershipQuery)).toEqual([
        { left_rows: 1, right_rows: 1 },
      ]);

      const missing = filter(
        sites,
        eq(sites.columns.site_id, param("missing")),
      );
      const emptyCount = aggregate(missing, {
        groupBy: {},
        aggregates: { rows: count() },
      });
      const repeatedEmptyCount = join(
        emptyCount,
        emptyCount,
        eq(param(1), param(1)),
      );
      expect(compileD1Query(repeatedEmptyCount).sql).toContain("WITH ");
      expect(executeAll(db, compileD1Query(repeatedEmptyCount))).toEqual([
        { left_rows: 0, right_rows: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("enforces the common binding budget for query and mutation compilation", () => {
    const sites = scan(schema.site_identities);
    const projections = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `value_${index}`,
        param("private-value"),
      ]),
    );

    try {
      compileD1Query(project(sites, projections), { tag: "query.budget" });
      throw new Error("expected query budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(D1StatementBudgetError);
      expect(error).toMatchObject({
        code: "d1_statement_budget_exceeded",
        item: "bindings",
        actual: 101,
        limit: 100,
        tag: "query.budget",
      });
      expect((error as Error).message).not.toContain("private-value");
    }
    expect(() =>
      compileD1QueryUnoptimizedForTest(project(sites, projections)),
    ).toThrowError(D1StatementBudgetError);

    try {
      compileD1Mutation(
        insert(
          schema.site_identities,
          Array.from({ length: 101 }, (_, index) => ({
            site_id: `site-${index}`,
          })),
        ),
        { tag: "mutation.budget" },
      );
      throw new Error("expected mutation budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(D1StatementBudgetError);
      expect(error).toMatchObject({
        code: "d1_statement_budget_exceeded",
        item: "bindings",
        actual: 101,
        limit: 100,
        tag: "mutation.budget",
      });
    }

    const sourceSites = scan(schema.site_identities);
    const filteredSourceSites = filter(
      sourceSites,
      inList(
        sourceSites.columns.site_id,
        Array.from(
          { length: 101 },
          (_, index) => `site-${index}-${"x".repeat(10_000)}`,
        ),
      ),
    );
    const source = project(filteredSourceSites, {
      site_id: filteredSourceSites.columns.site_id,
    });
    try {
      compileD1Mutation(
        insertFromQuery(schema.site_identities, ["site_id"], source),
        { tag: "mutation.query.budget" },
      );
      throw new Error("expected insert-from-query budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(D1StatementBudgetError);
      expect(error).toMatchObject({
        item: "bindings",
        actual: 101,
        limit: 100,
        tag: "mutation.query.budget",
      });
    }
  });

  it("packs safe text membership from final query binding costs", () => {
    const db = createMigratedDatabase();
    try {
      const specialValues = [
        "match",
        "",
        'quote"value',
        "back\\slash",
        "nul\u0000value",
        "中文🙂",
        "01",
        "1",
        "1.0",
        "1e0",
      ];
      const values = [
        ...specialValues,
        ...Array.from({ length: 118 }, (_, index) => `distractor-${index}`),
      ];
      values[73] = "match";
      expect(values).toHaveLength(128);
      for (const value of specialValues)
        db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
          value,
        );

      const sites = scan(schema.site_identities);
      const nativeSql = `SELECT site_id FROM site_identities WHERE site_id IN (${values.map(() => "?").join(",")})`;
      const matchedRows = filter(sites, inList(sites.columns.site_id, values));
      const matched = project(matchedRows, {
        site_id: matchedRows.columns.site_id,
      });
      const packed = compileD1Query(matched);
      expect(packed.bindings).toEqual([JSON.stringify(values)]);
      expect(packed.sql).toContain("json_each(?)");
      expect(new TextEncoder().encode(packed.sql).byteLength).toBeLessThan(
        100_000,
      );
      const packedExplain = executeAll(db, {
        sql: `EXPLAIN QUERY PLAN ${packed.sql}`,
        bindings: packed.bindings,
      });
      const nativeExplain = executeAll(db, {
        sql: `EXPLAIN QUERY PLAN ${nativeSql}`,
        bindings: values,
      });
      const usesSiteIdentityIndex = (plan: Array<Record<string, unknown>>) =>
        plan.some(
          (row) =>
            typeof row.detail === "string" &&
            row.detail.includes("sqlite_autoindex_site_identities_1"),
        );
      expect(usesSiteIdentityIndex(nativeExplain)).toBe(true);
      expect(usesSiteIdentityIndex(packedExplain)).toBe(true);

      const nativeOracle = db
        .prepare(nativeSql)
        .all(...(values as SQLInputValue[])) as Array<{ site_id: string }>;
      const actual = executeAll(db, packed).map((row) => row.site_id);
      expect(actual.sort()).toEqual(
        nativeOracle.map((row) => row.site_id).sort(),
      );
      expect(actual).toHaveLength(specialValues.length);

      const exactOneValues = [
        "1",
        ...Array.from({ length: 127 }, (_, index) => `one-miss-${index}`),
      ];
      const exactOneQuery = compileD1Query(
        filter(sites, inList(sites.columns.site_id, exactOneValues)),
      );
      const exactOneNativeOracle = db
        .prepare(
          `SELECT site_id FROM site_identities WHERE site_id IN (${exactOneValues.map(() => "?").join(",")})`,
        )
        .all(...(exactOneValues as SQLInputValue[])) as Array<{
        site_id: string;
      }>;
      const exactOnePackedRows = executeAll(db, exactOneQuery).map(
        (row) => row.site_id,
      );
      expect(exactOneQuery.sql).toContain("json_each(?)");
      expect(exactOnePackedRows).toEqual(
        exactOneNativeOracle.map((row) => row.site_id),
      );
      expect(exactOnePackedRows).toEqual(["1"]);
      expect(exactOnePackedRows).not.toContain("01");
      expect(exactOnePackedRows).not.toContain("1.0");
      expect(exactOnePackedRows).not.toContain("1e0");

      const insertFromQueryStatement = compileD1Mutation(
        insertFromQuery(schema.site_identities, ["site_id"], matched),
      );
      expect(insertFromQueryStatement.sql).toContain("json_each(?)");
      expect(insertFromQueryStatement.bindings).toEqual(packed.bindings);

      const small = compileD1Query(
        filter(sites, inList(sites.columns.site_id, ["match", "missing"])),
      );
      expect(small.sql).not.toContain("json_each");
      expect(small.bindings).toEqual(["match", "missing"]);
      const emptyMembership = compileD1Query(
        filter(sites, inList(sites.columns.site_id, [])),
      );
      expect(emptyMembership.sql).toContain("(0)");
      expect(emptyMembership.bindings).toEqual([]);

      const nullableTable = schema.account_action_tokens;
      for (const [id, email] of [
        ["null-email", null],
        ["outside-email", "outside"],
        ["inside-email", "inside"],
      ] as const)
        db.prepare(
          "INSERT INTO account_action_tokens (id, type, token_hash, email, expires_at) VALUES (?, 'team_invite', ?, ?, 2000000000)",
        ).run(id, `hash-${id}`, email);
      const nullableTokens = scan(nullableTable);
      const nullableValues = [
        "inside",
        ...Array.from({ length: 127 }, (_, index) => `email-${index}`),
      ];
      const nullableOutside = filter(
        nullableTokens,
        not(inList(nullableTokens.columns.email, nullableValues)),
      );
      const notIn = compileD1Query(
        project(nullableOutside, { id: nullableOutside.columns.id }),
      );
      expect(notIn.sql).toContain("NOT (");
      expect(notIn.sql).toContain("json_each(?)");
      expect(notIn.bindings).toEqual([JSON.stringify(nullableValues)]);
      expect(executeAll(db, notIn)).toEqual([{ id: "outside-email" }]);

      const listA = values.slice(0, 40);
      const listB = values.slice(40, 70);
      const listBHit = values[45]!;
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        listBHit,
      );
      const repeatedMembership = inList(sites.columns.site_id, listA);
      const multiList = compileD1Query(
        project(sites, {
          site_id: sites.columns.site_id,
          first: not(repeatedMembership),
          repeated: not(repeatedMembership),
          distinct: not(inList(sites.columns.site_id, listB)),
        }),
      );
      const multiListBindings = multiList.bindings ?? [];
      expect(multiListBindings).toHaveLength(32);
      expect(multiListBindings.slice(0, 2)).toEqual([
        JSON.stringify(listA),
        JSON.stringify(listA),
      ]);
      expect(multiListBindings.slice(2)).toEqual(listB);
      const multiListRows = executeAll(db, multiList);
      expect(multiListRows).toHaveLength(specialValues.length + 1);
      const nativeMultiListSql = `SELECT site_id, NOT (site_id IN (${listA.map(() => "?").join(",")})) AS first, NOT (site_id IN (${listA.map(() => "?").join(",")})) AS repeated, NOT (site_id IN (${listB.map(() => "?").join(",")})) AS "distinct" FROM site_identities`;
      const nativeMultiListRows = db
        .prepare(nativeMultiListSql)
        .all(...([...listA, ...listA, ...listB] as SQLInputValue[])) as Array<{
        site_id: string;
        first: number;
        repeated: number;
        distinct: number;
      }>;
      const normalizedMultiListRows = (rows: Array<Record<string, unknown>>) =>
        rows
          .map((row) => ({
            site_id: String(row.site_id),
            first: Number(row.first),
            repeated: Number(row.repeated),
            distinct: Number(row.distinct),
          }))
          .sort((left, right) => left.site_id.localeCompare(right.site_id));
      expect(normalizedMultiListRows(multiListRows)).toEqual(
        normalizedMultiListRows(nativeMultiListRows),
      );
      expect(
        multiListRows.find((row) => row.site_id === listBHit)?.distinct,
      ).toBe(0);

      const hundredNative = compileD1Query(
        filter(
          sites,
          inList(
            sites.columns.site_id,
            Array.from({ length: 100 }, (_, index) => `native-${index}`),
          ),
        ),
      );
      expect(hundredNative.bindings).toHaveLength(100);
      expect(hundredNative.sql).not.toContain("json_each");

      const numericSites = scan(schema.visits);
      expect(() =>
        compileD1Query(
          filter(
            numericSites,
            inList(
              numericSites.columns.started_at,
              Array.from({ length: 101 }, (_, index) => index),
            ),
          ),
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "d1_statement_budget_exceeded",
          item: "bindings",
          actual: 101,
        }),
      );

      const mixedList = compileD1Query(
        filter(sites, inList(sites.columns.site_id, ["text", 1] as never)),
      );
      expect(mixedList.sql).not.toContain("json_each");
      expect(mixedList.bindings).toEqual(["text", 1]);

      const unsafeMembershipLists: readonly {
        readonly name: string;
        readonly values: readonly unknown[];
      }[] = [
        {
          name: "mixed text and number",
          values: [
            ...Array.from({ length: 100 }, (_, index) => `mixed-${index}`),
            1,
          ],
        },
        {
          name: "NULL member",
          values: [
            ...Array.from({ length: 100 }, (_, index) => `null-${index}`),
            null,
          ],
        },
        {
          name: "ill-formed surrogate",
          values: [
            String.fromCharCode(0xd800),
            ...Array.from({ length: 100 }, (_, index) => `surrogate-${index}`),
          ],
        },
      ];
      for (const unsafe of unsafeMembershipLists) {
        expect(
          () =>
            compileD1Query(
              filter(
                sites,
                inList(sites.columns.site_id, unsafe.values as never),
              ),
            ),
          unsafe.name,
        ).toThrowError(
          expect.objectContaining({
            code: "d1_statement_budget_exceeded",
            item: "bindings",
            actual: 101,
          }),
        );
      }

      const malformedLowSurrogate = String.fromCharCode(0xdc00);
      const unsafeHighSavingValues = [
        malformedLowSurrogate,
        ...Array.from({ length: 98 }, (_, index) => `low-surrogate-${index}`),
      ];
      const safeFollowupValues = [
        "safe-followup-a",
        "safe-followup-b",
        "safe-followup-c",
      ];
      const skipsUnsafeMembership = compileD1Query(
        filter(
          sites,
          and(
            inList(sites.columns.site_id, unsafeHighSavingValues),
            inList(sites.columns.site_id, safeFollowupValues),
          ),
        ),
      );
      expect(skipsUnsafeMembership.bindings).toHaveLength(100);
      expect(skipsUnsafeMembership.bindings).toContain(malformedLowSurrogate);
      expect(skipsUnsafeMembership.bindings).toContain(
        JSON.stringify(safeFollowupValues),
      );
      expect(skipsUnsafeMembership.sql.match(/json_each\(\?\)/gu)).toHaveLength(
        1,
      );

      const selected = filter(sites, inList(sites.columns.site_id, values));
      const repeated = union(selected, selected, true);
      const withTailParameter = project(repeated, {
        site_id: repeated.columns.site_id,
        marker: param("tail"),
      });
      const cteQuery = compileD1Query(withTailParameter);
      expect(cteQuery.sql.match(/_d1_shared_\d+/g)).not.toBeNull();
      expect(cteQuery.bindings).toEqual([JSON.stringify(values), "tail"]);
      expect(executeAll(db, cteQuery)).toHaveLength(
        (specialValues.length + 1) * 2,
      );

      const nested = compileD1Query(
        filter(
          sites,
          and(
            inList(sites.columns.site_id, values),
            eq(sites.columns.site_id, param("match")),
          ),
        ),
      );
      expect(nested.bindings).toEqual([JSON.stringify(values), "match"]);
      const nestedNativeSql = `SELECT site_id FROM site_identities WHERE site_id IN (${values.map(() => "?").join(",")}) AND site_id = ?`;
      const nestedNativeOracle = db
        .prepare(nestedNativeSql)
        .all(...([...values, "match"] as SQLInputValue[])) as Array<{
        site_id: string;
      }>;
      const nestedActual = executeAll(db, nested).map((row) => row.site_id);
      expect(nestedActual).toEqual(
        nestedNativeOracle.map((row) => row.site_id),
      );
      expect(nestedActual).toEqual(["match"]);

      const malformedSurrogate = String.fromCharCode(0xd800);
      const unchangedMalformed = compileD1Query(
        filter(
          sites,
          inList(sites.columns.site_id, [malformedSurrogate, "ordinary"]),
        ),
      );
      expect(unchangedMalformed.sql).not.toContain("json_each");
      expect(unchangedMalformed.bindings).toEqual([
        malformedSurrogate,
        "ordinary",
      ]);

      const forgedRelation = filter(
        sites,
        inList(sites.columns.site_id, values),
      );
      const physical = lowerLogicalPlan(forgedRelation);
      if (physical.root.kind !== "filter")
        throw new Error("expected a filter physical root");
      const jsonText = JSON.stringify(values);
      const jsonUtf8Bytes = new TextEncoder().encode(jsonText).byteLength;
      const validPhysicalWithMetadata = {
        ...physical,
        membershipOptimization: {
          nativeBindingCount: 128,
          selectedBindingCount: 1,
          strategies: [
            {
              expression: physical.root.predicate as Extract<
                typeof physical.root.predicate,
                { kind: "in-list" }
              >,
              occurrences: 1,
              strategy: "json-text" as const,
              jsonText,
              jsonUtf8Bytes,
              nativeBindingsSaved: 127,
            },
          ],
        },
      };
      expect(compileD1Query(validPhysicalWithMetadata)).toEqual(
        compileD1Query(forgedRelation),
      );
      const forged = {
        ...physical,
        membershipOptimization: {
          nativeBindingCount: 128,
          selectedBindingCount: 1,
          strategies: [
            {
              expression: physical.root.predicate as Extract<
                typeof physical.root.predicate,
                { kind: "in-list" }
              >,
              occurrences: 1,
              strategy: "json-text" as const,
              jsonText: '["forged"]',
              jsonUtf8Bytes: 10,
              nativeBindingsSaved: 127,
            },
          ],
        },
      };
      expect(() => compileD1Query(forged)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );

      const forgedCost = {
        ...forged,
        membershipOptimization: {
          ...forged.membershipOptimization,
          nativeBindingCount: 129,
          strategies: [
            {
              ...forged.membershipOptimization.strategies[0]!,
              jsonText,
              jsonUtf8Bytes,
            },
          ],
        },
      };
      expect(() => compileD1Query(forgedCost)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );

      const oversizedPayloadValues = [
        "x".repeat(999_696),
        ...Array.from({ length: 100 }, () => ""),
      ];
      const boundaryQuery = compileD1Query(
        filter(sites, inList(sites.columns.site_id, oversizedPayloadValues)),
      );
      expect(boundaryQuery.bindings ?? []).toHaveLength(1);
      expect(
        new TextEncoder().encode((boundaryQuery.bindings ?? [])[0] as string)
          .byteLength,
      ).toBe(1_000_000);

      const overBoundaryValues = [
        "x".repeat(999_697),
        ...Array.from({ length: 100 }, () => ""),
      ];
      expect(() =>
        compileD1Query(
          filter(sites, inList(sites.columns.site_id, overBoundaryValues)),
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "d1_statement_budget_exceeded",
          item: "bindings",
          actual: 101,
        }),
      );
    } finally {
      db.close();
    }
  });

  it("does not hoist relations across subquery, sort, or limit boundaries", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, [
            { site_id: "site-a" },
            { site_id: "site-b" },
          ]),
        ),
      );
      const sites = scan(schema.site_identities);
      const selected = filter(
        sites,
        inList(sites.columns.site_id, ["site-a", "site-b"]),
      );
      const assertNoHoistAndCompare = (relation: Relation<object>) => {
        expect(lowerLogicalPlan(relation).sharedRelations).toEqual([]);
        const optimized = compileD1Query(relation);
        const mechanical = compileD1QueryUnoptimizedForTest(relation);
        expect(optimized.sql).not.toContain("WITH ");
        expect(executeAll(db, optimized)).toEqual(executeAll(db, mechanical));
      };

      const firstScalarSource = project(selected, {
        site_id: selected.columns.site_id,
      });
      const secondScalarSource = project(selected, {
        site_id: selected.columns.site_id,
      });
      const repeatedScalars = project(sites, {
        site_id: sites.columns.site_id,
        first_match: scalar(firstScalarSource),
        second_match: scalar(secondScalarSource),
      });
      assertNoHoistAndCompare(repeatedScalars);
      expect(executeAll(db, compileD1Query(firstScalarSource))).toHaveLength(2);

      const firstInSource = project(selected, {
        site_id: selected.columns.site_id,
      });
      const secondInSource = project(selected, {
        site_id: selected.columns.site_id,
      });
      const repeatedInSubqueries = project(sites, {
        site_id: sites.columns.site_id,
        first_contains: inSubquery(sites.columns.site_id, firstInSource),
        second_contains: inSubquery(sites.columns.site_id, secondInSource),
      });
      assertNoHoistAndCompare(repeatedInSubqueries);

      const limited = union(limit(selected, 1), selected, true);
      assertNoHoistAndCompare(limited);

      const sorted = sort(selected, [
        { expression: selected.columns.site_id, direction: "DESC" },
      ]);
      const sortedAndUnsorted = union(sorted, selected, true);
      assertNoHoistAndCompare(sortedAndUnsorted);
    } finally {
      db.close();
    }
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
