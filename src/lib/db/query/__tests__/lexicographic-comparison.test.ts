import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  and,
  callFunction,
  compileD1Query,
  constant,
  eq,
  filter,
  gt,
  gte,
  join,
  lt,
  or,
  project,
  scalar,
  scan,
  valuesRelation,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression, Predicate } from "@/lib/db/query/expression";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import { schema } from "@/lib/db/schema";
type Direction = ">" | "<";

function compare(
  direction: Direction,
  left: AnyExpression,
  right: AnyExpression,
): Predicate {
  return direction === ">"
    ? gt(left as never, right as never)
    : lt(left as never, right as never);
}

function equal(left: AnyExpression, right: AnyExpression): Predicate {
  return eq(left as never, right as never);
}

function nestedComparison(
  direction: Direction,
  left: readonly AnyExpression[],
  right: readonly AnyExpression[],
  width: number,
): Predicate {
  let suffix = compare(direction, left[width - 1]!, right[width - 1]!);
  for (let index = width - 2; index >= 0; index -= 1)
    suffix = or(
      compare(direction, left[index]!, right[index]!),
      and(equal(left[index]!, right[index]!), suffix),
    );
  return suffix;
}

interface TestRow {
  readonly a0: string | null;
  readonly a1: string | null;
  readonly a2: string | null;
  readonly a3: string | null;
  readonly b0: string | null;
  readonly b1: string | null;
  readonly b2: string | null;
  readonly b3: string | null;
}

const textRowSchema = {
  a0: { affinity: "text", nullable: true },
  a1: { affinity: "text", nullable: true },
  a2: { affinity: "text", nullable: true },
  a3: { affinity: "text", nullable: true },
  b0: { affinity: "text", nullable: true },
  b1: { affinity: "text", nullable: true },
  b2: { affinity: "text", nullable: true },
  b3: { affinity: "text", nullable: true },
} as const;

const baselineTuple: readonly string[] = ["m", "m", "m", "m"];

function comparisonRows(): TestRow[] {
  const rows: TestRow[] = [];
  const add = (left: readonly (string | null)[], right: readonly string[]) => {
    rows.push({
      a0: left[0] ?? null,
      a1: left[1] ?? null,
      a2: left[2] ?? null,
      a3: left[3] ?? null,
      b0: right[0]!,
      b1: right[1]!,
      b2: right[2]!,
      b3: right[3]!,
    });
  };
  for (let index = 0; index < 4; index += 1) {
    for (const decisive of ["a", "z"] as const) {
      const left: Array<string | null> = [...baselineTuple];
      left[index] = decisive;
      for (let suffix = index + 1; suffix < 4; suffix += 1) left[suffix] = null;
      add(left, baselineTuple);
    }
    const unknown: Array<string | null> = [...baselineTuple];
    unknown[index] = null;
    for (let suffix = index + 1; suffix < 4; suffix += 1) unknown[suffix] = "z";
    add(unknown, baselineTuple);
  }
  return rows;
}

