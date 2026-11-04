import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  constant,
  createDatabaseRuntime,
  eq,
  filter,
  lowerLogicalPlan,
  param,
  project,
  rowNumber,
  scan,
  sort,
  window,
} from "@/lib/db";
import {
  hashVersionFourteenPhysicalShape,
  isValidVersionFourteenPhysicalShape,
} from "@/lib/db/physical-shape-v14";
import {
  compileD1QueryWithDiagnosticsForTest,
  compileD1QueryWithoutCompileOrderForTest,
} from "@/lib/db/query/compiler";
import { DatabaseCompilerError } from "@/lib/db/query/errors";
import { derivePhysicalCompileOrderPolicy } from "@/lib/db/query/physical/compile-order";
import type {
  PhysicalCompileOrderPolicy,
  SharedRelationDefinition,
} from "@/lib/db/query/physical/contracts";
import { validatePhysicalQueryPlan } from "@/lib/db/query/physical-plan";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import {
  type CompileOrderSharedReference,
  renderCompileOrderGuard,
  renderCompileOrderHelper,
  scheduledCompileOrderLeaves,
} from "@/lib/db/query/render/compile-order";
import { createFinalRenderSession } from "@/lib/db/query/render/final-render-session";
import {
  concat as provenanceConcat,
  finalRenderEmissionCounts,
  recordFinalRenderEmission,
} from "@/lib/db/query/render/fragment-provenance";
import { schema } from "@/lib/db/schema";
import { text } from "@/lib/db/sql/fragment";
import type {
  DatabasePhysicalPlanShape,
  DatabaseQueryObservation,
} from "@/lib/db/types";

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function fakeNode(name: string): LogicalQueryNode {
  return { kind: "values-relation", name } as unknown as LogicalQueryNode;
}

function fakeDefinition(
  name: string,
  node: LogicalQueryNode,
  dependencies: readonly string[],
  materialization: "auto" | "materialized",
  strict = false,
): SharedRelationDefinition {
  return {
    name,
    node,
    scope: {} as SharedRelationDefinition["scope"],
    fields: [],
    dependencies,
    materialization,
    ...(strict
      ? {
          materializationSelection: {
            kind: "strict-serial-rank-stage" as const,
            choiceIndex: 0,
          },
        }
      : {}),
  };
}

function reference(
  definitions: readonly SharedRelationDefinition[],
  definitionIndex: number,
): CompileOrderSharedReference {
  return {
    definition: definitions[definitionIndex]!.node,
    definitionIndex,
    emissionCount: 1,
  };
}

function policy(candidates: readonly number[]): PhysicalCompileOrderPolicy {
  return {
    kind: "strict-rank-materialization-order",
    rootSort: { kind: "sort" } as PhysicalCompileOrderPolicy["rootSort"],
    strictStageDefinitionIndexes: [0],
    candidateDefinitionIndexes: candidates,
  };
}

