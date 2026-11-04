import type { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  and,
  callFunction,
  caseWhen,
  castInteger,
  castReal,
  coalesce,
  compileD1Query,
  count,
  eq,
  filter,
  inList,
  inSubquery,
  isDistinctFrom,
  isNotNull,
  isNull,
  join,
  limit,
  not,
  param,
  project,
  recursiveClosure,
  scalar,
  scan,
  sort,
  union,
} from "@/lib/db";
import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type { AnyExpression } from "@/lib/db/query/expression";
import type { Relation } from "@/lib/db/query/plan";
import { validateLogicalQueryPlan } from "@/lib/db/query/validator";
import { schema } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/sha256";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;

const databases = new Set<DatabaseSync>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function database(): DatabaseSync {
  const result = createMigratedDatabase();
  databases.add(result);
  return result;
}

function runAll(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]));
}

function edge(
  db: DatabaseSync,
  identities: ReturnType<typeof scan<typeof schema.site_identities>>,
  sourceKey: string,
  namespace: string,
  nodeId: number,
  parentNodeId: number | null,
) {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(sourceKey);
  const selected = filter(
    identities,
    eq(identities.columns.site_id, param(sourceKey)),
  );
  return project(selected, {
    namespace: param<string>(namespace),
    nodeId: param<number>(nodeId),
    parentNodeId: param<number | null>(parentNodeId),
  });
}

type EdgeRelation = ReturnType<typeof edge>;

function allRows(relations: readonly EdgeRelation[]): EdgeRelation {
  if (relations.length === 0)
    throw new Error("Test graph relations require at least one row source");
  return relations
    .slice(1)
    .reduce((result, relation) => union(result, relation, true), relations[0]!);
}

function closure(seed: EdgeRelation, candidates: EdgeRelation) {
  return recursiveClosure(seed, candidates, (current, candidate) =>
    and(
      eq(current.namespace, candidate.namespace),
      eq(current.parentNodeId, candidate.nodeId),
    ),
  );
}

function expectedHash(query: {
  readonly sql: string;
  readonly physicalPlanShape?: {
    readonly cteCount: number;
    readonly directScanProjectionCount: number;
    readonly nativeMembershipCount: number;
    readonly jsonMembershipCount: number;
  };
}): Promise<string> {
  const shape = query.physicalPlanShape;
  if (!shape) throw new Error("Typed query has no physical shape metadata");
  return sha256Hex(
    JSON.stringify([
      "d1-query-shape-v1",
      query.sql,
      shape.cteCount,
      shape.directScanProjectionCount,
      shape.nativeMembershipCount,
      shape.jsonMembershipCount,
    ]),
  ).then((digest) => `v1:${digest}`);
}

