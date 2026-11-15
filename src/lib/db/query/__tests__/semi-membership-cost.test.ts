import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  and,
  antiJoin,
  callFunction,
  compileD1Query,
  constant,
  eq,
  filter,
  gt,
  lowerLogicalPlan,
  lt,
  param,
  project,
  rowNumber,
  scan,
  semiJoin,
  union,
  window,
} from "@/lib/db";
import {
  compileD1QuerySemiMembershipFallbackForTest,
  compileD1QuerySemiMembershipForceSafeForTest,
  compileD1QueryUnoptimizedForTest,
} from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import { semiMembershipCostSelections } from "@/lib/db/query/physical/semi-membership-cost";
import { validatePhysicalQueryPlan } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type {
  SchemaIndexReference,
  SchemaTableReference,
} from "@/lib/db/schema/types";

type TestRelation = Relation<
  Record<string, unknown>,
  Readonly<Record<string, AnyExpression>>
>;

const registeredTables = new Set<string>();

function catalogTable(
  name: string,
  indexes: readonly SchemaIndexReference[] = [
    {
      name: `${name}_membership_binary_idx`,
      unique: false,
      columns: ["membership_key"],
      collations: ["BINARY"],
      partial: false,
    },
    {
      name: `${name}_lookup_unique_idx`,
      unique: true,
      columns: ["lookup_key"],
      collations: ["BINARY"],
      partial: false,
    },
  ],
): SchemaTableReference {
  const column = (
    sqlName: string,
    declaredType: string,
    affinity: "integer" | "text",
    nullable: boolean,
    primaryKeyPosition = 0,
    rowidAlias?: true,
  ) => ({
    kind: "column" as const,
    table: name,
    sqlName,
    propertyName: sqlName,
    declaredType,
    affinity,
    nullable,
    ...(rowidAlias ? { rowidAlias } : {}),
    primaryKeyPosition,
    defaultSql: null,
    hidden: 0,
    generated: false,
  });
  return {
    kind: "table",
    name,
    defaultCollation: "BINARY",
    columns: {
      id: column("id", "INTEGER", "integer", false, 1, true),
      membership_key: column("membership_key", "TEXT", "text", true),
      lookup_key: column("lookup_key", "TEXT", "text", false),
    },
    primaryKey: ["id"],
    indexes,
    foreignKeys: [],
  };
}

function relationFor(table: SchemaTableReference): TestRelation {
  const mutableSchema = schema as unknown as Record<string, unknown>;
  mutableSchema[table.name] = table;
  registeredTables.add(table.name);
  return scan(
    table as unknown as typeof schema.site_identities,
  ) as TestRelation;
}

function column(relation: TestRelation, name: string) {
  return (relation.columns as unknown as Record<string, unknown>)[
    name
  ] as never;
}

function rows(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as never[]))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

