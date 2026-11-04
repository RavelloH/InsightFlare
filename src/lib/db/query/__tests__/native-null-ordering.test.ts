import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  callFunction,
  caseWhen,
  castInteger,
  compileD1Query,
  constant,
  isNotNull,
  isNull,
  param,
  project,
  rowNumber,
  scan,
  window,
} from "@/lib/db";
import { analyzeNativeNullOrdering } from "@/lib/db/query/physical/native-null-ordering";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import { schema } from "@/lib/db/schema";

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function rankedRows(input: {
  readonly guardIsNull: boolean;
  readonly guardDirection: "ASC" | "DESC";
  readonly valueDirection: "ASC" | "DESC";
  readonly includeNeutralKey?: boolean;
}) {
  const source = scan(schema.visits);
  const column = source.columns.duration_ms!;
  const guard = input.guardIsNull ? isNull(column) : isNotNull(column);
  const orderBy = input.includeNeutralKey
    ? [
        { expression: guard, direction: input.guardDirection },
        { expression: param(0), direction: "ASC" as const },
        { expression: column, direction: input.valueDirection },
        { expression: source.columns.visit_id!, direction: "ASC" as const },
      ]
    : [
        { expression: guard, direction: input.guardDirection },
        { expression: column, direction: input.valueDirection },
        { expression: source.columns.visit_id!, direction: "ASC" as const },
      ];
  const ranked = window(source, {
    rowRank: rowNumber({ orderBy: orderBy as never }),
  });
  return project(ranked, {
    id: ranked.columns.visit_id!,
    duration: ranked.columns.duration_ms!,
    storageClass: callFunction("storage-class", ranked.columns.duration_ms!),
    rank: ranked.columns.rowRank!,
  });
}

function sqliteRows(sql: string, bindings: readonly unknown[]) {
  const database = new DatabaseSync(":memory:");
  databases.add(database);
  const columns = Object.values(schema.visits.columns)
    .map(({ sqlName }) => `"${sqlName}"`)
    .join(", ");
  database.exec(
    `CREATE TABLE visits (${columns});` +
      "INSERT INTO visits (visit_id, duration_ms, started_at) VALUES " +
      "('integer-b', 7, 1), ('integer-a', 7, 1), ('real', 1.5, 2), " +
      "('text', 'word', 3), ('blob', x'00ff01', 3), ('null', NULL, 4)",
  );
  return database.prepare(sql).all(...(bindings as SQLInputValue[]));
}