describe("finite typed recursive closure", () => {
  it("executes namespaced chain, fork, multi-seed, duplicate, NULL, and cyclic graphs", () => {
    const db = database();
    const identities = scan(schema.site_identities);
    const alphaSeed10 = edge(db, identities, "g-alpha-10", "alpha", 10, 20);
    const alphaSeed11 = edge(db, identities, "g-alpha-11", "alpha", 11, 20);
    const alpha20a = edge(db, identities, "g-alpha-20a", "alpha", 20, 30);
    const alpha20b = edge(db, identities, "g-alpha-20b", "alpha", 20, 40);
    const alpha30 = edge(db, identities, "g-alpha-30", "alpha", 30, null);
    const alpha40 = edge(db, identities, "g-alpha-40", "alpha", 40, null);
    const beta30 = edge(db, identities, "g-beta-30", "beta", 30, null);
    const self60 = edge(db, identities, "g-self-60", "cycles", 60, 60);
    const cycle50 = edge(db, identities, "g-cycle-50", "cycles", 50, 51);
    const cycle51 = edge(db, identities, "g-cycle-51", "cycles", 51, 50);
    const root70 = edge(db, identities, "g-root-70", "roots", 70, null);

    const seed = allRows([
      alphaSeed10,
      alphaSeed10,
      alphaSeed11,
      self60,
      cycle50,
      root70,
    ]);
    const candidates = allRows([
      alphaSeed10,
      alphaSeed11,
      alpha20a,
      alpha20a,
      alpha20b,
      alpha30,
      alpha40,
      beta30,
      self60,
      cycle50,
      cycle51,
      root70,
    ]);
    const result = closure(seed, candidates);
    const compiled = importCompile(result);
    const rows = runAll(db, compiled) as Array<{
      namespace: string;
      nodeId: number;
      parentNodeId: number | null;
    }>;

    expect(compiled.sql.match(/WITH RECURSIVE/gu)).toHaveLength(1);
    expect(compiled.sql).toMatch(
      /FROM "_d1_recursive_\d+" AS r\d+ INNER JOIN/gu,
    );
    expect(compiled.sql.match(/FROM "_d1_recursive_\d+"/gu)).toHaveLength(2);
    expect(compiled.physicalPlanShape?.cteCount).toBe(1);
    expect(rows).toHaveLength(10);
    expect(
      rows
        .map(({ namespace, nodeId, parentNodeId }) => [
          namespace,
          nodeId,
          parentNodeId,
        ])
        .sort((left, right) =>
          `${left[0]}:${left[1]}:${left[2] ?? "null"}`.localeCompare(
            `${right[0]}:${right[1]}:${right[2] ?? "null"}`,
          ),
        ),
    ).toEqual(
      [
        ["alpha", 10, 20],
        ["alpha", 11, 20],
        ["alpha", 20, 30],
        ["alpha", 20, 40],
        ["alpha", 30, null],
        ["alpha", 40, null],
        ["cycles", 50, 51],
        ["cycles", 51, 50],
        ["cycles", 60, 60],
        ["roots", 70, null],
      ].sort((left, right) =>
        `${left[0]}:${left[1]}:${left[2] ?? "null"}`.localeCompare(
          `${right[0]}:${right[1]}:${right[2] ?? "null"}`,
        ),
      ),
    );

    const emptySeed = filter(
      alphaSeed10,
      eq(alphaSeed10.columns.nodeId, param(-1)),
    );
    expect(runAll(db, importCompile(closure(emptySeed, candidates)))).toEqual(
      [],
    );
  });

  it("supports castReal in recursive closure predicates without crossing namespaces", () => {
    const db = database();
    const identities = scan(schema.site_identities);
    const alphaSeed = edge(
      db,
      identities,
      "g-cast-real-alpha-10",
      "alpha",
      10,
      20,
    );
    const alpha20 = edge(
      db,
      identities,
      "g-cast-real-alpha-20",
      "alpha",
      20,
      null,
    );
    const beta20 = edge(
      db,
      identities,
      "g-cast-real-beta-20",
      "beta",
      20,
      null,
    );
    const candidates = allRows([alphaSeed, alpha20, beta20]);
    const result = recursiveClosure(
      alphaSeed,
      candidates,
      (current, candidate) =>
        and(
          eq(current.namespace, candidate.namespace),
          eq(castReal(current.parentNodeId), castReal(candidate.nodeId)),
        ),
    );
    const compiled = importCompile(result);
    const rows = runAll(db, compiled) as Array<{
      namespace: string;
      nodeId: number;
      parentNodeId: number | null;
    }>;

    expect(compiled.sql).toMatch(/CAST\s*\(/iu);
    expect(compiled.bindings).toContain("alpha");
    expect(rows).toEqual([
      { namespace: "alpha", nodeId: 10, parentNodeId: 20 },
      { namespace: "alpha", nodeId: 20, parentNodeId: null },
    ]);
  });

  it("composes with Project, Filter, Sort, Limit, aggregates, and independent closures", () => {
    const db = database();
    const identities = scan(schema.site_identities);
    const seed10 = edge(db, identities, "g-compose-10", "compose", 10, 20);
    const seed11 = edge(db, identities, "g-compose-11", "compose", 11, 20);
    const node20 = edge(db, identities, "g-compose-20", "compose", 20, null);
    const candidates = allRows([seed10, seed11, node20]);
    const first = closure(allRows([seed10]), candidates);
    const second = closure(allRows([seed11]), candidates);

    const byNamespace = filter(
      first,
      eq(first.columns.namespace, param("compose")),
    );
    const ordered = sort(byNamespace, [
      { expression: byNamespace.columns.nodeId, direction: "ASC" },
    ]);
    const page = limit(ordered, 2);
    const named = project(page, {
      key: page.columns.namespace,
      node: page.columns.nodeId,
      parent: page.columns.parentNodeId,
    });
    const projectedRows = runAll(db, importCompile(named));
    expect(projectedRows).toEqual([
      { key: "compose", node: 10, parent: 20 },
      { key: "compose", node: 20, parent: null },
    ]);

    const grouped = aggregate(first, {
      groupBy: { namespace: first.columns.namespace },
      aggregates: { nodeCount: count() },
    });
    expect(runAll(db, importCompile(grouped))).toEqual([
      { namespace: "compose", nodeCount: 2 },
    ]);

    const together = join(
      first,
      second,
      eq(first.columns.namespace, second.columns.namespace),
    );
    const both = importCompile(together);
    expect(both.sql.match(/WITH RECURSIVE/gu)).toHaveLength(2);
    expect(both.physicalPlanShape?.cteCount).toBe(2);
    expect(runAll(db, both)).toHaveLength(4);
  });

  it("keeps closure predicates, SQL budgets, JSON membership, EXPLAIN, and hashes stable", async () => {
    const db = database();
    const identities = scan(schema.site_identities);
    const seed = edge(db, identities, "g-budget-seed", "budget", 1, 2);
    const parent = edge(db, identities, "g-budget-parent", "budget", 2, null);
    const candidates = allRows([seed, parent]);
    const values = [
      "budget",
      ...Array.from({ length: 160 }, (_, index) => `miss-${index}`),
    ];
    const first = recursiveClosure(seed, candidates, (current, candidate) =>
      and(
        eq(current.namespace, candidate.namespace),
        eq(current.parentNodeId, candidate.nodeId),
        inList(current.namespace, values),
      ),
    );
    const second = recursiveClosure(seed, candidates, (current, candidate) =>
      and(
        eq(current.namespace, candidate.namespace),
        eq(current.parentNodeId, candidate.nodeId),
        inList(current.namespace, values),
      ),
    );
    const compiled = importCompile(first);
    const recompilation = importCompile(second);
    expect(compiled.sql).toBe(recompilation.sql);
    expect(compiled.bindings).toEqual(recompilation.bindings);
    expect(compiled.sql).toContain("json_each(?)");
    expect((compiled.bindings ?? []).length).toBeLessThanOrEqual(100);
    expect(new TextEncoder().encode(compiled.sql).byteLength).toBeLessThan(
      100_000,
    );
    expect(runAll(db, compiled)).toEqual([
      { namespace: "budget", nodeId: 1, parentNodeId: 2 },
      { namespace: "budget", nodeId: 2, parentNodeId: null },
    ]);

    const explanation = runAll(db, {
      sql: `EXPLAIN QUERY PLAN ${compiled.sql}`,
      bindings: compiled.bindings,
    }) as Array<{ detail: string }>;
    expect(explanation.length).toBeGreaterThan(0);
    expect(
      explanation.some(({ detail }) => detail.includes("site_identities")),
    ).toBe(true);

    const firstHash = await expectedHash(compiled);
    const stableHash = await expectedHash(recompilation);
    const changed = importCompile(
      recursiveClosure(seed, candidates, (current, candidate) =>
        and(
          eq(current.namespace, candidate.namespace),
          eq(current.parentNodeId, candidate.nodeId),
          inList(candidate.namespace, values),
        ),
      ),
    );
    expect(firstHash).toBe(stableHash);
    expect(await expectedHash(changed)).not.toBe(firstHash);
  });

  it("rejects incompatible construction, escaped scopes, forged shapes, and nested closure", () => {
    const db = database();
    const identities = scan(schema.site_identities);
    const seed = edge(db, identities, "g-invalid-seed", "invalid", 1, 2);
    const candidates = edge(
      db,
      identities,
      "g-invalid-candidate",
      "invalid",
      2,
      null,
    );
    const valid = closure(seed, candidates);

    const wrongNames = project(
      filter(identities, eq(identities.columns.site_id, param("wrong-name"))),
      {
        differentNamespace: param("invalid"),
        nodeId: param(2),
        parentNodeId: param<number | null>(null),
      },
    );
    expect(() =>
      recursiveClosure(seed, wrongNames as unknown as EdgeRelation, () =>
        eq(param(1), param(1)),
      ),
    ).toThrow(DatabaseCompilerError);

    const wrongAffinity = project(
      filter(
        identities,
        eq(identities.columns.site_id, param("wrong-affinity")),
      ),
      {
        namespace: param(42),
        nodeId: param(2),
        parentNodeId: param<number | null>(null),
      },
    );
    expect(() =>
      recursiveClosure(seed, wrongAffinity as unknown as EdgeRelation, () =>
        eq(param(1), param(1)),
      ),
    ).toThrow(DatabaseCompilerError);

    const external = scan(schema.site_identities);
    const escaped = recursiveClosure(seed, candidates, (current, candidate) =>
      and(
        eq(current.namespace, candidate.namespace),
        eq(current.parentNodeId, candidate.nodeId),
        eq(external.columns.site_id, param("outside")),
      ),
    );
    expect(() => importCompile(escaped)).toThrow(DatabaseCompilerError);

    const validNode = valid.node;
    if (validNode.kind !== "recursive-closure")
      throw new Error("Expected recursive closure test node");
    const predicate = validNode.predicate;
    if (predicate.kind !== "boolean")
      throw new Error("Expected conjunction in recursive closure predicate");
    const firstPredicate = predicate.expressions[0];
    if (
      firstPredicate?.kind !== "binary" ||
      firstPredicate.left.kind !== "column"
    )
      throw new Error(
        "Expected column comparison in recursive closure predicate",
      );
    const forgedPredicate = {
      ...predicate,
      expressions: [
        {
          ...firstPredicate,
          left: { ...firstPredicate.left, name: "forged-name" },
        },
        ...predicate.expressions.slice(1),
      ],
    } as unknown as typeof predicate;
    const mutableNode = validNode as unknown as {
      fields: typeof validNode.fields;
      predicate: typeof predicate;
      cteName?: string;
    };
    const originalPredicate = mutableNode.predicate;
    mutableNode.predicate = forgedPredicate;
    expect(() => validateLogicalQueryPlan(validNode)).toThrow(
      DatabaseCompilerError,
    );
    mutableNode.predicate = originalPredicate;

    const originalFields = mutableNode.fields;
    mutableNode.fields = [];
    expect(() => validateLogicalQueryPlan(validNode)).toThrow(
      DatabaseCompilerError,
    );
    mutableNode.fields = originalFields;
    mutableNode.fields = originalFields.map((field, index) =>
      index === 0 ? { ...field, name: "forged-output" } : field,
    );
    expect(() => validateLogicalQueryPlan(validNode)).toThrow(
      DatabaseCompilerError,
    );
    mutableNode.fields = originalFields;

    const forgedScope = {
      ...valid,
      node: {
        ...valid.node,
        candidateScope: validNode.seed.scope,
      },
    } as unknown as AnyRelation;
    expect(() => validateLogicalQueryPlan(forgedScope)).toThrow(
      DatabaseCompilerError,
    );

    mutableNode.cteName = "caller-controlled";
    expect(() => validateLogicalQueryPlan(validNode)).toThrow(
      DatabaseCompilerError,
    );
    delete mutableNode.cteName;

    const nested = recursiveClosure(valid, candidates, (current, candidate) =>
      and(
        eq(current.namespace, candidate.namespace),
        eq(current.parentNodeId, candidate.nodeId),
      ),
    );
    expect(() => importCompile(nested)).toThrow(DatabaseCompilerError);
  });

  it("validates supported scalar trees and rejects aggregate or query predicates", () => {
    const db = database();
    const identities = scan(schema.site_identities);
    const seed = edge(db, identities, "g-scalar-seed", "scalar", 1, 2);
    const candidates = edge(
      db,
      identities,
      "g-scalar-candidate",
      "scalar",
      2,
      null,
    );
    const rich = recursiveClosure(seed, candidates, (current, candidate) =>
      and(
        eq(current.namespace, candidate.namespace),
        isDistinctFrom(current.nodeId, candidate.nodeId),
        not(isNull(current.parentNodeId)),
        inList(candidate.nodeId, [1, 2]),
        eq(callFunction("length", current.namespace), param(6)),
        eq(coalesce(current.parentNodeId, param(0)), param(1)),
        eq(
          caseWhen(
            [
              {
                when: isNotNull(current.parentNodeId),
                then: castInteger(current.parentNodeId),
              },
            ],
            param(0),
          ),
          param(2),
        ),
      ),
    );
    expect(() => compileD1Query(rich)).not.toThrow();

    const aggregatePredicate = recursiveClosure(seed, candidates, (current) =>
      eq(count(current.nodeId), param(1)),
    );
    expect(() => validateLogicalQueryPlan(aggregatePredicate)).toThrow(
      DatabaseCompilerError,
    );

    const scalarRelation = project(candidates, {
      value: candidates.columns.nodeId,
    });
    const scalarPredicate = recursiveClosure(seed, candidates, () =>
      eq(scalar(scalarRelation), param<number | null>(1)),
    );
    expect(() => validateLogicalQueryPlan(scalarPredicate)).toThrow(
      DatabaseCompilerError,
    );

    const inSubqueryRelation = project(candidates, {
      value: candidates.columns.nodeId,
    });
    const inSubqueryPredicate = recursiveClosure(seed, candidates, (current) =>
      inSubquery(current.nodeId, inSubqueryRelation),
    );
    expect(() => validateLogicalQueryPlan(inSubqueryPredicate)).toThrow(
      DatabaseCompilerError,
    );
  });
});

function importCompile<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<Row, Columns>) {
  // Kept behind one helper to make every fixture execute the public compiler.
  return compileD1Query(relation);
}