describe("typed compile-order helper", () => {
  it("orders reachable materialized leaves through auto definitions and omits unreachable leaves", () => {
    const nodes = [0, 1, 2, 3].map((index) => fakeNode(`node-${index}`));
    const definitions = [
      fakeDefinition("mat-0", nodes[0]!, [], "materialized", true),
      fakeDefinition("auto-1", nodes[1]!, ["mat-0"], "auto"),
      fakeDefinition("mat-2", nodes[2]!, ["auto-1"], "materialized"),
      fakeDefinition("mat-3", nodes[3]!, [], "materialized"),
    ];
    const scheduled = scheduledCompileOrderLeaves({
      policy: policy([0, 2, 3]),
      definitions,
      referencesByDefinition: [
        [],
        [reference(definitions, 0)],
        [reference(definitions, 1)],
        [],
      ],
      mainReferences: [reference(definitions, 2)],
    });

    expect(scheduled).toEqual([0, 2]);
  });

  it("falls back with fewer than two leaves and over the internal cap", () => {
    const definitions = [0, 1].map((index) =>
      fakeDefinition(
        `mat-${index}`,
        fakeNode(`node-${index}`),
        [],
        "materialized",
        index === 0,
      ),
    );
    const sharedPolicy = policy([0, 1]);
    const emptyBodies = definitions.map(
      () => [] as CompileOrderSharedReference[],
    );
    expect(
      scheduledCompileOrderLeaves({
        policy: sharedPolicy,
        definitions,
        referencesByDefinition: emptyBodies,
        mainReferences: [],
      }),
    ).toBeUndefined();
    expect(
      scheduledCompileOrderLeaves({
        policy: sharedPolicy,
        definitions,
        referencesByDefinition: emptyBodies,
        mainReferences: [reference(definitions, 0)],
      }),
    ).toBeUndefined();

    const many = Array.from({ length: 101 }, (_unused, index) =>
      fakeDefinition(
        `mat-${index}`,
        fakeNode(`node-${index}`),
        [],
        "materialized",
        index === 0,
      ),
    );
    const manyPolicy = policy(many.map((_definition, index) => index));
    expect(
      scheduledCompileOrderLeaves({
        policy: manyPolicy,
        definitions: many,
        referencesByDefinition: many.map(() => []),
        mainReferences: many.map((_definition, index) =>
          reference(many, index),
        ),
      }),
    ).toBeUndefined();
  });

  it("rejects stale and forward typed dependencies as invalid plans", () => {
    const definitions = [
      fakeDefinition("mat-0", fakeNode("node-0"), [], "materialized", true),
      fakeDefinition("mat-1", fakeNode("node-1"), [], "materialized"),
    ];
    expect(() =>
      scheduledCompileOrderLeaves({
        policy: policy([0, 1]),
        definitions,
        referencesByDefinition: [[reference(definitions, 1)], []],
        mainReferences: [reference(definitions, 0)],
      }),
    ).toThrowError(DatabaseCompilerError);
    const autoDefinition = fakeDefinition(
      "auto",
      fakeNode("auto-node"),
      [],
      "auto",
    );
    expect(() =>
      scheduledCompileOrderLeaves({
        policy: policy([0, 1]),
        definitions: [definitions[0]!, autoDefinition],
        referencesByDefinition: [[], []],
        mainReferences: [],
      }),
    ).toThrowError(DatabaseCompilerError);
    expect(() =>
      scheduledCompileOrderLeaves({
        policy: policy([0, 1]),
        definitions,
        referencesByDefinition: [[], []],
        mainReferences: [
          {
            definition: fakeNode("stale"),
            definitionIndex: 0,
            emissionCount: 1,
          },
        ],
      }),
    ).toThrowError(DatabaseCompilerError);
  });

  it("isolates discarded references and rejects provenance from another frame", () => {
    const definition = fakeNode("current-definition");
    const firstSession = createFinalRenderSession();
    const secondSession = createFinalRenderSession();
    const discarded = recordFinalRenderEmission(
      firstSession,
      text("discarded"),
      { kind: "shared-reference", definition, definitionIndex: 0 },
    );
    const retained = provenanceConcat(text("SELECT 1"));
    expect(
      finalRenderEmissionCounts(firstSession, retained).sharedReferences.size,
    ).toBe(0);

    const otherFrame = recordFinalRenderEmission(
      secondSession,
      text("other frame"),
      { kind: "shared-reference", definition, definitionIndex: 0 },
    );
    expect(() => provenanceConcat(discarded, otherFrame)).toThrow(
      "sql_fragments_from_different_render_sessions",
    );
  });

  it("uses a balanced, binding-free helper and never evaluates its business leaves", () => {
    const definitions = [
      fakeDefinition("mat_a", fakeNode("a"), [], "materialized", true),
      fakeDefinition("mat_b", fakeNode("b"), [], "materialized"),
      fakeDefinition("mat_c", fakeNode("c"), [], "materialized"),
    ];
    const session = createFinalRenderSession();
    const reserved = new Set([
      "_d1_compile_order",
      "_d1_compile_order_alias",
      "_d1_compile_order_marker",
    ]);
    const helper = renderCompileOrderHelper({
      definitions,
      definitionIndexes: [0, 1, 2],
      reservedIdentifiers: reserved,
      session,
    });
    expect(helper.definition.bindings).toEqual([]);
    expect(helper.definition.text).toContain("CASE WHEN 0 THEN EXISTS");
    expect(helper.definition.text).toContain(" ELSE 1 END");
    expect(helper.definition.text.match(/\?/gu)).toBeNull();
    expect(helper.cteName).not.toBe("_d1_compile_order");
    expect(
      finalRenderEmissionCounts(
        session,
        helper.definition,
      ).compileOrderHelpers.get(helper.emission.helper),
    ).toMatchObject({
      leafDefinitionIndexes: [0, 1, 2],
      emissionCount: 1,
    });

    const database = new DatabaseSync(":memory:");
    databases.add(database);
    let reads = 0;
    database.function("compile_order_bomb", () => {
      reads += 1;
      throw new Error("business leaf was evaluated");
    });
    database.exec(
      "CREATE VIEW mat_a AS SELECT 1 WHERE compile_order_bomb(); CREATE VIEW mat_b AS SELECT 1 WHERE compile_order_bomb(); CREATE VIEW mat_c AS SELECT 1 WHERE compile_order_bomb();",
    );
    const sql = `WITH ${helper.definition.text} SELECT ${helper.alias}.${helper.marker} FROM ${helper.cteName} AS ${helper.alias} WHERE ${helper.alias}.${helper.marker} = ${helper.leafCount}`;
    const row = database.prepare(sql).get() as Record<string, number>;
    expect(Object.values(row)).toEqual([3]);
    database.exec(
      "CREATE TABLE bag_values (value INTEGER); INSERT INTO bag_values VALUES (NULL), (7), (7);",
    );
    const baselineRows = database
      .prepare(
        "SELECT value, typeof(value) AS value_type FROM bag_values ORDER BY rowid LIMIT 3",
      )
      .all();
    const guardedRows = database
      .prepare(
        `WITH ${helper.definition.text} SELECT bag_values.value, typeof(bag_values.value) AS value_type FROM ${helper.cteName} AS ${helper.alias} CROSS JOIN bag_values WHERE ${renderCompileOrderGuard(helper).text} ORDER BY bag_values.rowid LIMIT 3`,
      )
      .all();
    expect(guardedRows).toEqual(baselineRows);
    expect(reads).toBe(0);
  });

  it("keeps root-sort bag semantics, parameters, and shape metadata while scheduling", async () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?), (?), (?)")
      .run("compile-order-a", "compile-order-b", "compile-order-c");
    const identities = scan(schema.site_identities);
    const source = project(identities, { key: identities.columns.site_pk! });
    let current = source;
    for (let index = 0; index < 5; index += 1) {
      const key = current.columns.key!;
      const ranked = window(current, {
        rank: rowNumber({
          partitionBy: [key],
          orderBy: [{ expression: key, direction: "ASC" }],
        }),
      });
      const selected = filter(ranked, eq(ranked.columns.rank!, constant(1)));
      current = project(selected, { key: selected.columns.key! });
    }
    const filtered = filter(current, eq(current.columns.key!, param(1)));
    const sorted = sort(filtered, [
      { expression: filtered.columns.key!, direction: "ASC" },
    ]);
    const physical = lowerLogicalPlan(sorted);
    const validated = validatePhysicalQueryPlan(physical);
    const copiedBoundaries = new Map(
      validated.interfaces.map((boundary) => {
        const definition = physical.sharedRelations.find(
          ({ node }) => node === boundary.definition.node,
        )!;
        return [
          definition.node,
          { ...boundary, definition: { ...definition } },
        ] as const;
      }),
    );
    expect(
      derivePhysicalCompileOrderPolicy(
        physical.root,
        physical.sharedRelations,
        copiedBoundaries,
      ),
    ).toEqual(physical.compileOrderPolicy);
    const [firstNode, firstBoundary] = [...copiedBoundaries][0]!;
    const staleBoundaries = new Map(copiedBoundaries);
    staleBoundaries.set(firstNode, {
      ...firstBoundary,
      definition: {
        ...firstBoundary.definition,
        name: `${firstBoundary.definition.name}_stale`,
      },
    });
    expect(
      derivePhysicalCompileOrderPolicy(
        physical.root,
        physical.sharedRelations,
        staleBoundaries,
      )?.candidateDefinitionIndexes ?? [],
    ).not.toContain(
      physical.sharedRelations.findIndex(({ node }) => node === firstNode),
    );
    expect(
      physical.compileOrderPolicy?.candidateDefinitionIndexes.length,
    ).toBeGreaterThanOrEqual(2);
    const stalePolicy = {
      ...physical,
      compileOrderPolicy: {
        ...physical.compileOrderPolicy!,
        candidateDefinitionIndexes: [
          physical.compileOrderPolicy!.candidateDefinitionIndexes[0]!,
        ],
      },
    };
    expect(() => compileD1QueryWithDiagnosticsForTest(stalePolicy)).toThrow(
      expect.objectContaining({ code: "invalid_plan" }),
    );

    const phases: Array<{
      readonly phase: string;
      readonly elapsedMs: number;
    }> = [];
    const captured = compileD1QueryWithDiagnosticsForTest(
      physical,
      {},
      (phase, elapsedMs) => phases.push({ phase, elapsedMs }),
    );
    const optimized = captured.query;
    const withoutHelper = compileD1QueryWithoutCompileOrderForTest(physical);
    expect(optimized.sql).toContain(
      '"_d1_compile_order" AS MATERIALIZED (SELECT',
    );
    expect(optimized.bindings).toEqual(withoutHelper.bindings);
    const v14Shape = optimized.physicalPlanShape;
    expect(v14Shape?.version).toBe(14);
    if (v14Shape?.version !== 14)
      throw new Error("expected_v14_compile_order_shape");
    expect(v14Shape.compileOrder.helperCount).toBe(1);
    expect(v14Shape.compileOrder.leafCount).toBeGreaterThanOrEqual(2);
    expect(captured.compileOrderGraph?.scheduledDefinitionIndexes).toEqual(
      v14Shape.compileOrder.definitionIndexes,
    );
    expect(phases.map(({ phase }) => phase)).toEqual([
      "lower-physical-validation-and-selection",
      "sql-render-parameter-layout-budget",
      "compiler-total",
    ]);
    expect(v14Shape.cteCount).toBe(
      (withoutHelper.physicalPlanShape?.cteCount ?? 0) + 1,
    );

    const optimizedRows = database
      .prepare(optimized.sql)
      .all(...(optimized.bindings as unknown as SQLInputValue[]));
    const baselineRows = database
      .prepare(withoutHelper.sql)
      .all(...(withoutHelper.bindings as unknown as SQLInputValue[]));
    expect(optimizedRows).toEqual(baselineRows);

    expect(isValidVersionFourteenPhysicalShape(v14Shape, () => true)).toBe(
      true,
    );
    expect(
      isValidVersionFourteenPhysicalShape(
        {
          ...v14Shape,
          compileOrder: {
            ...v14Shape.compileOrder,
            definitionIndexes: v14Shape.compileOrder.definitionIndexes.map(
              (index, position) =>
                position === 0 ? v14Shape.cteCount - 1 : index,
            ),
          },
        },
        () => true,
      ),
    ).toBe(false);
    const sparseDefinitionIndexes = [
      ...v14Shape.compileOrder.definitionIndexes,
    ];
    delete sparseDefinitionIndexes[0];
    const sparseLeaves = {
      ...v14Shape,
      compileOrder: {
        ...v14Shape.compileOrder,
        definitionIndexes: sparseDefinitionIndexes,
      },
    } as Extract<DatabasePhysicalPlanShape, { readonly version: 14 }>;
    expect(isValidVersionFourteenPhysicalShape(sparseLeaves, () => true)).toBe(
      false,
    );
    const duplicateLeaves = {
      ...v14Shape,
      compileOrder: {
        ...v14Shape.compileOrder,
        definitionIndexes: v14Shape.compileOrder.definitionIndexes.map(
          () => v14Shape.compileOrder.definitionIndexes[0]!,
        ),
      },
    } as Extract<DatabasePhysicalPlanShape, { readonly version: 14 }>;
    expect(
      isValidVersionFourteenPhysicalShape(duplicateLeaves, () => true),
    ).toBe(false);
    const accessorLeafCount = { ...v14Shape.compileOrder };
    Object.defineProperty(accessorLeafCount, "leafCount", {
      get: () => v14Shape.compileOrder.leafCount,
    });
    const accessorShape = {
      ...v14Shape,
      compileOrder: accessorLeafCount,
    } as Extract<DatabasePhysicalPlanShape, { readonly version: 14 }>;
    expect(isValidVersionFourteenPhysicalShape(accessorShape, () => true)).toBe(
      false,
    );
    const firstHash = await hashVersionFourteenPhysicalShape(
      v14Shape,
      async () => "v12:base",
    );
    const reorderedShape = {
      ...v14Shape,
      compileOrder: {
        ...v14Shape.compileOrder,
        definitionIndexes: [
          ...v14Shape.compileOrder.definitionIndexes,
        ].reverse(),
      },
    } satisfies DatabasePhysicalPlanShape;
    const secondHash = await hashVersionFourteenPhysicalShape(
      reorderedShape as Extract<
        DatabasePhysicalPlanShape,
        { readonly version: 14 }
      >,
      async () => "v12:base",
    );
    expect(firstHash).toMatch(/^v14:/u);
    expect(secondHash).not.toBe(firstHash);

    const events: DatabaseQueryObservation[] = [];
    const prepared = {
      bind: () => prepared,
      all: async () => ({
        success: true,
        results: [],
      }),
      first: async () => null,
      run: async () => ({ success: true, results: [] }),
    };
    const runtime = createDatabaseRuntime(
      { prepare: () => prepared } as unknown as D1Database,
      {
        observer: {
          begin: () => ({
            statementIndexes: [0],
            includeBatchSummary: false,
            record: (event) => {
              events.push(event);
            },
            release: () => {},
          }),
        },
      },
    );
    await runtime.all(optimized);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.physicalPlanHash).toMatch(/^v14:/u);
  });
});