describe("Generic SemiJoin cost selection", () => {
  afterEach(() => {
    const mutableSchema = schema as unknown as Record<string, unknown>;
    for (const name of registeredTables)
      Reflect.deleteProperty(mutableSchema, name);
    registeredTables.clear();
  });

  it("proves nested membership and UNION DISTINCT inputs and indexes a licensed right boundary", () => {
    const source = relationFor(catalogTable("cost_materialized_membership"));
    const left = union(source, source, false);
    const nested = semiJoin(source, left, eq(param(1), param(1)));
    const right = filter(
      source,
      eq(column(source, "lookup_key"), param("target")),
    );
    const keys = project(right, {
      key: column(right as TestRelation, "membership_key"),
    });
    const query = semiJoin(
      nested,
      keys,
      eq(column(nested as TestRelation, "membership_key"), keys.columns.key),
    );
    const physical = lowerLogicalPlan(query);
    expect(physical.semiMembershipChoices).toHaveLength(1);
    const choice = physical.semiMembershipChoices[0]!;
    // Cost selection consumes the freshly licensed materialized stops from
    // totality analysis; engine integration covers their actual production.
    expect(
      semiMembershipCostSelections([
        { ...choice, materializedStops: [right.node] },
      ]),
    ).toMatchObject([
      { strategy: "in", reason: "selected-materialized-right-membership" },
    ]);
    expect(
      semiMembershipCostSelections([
        { ...choice, materializedStops: [nested.node] },
      ]),
    ).toMatchObject([{ strategy: "exists" }]);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE cost_materialized_membership(id INTEGER PRIMARY KEY, membership_key TEXT, lookup_key TEXT NOT NULL)",
      );
      const insert = db.prepare(
        "INSERT INTO cost_materialized_membership VALUES (?, ?, ?)",
      );
      for (const [index, key] of [
        "same",
        "same",
        "nul\0tail",
        new Uint8Array([97]),
        null,
      ].entries())
        insert.run(index + 1, key, String(index));
      insert.run(101, "same", "target");
      const optimized = compileD1QuerySemiMembershipForceSafeForTest(query);
      const fallback = compileD1QuerySemiMembershipFallbackForTest(query);
      expect(optimized.sql).toContain(" IN (SELECT ");
      expect(rows(db, optimized)).toEqual(rows(db, fallback));
      expect(rows(db, optimized)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("keeps an unsafe expression inside a nested membership behind EXISTS", () => {
    const source = relationFor(catalogTable("cost_nested_error"));
    const unsafe = project(source, {
      id: callFunction("abs", column(source, "id")),
      key: column(source, "membership_key"),
    });
    const nested = semiJoin(
      source,
      unsafe,
      eq(column(source, "id"), unsafe.columns.id),
    );
    const right = filter(
      source,
      eq(column(source, "lookup_key"), param("target")),
    );
    const candidate = semiJoin(
      nested,
      right,
      eq(
        column(nested as TestRelation, "membership_key"),
        column(right as TestRelation, "membership_key"),
      ),
    );
    expect(lowerLogicalPlan(candidate).semiMembershipChoices).toHaveLength(0);
    expect(
      compileD1QuerySemiMembershipForceSafeForTest(candidate).sql,
    ).not.toContain(" IN (SELECT ");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE cost_nested_error(id INTEGER PRIMARY KEY, membership_key TEXT, lookup_key TEXT NOT NULL);
        INSERT INTO cost_nested_error VALUES (-9223372036854775808, 'same', 'target')`);
      for (const compiled of [
        compileD1QuerySemiMembershipForceSafeForTest(candidate),
        compileD1QuerySemiMembershipFallbackForTest(candidate),
      ])
        expect(() => rows(db, compiled)).toThrow(/integer overflow/u);
    } finally {
      db.close();
    }
  });

  it("composes reordered project maps without mistaking a non-unique filter for a unique lookup", () => {
    const left = relationFor(catalogTable("cost_project_left"));
    const rightScan = relationFor(catalogTable("cost_project_right"));
    const inner = project(rightScan, {
      a: column(rightScan, "membership_key"),
      b: column(rightScan, "id"),
      c: column(rightScan, "lookup_key"),
    });
    const outer = project(inner, {
      x: inner.columns.a,
      y: inner.columns.c,
      z: inner.columns.b,
    });
    const nonUnique = filter(outer, eq(outer.columns.x, param("repeated")));
    const nonUniqueQuery = semiJoin(
      left,
      nonUnique,
      eq(column(left, "membership_key"), nonUnique.columns.y),
    );
    const nonUniquePlan = lowerLogicalPlan(nonUniqueQuery);
    expect(nonUniquePlan.semiMembershipChoices).toHaveLength(1);
    expect(nonUniquePlan.semiMembershipCostSelections).toMatchObject([
      {
        strategy: "exists",
        reason: "right-source-has-no-unique-point-lookup-proof",
      },
    ]);

    const unique = filter(outer, eq(outer.columns.y, param("one")));
    const uniqueQuery = semiJoin(
      left,
      unique,
      eq(column(left, "membership_key"), unique.columns.x),
    );
    expect(
      lowerLogicalPlan(uniqueQuery).semiMembershipCostSelections,
    ).toMatchObject([
      {
        strategy: "in",
        evidence: {
          right: { columnName: "lookup_key" },
          left: { keyColumns: ["membership_key"] },
        },
      },
    ]);

    const leftInner = project(left, {
      a: column(left, "membership_key"),
      b: column(left, "id"),
      c: column(left, "lookup_key"),
    });
    const leftOuter = project(leftInner, {
      x: leftInner.columns.a,
      y: leftInner.columns.c,
      z: leftInner.columns.b,
    });
    const reorderedLeft = semiJoin(
      leftOuter,
      unique,
      eq(leftOuter.columns.x, unique.columns.x),
    );
    expect(
      lowerLogicalPlan(reorderedLeft).semiMembershipCostSelections,
    ).toMatchObject([
      {
        strategy: "in",
        evidence: {
          left: {
            keyColumns: ["membership_key"],
            indexName: "cost_project_left_membership_binary_idx",
          },
        },
      },
    ]);

    const narrowLeft = project(left, { key: column(left, "membership_key") });
    const narrowQuery = semiJoin(
      narrowLeft,
      unique,
      eq(narrowLeft.columns.key, unique.columns.x),
    );
    expect(
      lowerLogicalPlan(narrowQuery).semiMembershipCostSelections,
    ).toMatchObject([
      {
        strategy: "in",
        evidence: { left: { keyColumns: ["membership_key"] } },
      },
    ]);
  });

  it("selects IN only for a unique right point lookup and an indexed full left scan", () => {
    const table = relationFor(catalogTable("wave97bm_cost_text_positive"));
    const left = scan(
      table.node.kind === "scan"
        ? (table.node.table as typeof schema.site_identities)
        : schema.site_identities,
    ) as TestRelation;
    const rightScan = relationFor(
      catalogTable("wave97bm_cost_text_positive_right"),
    );
    const right = filter(
      rightScan,
      eq(column(rightScan, "lookup_key"), param("selected")),
    );
    const candidate = semiJoin(
      left,
      right as unknown as TestRelation,
      eq(
        column(left, "membership_key"),
        column(right as unknown as TestRelation, "membership_key"),
      ),
    );
    const physical = lowerLogicalPlan(candidate);
    expect(physical.semiMembershipChoices).toHaveLength(1);
    expect(physical.semiMembershipCostSelections).toMatchObject([
      {
        strategy: "in",
        reason: "selected-unique-right-point-lookup-with-left-index",
        evidence: {
          left: {
            access: "binary-index",
            indexName: "wave97bm_cost_text_positive_membership_binary_idx",
            keyColumns: ["membership_key"],
          },
          right: {
            access: "unique-index",
            indexName: "wave97bm_cost_text_positive_right_lookup_unique_idx",
            columnName: "lookup_key",
            constraint: "parameter",
            valueClass: "text",
          },
        },
      },
    ]);
    const selected = compileD1Query(candidate);
    expect(selected.sql).toContain(" IN (SELECT ");
    const expanded = compileD1QueryUnoptimizedForTest(candidate);
    expect(expanded.sql).toContain("EXISTS (SELECT ");
    expect(expanded.sql).not.toContain(" IN (SELECT ");
    expect(selected.physicalPlanShape?.version).toBe(10);
    expect(validatePhysicalQueryPlan(physical)).toBeDefined();
  });

  it("keeps filtered-left candidates at EXISTS while force-safe remains differential", () => {
    const name = "wave97bm_cost_filtered_left";
    const table = catalogTable(name);
    const leftScan = relationFor(table);
    const rightScan = relationFor(table);
    const left = filter(leftScan, lt(column(leftScan, "id"), param(100)));
    const right = filter(
      rightScan,
      eq(column(rightScan, "lookup_key"), param("selected")),
    );
    const candidate = semiJoin(
      left as unknown as TestRelation,
      right as unknown as TestRelation,
      eq(
        column(left as unknown as TestRelation, "membership_key"),
        column(right as unknown as TestRelation, "membership_key"),
      ),
    );
    const physical = lowerLogicalPlan(candidate);
    expect(physical.semiMembershipCostSelections).toMatchObject([
      {
        strategy: "exists",
        reason: "left-source-is-not-an-unfiltered-catalog-scan",
      },
    ]);
    const defaultQuery = compileD1Query(candidate);
    const fallback = compileD1QuerySemiMembershipFallbackForTest(candidate);
    const forced = compileD1QuerySemiMembershipForceSafeForTest(candidate);
    expect(defaultQuery.sql).toContain("EXISTS (SELECT ");
    expect(defaultQuery.sql).not.toContain(" IN (SELECT ");
    expect(defaultQuery.sql).toBe(fallback.sql);
    expect(defaultQuery.bindings).toEqual(fallback.bindings);
    expect(defaultQuery.physicalPlanShape).toEqual(fallback.physicalPlanShape);
    expect(forced.sql).toContain(" IN (SELECT ");
    expect(forced.physicalPlanShape?.version).toBe(10);
  });

  it("retains the prior rowid64 selection and identical SQL shape", () => {
    const left = scan(schema.site_identities);
    const rightScan = scan(schema.site_identities);
    const right = filter(
      rightScan,
      eq(rightScan.columns.site_id, param("site-037")),
    );
    const candidate = semiJoin(
      left,
      right,
      eq(left.columns.site_pk, right.columns.site_pk),
    );
    const selected = compileD1Query(candidate);
    const fallback = compileD1QuerySemiMembershipFallbackForTest(candidate);
    expect(selected.sql).toContain(" IN (SELECT ");
    expect(selected.physicalPlanShape?.version).toBe(10);
    expect(selected.sql).toBe(
      'SELECT q1._c0 AS "site_pk", q1._c1 AS "site_id" FROM (SELECT l0.* FROM (SELECT t0."site_pk" AS _c0, t0."site_id" AS _c1 FROM "site_identities" AS t0) AS l0 WHERE (l0._c0) IN (SELECT r0._c0 FROM (SELECT q0.* FROM (SELECT t1."site_pk" AS _c0, t1."site_id" AS _c1 FROM "site_identities" AS t1) AS q0 WHERE (q0._c1 = ?)) AS r0)) AS q1',
    );
    expect(selected.bindings).toEqual(["site-037"]);
    expect(selected.physicalPlanShape).toMatchObject({
      version: 10,
      semiMembershipCount: 1,
      semiMemberships: [{ keyCount: 1, emissionCount: 1 }],
    });
    expect(fallback.sql).toContain("EXISTS (SELECT ");
  });

  it.each([
    {
      name: "non-unique RHS key",
      indexes: [
        {
          name: "left",
          unique: false,
          columns: ["membership_key"],
          collations: ["BINARY"],
          partial: false,
        },
        {
          name: "lookup",
          unique: false,
          columns: ["lookup_key"],
          collations: ["BINARY"],
          partial: false,
        },
      ],
      reason: "right-source-has-no-unique-point-lookup-proof",
    },
    {
      name: "missing left membership index",
      indexes: [
        {
          name: "lookup",
          unique: true,
          columns: ["lookup_key"],
          collations: ["BINARY"],
          partial: false,
        },
      ],
      reason: "left-membership-key-has-no-proven-index-access",
    },
    {
      name: "partial left membership index",
      indexes: [
        {
          name: "left",
          unique: false,
          columns: ["membership_key"],
          collations: ["BINARY"],
          partial: true,
        },
        {
          name: "lookup",
          unique: true,
          columns: ["lookup_key"],
          collations: ["BINARY"],
          partial: false,
        },
      ],
      reason: "left-membership-key-has-no-proven-index-access",
    },
    {
      name: "expression left membership index",
      indexes: [
        {
          name: "left",
          unique: false,
          columns: ["membership_key"],
          collations: ["BINARY"],
          partial: false,
          rawExpressionSql: "lower(membership_key)",
        },
        {
          name: "lookup",
          unique: true,
          columns: ["lookup_key"],
          collations: ["BINARY"],
          partial: false,
        },
      ],
      reason: "left-membership-key-has-no-proven-index-access",
    },
    {
      name: "non-BINARY left membership index",
      indexes: [
        {
          name: "left",
          unique: false,
          columns: ["membership_key"],
          collations: ["NOCASE"],
          partial: false,
        },
        {
          name: "lookup",
          unique: true,
          columns: ["lookup_key"],
          collations: ["BINARY"],
          partial: false,
        },
      ],
      reason: "left-membership-key-has-no-proven-index-access",
    },
  ] as const)("uses EXISTS for $name", ({ name, indexes, reason }) => {
    const table = relationFor(
      catalogTable(
        `wave97bm_cost_negative_${name.replaceAll(/[^a-z]+/giu, "_")}`,
        indexes,
      ),
    );
    const left = scan(
      (table.node as { kind: "scan"; table: SchemaTableReference })
        .table as typeof schema.site_identities,
    ) as TestRelation;
    const rightScan = scan(
      (table.node as { kind: "scan"; table: SchemaTableReference })
        .table as typeof schema.site_identities,
    ) as TestRelation;
    const right = filter(
      rightScan,
      eq(column(rightScan, "lookup_key"), param("selected")),
    );
    const candidate = semiJoin(
      left,
      right as unknown as TestRelation,
      eq(
        column(left, "membership_key"),
        column(right as unknown as TestRelation, "membership_key"),
      ),
    );
    const physical = lowerLogicalPlan(candidate);
    expect(physical.semiMembershipCostSelections).toMatchObject([
      { strategy: "exists", reason },
    ]);
    expect(compileD1Query(candidate).sql).toContain("EXISTS (SELECT ");
  });

  it("recomputes and rejects stale or forged cost-selection metadata", () => {
    const name = "wave97bm_cost_stale_index";
    const relation = relationFor(catalogTable(name));
    const left = scan(
      (relation.node as { kind: "scan"; table: SchemaTableReference })
        .table as typeof schema.site_identities,
    ) as TestRelation;
    const rightScan = scan(
      (relation.node as { kind: "scan"; table: SchemaTableReference })
        .table as typeof schema.site_identities,
    ) as TestRelation;
    const right = filter(
      rightScan,
      eq(column(rightScan, "lookup_key"), param("selected")),
    );
    const candidate = semiJoin(
      left,
      right as unknown as TestRelation,
      eq(
        column(left, "membership_key"),
        column(right as unknown as TestRelation, "membership_key"),
      ),
    );
    const physical = lowerLogicalPlan(candidate);
    expect(physical.semiMembershipCostSelections[0]?.strategy).toBe("in");
    const selected = physical.semiMembershipCostSelections[0]!;
    expect(() =>
      validatePhysicalQueryPlan({
        ...physical,
        semiMembershipCostSelections: [
          {
            ...selected,
            reason: "right-source-has-no-unique-point-lookup-proof",
          },
        ],
      }),
    ).toThrow(/semi membership cost selections/u);
    expect(() =>
      validatePhysicalQueryPlan({
        ...physical,
        semiMembershipCostSelections: [
          { ...selected, forged: true } as unknown as typeof selected,
        ],
      }),
    ).toThrow(/semi membership cost selections/u);

    const mutableTable = (
      relation.node as { kind: "scan"; table: SchemaTableReference }
    ).table as unknown as { indexes: readonly SchemaIndexReference[] };
    const originalIndexes = mutableTable.indexes;
    try {
      mutableTable.indexes = originalIndexes.filter(
        ({ name: indexName }) => indexName !== `${name}_membership_binary_idx`,
      );
      expect(() => validatePhysicalQueryPlan(physical)).toThrow(
        /semi membership cost selections/u,
      );
    } finally {
      mutableTable.indexes = originalIndexes;
    }
  });

  it("keeps nonmaterialized AntiJoin at NOT EXISTS despite catalog point lookup evidence", () => {
    const table = relationFor(catalogTable("wave97bm_cost_anti"));
    const scanTable = (
      table.node as { kind: "scan"; table: SchemaTableReference }
    ).table as typeof schema.site_identities;
    const left = scan(scanTable) as TestRelation;
    const rightScan = scan(scanTable) as TestRelation;
    const right = filter(
      rightScan,
      eq(column(rightScan, "lookup_key"), param("selected")),
    );
    const candidate = antiJoin(
      left,
      right as unknown as TestRelation,
      eq(
        column(left, "membership_key"),
        column(right as unknown as TestRelation, "membership_key"),
      ),
    );
    expect(
      lowerLogicalPlan(candidate).semiMembershipCostSelections,
    ).toMatchObject([
      { strategy: "exists", reason: "anti-source-is-not-materialized" },
    ]);
    expect(compileD1Query(candidate).sql).toContain("NOT EXISTS (SELECT ");
    expect(
      compileD1QuerySemiMembershipForceSafeForTest(candidate).sql,
    ).toContain(") IS NOT TRUE");
  });

  it("preserves composite anti membership NULLs, empty sets and duplicate left bags", () => {
    const name = "cost_anti_tuple";
    const table = catalogTable(name);
    const leftScan = relationFor(table);
    const rightScan = scan(
      table as typeof schema.site_identities,
    ) as TestRelation;
    const left = union(
      filter(leftScan, lt(column(leftScan, "id"), param(100))),
      filter(leftScan, lt(column(leftScan, "id"), param(100))),
      true,
    ) as TestRelation;
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE ${name}(id INTEGER PRIMARY KEY, membership_key TEXT COLLATE BINARY, lookup_key TEXT COLLATE BINARY NOT NULL)`,
      );
      const insert = db.prepare(`INSERT INTO ${name} VALUES (?, ?, ?)`);
      for (const [id, key, site] of [
        [1, "same", "a"],
        [2, "same", "b"],
        [3, null, "a"],
        [4, "nul\0tail", "a"],
        [5, new Uint8Array([0, 255]), "a"],
        [6, "missing", "a"],
        [101, "same", "a"],
        [102, null, "a"],
        [103, "nul\0tail", "a"],
        [104, new Uint8Array([0, 255]), "a"],
      ] as const)
        insert.run(id, key, site);
      for (const threshold of [100, 1000]) {
        const right = filter(
          rightScan,
          gt(column(rightScan, "id"), param(threshold)),
        ) as TestRelation;
        const candidate = antiJoin(
          left,
          right,
          and(
            eq(column(left, "membership_key"), column(right, "membership_key")),
            eq(column(left, "lookup_key"), column(right, "lookup_key")),
          ),
        );
        const physical = lowerLogicalPlan(candidate);
        expect(physical.semiMembershipChoices).toHaveLength(1);
        const choice = physical.semiMembershipChoices[0]!;
        expect(
          semiMembershipCostSelections([
            { ...choice, materializedStops: [right.node] },
          ]),
        ).toMatchObject([
          { strategy: "in", reason: "selected-materialized-right-membership" },
        ]);
        const optimized =
          compileD1QuerySemiMembershipForceSafeForTest(candidate);
        const fallback = compileD1QuerySemiMembershipFallbackForTest(candidate);
        expect(optimized.sql).toContain(") IS NOT TRUE");
        expect(optimized.sql).not.toContain("NOT IN");
        expect(optimized.physicalPlanShape).toMatchObject({
          semiMembershipCount: 1,
          semiMemberships: [{ keyCount: 2, emissionCount: 1 }],
        });
        expect(fallback.physicalPlanShape).not.toHaveProperty(
          "semiMembershipCount",
        );
        expect(rows(db, optimized)).toEqual(rows(db, fallback));
        expect(rows(db, optimized).map((row) => row.id)).toEqual(
          threshold === 100
            ? [2, 2, 3, 3, 6, 6]
            : [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6],
        );
      }
    } finally {
      db.close();
    }
  });

  it("selects and freshly validates anti IN against an actual licensed materialized boundary", () => {
    const name = "cost_anti_licensed";
    const table = catalogTable(name);
    const left = relationFor(table);
    const rightScan = scan(
      table as typeof schema.site_identities,
    ) as TestRelation;
    const right = filter(
      rightScan,
      gt(column(rightScan, "id"), param(100)),
    ) as TestRelation;
    const ascending = window(right, {
      rank: rowNumber({
        orderBy: [{ expression: column(right, "id"), direction: "ASC" }],
      }),
    });
    const descending = window(right, {
      rank: rowNumber({
        orderBy: [{ expression: column(right, "id"), direction: "DESC" }],
      }),
    });
    const unmatched = antiJoin(
      left,
      right,
      eq(column(left, "membership_key"), column(right, "membership_key")),
    );
    const output = union(
      union(
        project(ascending, {
          branch: constant("window-a"),
          id: ascending.columns.id!,
        }),
        project(descending, {
          branch: constant("window-b"),
          id: descending.columns.id!,
        }),
        true,
      ),
      project(unmatched, {
        branch: constant("anti"),
        id: unmatched.columns.id!,
      }),
      true,
    );
    const physical = lowerLogicalPlan(output);
    expect(
      physical.sharedRelations.find(({ node }) => node === right.node),
    ).toMatchObject({ materialization: "materialized" });
    expect(physical.semiMembershipCostSelections).toMatchObject([
      { strategy: "in", reason: "selected-materialized-right-membership" },
    ]);
    expect(validatePhysicalQueryPlan(physical)).toBeDefined();
    const selected = physical.semiMembershipCostSelections[0]!;
    expect(() =>
      validatePhysicalQueryPlan({
        ...physical,
        semiMembershipCostSelections: [
          { ...selected, reason: "anti-source-is-not-materialized" },
        ],
      }),
    ).toThrow(/semi membership cost selections/u);
    const optimized = compileD1Query(physical);
    const fallback = compileD1QuerySemiMembershipFallbackForTest(physical);
    expect(optimized.sql).toContain(") IS NOT TRUE");
    expect(fallback.sql).toContain("NOT EXISTS (SELECT ");
    expect(optimized.physicalPlanShape).toMatchObject({
      semiMembershipCount: 1,
      semiMemberships: [{ keyCount: 1, emissionCount: 1 }],
    });
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE ${name}(id INTEGER PRIMARY KEY,membership_key TEXT,lookup_key TEXT NOT NULL); INSERT INTO ${name} VALUES(1,'hit','a'),(2,'miss','b'),(3,NULL,'c'),(101,'hit','d'),(102,NULL,'e')`,
      );
      expect(rows(db, optimized)).toEqual(rows(db, fallback));
      expect(
        rows(db, optimized)
          .filter((row) => row.branch === "anti")
          .map((row) => row.id)
          .sort((a, b) => Number(a) - Number(b)),
      ).toEqual([2, 3, 102]);
    } finally {
      db.close();
    }
  });

  it("retains anti error short-circuiting when an unvisited right expression can overflow", () => {
    const name = "cost_anti_partial";
    const table = catalogTable(name);
    const leftScan = relationFor(table);
    const rightScan = scan(
      table as typeof schema.site_identities,
    ) as TestRelation;
    const left = filter(
      leftScan,
      gt(column(leftScan, "id"), param(0)),
    ) as TestRelation;
    const right = project(rightScan, {
      key: callFunction("abs", column(rightScan, "id")),
    });
    const candidate = antiJoin(
      left,
      right,
      eq(column(left, "id"), right.columns.key),
    );
    expect(lowerLogicalPlan(candidate).semiMembershipChoices).toHaveLength(0);
    const optimized = compileD1QuerySemiMembershipForceSafeForTest(candidate);
    const fallback = compileD1QuerySemiMembershipFallbackForTest(candidate);
    expect(optimized.sql).not.toContain(" IS NOT TRUE");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE ${name}(id INTEGER PRIMARY KEY,membership_key TEXT,lookup_key TEXT NOT NULL);INSERT INTO ${name} VALUES(-9223372036854775808,'k','k')`,
      );
      expect(rows(db, optimized)).toEqual([]);
      expect(rows(db, optimized)).toEqual(rows(db, fallback));
    } finally {
      db.close();
    }
  });

  it("keeps BLOB, NULL, duplicate and NUL rows equivalent in the force-safe path", () => {
    const name = "wave97bm_cost_force_semantics";
    const table = catalogTable(name);
    const leftRelation = relationFor(table);
    const rightRelation = relationFor(table);
    const leftScan = scan(
      (leftRelation.node as { kind: "scan"; table: SchemaTableReference })
        .table as typeof schema.site_identities,
    ) as TestRelation;
    const rightScan = scan(
      (rightRelation.node as { kind: "scan"; table: SchemaTableReference })
        .table as typeof schema.site_identities,
    ) as TestRelation;
    const left = filter(leftScan, lt(column(leftScan, "id"), param(100)));
    const right = filter(
      rightScan,
      eq(column(rightScan, "lookup_key"), param("target")),
    );
    const candidate = semiJoin(
      left as unknown as TestRelation,
      right as unknown as TestRelation,
      eq(
        column(left as unknown as TestRelation, "membership_key"),
        column(right as unknown as TestRelation, "membership_key"),
      ),
    );
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, membership_key TEXT COLLATE BINARY, lookup_key TEXT COLLATE BINARY NOT NULL UNIQUE)`,
      );
      db.exec(
        `CREATE INDEX ${name}_membership_binary_idx ON ${name}(membership_key COLLATE BINARY)`,
      );
      const insert = db.prepare(
        `INSERT INTO ${name}(id, membership_key, lookup_key) VALUES (?, ?, ?)`,
      );
      insert.run(1, "same", "left-1");
      insert.run(2, "same", "left-2");
      insert.run(3, "nul\0tail", "left-nul");
      insert.run(4, new Uint8Array([0x61, 0x62]), "left-blob");
      insert.run(5, null, "left-null");
      insert.run(101, "same", "target");

      const defaultQuery = compileD1Query(candidate);
      const forced = compileD1QuerySemiMembershipForceSafeForTest(candidate);
      const fallback = compileD1QuerySemiMembershipFallbackForTest(candidate);
      expect(defaultQuery.sql).toBe(fallback.sql);
      expect(forced.sql).toContain(" IN (SELECT ");
      expect(rows(db, forced)).toEqual(rows(db, fallback));
      expect(rows(db, forced).map((row) => row.id)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });
});