function normalizeResultRows(
  rows: readonly Record<string, unknown>[],
): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function createTypedComparisonDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  const columns = Object.values(schema.archive_objects.columns);
  db.exec(
    `CREATE TABLE ${quote(schema.archive_objects.name)} (${columns
      .map(
        ({ sqlName, declaredType }) =>
          `${quote(sqlName)} ${
            sqlName === "format" ? "TEXT COLLATE NOCASE" : declaredType
          }`,
      )
      .join(", ")})`,
  );
  const insert = db.prepare(
    `INSERT INTO ${quote(schema.archive_objects.name)} (
      ${quote("archive_key")}, ${quote("start_hour")}, ${quote("site_pk")},
      ${quote("format")}, ${quote("size_bytes")}
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  const rows: readonly (readonly SQLInputValue[])[] = [
    ["row-a", 10, 1, "alpha", "9223372036854775807"],
    ["row-b", 10, 1.5, "ALPHA", "9223372036854775806"],
    ["row-c", 10, 1, "alpha", "-9223372036854775808"],
    ["row-d", 10, 1, null, 0],
    ["row-e", 10, null, "alpha", 0],
    ["row-f", 11, 1.5, "beta", 2.5],
  ];
  for (const row of rows) insert.run(...row);
  return db;
}

function compilePredicate(direction: Direction, width: number) {
  const relation = valuesRelation(textRowSchema, comparisonRows());
  const left = [
    relation.columns.a0,
    relation.columns.a1,
    relation.columns.a2,
    relation.columns.a3,
  ];
  const right = [
    relation.columns.b0,
    relation.columns.b1,
    relation.columns.b2,
    relation.columns.b3,
  ];
  const predicate = nestedComparison(direction, left, right, width);
  return project(relation, { matched: predicate });
}

describe("strict lexicographic physical comparison", () => {
  it("rewrites 2, 3, and 4 text columns in the Generic compiler without changing bindings or results", () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const width of [2, 3, 4] as const) {
        for (const direction of [">", "<"] as const) {
          const query = compilePredicate(direction, width);
          const optimized = compileD1Query(query);
          const expanded = compileD1QueryUnoptimizedForTest(query);
          const shape = optimized.physicalPlanShape;
          expect(shape).toMatchObject({
            version: 9,
            lexicographicComparisonCount: 1,
            lexicographicComparisons: [
              { direction, componentCount: width, emissionCount: 1 },
            ],
          });
          expect(optimized.sql).toMatch(
            direction === ">" ? /\) > \(/u : /\) < \(/u,
          );
          expect(optimized.sql.length).toBeLessThan(expanded.sql.length);
          expect(optimized.bindings).toEqual(expanded.bindings);
          expect(
            normalizeResultRows(
              db
                .prepare(optimized.sql)
                .all(...(optimized.bindings as SQLInputValue[])) as Record<
                string,
                unknown
              >[],
            ),
          ).toEqual(
            normalizeResultRows(
              db
                .prepare(expanded.sql)
                .all(...(expanded.bindings as SQLInputValue[])) as Record<
                string,
                unknown
              >[],
            ),
          );
        }
      }
    } finally {
      db.close();
    }
  });

  it("preserves typed Generic SQLite results for INTEGER, REAL, TEXT collation, boundary integers, and NULL", () => {
    const db = createTypedComparisonDatabase();
    try {
      for (const width of [2, 3, 4] as const) {
        for (const direction of [">", "<"] as const) {
          const left = scan(schema.archive_objects);
          const right = scan(schema.archive_objects);
          const pairs = join(left, right, eq(constant(1), constant(1)));
          const leftColumns = [
            pairs.columns.left_start_hour,
            pairs.columns.left_site_pk,
            pairs.columns.left_format,
            pairs.columns.left_size_bytes,
          ];
          const rightColumns = [
            pairs.columns.right_start_hour,
            pairs.columns.right_site_pk,
            pairs.columns.right_format,
            pairs.columns.right_size_bytes,
          ];
          const query = project(pairs, {
            matched: nestedComparison(
              direction,
              leftColumns,
              rightColumns,
              width,
            ),
          });
          const optimized = compileD1Query(query);
          const expanded = compileD1QueryUnoptimizedForTest(query);
          expect(optimized.physicalPlanShape).toMatchObject({
            version: 9,
            lexicographicComparisons: expect.arrayContaining([
              { direction, componentCount: width, emissionCount: 1 },
            ]),
          });
          expect(optimized.sql.length).toBeLessThan(expanded.sql.length);
          expect(optimized.bindings).toEqual(expanded.bindings);
          expect(
            normalizeResultRows(
              db
                .prepare(optimized.sql)
                .all(...(optimized.bindings as SQLInputValue[])) as Record<
                string,
                unknown
              >[],
            ),
          ).toEqual(
            normalizeResultRows(
              db
                .prepare(expanded.sql)
                .all(...(expanded.bindings as SQLInputValue[])) as Record<
                string,
                unknown
              >[],
            ),
          );
        }
      }
    } finally {
      db.close();
    }
  });

  it("emits the selected tuple from a row-pipeline filter predicate", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const source = valuesRelation(textRowSchema, comparisonRows());
      const left = [source.columns.a0, source.columns.a1, source.columns.a2];
      const right = [source.columns.b0, source.columns.b1, source.columns.b2];
      const predicate = nestedComparison(">", left, right, 3);
      const filtered = filter(source, predicate);
      const query = project(filtered, { first: filtered.columns.a0 });
      const physical = lowerLogicalPlan(query);
      expect(
        physical.rowPipelineChoices.some((choice) =>
          choice.filters.some(
            ({ filter: filterNode }) => filterNode.predicate === predicate,
          ),
        ),
      ).toBe(true);
      const optimized = compileD1Query(query);
      const expanded = compileD1QueryUnoptimizedForTest(query);
      expect(optimized.physicalPlanShape).toMatchObject({
        version: 9,
        lexicographicComparisons: expect.arrayContaining([
          { direction: ">", componentCount: 3, emissionCount: 1 },
        ]),
      });
      expect(optimized.sql).toMatch(/\) > \(/u);
      expect(optimized.bindings).toEqual(expanded.bindings);
      expect(
        normalizeResultRows(
          db
            .prepare(optimized.sql)
            .all(...(optimized.bindings as SQLInputValue[])) as Record<
            string,
            unknown
          >[],
        ),
      ).toEqual(
        normalizeResultRows(
          db
            .prepare(expanded.sql)
            .all(...(expanded.bindings as SQLInputValue[])) as Record<
            string,
            unknown
          >[],
        ),
      );
    } finally {
      db.close();
    }
  });

  it("keeps SQLite three-valued results equal for NULL, numeric boundaries, mixed values, and collations", () => {
    const db = new DatabaseSync(":memory:");
    const literal = (value: string | number | bigint | null): string => {
      if (value === null) return "NULL";
      if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
      return value.toString();
    };
    try {
      for (const width of [2, 3, 4] as const) {
        const right = Array<string | number | bigint | null>(width).fill(7);
        const cases: Array<{
          left: Array<string | number | bigint | null>;
          right: Array<string | number | bigint | null>;
          collation?: "NOCASE";
        }> = [{ left: [...right], right: [...right] }];
        for (let index = 0; index < width; index += 1) {
          for (const decisive of [6, 8]) {
            const left = [...right];
            left[index] = decisive;
            for (let suffix = index + 1; suffix < width; suffix += 1)
              left[suffix] = null;
            cases.push({ left, right: [...right] });
          }
          const unknown = [...right];
          unknown[index] = null;
          for (let suffix = index + 1; suffix < width; suffix += 1)
            unknown[suffix] = 8;
          cases.push({ left: unknown, right: [...right] });
        }
        cases.push({
          left: [
            "2",
            ...Array<string | number | bigint | null>(width - 1).fill(null),
          ],
          right: [
            2,
            ...Array<string | number | bigint | null>(width - 1).fill(2),
          ],
        });
        cases.push({
          left: [
            1.5,
            ...Array<string | number | bigint | null>(width - 1).fill(null),
          ],
          right: [
            1.25,
            ...Array<string | number | bigint | null>(width - 1).fill(1.25),
          ],
        });
        cases.push({
          left: [
            9223372036854775807n,
            ...Array<string | number | bigint | null>(width - 1).fill(0),
          ],
          right: [
            9223372036854775806n,
            ...Array<string | number | bigint | null>(width - 1).fill(0),
          ],
        });
        cases.push({
          left: [
            "alpha",
            ...Array<string | number | bigint | null>(width - 1).fill("same"),
          ],
          right: [
            "ALPHA",
            ...Array<string | number | bigint | null>(width - 1).fill("same"),
          ],
          collation: "NOCASE",
        });

        for (const direction of [">", "<"] as const) {
          for (const { left, right: threshold, collation } of cases) {
            const names = Array.from(
              { length: width },
              (_, index) => `c${index}`,
            );
            const leftSql = names.map((name) =>
              collation ? `${name} COLLATE ${collation}` : name,
            );
            let expanded = `${leftSql[width - 1]} ${direction} ${literal(threshold[width - 1]!)}`;
            for (let index = width - 2; index >= 0; index -= 1)
              expanded = `(${leftSql[index]} ${direction} ${literal(threshold[index]!)}) OR (${leftSql[index]} = ${literal(threshold[index]!)} AND (${expanded}))`;
            const tuple = `(${leftSql.join(", ")}) ${direction} (${threshold.map(literal).join(", ")})`;
            const source = names
              .map((name, index) => `${literal(left[index]!)} AS ${name}`)
              .join(", ");
            const result = db
              .prepare(
                `SELECT (${expanded}) AS expanded, (${tuple}) AS tuple FROM (SELECT ${source})`,
              )
              .get() as { expanded: number | null; tuple: number | null };
            expect(result.tuple).toBe(result.expanded);
          }
        }
      }
    } finally {
      db.close();
    }
  });

  it("rejects missing or malformed physical components before they can drop a decisive key", () => {
    const source = valuesRelation(textRowSchema, [
      {
        a0: "m",
        a1: "z",
        a2: "a",
        a3: "m",
        b0: "m",
        b1: "m",
        b2: "m",
        b3: "m",
      },
    ]);
    const predicate = nestedComparison(
      ">",
      [source.columns.a0, source.columns.a1, source.columns.a2],
      [source.columns.b0, source.columns.b1, source.columns.b2],
      3,
    );
    const physical = lowerLogicalPlan(project(source, { matched: predicate }));
    const first = physical.lexicographicComparisonChoices[0]!;
    const sparseChoices = physical.lexicographicComparisonChoices.slice();
    delete sparseChoices[0];
    const sparseComponents = first.components.slice();
    delete sparseComponents[1];
    const malformedComponents: unknown[] = [
      sparseComponents,
      Array(first.components.length),
      null,
      { length: first.components.length },
      first.components.map((component, index) =>
        index === 1 ? null : component,
      ),
    ];
    const malformedChoices: unknown[] = [
      sparseChoices,
      physical.lexicographicComparisonChoices.map((choice, index) =>
        index === 0 ? null : choice,
      ),
      ...malformedComponents.map((components) =>
        physical.lexicographicComparisonChoices.map((choice, index) =>
          index === 0 ? { ...choice, components } : choice,
        ),
      ),
    ];
    for (const choices of malformedChoices) {
      const forged = {
        ...physical,
        lexicographicComparisonChoices: choices,
      } as typeof physical;
      expect(() => validatePhysicalQueryPlan(forged)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );
      expect(() => compileD1Query(forged)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );
    }
    const db = new DatabaseSync(":memory:");
    try {
      const compiled = compileD1Query(physical);
      expect(
        db.prepare(compiled.sql).get(...(compiled.bindings as SQLInputValue[])),
      ).toMatchObject({ matched: 1 });
    } finally {
      db.close();
    }
  });

  it("selects only exact direct-column, same-direction strict shapes and revalidates mutable plans", () => {
    const source = valuesRelation(textRowSchema, comparisonRows().slice(0, 1));
    const left = [source.columns.a0, source.columns.a1, source.columns.a2];
    const right = [source.columns.b0, source.columns.b1, source.columns.b2];
    const valid = nestedComparison(">", left, right, 3);
    const validPlan = lowerLogicalPlan(project(source, { matched: valid }));
    expect(validPlan.lexicographicComparisonChoices[0]?.expression).toBe(valid);
    expect(
      validPlan.lexicographicComparisonChoices[0]?.components,
    ).toHaveLength(3);

    const subquery = project(source, { matched: valid });
    const outer = project(source, { nestedResult: scalar(subquery) });
    const nestedPhysical = lowerLogicalPlan(outer);
    expect(nestedPhysical.lexicographicComparisonChoices[0]?.expression).toBe(
      valid,
    );
    expect(compileD1Query(outer).physicalPlanShape).toMatchObject({
      version: 9,
      lexicographicComparisonCount: 1,
    });

    const malformed: Predicate[] = [
      or(
        gt(left[0] as never, right[0] as never),
        and(
          eq(left[0] as never, right[0] as never),
          lt(left[1] as never, right[1] as never),
        ),
      ),
      or(
        gt(left[0] as never, right[0] as never),
        and(
          eq(right[0] as never, left[0] as never),
          gt(left[1] as never, right[1] as never),
        ),
      ),
      or(
        gte(left[0] as never, right[0] as never),
        and(
          eq(left[0] as never, right[0] as never),
          gt(left[1] as never, right[1] as never),
        ),
      ),
      or(
        gt(left[0] as never, right[0] as never),
        and(
          eq(left[0] as never, right[0] as never),
          gte(left[1] as never, right[1] as never),
        ),
      ),
      or(
        gt(left[0] as never, right[0] as never),
        and(
          eq(left[0] as never, right[0] as never),
          and(
            gt(left[1] as never, right[1] as never),
            eq(left[1] as never, right[1] as never),
          ),
        ),
      ),
      or(
        gt(left[0] as never, right[0] as never),
        or(
          and(
            eq(left[0] as never, right[0] as never),
            gt(left[1] as never, right[1] as never),
          ),
          gt(left[2] as never, right[2] as never),
        ),
      ),
      or(
        gt(callFunction("lower", left[0] as never), right[0] as never),
        and(
          eq(left[0] as never, right[0] as never),
          gt(left[1] as never, right[1] as never),
        ),
      ),
    ];
    for (const expression of malformed) {
      const physical = lowerLogicalPlan(
        project(source, { malformed: expression }),
      );
      expect(physical.lexicographicComparisonChoices).toHaveLength(0);
    }

    const other = valuesRelation(textRowSchema, comparisonRows().slice(0, 1));
    const invalidScope = nestedComparison(
      ">",
      [source.columns.a0, source.columns.a1],
      [other.columns.b0, other.columns.b1],
      2,
    );
    expect(() => lowerLogicalPlan(project(source, { invalidScope }))).toThrow();

    const forged = {
      ...validPlan,
      lexicographicComparisonChoices: [],
    };
    expect(() => validatePhysicalQueryPlan(forged)).toThrow(/lexicographic/u);

    const original = (
      validPlan.root as {
        projections: readonly { name: string; expression: AnyExpression }[];
      }
    ).projections;
    Object.assign(validPlan.root, {
      projections: [{ name: "matched", expression: malformed[0]! }],
    });
    expect(() => compileD1Query(validPlan)).toThrow();
    Object.assign(validPlan.root, { projections: original });
    expect(() => compileD1Query(validPlan)).not.toThrow();
  });
});
