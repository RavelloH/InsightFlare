import type { SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  and,
  callFunction,
  compileD1Query,
  distinct,
  eq,
  filter,
  gt,
  inSubquery,
  join,
  limit,
  param,
  project,
  rowNumber,
  scan,
  sort,
  union,
  valuesRelation,
  window,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import { schema } from "@/lib/db/schema";

const databases = new Set<ReturnType<typeof createMigratedDatabase>>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function databaseWithRowPipelineValues() {
  const database = createMigratedDatabase();
  databases.add(database);
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run("row-pipeline-site");
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get("row-pipeline-site") as { readonly site_pk: number }
    ).site_pk,
  );
  const insert = database.prepare(`
    INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, duration_ms, pathname, hostname, site_pk
    ) VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, ?, 'example.test', ?)
  `);
  const rows: readonly {
    readonly id: string;
    readonly duration: SQLInputValue;
    readonly path: string;
  }[] = [
    { id: "integer-a", duration: 7, path: "/keep" },
    { id: "integer-b", duration: 7, path: "/keep" },
    { id: "real", duration: 1.5, path: "/keep" },
    { id: "text", duration: "word", path: "/keep" },
    { id: "blob", duration: Uint8Array.from([0, 255, 1]), path: "/keep" },
    { id: "null", duration: null, path: "/keep" },
    { id: "case-mismatch", duration: 12, path: "/Keep" },
  ];
  rows.forEach(({ id, duration, path }, index) => {
    insert.run(
      id,
      "row-pipeline-site",
      `visitor-${id}`,
      `session-${id}`,
      index + 1,
      index + 1,
      duration,
      path,
      sitePk,
    );
  });
  return database;
}

function readRows(
  database: ReturnType<typeof createMigratedDatabase>,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
) {
  return database
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]))
    .map((row) => {
      const value = row.value;
      return {
        visit: row.visit,
        storage: row.storage,
        value:
          value instanceof Uint8Array
            ? [...value]
            : (value as string | number | null),
        copy:
          row.copy instanceof Uint8Array
            ? [...row.copy]
            : (row.copy as string | number | null),
      };
    })
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

