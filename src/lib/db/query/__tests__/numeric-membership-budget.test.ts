import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  add,
  and,
  compileD1Mutation,
  compileD1Query,
  D1StatementBudgetError,
  eq,
  filter,
  inList,
  insertFromQuery,
  inSubquery,
  join,
  lowerLogicalPlan,
  not,
  param,
  project,
  scan,
  union,
  valuesRelation,
} from "@/lib/db";
import { optimizePhysicalMembershipBudget } from "@/lib/db/query/physical-plan";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

function createDatabase(): DatabaseSync {
  const db = createMigratedDatabase();
  db.prepare(
    "INSERT INTO site_identities (site_pk, site_id) VALUES (1, 'site')",
  ).run();
  return db;
}

function insertVisit(
  db: DatabaseSync,
  id: string,
  duration: SQLInputValue,
): void {
  db.prepare(
    "INSERT INTO visits (visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at, duration_ms, pathname, hostname, site_pk) VALUES (?, 'site', ?, ?, 'closed', 1, 1, ?, '/', 'example.test', 1)",
  ).run(id, `visitor-${id}`, `session-${id}`, duration);
}

function executeAll(
  db: DatabaseSync,
  query: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]));
}

function normalizeTruthRows(
  rows: Array<Record<string, unknown>>,
): Array<{ id: string; included: number | null; excluded: number | null }> {
  return rows
    .map((row) => ({
      id: String(row.id),
      included: row.included === null ? null : Number(row.included),
      excluded: row.excluded === null ? null : Number(row.excluded),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function expectBindingBudgetError(run: () => unknown, actual: number) {
  expect(run).toThrowError(
    expect.objectContaining({
      code: "d1_statement_budget_exceeded",
      item: "bindings",
      actual,
      limit: 100,
    }),
  );
}

function projectWithAdditionalBindings(
  relation: Relation<object>,
  values: readonly number[],
  additionalBindings: number,
) {
  const selected = filter(
    relation,
    inList(relation.columns.duration_ms, values as never),
  );
  const projections: Record<string, never> = {
    id: selected.columns.visit_id as never,
  };
  for (let index = 0; index < additionalBindings; index++)
    projections[`other_${index}`] = param(index) as never;
  return compileD1Query(project(selected, projections));
}

describe("numeric membership binding optimizer", () => {
  it("chooses text rows and membership values together from final savings", () => {
    const visits = scan(schema.visits);
    const rowSchema = {
      row_key: { affinity: "text", nullable: false },
      row_value: { affinity: "text", nullable: false },
    } as const;
    const membershipValues = Array.from(
      { length: 101 },
      (_, index) => `member-${index}`,
    );
    const membershipOnlyWins = valuesRelation(
      rowSchema,
      Array.from({ length: 40 }, (_unused, index) => ({
        row_key: `key-${index}`,
        row_value: `value-${index}`,
      })),
    );
    const first = compileD1Query(
      join(
        membershipOnlyWins,
        visits,
        eq(membershipOnlyWins.columns.row_value, visits.columns.pathname),
      ),
    );
    const joinedFirst = join(
      membershipOnlyWins,
      visits,
      eq(membershipOnlyWins.columns.row_value, visits.columns.pathname),
    );
    const firstWithMembership = compileD1Query(
      filter(
        joinedFirst,
        inList(joinedFirst.columns.right_pathname, membershipValues),
      ),
    );
    const firstWithNumericMembership = compileD1Query(
      filter(
        joinedFirst,
        inList(
          joinedFirst.columns.right_duration_ms,
          Array.from({ length: 101 }, (_, index) => index) as never,
        ),
      ),
    );
    const packedRows = valuesRelation(
      rowSchema,
      Array.from({ length: 60 }, (_unused, index) => ({
        row_key: `key-${index}`,
        row_value: `value-${index}`,
      })),
    );
    const joinedPackedRows = join(
      packedRows,
      visits,
      eq(packedRows.columns.row_value, visits.columns.pathname),
    );
    const bothSelected = compileD1Query(
      filter(
        joinedPackedRows,
        inList(
          joinedPackedRows.columns.right_pathname,
          Array.from({ length: 121 }, (_, index) => `member-${index}`),
        ),
      ),
    );

    expect(first.bindings).toHaveLength(80);
    expect(first.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 1,
      jsonRowRelationCount: 0,
    });
    expect(firstWithMembership.bindings).toHaveLength(81);
    expect(firstWithMembership.sql).toContain("json_each(?)");
    expect(firstWithMembership.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 1,
      jsonRowRelationCount: 0,
      nativeMembershipCount: 0,
      jsonMembershipCount: 1,
    });
    expect(firstWithNumericMembership.bindings).toHaveLength(81);
    expect(firstWithNumericMembership.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 1,
      jsonRowRelationCount: 0,
      nativeMembershipCount: 0,
      jsonMembershipCount: 1,
    });
    expect(bothSelected.bindings).toHaveLength(2);
    expect(bothSelected.sql.match(/json_each\(\?\)/gu)).toHaveLength(1);
    expect(bothSelected.sql.match(/json_extract\("_tuple"/gu)).not.toBeNull();
    expect(bothSelected.physicalPlanShape).toMatchObject({
      version: 2,
      nativeRowRelationCount: 0,
      jsonRowRelationCount: 1,
      nativeMembershipCount: 0,
      jsonMembershipCount: 1,
    });
  });

  it("keeps text rows native through 100 bindings and packs complete UTF8 tuples", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = {
        value: { affinity: "text", nullable: false },
      } as const;
      const hundred = valuesRelation(
        schema,
        Array.from({ length: 100 }, (_unused, index) => ({
          value: `small-${index}`,
        })),
      );
      const hundredCompiled = compileD1Query(hundred);
      expect(hundredCompiled.bindings).toHaveLength(100);
      expect(hundredCompiled.physicalPlanShape).toMatchObject({
        version: 2,
        nativeRowRelationCount: 1,
        jsonRowRelationCount: 0,
      });

      const exactUtf8Limit = `${"雪".repeat(333_331)}a`;
      expect(new TextEncoder().encode(exactUtf8Limit).byteLength).toBe(999_994);
      const rowsAtLimit = valuesRelation(schema, [
        { value: exactUtf8Limit },
        ...Array.from({ length: 100 }, () => ({ value: "tail" })),
      ]);
      const packed = compileD1Query(rowsAtLimit);
      expect(packed.bindings).toHaveLength(2);
      expect(
        (packed.bindings ?? []).map(
          (binding) => new TextEncoder().encode(String(binding)).byteLength,
        ),
      ).toEqual([1_000_000, expect.any(Number)]);
      expect(packed.physicalPlanShape).toMatchObject({
        version: 2,
        nativeRowRelationCount: 0,
        jsonRowRelationCount: 1,
      });
      const actual = executeAll(db, packed) as Array<{ value: string }>;
      expect(actual).toHaveLength(101);
      expect(actual.filter((row) => row.value === "tail")).toHaveLength(100);
      expect(actual[0]?.value).toBe(exactUtf8Limit);

      const repeatedTail = compileD1Query(
        valuesRelation(
          schema,
          Array.from({ length: 101 }, () => ({ value: "tail" })),
        ),
      );
      expect(repeatedTail.bindings).toHaveLength(1);
      expect(executeAll(db, repeatedTail)).toEqual(
        Array.from({ length: 101 }, () => ({ value: "tail" })),
      );

      const overLimit = valuesRelation(schema, [
        { value: "x".repeat(999_995) },
        ...Array.from({ length: 100 }, (_unused, index) => ({
          value: `tail-${index}`,
        })),
      ]);
      expectBindingBudgetError(() => compileD1Query(overLimit), 101);
    } finally {
      db.close();
    }
  });

  it("recomputes text row bindings and physical JSON segmentation for forged plans", () => {
    const relation = valuesRelation(
      {
        first: { affinity: "text", nullable: false },
        second: { affinity: "text", nullable: true },
      } as const,
      Array.from({ length: 60 }, (_unused, index) => ({
        first: `first-${index}`,
        second: index % 2 === 0 ? null : `second-${index}`,
      })),
    );
    const physical = lowerLogicalPlan(relation);
    if (physical.root.kind !== "values-relation")
      throw new Error("expected a text values root");
    const optimized = optimizePhysicalMembershipBudget(
      physical,
      {
        nativeBindingCount: 120,
        usage: [],
        rowUsage: [{ node: physical.root, occurrences: 1 }],
      },
      100,
    );
    expect(compileD1Query(optimized).bindings).toHaveLength(1);

    const rowStrategy = optimized.membershipOptimization?.rowStrategies?.[0];
    if (
      !rowStrategy ||
      rowStrategy.strategy !== "json-rows" ||
      !rowStrategy.jsonSegments
    )
      throw new Error("expected JSON row encoding metadata");
    const forged = {
      ...optimized,
      membershipOptimization: {
        ...optimized.membershipOptimization,
        rowStrategies: [
          {
            ...rowStrategy,
            jsonSegments: [
              {
                ...rowStrategy.jsonSegments[0]!,
                jsonText: '[["forged",null]]',
              },
            ],
          },
        ],
      },
    };
    expect(() => compileD1Query(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );

    const invalidLogical = {
      ...relation,
      node: {
        ...relation.node,
        rows: [["valid", 3]],
      },
    };
    expect(() => compileD1Query(invalidLogical as never)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });

  it("rejects malformed text row nodes and optimizer usage metadata", () => {
    const relation = valuesRelation(
      { value: { affinity: "text", nullable: false } } as const,
      [{ value: "valid" }] as const,
    );
    const malformedNodes = [
      { ...relation.node, columns: [] },
      {
        ...relation.node,
        columns: [{ name: "value", nullable: "false" }],
      },
      {
        ...relation.node,
        columns: [
          { name: "value", nullable: false },
          { name: "value", nullable: false },
        ],
        fields: [...relation.node.fields, relation.node.fields[0]!],
      },
      {
        ...relation.node,
        fields: [{ ...relation.node.fields[0]!, nullable: true }],
      },
      {
        ...relation.node,
        rows: Object.assign([["valid"]], { extra: true }),
      },
      { ...relation.node, rows: [["too", "many"]] },
    ];
    for (const node of malformedNodes)
      expect(() => compileD1Query({ ...relation, node } as never)).toThrow();

    expect(() =>
      compileD1Query({ ...relation, fields: [] } as never),
    ).toThrow();
    expect(() =>
      compileD1Query({
        ...relation,
        columns: { other: relation.columns.value },
      } as never),
    ).toThrow();
    expect(() =>
      compileD1Query({
        ...relation,
        columns: { value: param("forged") },
      } as never),
    ).toThrow();

    const physical = lowerLogicalPlan(relation);
    expect(() =>
      optimizePhysicalMembershipBudget(
        physical,
        { nativeBindingCount: -1, usage: [] },
        100,
      ),
    ).toThrow();
    expect(() =>
      optimizePhysicalMembershipBudget(
        physical,
        {
          nativeBindingCount: 1,
          usage: [{ expression: {} as never, occurrences: 1 }],
        },
        100,
      ),
    ).toThrow();
    expect(() =>
      optimizePhysicalMembershipBudget(
        physical,
        {
          nativeBindingCount: 1,
          usage: [
            {
              expression: { kind: "in-list" } as never,
              occurrences: 0,
            },
          ],
        },
        100,
      ),
    ).toThrow();
    expect(() =>
      optimizePhysicalMembershipBudget(
        physical,
        {
          nativeBindingCount: 1,
          usage: [],
          rowUsage: [{ node: null as never, occurrences: 1 }],
        },
        100,
      ),
    ).toThrow();
    expect(() =>
      optimizePhysicalMembershipBudget(
        physical,
        {
          nativeBindingCount: 1,
          usage: [],
          rowUsage: [{ node: physical.root as never, occurrences: 0 }],
        },
        100,
      ),
    ).toThrow();
  });

  it("measures repeated and competing row relations at their final render occurrences", () => {
    const repeatedSchema = Object.fromEntries(
      Array.from({ length: 17 }, (_unused, index) => [
        `field_${index}`,
        { affinity: "text", nullable: false },
      ]),
    ) as Record<
      string,
      { readonly affinity: "text"; readonly nullable: false }
    >;
    const repeatedRows = Array.from(
      { length: 3 },
      (_unused, rowIndex) =>
        Object.fromEntries(
          Array.from({ length: 17 }, (_cell, columnIndex) => [
            `field_${columnIndex}`,
            `r${rowIndex}-c${columnIndex}`,
          ]),
        ) as Record<string, string>,
    );
    const repeatedSource = valuesRelation(repeatedSchema, repeatedRows);
    const duplicated = compileD1Query(
      union(repeatedSource, repeatedSource, true),
    );
    expect(duplicated.bindings).toHaveLength(2);
    expect(duplicated.bindings?.[0]).toBe(duplicated.bindings?.[1]);
    expect(
      duplicated.sql.match(/json_each\("_segments"\.column1\)/gu),
    ).toHaveLength(2);

    const db = new DatabaseSync(":memory:");
    try {
      const schema = { key: { affinity: "text", nullable: false } } as const;
      const leftRows = valuesRelation(
        schema,
        Array.from({ length: 55 }, (_unused, index) => ({
          key: `key-${index}`,
        })),
      );
      const rightRows = valuesRelation(
        schema,
        Array.from({ length: 55 }, (_unused, index) => ({
          key: `key-${index}`,
        })),
      );
      const compiled = compileD1Query(
        join(
          leftRows,
          rightRows,
          eq(leftRows.columns.key, rightRows.columns.key),
        ),
      );
      expect(compiled.bindings).toHaveLength(56);
      expect(compiled.physicalPlanShape).toMatchObject({
        version: 2,
        nativeRowRelationCount: 1,
        jsonRowRelationCount: 1,
      });
      expect(executeAll(db, compiled)).toHaveLength(55);
    } finally {
      db.close();
    }
  });

  it("matches frozen native INTEGER IN and NOT IN oracles, including 3VL and weak storage", () => {
    const db = createDatabase();
    try {
      insertVisit(db, "negative-safe-boundary", -Number.MAX_SAFE_INTEGER);
      insertVisit(db, "positive-safe-boundary", Number.MAX_SAFE_INTEGER);
      insertVisit(db, "zero", 0);
      insertVisit(db, "minus-zero", -0);
      insertVisit(db, "duplicate-hit", 13);
      insertVisit(db, "miss", 900_001);
      insertVisit(db, "nullable", null);
      insertVisit(db, "weak-text", "not-a-number");
      insertVisit(db, "weak-blob", Buffer.from("7"));

      const values = [
        Number.MAX_SAFE_INTEGER,
        -Number.MAX_SAFE_INTEGER,
        0,
        -0,
        13,
        13,
        ...Array.from({ length: 101 }, (_, index) => index + 10_000),
      ];
      const visits = scan(schema.visits);
      const sharedMembership = inList(
        visits.columns.duration_ms,
        values as never,
      );
      const compiled = compileD1Query(
        project(visits, {
          id: visits.columns.visit_id,
          included: sharedMembership,
          excluded: not(sharedMembership),
        }),
      );
      const nativeSql = `SELECT visit_id AS id, duration_ms IN (${placeholders(values.length)}) AS included, NOT (duration_ms IN (${placeholders(values.length)})) AS excluded FROM visits ORDER BY visit_id`;
      const native = db
        .prepare(nativeSql)
        .all(...([...values, ...values] as SQLInputValue[])) as Array<
        Record<string, unknown>
      >;

      expect(compiled.sql.match(/json_each\(\?\)/gu)).toHaveLength(2);
      expect(compiled.bindings).toEqual([
        JSON.stringify(values),
        JSON.stringify(values),
      ]);
      expect(normalizeTruthRows(executeAll(db, compiled))).toEqual(
        normalizeTruthRows(native),
      );
      expect(
        db
          .prepare(
            "SELECT typeof(duration_ms) AS storage FROM visits WHERE visit_id IN ('weak-text', 'weak-blob') ORDER BY visit_id",
          )
          .all(),
      ).toEqual([{ storage: "blob" }, { storage: "text" }]);
      expect(
        normalizeTruthRows(executeAll(db, compiled)).filter(
          (row) => row.id === "nullable",
        ),
      ).toEqual([{ id: "nullable", included: null, excluded: null }]);
    } finally {
      db.close();
    }
  });

  it("preserves safe numeric JSON types for REAL and no-affinity numeric expressions", () => {
    const db = createDatabase();
    try {
      const insertRollup = db.prepare(
        "INSERT INTO visit_hourly_rollups (site_id, site_pk, hour_bucket, views, perf_ttfb_sum, input_cutoff_ms) VALUES (?, 1, ?, ?, ?, 1)",
      );
      insertRollup.run("int-hit", 1, 7, 7);
      insertRollup.run("real-hit", 2, 8, 8.5);
      insertRollup.run("text", 3, "not-numeric", "not-numeric");
      insertRollup.run("blob", 4, Buffer.from("7"), Buffer.from("8"));

      const values = [
        -Number.MAX_SAFE_INTEGER,
        0,
        7,
        8,
        ...Array.from({ length: 101 }, (_, index) => index + 20_000),
      ];
      // The REAL column stores 8.5; the membership values stay safe integers.
      const safeValues = values;
      const rollups = scan(schema.visit_hourly_rollups);
      const realMembership = inList(
        rollups.columns.perf_ttfb_sum,
        safeValues as never,
      );
      const realCompiled = compileD1Query(
        project(rollups, {
          id: rollups.columns.site_id,
          included: realMembership,
          excluded: not(realMembership),
        }),
      );
      const nativeRealSql = `SELECT site_id AS id, perf_ttfb_sum IN (${placeholders(safeValues.length)}) AS included, NOT (perf_ttfb_sum IN (${placeholders(safeValues.length)})) AS excluded FROM visit_hourly_rollups ORDER BY site_id`;
      const nativeReal = db
        .prepare(nativeRealSql)
        .all(...([...safeValues, ...safeValues] as SQLInputValue[])) as Array<
        Record<string, unknown>
      >;
      expect(realCompiled.sql).toContain("json_each(?)");
      expect(normalizeTruthRows(executeAll(db, realCompiled))).toEqual(
        normalizeTruthRows(nativeReal),
      );

      const numericOperand = add(rollups.columns.views, param(0));
      const numericMembership = inList(numericOperand, safeValues as never);
      const numericCompiled = compileD1Query(
        project(rollups, {
          id: rollups.columns.site_id,
          included: numericMembership,
          excluded: not(numericMembership),
        }),
      );
      const nativeNumericSql = `SELECT site_id AS id, (views + 0) IN (${placeholders(safeValues.length)}) AS included, NOT ((views + 0) IN (${placeholders(safeValues.length)})) AS excluded FROM visit_hourly_rollups ORDER BY site_id`;
      const nativeNumeric = db
        .prepare(nativeNumericSql)
        .all(...([...safeValues, ...safeValues] as SQLInputValue[])) as Array<
        Record<string, unknown>
      >;
      expect(numericCompiled.sql).toContain("json_each(?)");
      expect(normalizeTruthRows(executeAll(db, numericCompiled))).toEqual(
        normalizeTruthRows(nativeNumeric),
      );
    } finally {
      db.close();
    }
  });

  it("uses native lists through 100 bindings and admits two-value packing only at 101", () => {
    const visits = scan(schema.visits);
    const hundredValues = Array.from({ length: 100 }, (_, index) => index);
    const oneHundredOneValues = [...hundredValues, 100];
    const hundred = compileD1Query(
      filter(visits, inList(visits.columns.duration_ms, hundredValues)),
    );
    const oneHundredOne = compileD1Query(
      filter(visits, inList(visits.columns.duration_ms, oneHundredOneValues)),
    );

    expect(hundred.bindings).toHaveLength(100);
    expect(hundred.sql).not.toContain("json_each");
    expect(oneHundredOne.sql).toContain("json_each(?)");
    expect(oneHundredOne.bindings).toEqual([
      JSON.stringify(oneHundredOneValues),
    ]);
    expect(
      compileD1Query(filter(visits, inList(visits.columns.duration_ms, [])))
        .bindings,
    ).toEqual([]);
    const one = compileD1Query(
      filter(visits, inList(visits.columns.duration_ms, [7])),
    );
    expect(one.sql).not.toContain("json_each");
    expect(one.bindings).toEqual([7]);

    const twoValues = [7, 8];
    const atOneHundred = projectWithAdditionalBindings(visits, twoValues, 98);
    const atOneHundredOne = projectWithAdditionalBindings(
      visits,
      twoValues,
      99,
    );
    expect(atOneHundred.bindings).toHaveLength(100);
    expect(atOneHundred.sql).not.toContain("json_each");
    expect(atOneHundredOne.bindings).toHaveLength(100);
    expect(atOneHundredOne.sql).toContain("json_each(?)");
  });

  it("keeps A/B/A numeric membership output deterministic for logical and physical inputs", () => {
    const visits = scan(schema.visits);
    const valuesA = Array.from({ length: 101 }, (_, index) => index - 50);
    const valuesB = Array.from({ length: 101 }, (_, index) => index + 5_000);
    const relationFor = (values: readonly number[]) =>
      filter(visits, inList(visits.columns.duration_ms, values));
    const relationA = relationFor(valuesA);
    const relationB = relationFor(valuesB);
    const logicalA = compileD1Query(relationA);
    const logicalB = compileD1Query(relationB);
    const logicalAAgain = compileD1Query(relationA);

    expect(logicalA.sql).toBe(logicalB.sql);
    expect(logicalA.sql).toBe(logicalAAgain.sql);
    expect(logicalA.physicalPlanShape).toEqual(logicalB.physicalPlanShape);
    expect(logicalA.physicalPlanShape).toEqual(logicalAAgain.physicalPlanShape);
    expect(logicalA.bindings).toEqual([JSON.stringify(valuesA)]);
    expect(logicalB.bindings).toEqual([JSON.stringify(valuesB)]);
    expect(logicalAAgain.bindings).toEqual([JSON.stringify(valuesA)]);

    const physicalA = lowerLogicalPlan(relationA);
    const physicalB = lowerLogicalPlan(relationB);
    const physicalACompiled = compileD1Query(physicalA);
    const physicalBCompiled = compileD1Query(physicalB);
    const physicalAAgain = compileD1Query(physicalA);

    expect(physicalACompiled.sql).toBe(physicalBCompiled.sql);
    expect(physicalACompiled.sql).toBe(physicalAAgain.sql);
    expect(physicalACompiled.physicalPlanShape).toEqual(
      physicalBCompiled.physicalPlanShape,
    );
    expect(physicalACompiled.physicalPlanShape).toEqual(
      physicalAAgain.physicalPlanShape,
    );
    expect(physicalACompiled.bindings).toEqual([JSON.stringify(valuesA)]);
    expect(physicalBCompiled.bindings).toEqual([JSON.stringify(valuesB)]);
    expect(physicalAAgain.bindings).toEqual([JSON.stringify(valuesA)]);
  });

  it("packs 1200 safe integers, keeps final-shape hashing value-free, and lowers through a shared CTE and mutation", () => {
    const db = createDatabase();
    try {
      insertVisit(db, "target", 3);
      const visits = scan(schema.visits);
      const values = Array.from({ length: 1200 }, (_, index) => index - 600);
      const firstRelation = filter(
        visits,
        inList(visits.columns.duration_ms, values),
      );
      const firstQuery = compileD1Query(firstRelation);
      expect(firstQuery.sql).toContain("json_each(?)");
      expect(firstQuery.bindings).toEqual([JSON.stringify(values)]);
      expect(executeAll(db, firstQuery)).toHaveLength(1);

      const secondValues = values.map((value) => value + 10_000);
      const secondQuery = compileD1Query(
        filter(visits, inList(visits.columns.duration_ms, secondValues)),
      );
      expect(firstQuery.sql).toBe(secondQuery.sql);
      expect(firstQuery.physicalPlanShape).toEqual(
        secondQuery.physicalPlanShape,
      );
      expect(firstQuery.bindings).not.toEqual(secondQuery.bindings);
      expect(JSON.stringify(firstQuery.physicalPlanShape)).not.toContain(
        "-600",
      );

      const numericCandidates = project(firstRelation, {
        duration_ms: firstRelation.columns.duration_ms,
      });
      const nestedQuery = compileD1Query(
        project(visits, {
          id: visits.columns.visit_id,
          included: inSubquery(visits.columns.duration_ms, numericCandidates),
        }),
      );
      expect(nestedQuery.sql).toContain("json_each(?)");
      const nativeNested = db
        .prepare(
          `SELECT visit_id AS id, duration_ms IN (SELECT duration_ms FROM visits WHERE duration_ms IN (${placeholders(values.length)})) AS included FROM visits ORDER BY visit_id`,
        )
        .all(...(values as SQLInputValue[])) as Array<Record<string, unknown>>;
      expect(
        executeAll(db, nestedQuery)
          .map((row) => ({
            id: String(row.id),
            included: row.included === null ? null : Number(row.included),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      ).toEqual(
        nativeNested
          .map((row) => ({
            id: String(row.id),
            included: row.included === null ? null : Number(row.included),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      );

      const selected = project(firstRelation, {
        site_id: param("selected"),
      });
      const sharedCte = union(selected, selected, true);
      const cteQuery = compileD1Query(sharedCte);
      expect(cteQuery.sql).toContain("_d1_shared_");
      expect(cteQuery.sql).toContain("json_each(?)");
      expect(executeAll(db, cteQuery)).toEqual([
        { site_id: "selected" },
        { site_id: "selected" },
      ]);

      const source = project(firstRelation, { site_id: param("copied") });
      const mutation = compileD1Mutation(
        insertFromQuery(schema.site_identities, ["site_id"], source),
      );
      expect(mutation.sql).toContain("json_each(?)");
      expect(mutation.bindings).toEqual(["copied", JSON.stringify(values)]);
      db.prepare(mutation.sql).run(
        ...((mutation.bindings ?? []) as SQLInputValue[]),
      );
      expect(
        db
          .prepare(
            "SELECT site_id FROM site_identities WHERE site_id = 'copied'",
          )
          .all(),
      ).toEqual([{ site_id: "copied" }]);
    } finally {
      db.close();
    }
  });

  it("selects the greatest savings first and keeps stable tie order", () => {
    const visits = scan(schema.visits);
    const largest = Array.from({ length: 80 }, (_, index) => index + 1_000);
    const tiedFirst = Array.from({ length: 60 }, (_, index) => index + 2_000);
    const tiedSecond = Array.from({ length: 60 }, (_, index) => index + 3_000);
    const query = compileD1Query(
      filter(
        visits,
        and(
          inList(visits.columns.duration_ms, largest),
          inList(visits.columns.duration_ms, tiedFirst),
          inList(visits.columns.duration_ms, tiedSecond),
        ),
      ),
    );

    expect(query.bindings).toEqual([
      JSON.stringify(largest),
      JSON.stringify(tiedFirst),
      ...tiedSecond,
    ]);
    expect(query.sql.match(/json_each\(\?\)/gu)).toHaveLength(2);
  });

  it("rejects unsafe numeric candidates and preserves the known unsafe-integer counterexample", () => {
    const visits = scan(schema.visits);
    const safeValues = Array.from({ length: 100 }, (_, index) => index);
    const malformedMemberships: readonly {
      readonly name: string;
      readonly values: readonly unknown[];
    }[] = [
      { name: "fraction", values: [...safeValues, 1.5] },
      {
        name: "unsafe integer",
        values: [...safeValues, 1000000000000000100],
      },
      { name: "mixed text", values: [...safeValues, "7"] },
      { name: "boolean", values: [...safeValues, true] },
      { name: "NULL", values: [...safeValues, null] },
    ];
    for (const malformed of malformedMemberships) {
      expectBindingBudgetError(
        () =>
          compileD1Query(
            filter(
              visits,
              inList(visits.columns.duration_ms, malformed.values as never),
            ),
          ),
        101,
      );
    }

    const unsafe = 1000000000000000100;
    const native = dbSafeIntegerCounterexample(unsafe);
    expect(native).toEqual({ native: 1, naiveJson: 0 });
  });

  it("refuses numeric packing for text affinity and still applies the statement budget", () => {
    const identities = scan(schema.site_identities);
    const values = Array.from({ length: 101 }, (_, index) => index);
    expectBindingBudgetError(
      () =>
        compileD1Query(
          filter(
            identities,
            inList(identities.columns.site_id, values as never),
          ),
        ),
      101,
    );
  });

  it("enforces the one-megabyte numeric JSON payload boundary", () => {
    const visits = scan(schema.visits);
    const atLimit = Array.from({ length: 499_999 }, () => 0);
    atLimit[123] = 10;
    const atLimitJson = JSON.stringify(atLimit);
    expect(new TextEncoder().encode(atLimitJson).byteLength).toBe(1_000_000);
    const packedAtLimit = compileD1Query(
      filter(visits, inList(visits.columns.duration_ms, atLimit)),
    );
    expect(packedAtLimit.bindings).toEqual([atLimitJson]);
    expect(packedAtLimit.sql).toContain("json_each(?)");

    const overLimit = Array.from({ length: 499_999 }, () => 0);
    overLimit[123] = 10;
    overLimit[456] = 10;
    expect(new TextEncoder().encode(JSON.stringify(overLimit)).byteLength).toBe(
      1_000_001,
    );
    expect(() =>
      compileD1Query(
        filter(visits, inList(visits.columns.duration_ms, overLimit)),
      ),
    ).toThrowError(D1StatementBudgetError);
  });

  it("validates numeric strategy metadata instead of trusting forged JSON", () => {
    const visits = scan(schema.visits);
    const values = Array.from({ length: 101 }, (_, index) => index);
    const relation = filter(visits, inList(visits.columns.duration_ms, values));
    const physical = lowerLogicalPlan(relation);
    if (physical.root.kind !== "filter")
      throw new Error("expected a filter physical root");
    const membership = physical.root.predicate as Extract<
      typeof physical.root.predicate,
      { kind: "in-list" }
    >;
    const jsonText = JSON.stringify(values);
    const jsonUtf8Bytes = new TextEncoder().encode(jsonText).byteLength;
    const validPhysical = {
      ...physical,
      membershipOptimization: {
        nativeBindingCount: values.length,
        selectedBindingCount: 1,
        strategies: [
          {
            expression: membership,
            occurrences: 1,
            strategy: "json-text" as const,
            jsonText,
            jsonUtf8Bytes,
            nativeBindingsSaved: values.length - 1,
          },
        ],
      },
    };
    expect(compileD1Query(validPhysical)).toEqual(compileD1Query(relation));

    const forged = {
      ...validPhysical,
      membershipOptimization: {
        ...validPhysical.membershipOptimization,
        strategies: [
          {
            ...validPhysical.membershipOptimization.strategies[0]!,
            jsonText: JSON.stringify(values.map((value) => value + 1)),
          },
        ],
      },
    };
    expect(() => compileD1Query(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });
});

function dbSafeIntegerCounterexample(unsafe: number) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE numeric_values (value INTEGER)");
    db.prepare("INSERT INTO numeric_values (value) VALUES (?)").run(unsafe);
    const native = db
      .prepare("SELECT value IN (?) AS matched FROM numeric_values")
      .get(unsafe) as { matched: number };
    const naiveJson = db
      .prepare(
        "SELECT numeric_values.value IN (SELECT value FROM json_each(?)) AS matched FROM numeric_values",
      )
      .get(JSON.stringify([unsafe])) as { matched: number };
    return { native: native.matched, naiveJson: naiveJson.matched };
  } finally {
    db.close();
  }
}
