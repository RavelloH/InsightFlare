import type { DatabaseSync } from "node:sqlite";
import { type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  filter,
  gt,
  limit,
  param,
  project,
  scan,
  sort,
  union,
  unixepoch,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import { lowerLogicalPlan } from "@/lib/db/query/physical-plan";
import { schema } from "@/lib/db/schema";

const databases = new Set<DatabaseSync>();

function selectedProjection(width: number, selective = true) {
  const identities = scan(schema.site_identities);
  const projected = project(identities, {
    sitePk: identities.columns.site_pk,
    siteId: identities.columns.site_id,
  });
  const filtered = selective
    ? filter(projected, gt(projected.columns.sitePk, param(0)))
    : projected;
  const available = Object.values(filtered.columns) as AnyExpression[];
  const projections: Record<string, AnyExpression> = {};
  for (let index = 0; index < width; index += 1)
    projections[`field${index}`] = available[index % available.length]!;
  return project(filtered, projections);
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function repeatedThree(relation: ReturnType<typeof selectedProjection>) {
  return union(union(relation, relation, true), relation, true);
}

describe("shared relation physical selection", () => {
  it.each([5, 16])(
    "materializes a selective self-contained %i-field relation used three times",
    (width) => {
      const relation = selectedProjection(width);
      const repeated = repeatedThree(relation);
      const physical = lowerLogicalPlan(repeated);
      const definition = physical.sharedRelations.find(
        (shared) => shared.node === relation.node,
      );

      expect(definition).toMatchObject({
        materialization: "materialized",
      });
      expect(definition?.fields).toHaveLength(width);
      const compiled = compileD1Query(physical);
      expect(compiled.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
      expect(compiled.physicalPlanShape?.cteCount).toBe(1);
    },
  );

  it("does not widen the prior narrow or reuse-count policy", () => {
    const narrow = selectedProjection(4);
    const narrowQuery = compileD1Query(repeatedThree(narrow));
    expect(narrowQuery.sql).toContain(" AS (");
    expect(narrowQuery.sql).not.toContain("AS MATERIALIZED");

    const fiveFieldsTwice = selectedProjection(5);
    expect(
      lowerLogicalPlan(union(fiveFieldsTwice, fiveFieldsTwice, true))
        .sharedRelations,
    ).toEqual([]);

    const seventeenFields = selectedProjection(17);
    expect(
      lowerLogicalPlan(repeatedThree(seventeenFields)).sharedRelations,
    ).toEqual([]);

    const identityTable = scan(schema.site_identities);
    const wideInput = project(identityTable, {
      field0: identityTable.columns.site_pk,
      field1: identityTable.columns.site_id,
      field2: identityTable.columns.site_pk,
      field3: identityTable.columns.site_id,
      field4: identityTable.columns.site_pk,
    });
    const selectiveWideFilter = filter(
      wideInput,
      gt(wideInput.columns.field0, param(0)),
    );
    expect(
      lowerLogicalPlan(repeatedThree(selectiveWideFilter)).sharedRelations,
    ).toEqual([]);
  });

  it("requires selective deterministic input and rejects scope barriers", () => {
    const fullScan = selectedProjection(5, false);
    expect(lowerLogicalPlan(repeatedThree(fullScan)).sharedRelations).toEqual(
      [],
    );

    const identities = scan(schema.site_identities);
    const projected = project(identities, {
      sitePk: identities.columns.site_pk,
      siteId: identities.columns.site_id,
    });
    const filtered = filter(projected, gt(projected.columns.sitePk, param(0)));
    const volatile = project(filtered, {
      field0: filtered.columns.sitePk,
      field1: filtered.columns.siteId,
      field2: unixepoch(),
      field3: filtered.columns.sitePk,
      field4: filtered.columns.siteId,
    });
    expect(lowerLogicalPlan(repeatedThree(volatile)).sharedRelations).toEqual(
      [],
    );

    const safe = selectedProjection(5);
    const branches = union(union(safe, safe, true), safe, true);
    const limitedRoot = limit(branches, 10);
    expect(lowerLogicalPlan(limitedRoot).sharedRelations).toEqual([]);

    const branchSorted = sort(safe, [
      { expression: safe.columns.field0, direction: "ASC" },
    ]);
    const mixedSorted = union(union(branchSorted, safe, true), safe, true);
    expect(lowerLogicalPlan(mixedSorted).sharedRelations).toEqual([]);
  });

  it("allows a terminal root sort and preserves UNION ALL order and multiplicity", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)")
      .run("site-b", "site-a");
    const relation = selectedProjection(5);
    const repeated = repeatedThree(relation);
    const ordered = sort(repeated, [
      { expression: repeated.columns.field1, direction: "ASC" },
    ]);
    const physical = lowerLogicalPlan(ordered);
    const selected = physical.sharedRelations.find(
      (shared) => shared.node === relation.node,
    );
    expect(selected?.materialization).toBe("materialized");

    const optimized = compileD1Query(physical);
    const mechanical = compileD1QueryUnoptimizedForTest(ordered);
    expect(optimized.sql.match(/ AS MATERIALIZED \(/gu)).toHaveLength(1);
    expect(optimized.sql.lastIndexOf("ORDER BY")).toBeGreaterThan(
      optimized.sql.lastIndexOf("UNION ALL"),
    );
    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as SQLInputValue[]));
    const mechanicalRows = database
      .prepare(mechanical.sql)
      .all(...(mechanical.bindings as SQLInputValue[]));
    expect(optimizedRows).toEqual(mechanicalRows);
    expect(optimizedRows).toHaveLength(6);

    const forged = {
      ...physical,
      sharedRelations: physical.sharedRelations.map((shared) => ({
        ...shared,
        materialization: "auto" as const,
      })),
    };
    expect(() => compileD1Query(forged)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });
});
