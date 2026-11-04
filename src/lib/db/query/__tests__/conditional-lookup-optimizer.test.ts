import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  and,
  callFunction,
  caseWhen,
  castInteger,
  coalesce,
  compileD1Query,
  constant,
  eq,
  filter,
  gt,
  inList,
  isNotNull,
  join,
  lowerLogicalPlan,
  or,
  param,
  project,
  recursiveClosure,
  scan,
  union,
} from "@/lib/db";
import { analyzeConditionalLookupChoices } from "@/lib/db/query/physical/conditional-lookup";
import type { JoinNode } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type { SchemaObjectReference } from "@/lib/db/schema/types";
import type { SchemaColumnReference } from "@/lib/db/schema/types";
import type { DatabasePhysicalPlanShape } from "@/lib/db/types";

type Row = Record<string, unknown>;

function executeAll(
  database: DatabaseSync,
  statement: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Row[] {
  return database
    .prepare(statement.sql)
    .all(...((statement.bindings ?? []) as SQLInputValue[])) as Row[];
}

function asBag(rows: readonly Row[], columns: readonly string[]): string[] {
  return rows
    .map((row) => JSON.stringify(columns.map((column) => row[column])))
    .sort();
}

function makeGenericLeftJoin() {
  const left = scan(schema.archive_objects);
  const right = scan(schema.archive_objects);
  const joined = join(
    left,
    right,
    and(
      eq(left.columns.site_pk, right.columns.site_pk),
      eq(left.columns.start_hour, right.columns.start_hour),
      gt(left.columns.created_at, param(10)),
    ),
    "left",
  );
  return project(joined, {
    leftKey: joined.columns.left_archive_key,
    rightKey: joined.columns.right_archive_key,
  });
}

function createArchiveFixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE archive_objects (
      archive_key TEXT,
      site_id TEXT,
      start_hour INTEGER,
      end_hour INTEGER,
      granularity TEXT,
      format TEXT,
      row_count INTEGER,
      size_bytes INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      site_pk INTEGER
    );
    CREATE INDEX idx_archive_objects_site_pk_hour
      ON archive_objects(site_pk, start_hour, end_hour);
  `);
  const insert = database.prepare(`
    INSERT INTO archive_objects (
      archive_key, site_id, start_hour, end_hour, granularity, format,
      row_count, size_bytes, created_at, updated_at, site_pk
    ) VALUES (?, 'fixture', ?, 200, 'hour', 'json', 1, 1, ?, 0, ?)
  `);
  const rows: readonly [string, number | null, number | null, SQLInputValue][] =
    [
      ["left-a", 100, 20, 1],
      ["left-a-duplicate", 100, 20, 1],
      ["left-false", 100, 1, 1],
      ["left-null-p", 100, null, 1],
      ["left-missing", 100, 20, 999],
      ["left-null-key", 100, 20, null],
      ["left-real-key", 100, 20, 1.5],
      ["left-text-key", 100, 20, "not-a-number"],
      ["left-blob-key", 100, 20, new Uint8Array([1, 2])],
      ["left-null-composite-key", null, 20, 1],
      ["right-numeric-duplicate", 100, 50, 1],
      ["right-null-key", 100, 50, null],
      ["right-real-key", 100, 50, 1.5],
      ["right-text-key", 100, 50, "not-a-number"],
      ["right-blob-key", 100, 50, new Uint8Array([1, 2])],
      ["right-null-composite-key", null, 50, 1],
    ];
  for (const [key, startHour, createdAt, sitePk] of rows)
    insert.run(key, startHour, createdAt, sitePk);
  return database;
}

describe("conditional indexed lookup Physical rule", () => {
  it("preserves LEFT JOIN bags for true, false, NULL guards and mixed INTEGER storage classes", () => {
    const database = createArchiveFixture();
    try {
      const query = makeGenericLeftJoin();
      if (
        query.node.kind !== "project" ||
        query.node.input.node.kind !== "join"
      )
        throw new Error("test_join_shape_changed");
      const originalJoin = query.node.input.node;
      const originalCondition = originalJoin.condition;
      const physical = lowerLogicalPlan(query);
      const compiled = compileD1Query(query);
      const oracle = database
        .prepare(
          `
          SELECT l.archive_key AS left_key, r.archive_key AS right_key
          FROM archive_objects AS l
          LEFT JOIN archive_objects AS r
            ON l.site_pk = r.site_pk
           AND l.start_hour = r.start_hour
           AND l.created_at > ?
        `,
        )
        .all(10) as Row[];
      const optimized = executeAll(database, compiled);
      const shape = compiled.physicalPlanShape as DatabasePhysicalPlanShape;

      expect(physical.root).toBe(query.node);
      expect(originalJoin.condition).toBe(originalCondition);
      expect(compiled.sql).toContain("CASE WHEN");
      expect(compiled.bindings).toEqual([10]);
      expect(shape.version).toBe(6);
      if (shape.version === 6) {
        expect(shape.conditionalLookupCount).toBe(1);
        expect(shape.conditionalLookupStrategies[0]).toMatchObject({
          tableName: "archive_objects",
          indexName: "idx_archive_objects_site_pk_hour",
          keyColumns: [
            { name: "site_pk", leftIndex: 10, rightIndex: 10 },
            { name: "start_hour", leftIndex: 2, rightIndex: 2 },
          ],
          selectedKey: { name: "site_pk", leftIndex: 10, rightIndex: 10 },
          guardConjunctCount: 1,
        });
      }
      expect(asBag(optimized, ["leftKey", "rightKey"])).toEqual(
        asBag(oracle, ["left_key", "right_key"]),
      );
    } finally {
      database.close();
    }
  });

  it("moves legal CASE, COALESCE, NULL, and primitive-set left guards without changing LEFT bags", () => {
    const database = createArchiveFixture();
    try {
      database
        .prepare(
          "UPDATE archive_objects SET format = 'xml' WHERE archive_key = 'left-a-duplicate'",
        )
        .run();
      database
        .prepare(
          "UPDATE archive_objects SET format = NULL WHERE archive_key = 'left-false'",
        )
        .run();

      const left = scan(schema.archive_objects);
      const right = scan(schema.archive_objects);
      const joined = join(
        left,
        right,
        and(
          eq(right.columns.site_pk, left.columns.site_pk),
          eq(right.columns.start_hour, left.columns.start_hour),
          gt(left.columns.created_at, param(10)),
          inList(coalesce(left.columns.format, constant("json")), [
            "json",
            "csv",
          ]),
          eq(
            caseWhen(
              [
                {
                  when: isNotNull(left.columns.granularity),
                  then: constant(1),
                },
              ],
              constant(0),
            ),
            constant(1),
          ),
          isNotNull(left.columns.start_hour),
        ),
        "left",
      );
      const query = project(joined, {
        leftKey: joined.columns.left_archive_key,
        rightKey: joined.columns.right_archive_key,
      });
      const compiled = compileD1Query(query);
      const shape = compiled.physicalPlanShape as DatabasePhysicalPlanShape;
      const oracle = database
        .prepare(
          `
          SELECT l.archive_key AS left_key, r.archive_key AS right_key
          FROM archive_objects AS l
          LEFT JOIN archive_objects AS r
            ON r.site_pk = l.site_pk
           AND r.start_hour = l.start_hour
           AND l.created_at > ?
           AND COALESCE(l.format, 'json') IN ('json', 'csv')
           AND CASE WHEN l.granularity IS NOT NULL THEN 1 ELSE 0 END = 1
           AND l.start_hour IS NOT NULL
        `,
        )
        .all(10) as Row[];

      expect(shape.version).toBe(6);
      if (shape.version === 6) {
        expect(shape.conditionalLookupCount).toBe(1);
        expect(shape.conditionalLookupStrategies[0]?.guardConjunctCount).toBe(
          4,
        );
      }
      expect(
        asBag(executeAll(database, compiled), ["leftKey", "rightKey"]),
      ).toEqual(asBag(oracle, ["left_key", "right_key"]));
      const rows = executeAll(database, compiled);
      expect(
        rows
          .filter(({ leftKey }) => leftKey === "left-a")
          .map(({ rightKey }) => rightKey)
          .sort(),
      ).toEqual(
        [
          "left-a",
          "left-a-duplicate",
          "left-false",
          "left-null-p",
          "right-numeric-duplicate",
        ].sort(),
      );
      expect(
        rows.filter(({ leftKey }) => leftKey === "left-a-duplicate"),
      ).toEqual([{ leftKey: "left-a-duplicate", rightKey: null }]);
    } finally {
      database.close();
    }
  });

  it("freshly rejects missing and forged conditional lookup metadata", () => {
    const query = makeGenericLeftJoin();
    const physical = lowerLogicalPlan(query);
    const forged = {
      ...physical,
      conditionalLookupChoices: [],
    };
    expect(() => compileD1Query(forged)).toThrow(/conditional lookup choices/u);

    const first = physical.conditionalLookupChoices[0]!;
    const forgedIndex = {
      ...physical,
      conditionalLookupChoices: [
        { ...first, indexName: "not_the_generated_index" },
      ],
    };
    expect(() => compileD1Query(forgedIndex)).toThrow(
      /conditional lookup choices/u,
    );

    const forgedGuard = {
      ...physical,
      conditionalLookupChoices: [{ ...first, guardConjuncts: [] }],
    };
    expect(() => compileD1Query(forgedGuard)).toThrow(
      /conditional lookup choices/u,
    );
  });

  it("proves keys through pure Projects, consistent UNION arms, and recursive inputs", () => {
    const projected = () => {
      const input = scan(schema.archive_objects);
      return project(input, {
        sitePk: input.columns.site_pk,
        startHour: input.columns.start_hour,
        createdAt: input.columns.created_at,
      });
    };
    const attachRight = (left: ReturnType<typeof projected>) => {
      const right = scan(schema.archive_objects);
      const joined = join(
        left,
        right,
        and(
          eq(left.columns.sitePk, right.columns.site_pk),
          eq(left.columns.startHour, right.columns.start_hour),
          gt(left.columns.createdAt, param(10)),
        ),
        "left",
      );
      return project(joined, { key: joined.columns.left_sitePk });
    };

    const projectPlan = lowerLogicalPlan(attachRight(projected()));
    const unionPlan = lowerLogicalPlan(
      attachRight(union(projected(), projected(), true)),
    );
    const seed = projected();
    const candidates = projected();
    const closure = recursiveClosure(seed, candidates, (current, candidate) =>
      eq(current.sitePk, candidate.sitePk),
    );
    const recursivePlan = lowerLogicalPlan(attachRight(closure));

    expect(projectPlan.conditionalLookupChoices).toHaveLength(1);
    expect(unionPlan.conditionalLookupChoices).toHaveLength(1);
    expect(recursivePlan.conditionalLookupChoices).toHaveLength(1);
  });

  it("rejects a UNION when one arm replaces an INTEGER key with a constant", () => {
    const makeInput = () => {
      const input = scan(schema.archive_objects);
      return project(input, {
        sitePk: input.columns.site_pk,
        startHour: input.columns.start_hour,
        createdAt: input.columns.created_at,
      });
    };
    const original = makeInput();
    const constantSource = scan(schema.archive_objects);
    const constantKey = project(constantSource, {
      sitePk: constant(7),
      startHour: constantSource.columns.start_hour,
      createdAt: constantSource.columns.created_at,
    });
    const left = union(original, constantKey, true);
    const right = scan(schema.archive_objects);
    const joined = join(
      left,
      right,
      and(
        eq(left.columns.sitePk, right.columns.site_pk),
        eq(left.columns.startHour, right.columns.start_hour),
        gt(left.columns.createdAt, param(10)),
      ),
      "left",
    );

    expect(lowerLogicalPlan(joined).conditionalLookupChoices).toHaveLength(0);
  });

  it("rejects unsafe guards, computed equality keys, and filtered RHS inputs", () => {
    const left = scan(schema.archive_objects);
    const right = scan(schema.archive_objects);
    const functionGuard = join(
      left,
      right,
      and(
        eq(left.columns.site_pk, right.columns.site_pk),
        gt(callFunction("abs", left.columns.created_at), param(10)),
      ),
      "left",
    );
    expect(
      lowerLogicalPlan(functionGuard).conditionalLookupChoices,
    ).toHaveLength(0);

    const safeCoalesceLeft = scan(schema.archive_objects);
    const safeCoalesceRight = scan(schema.archive_objects);
    const safeCoalesceGuard = join(
      safeCoalesceLeft,
      safeCoalesceRight,
      and(
        eq(safeCoalesceLeft.columns.site_pk, safeCoalesceRight.columns.site_pk),
        gt(coalesce(safeCoalesceLeft.columns.created_at, param(0)), param(10)),
      ),
      "left",
    );
    expect(
      lowerLogicalPlan(safeCoalesceGuard).conditionalLookupChoices,
    ).toHaveLength(1);

    const unsafeCoalesceLeft = scan(schema.archive_objects);
    const unsafeCoalesceRight = scan(schema.archive_objects);
    const unsafeCoalesceGuard = join(
      unsafeCoalesceLeft,
      unsafeCoalesceRight,
      and(
        eq(
          unsafeCoalesceLeft.columns.site_pk,
          unsafeCoalesceRight.columns.site_pk,
        ),
        gt(
          coalesce(
            callFunction("abs", unsafeCoalesceLeft.columns.created_at),
            param(0),
          ),
          param(10),
        ),
      ),
      "left",
    );
    expect(
      lowerLogicalPlan(unsafeCoalesceGuard).conditionalLookupChoices,
    ).toHaveLength(0);

    const castLeft = scan(schema.archive_objects);
    const castRight = scan(schema.archive_objects);
    const castKey = join(
      castLeft,
      castRight,
      and(
        eq(castInteger(castLeft.columns.site_pk), castRight.columns.site_pk),
        gt(castLeft.columns.created_at, param(10)),
      ),
      "left",
    );
    expect(lowerLogicalPlan(castKey).conditionalLookupChoices).toHaveLength(0);

    const filteredLeft = scan(schema.archive_objects);
    const filteredRightScan = scan(schema.archive_objects);
    const filteredRight = filter(
      filteredRightScan,
      gt(filteredRightScan.columns.created_at, param(0)),
    );
    const filteredJoin = join(
      filteredLeft,
      filteredRight,
      and(
        eq(filteredLeft.columns.site_pk, filteredRight.columns.site_pk),
        gt(filteredLeft.columns.created_at, param(10)),
      ),
      "left",
    );
    expect(
      lowerLogicalPlan(filteredJoin).conditionalLookupChoices,
    ).toHaveLength(0);

    const rightResidualLeft = scan(schema.archive_objects);
    const rightResidualRight = scan(schema.archive_objects);
    const rightResidual = join(
      rightResidualLeft,
      rightResidualRight,
      and(
        eq(
          rightResidualLeft.columns.site_pk,
          rightResidualRight.columns.site_pk,
        ),
        gt(rightResidualLeft.columns.created_at, param(10)),
        gt(rightResidualRight.columns.created_at, param(0)),
      ),
      "left",
    );
    expect(
      lowerLogicalPlan(rightResidual).conditionalLookupChoices,
    ).toHaveLength(0);
  });

  it("requires a real ordinary nonpartial nonexpression BINARY index and visible columns", () => {
    const query = makeGenericLeftJoin();
    if (query.node.kind !== "project" || query.node.input.node.kind !== "join")
      throw new Error("test_join_shape_changed");
    const joinNode = query.node.input.node as JoinNode;
    if (joinNode.right.node.kind !== "scan")
      throw new Error("test_right_scan_shape_changed");
    const scanNode = joinNode.right.node;
    const original = scanNode.table;
    const replaceTable = (table: SchemaObjectReference) =>
      analyzeConditionalLookupChoices({
        ...joinNode,
        right: { ...joinNode.right, node: { ...scanNode, table } },
      }).length;
    const withIndex = (
      updateIndex: (
        index: SchemaObjectReference["indexes"][number],
      ) => SchemaObjectReference["indexes"][number],
      table: SchemaObjectReference = original,
    ) => ({
      ...table,
      indexes: table.indexes.map((index) =>
        index.name === "idx_archive_objects_site_pk_hour"
          ? updateIndex(index)
          : index,
      ),
    });

    expect(
      replaceTable(withIndex((index) => ({ ...index, partial: true }))),
    ).toBe(0);
    expect(
      replaceTable(
        withIndex((index) => ({ ...index, rawExpressionSql: "site_pk + 0" })),
      ),
    ).toBe(0);
    expect(
      replaceTable(
        withIndex((index) => ({
          ...index,
          collations: ["NOCASE", ...index.collations!.slice(1)],
        })),
      ),
    ).toBe(0);
    expect(
      replaceTable(withIndex((index) => index, { ...original, kind: "view" })),
    ).toBe(0);
    expect(
      replaceTable({
        ...original,
        defaultCollation: "unknown",
      }),
    ).toBe(0);

    const generatedColumns: Record<string, SchemaColumnReference> = {
      ...original.columns,
    };
    generatedColumns.site_pk = {
      ...original.columns.site_pk!,
      generated: true,
    };
    expect(replaceTable({ ...original, columns: generatedColumns })).toBe(0);
    const hiddenColumns: Record<string, SchemaColumnReference> = {
      ...original.columns,
    };
    hiddenColumns.site_pk = { ...original.columns.site_pk!, hidden: 1 };
    expect(replaceTable({ ...original, columns: hiddenColumns })).toBe(0);
  });

  it("does not split an OR into a lookup equality and a movable guard", () => {
    const left = scan(schema.archive_objects);
    const right = scan(schema.archive_objects);
    const joined = join(
      left,
      right,
      or(
        eq(left.columns.site_pk, right.columns.site_pk),
        gt(left.columns.created_at, param(10)),
      ),
      "left",
    );
    const query = project(joined, {
      key: joined.columns.left_archive_key,
    });
    const compiled = compileD1Query(query);

    expect(compiled.sql).not.toContain("CASE WHEN");
    expect(compiled.physicalPlanShape?.version).not.toBe(6);
    expect(compileD1Query(query).sql).toBe(compiled.sql);
  });
});