describe("Generic row pipeline fusion", () => {
  it.each(["NOCASE", "RTRIM"] as const)(
    "preserves inherited %s collation through renamed columns",
    (collation) => {
      const database = databaseWithRowPipelineValues();
      database.exec(`
        CREATE TABLE row_pipeline_collated (
          visit_id TEXT NOT NULL,
          pathname TEXT COLLATE ${collation} NOT NULL
        )
      `);
      const values =
        collation === "NOCASE" ? ["a", "A", "b"] : ["x", "x ", "y"];
      values.forEach((value, index) => {
        database
          .prepare("INSERT INTO row_pipeline_collated VALUES (?, ?)")
          .run(String(index), value);
      });
      const table = {
        ...schema.visits,
        name: "row_pipeline_collated",
        defaultCollation: "unknown" as const,
        columns: {
          visit_id: {
            ...schema.visits.columns.visit_id,
            table: "row_pipeline_collated",
          },
          pathname: {
            ...schema.visits.columns.pathname,
            table: "row_pipeline_collated",
          },
        },
        primaryKey: [],
        indexes: [],
        foreignKeys: [],
      };
      // Register this DDL-matching fixture without weakening scan validation.
      const catalogKey = "__row_pipeline_collated_test";
      Object.defineProperty(schema, catalogKey, {
        value: table,
        enumerable: true,
        configurable: true,
      });
      try {
        // The generated catalog's static union cannot name this temporary table.
        const source = scan(table as unknown as typeof schema.visits);
        const renamed = project(source, {
          visit: source.columns.visit_id,
          value: source.columns.pathname,
        });
        const probe = values[0]!;
        const selected = filter(
          renamed,
          eq(renamed.columns.value, param(probe)),
        );
        const reordered = project(selected, {
          value: selected.columns.value,
          visit: selected.columns.visit,
        });
        const output = filter(
          reordered,
          eq(reordered.columns.value, param(probe)),
        );
        const physical = lowerLogicalPlan(output);
        expect(
          physical.rowPipelineChoices.some(({ root }) => root === output.node),
        ).toBe(true);
        const read = (query: ReturnType<typeof compileD1Query>) =>
          database
            .prepare(query.sql)
            .all(...(query.bindings as SQLInputValue[]))
            .map(({ visit, value }) => ({ visit, value }))
            .sort((a, b) => String(a.visit).localeCompare(String(b.visit)));
        const baseline = read(compileD1QueryUnoptimizedForTest(output));
        expect(baseline).toEqual([
          { visit: "0", value: values[0] },
          { visit: "1", value: values[1] },
        ]);
        expect(read(compileD1Query(output))).toEqual(baseline);
      } finally {
        Reflect.deleteProperty(schema, catalogKey);
      }
    },
  );

  it("keeps a guarded overflowing computed column behind the pipeline leaf", () => {
    const database = databaseWithRowPipelineValues();
    database.exec(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, duration_ms, pathname, hostname, site_pk
      ) SELECT 'guarded-overflow', site_id, 'guarded-overflow', 'guarded-overflow',
        'complete', 99, 99, -9223372036854775808, '/keep', 'example.test', site_pk
      FROM site_identities WHERE site_id = 'row-pipeline-site'
    `);
    const source = scan(schema.visits);
    const computed = project(source, {
      visit: source.columns.visit_id,
      magnitude: callFunction("abs", source.columns.duration_ms),
    });
    const forwarded = project(computed, {
      visit: computed.columns.visit,
      magnitude: computed.columns.magnitude,
    });
    const selected = filter(
      forwarded,
      eq(forwarded.columns.visit, param("integer-a")),
    );
    const output = project(selected, {
      visit: selected.columns.visit,
      magnitude: selected.columns.magnitude,
    });
    const choice = lowerLogicalPlan(output).rowPipelineChoices.find(
      ({ root }) => root === output.node,
    );
    expect(choice?.leaf.node).toBe(computed.node);
    const read = (query: ReturnType<typeof compileD1Query>) =>
      database
        .prepare(query.sql)
        .all(...(query.bindings as SQLInputValue[]))
        .map(({ visit, magnitude }) => ({ visit, magnitude }));
    const baseline = read(compileD1QueryUnoptimizedForTest(output));
    expect(baseline).toEqual([{ visit: "integer-a", magnitude: 7 }]);
    expect(read(compileD1Query(output))).toEqual(baseline);
  });

  it("preserves SQLite storage classes, BINARY filtering, duplicate rows, and bindings", () => {
    const database = databaseWithRowPipelineValues();
    const visits = scan(schema.visits);
    const projected = project(visits, {
      visit: visits.columns.visit_id,
      value: visits.columns.duration_ms,
      path: visits.columns.pathname,
      copy: visits.columns.duration_ms,
    });
    const firstFilter = filter(
      projected,
      eq(projected.columns.path, param("/keep")),
    );
    const secondProject = project(firstFilter, {
      path: firstFilter.columns.path,
      copy: firstFilter.columns.copy,
      visit: firstFilter.columns.visit,
      value: firstFilter.columns.value,
    });
    const filtered = filter(
      secondProject,
      eq(secondProject.columns.path, param("/keep")),
    );
    const output = project(filtered, {
      visit: filtered.columns.visit,
      value: filtered.columns.value,
      copy: filtered.columns.copy,
      storage: callFunction("storage-class", filtered.columns.value),
    });

    const optimized = compileD1Query(output);
    const baseline = compileD1QueryUnoptimizedForTest(output);
    const physical = lowerLogicalPlan(output);

    expect(
      physical.rowPipelineChoices
        .find((choice) => choice.root === filtered.node)
        ?.nodes.map(({ kind }) => kind),
    ).toEqual(["filter", "project", "filter"]);
    expect(
      physical.rowPipelineChoices.find(
        (choice) => choice.root === filtered.node,
      )?.leaf.node,
    ).toBe(projected.node);
    expect(optimized.physicalPlanShape?.version).toBe(8);
    expect(JSON.stringify(optimized.physicalPlanShape)).not.toContain("/keep");
    expect(optimized.bindings).toEqual(baseline.bindings);
    expect(optimized.bindings).toEqual(["/keep", "/keep"]);
    expect(optimized.sql.length).toBeLessThan(baseline.sql.length);
    expect(readRows(database, optimized)).toEqual(readRows(database, baseline));

    const result = readRows(database, optimized);
    expect(result).toHaveLength(6);
    expect(result.filter((row) => row.storage === "integer")).toHaveLength(2);
    expect(result.map((row) => row.storage).sort()).toEqual([
      "blob",
      "integer",
      "integer",
      "null",
      "real",
      "text",
    ]);
  });

  it("stops at computed projections and declines unsafe or query-edge filters", () => {
    const visits = scan(schema.visits);
    const computed = project(visits, {
      magnitude: callFunction("abs", visits.columns.duration_ms),
      visit: visits.columns.visit_id,
    });
    const forwarded = project(computed, {
      magnitude: computed.columns.magnitude,
      visit: computed.columns.visit,
    });
    const afterComputed = filter(
      forwarded,
      gt(forwarded.columns.magnitude, param(0)),
    );
    const computedPhysical = lowerLogicalPlan(afterComputed);
    const computedChoice = computedPhysical.rowPipelineChoices.find(
      (choice) => choice.root === afterComputed.node,
    );

    expect(computedChoice).toBeDefined();
    expect(computedChoice?.leaf.node).toBe(computed.node);
    expect(computedChoice?.nodes).not.toContain(computed.node);

    const direct = project(visits, {
      duration: visits.columns.duration_ms,
      visit: visits.columns.visit_id,
    });
    const unsafeFilter = filter(
      direct,
      gt(callFunction("abs", direct.columns.duration), param(0)),
    );
    expect(lowerLogicalPlan(unsafeFilter).rowPipelineChoices).toHaveLength(0);
    const database = databaseWithRowPipelineValues();
    database.exec(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, duration_ms, pathname, hostname, site_pk
      )
      SELECT 'abs-minimum-integer', site_id, 'abs-minimum-integer',
        'abs-minimum-integer', 'complete', 99, 99, -9223372036854775808,
        '/keep', 'example.test', site_pk
      FROM site_identities WHERE site_id = 'row-pipeline-site'
    `);
    const optimizedUnsafe = compileD1Query(unsafeFilter);
    const baselineUnsafe = compileD1QueryUnoptimizedForTest(unsafeFilter);
    const readUnsafe = (query: {
      readonly sql: string;
      readonly bindings?: readonly unknown[];
    }) =>
      database
        .prepare(query.sql)
        .all(...((query.bindings ?? []) as SQLInputValue[]));
    expect(() => readUnsafe(optimizedUnsafe)).toThrow(/integer overflow/i);
    expect(() => readUnsafe(baselineUnsafe)).toThrow(/integer overflow/i);

    const outerScan = scan(schema.site_identities);
    const outer = project(outerScan, {
      site: outerScan.columns.site_id,
    });
    const innerScan = scan(schema.site_identities);
    const correlatedFilter = filter(
      innerScan,
      eq(innerScan.columns.site_id, outer.columns.site),
    );
    const inner = project(correlatedFilter, {
      site: correlatedFilter.columns.site_id,
    });
    const queryEdgeFilter = filter(
      outer,
      inSubquery(outer.columns.site, inner),
    );
    expect(lowerLogicalPlan(queryEdgeFilter).rowPipelineChoices).toHaveLength(
      0,
    );
  });

  it("keeps sort, limit, window, and shared relations outside fused segments", () => {
    const sortedInput = scan(schema.visits);
    const sorted = sort(sortedInput, [
      { expression: sortedInput.columns.started_at, direction: "ASC" },
    ]);
    const sortedProject = project(sorted, {
      visit: sorted.columns.visit_id,
      path: sorted.columns.pathname,
    });
    const sortedFilter = filter(
      sortedProject,
      eq(sortedProject.columns.path, param("/keep")),
    );
    const sortedPlan = lowerLogicalPlan(sortedFilter);
    const sortedChoice = sortedPlan.rowPipelineChoices.find(
      (choice) => choice.root === sortedFilter.node,
    );
    expect(sortedChoice?.leaf.node).toBe(sorted.node);
    expect(sortedChoice?.nodes.map(({ kind }) => kind)).toEqual([
      "filter",
      "project",
    ]);

    const limitedInput = scan(schema.visits);
    const limited = limit(limitedInput, 3);
    const limitedProject = project(limited, {
      visit: limited.columns.visit_id,
      path: limited.columns.pathname,
    });
    const limitedFilter = filter(
      limitedProject,
      eq(limitedProject.columns.path, param("/keep")),
    );
    const limitedPlan = lowerLogicalPlan(limitedFilter);
    const limitedChoice = limitedPlan.rowPipelineChoices.find(
      (choice) => choice.root === limitedFilter.node,
    );
    expect(limitedChoice?.leaf.node).toBe(limited.node);
    expect(limitedChoice?.nodes.map(({ kind }) => kind)).toEqual([
      "filter",
      "project",
    ]);

    const windowInput = scan(schema.visits);
    const windowed = window(windowInput, {
      sequence: rowNumber({
        orderBy: [
          { expression: windowInput.columns.started_at, direction: "ASC" },
        ],
      }),
    });
    const windowProject = project(windowed, {
      visit: windowed.columns.visit_id,
      path: windowed.columns.pathname,
    });
    const windowFilter = filter(
      windowProject,
      eq(windowProject.columns.path, param("/keep")),
    );
    const windowPlan = lowerLogicalPlan(windowFilter);
    const windowChoice = windowPlan.rowPipelineChoices.find(
      (choice) => choice.root === windowFilter.node,
    );
    expect(windowChoice?.leaf.node).toBe(windowed.node);
    expect(windowChoice?.nodes.map(({ kind }) => kind)).toEqual([
      "filter",
      "project",
    ]);

    const identities = scan(schema.site_identities);
    const sharedProjection = project(identities, {
      site: identities.columns.site_id,
    });
    const selected = filter(
      sharedProjection,
      eq(sharedProjection.columns.site, param("row-pipeline-shared")),
    );
    const repeated = union(selected, selected, true);
    const repeatedPlan = lowerLogicalPlan(repeated);
    const sharedNodes = new Set(
      repeatedPlan.sharedRelations.map((definition) => definition.node),
    );
    expect(sharedNodes.size).toBeGreaterThan(0);
    expect(
      repeatedPlan.rowPipelineChoices.some(
        (choice) =>
          sharedNodes.has(choice.root) || sharedNodes.has(choice.leaf.node),
      ),
    ).toBe(false);
  });

  it("preserves an interior canonical tuple renderer in an outer pipeline", () => {
    const database = createMigratedDatabase();
    databases.add(database);
    const insertSite = database.prepare(
      "INSERT INTO site_identities (site_id) VALUES (?)",
    );
    insertSite.run("tuple-site-a");
    insertSite.run("tuple-site-b");
    const sitePk = (siteId: string) =>
      Number(
        (
          database
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get(siteId) as { readonly site_pk: number }
        ).site_pk,
      );
    const insertVisit = database.prepare(`
      INSERT INTO visits (
        visit_id, site_id, visitor_id, session_id, status, started_at,
        last_activity_at, pathname, hostname, site_pk
      ) VALUES (?, ?, ?, ?, 'complete', 1, 1, '/', 'tuple.test', ?)
    `);
    insertVisit.run(
      "tuple-a-1",
      "tuple-site-a",
      "v1",
      "tuple-a",
      sitePk("tuple-site-a"),
    );
    insertVisit.run(
      "tuple-a-2",
      "tuple-site-a",
      "v2",
      "tuple-a",
      sitePk("tuple-site-a"),
    );
    insertVisit.run(
      "tuple-b-1",
      "tuple-site-b",
      "v3",
      "tuple-b",
      sitePk("tuple-site-b"),
    );

    const finiteRows = valuesRelation(
      {
        siteId: { affinity: "text", nullable: false },
        sessionId: { affinity: "text", nullable: false },
      } as const,
      [
        ...Array.from({ length: 101 }, () => ({
          siteId: "tuple-site-a",
          sessionId: "tuple-a",
        })),
        { siteId: "tuple-site-b", sessionId: "tuple-b" },
      ],
    );
    const authorizedSites = scan(schema.site_identities);
    const authorizedPairs = join(
      finiteRows,
      authorizedSites,
      eq(finiteRows.columns.siteId, authorizedSites.columns.site_id),
    );
    const keyProjection = project(authorizedPairs, {
      sessionKey: authorizedPairs.columns.left_sessionId,
      ownerKey: authorizedPairs.columns.right_site_pk,
    });
    const keys = distinct(keyProjection);
    const visits = scan(schema.visits);
    const matches = join(
      visits,
      keys,
      and(
        eq(visits.columns.site_pk, keys.columns.ownerKey),
        eq(visits.columns.session_id, keys.columns.sessionKey),
      ),
    );
    const canonicalProject = project(matches, {
      siteId: matches.columns.left_site_id,
      sessionId: matches.columns.left_session_id,
    });
    const outerFilter = filter(
      canonicalProject,
      eq(canonicalProject.columns.siteId, param("tuple-site-a")),
    );
    const output = project(outerFilter, {
      sessionId: outerFilter.columns.sessionId,
      siteId: outerFilter.columns.siteId,
    });
    const physical = lowerLogicalPlan(output);
    expect(
      physical.positiveTupleMembershipCandidates.some(
        ({ project: candidate }) => candidate === canonicalProject.node,
      ),
    ).toBe(true);
    const pipeline = physical.rowPipelineChoices.find(
      ({ root }) => root === output.node,
    );
    expect(pipeline?.leaf.node).toBe(canonicalProject.node);
    expect(pipeline?.nodes).not.toContain(canonicalProject.node);

    const optimized = compileD1Query(output);
    expect(optimized.sql).toContain(" IN (SELECT ");
    expect(optimized.bindings?.length ?? 0).toBeLessThanOrEqual(100);
    const read = (query: ReturnType<typeof compileD1Query>) =>
      database
        .prepare(query.sql)
        .all(...(query.bindings as SQLInputValue[]))
        .sort((left, right) =>
          String(left.sessionId).localeCompare(String(right.sessionId)),
        );
    expect(read(optimized)).toEqual([
      { sessionId: "tuple-a", siteId: "tuple-site-a" },
      { sessionId: "tuple-a", siteId: "tuple-site-a" },
    ]);
  });

  it("rejects forged row pipeline choices during physical-plan validation", () => {
    const identities = scan(schema.site_identities);
    const projected = project(identities, {
      site: identities.columns.site_id,
    });
    const filtered = filter(projected, eq(projected.columns.site, param("x")));
    const renamed = project(filtered, { site: filtered.columns.site });
    const output = filter(renamed, eq(renamed.columns.site, param("y")));
    const physical = lowerLogicalPlan(output);
    const choice = physical.rowPipelineChoices.find(
      ({ root }) => root === output.node,
    );
    expect(choice).toBeDefined();
    if (!choice) throw new Error("expected a canonical row pipeline choice");

    const forged = {
      ...physical,
      rowPipelineChoices: [
        { ...choice, outputColumnIndexes: [Number.MAX_SAFE_INTEGER] },
      ],
    };
    expect(() => validatePhysicalQueryPlan(forged)).toThrow(
      "Physical row-pipeline choices are inconsistent",
    );
  });
});