describe("typed ROW_NUMBER native NULL ordering", () => {
  for (const guardKind of ["IS NULL", "IS NOT NULL"] as const) {
    for (const guardDirection of ["ASC", "DESC"] as const) {
      for (const valueDirection of ["ASC", "DESC"] as const) {
        it(`preserves rows for ${guardKind} ${guardDirection}, value ${valueDirection}`, () => {
          const optimized = compileD1Query(
            rankedRows({
              guardIsNull: guardKind === "IS NULL",
              guardDirection,
              valueDirection,
            }),
          );
          const original = compileD1Query(
            rankedRows({
              guardIsNull: guardKind === "IS NULL",
              guardDirection,
              valueDirection,
              includeNeutralKey: true,
            }),
          );

          expect(optimized.sql).toContain(
            `NULLS ${
              guardKind === "IS NOT NULL"
                ? guardDirection === "ASC"
                  ? "FIRST"
                  : "LAST"
                : guardDirection === "ASC"
                  ? "LAST"
                  : "FIRST"
            }`,
          );
          expect(optimized.sql).not.toContain("IS NULL");
          expect(optimized.sql).not.toContain("IS NOT NULL");
          expect(optimized.physicalPlanShape?.version).toBe(12);
          expect(
            optimized.physicalPlanShape?.version === 12
              ? optimized.physicalPlanShape.nativeNullOrderingCount
              : 0,
          ).toBe(1);
          expect(sqliteRows(optimized.sql, optimized.bindings ?? [])).toEqual(
            sqliteRows(original.sql, original.bindings ?? []),
          );
        });
      }
    }
  }

  it("preserves native ordering for a non-null typed key", () => {
    const source = scan(schema.visits);
    const startedAt = source.columns.started_at!;
    const optimizedRanked = window(source, {
      rank: rowNumber({
        orderBy: [
          { expression: isNull(startedAt), direction: "ASC" },
          { expression: startedAt, direction: "DESC" },
          { expression: source.columns.visit_id!, direction: "ASC" },
        ],
      }),
    });
    const baselineRanked = window(source, {
      rank: rowNumber({
        orderBy: [
          { expression: isNull(startedAt), direction: "ASC" },
          { expression: param(0), direction: "ASC" },
          { expression: startedAt, direction: "DESC" },
          { expression: source.columns.visit_id!, direction: "ASC" },
        ],
      }),
    });
    const optimized = compileD1Query(
      project(optimizedRanked, {
        id: optimizedRanked.columns.visit_id!,
        rank: optimizedRanked.columns.rank!,
      }),
    );
    const baseline = compileD1Query(
      project(baselineRanked, {
        id: baselineRanked.columns.visit_id!,
        rank: baselineRanked.columns.rank!,
      }),
    );

    expect(optimized.sql).toContain("NULLS LAST");
    expect(sqliteRows(optimized.sql, optimized.bindings ?? [])).toEqual(
      sqliteRows(baseline.sql, baseline.bindings ?? []),
    );
  });

  it("revalidates current pairs and rejects non-direct, cast, and separated keys", () => {
    const source = scan(schema.visits);
    const duration = source.columns.duration_ms!;
    const exact = window(source, {
      rank: rowNumber({
        orderBy: [
          { expression: isNull(duration), direction: "ASC" },
          { expression: duration, direction: "DESC" },
        ],
      }),
    });
    const physical = lowerLogicalPlan(exact);
    expect(physical.nativeNullOrderingChoices).toHaveLength(1);
    expect(validatePhysicalQueryPlan(physical)).toBeDefined();
    expect(() =>
      validatePhysicalQueryPlan({
        ...physical,
        nativeNullOrderingChoices: [],
      }),
    ).toThrow(/native null-ordering choices are inconsistent/u);
    expect(() =>
      validatePhysicalQueryPlan({
        ...physical,
        nativeNullOrderingChoices: [
          ...physical.nativeNullOrderingChoices,
          physical.nativeNullOrderingChoices[0]!,
        ],
      }),
    ).toThrow(/native null-ordering choices are inconsistent/u);

    const casted = window(source, {
      rank: rowNumber({
        orderBy: [
          { expression: isNull(castInteger(duration)), direction: "ASC" },
          { expression: castInteger(duration), direction: "DESC" },
        ],
      }),
    });
    expect(analyzeNativeNullOrdering(casted.node)).toHaveLength(0);

    const separated = window(source, {
      rank: rowNumber({
        orderBy: [
          { expression: isNull(duration), direction: "ASC" },
          { expression: constant(0), direction: "ASC" },
          { expression: duration, direction: "DESC" },
        ],
      }),
    });
    expect(analyzeNativeNullOrdering(separated.node)).toHaveLength(0);

    const otherScope = scan(schema.site_identities);
    const crossScope = window(source, {
      rank: rowNumber({
        orderBy: [
          { expression: isNull(otherScope.columns.site_pk!), direction: "ASC" },
          { expression: otherScope.columns.site_pk!, direction: "DESC" },
        ],
      }),
    });
    expect(analyzeNativeNullOrdering(crossScope.node)).toHaveLength(0);

    const functionKey = window(source, {
      rank: rowNumber({
        orderBy: [
          {
            expression: isNull(callFunction("abs", duration)),
            direction: "ASC",
          },
          { expression: callFunction("abs", duration), direction: "DESC" },
        ],
      }),
    });
    expect(analyzeNativeNullOrdering(functionKey.node)).toHaveLength(0);

    const caseKey = caseWhen(
      [{ when: isNotNull(duration), then: duration }],
      duration,
    );
    const caseWindow = window(source, {
      rank: rowNumber({
        orderBy: [
          { expression: isNull(caseKey), direction: "ASC" },
          { expression: caseKey, direction: "DESC" },
        ],
      }),
    });
    expect(analyzeNativeNullOrdering(caseWindow.node)).toHaveLength(0);

    const samePairIndexes = window(source, {
      firstRank: rowNumber({
        orderBy: [
          { expression: isNull(duration), direction: "ASC" },
          { expression: duration, direction: "DESC" },
        ],
      }),
      secondRank: rowNumber({
        orderBy: [
          {
            expression: isNotNull(source.columns.started_at!),
            direction: "DESC",
          },
          { expression: source.columns.started_at!, direction: "ASC" },
        ],
      }),
    });
    expect(analyzeNativeNullOrdering(samePairIndexes.node)).toHaveLength(2);
  });
});
