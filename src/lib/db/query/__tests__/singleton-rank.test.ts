import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  and,
  callFunction,
  castText,
  compileD1Query,
  constant,
  distinct,
  eq,
  filter,
  gt,
  inSubquery,
  isNotNull,
  join,
  limit,
  neq,
  or,
  param,
  project,
  rowNumber,
  scan,
  sort,
  union,
  window,
  windowCountRows,
} from "@/lib/db";
import { compileD1QueryWithoutSingletonRankFusionForTest } from "@/lib/db/query/compiler";
import type {
  ColumnExpression,
  ExpressionResultType,
} from "@/lib/db/query/expression";
import {
  buildPhysicalParentIndex,
  proveDistinctUnionConsumerEquivalence,
} from "@/lib/db/query/physical/consumer-equivalence";
import type { SharedRelationDefinition } from "@/lib/db/query/physical/contracts";
import { materializationConsumerEdges } from "@/lib/db/query/physical/materialization-context";
import { materializationReaderContextProof } from "@/lib/db/query/physical/materialization-reader-context";
import type { PhysicalSharedRelationBoundaryEvidence } from "@/lib/db/query/physical/shared-relation-interfaces";
import {
  lowerLogicalPlan,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type {
  LogicalQueryNode,
  QuerySource,
  Relation,
  UnionNode,
  WindowNode,
} from "@/lib/db/query/plan";
import type {
  GeneratedSchemaObject,
  SchemaColumnReference,
  SchemaTableReference,
} from "@/lib/db/schema";
import { schema } from "@/lib/db/schema";

type TestRelation = Relation<
  {
    readonly id: string;
    readonly group_id: string;
    readonly payload: ArrayBuffer | ArrayBufferView | null;
    readonly amount: number;
  },
  {
    readonly id: ColumnExpression<string, ExpressionResultType<"text", false>>;
    readonly group_id: ColumnExpression<
      string,
      ExpressionResultType<"text", false>
    >;
    readonly payload: ColumnExpression<
      ArrayBuffer | ArrayBufferView | null,
      ExpressionResultType<"blob", true>
    >;
    readonly amount: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
  }
>;

type NullableUniqueRelation = Relation<
  {
    readonly id: number;
    readonly nullable_key: string | null;
    readonly amount: number;
  },
  {
    readonly id: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    readonly nullable_key: ColumnExpression<
      string | null,
      ExpressionResultType<"text", true>
    >;
    readonly amount: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
  }
>;

type UniqueAmountRelation = Relation<
  { readonly id: string; readonly group_id: string; readonly amount: number },
  {
    readonly id: ColumnExpression<string, ExpressionResultType<"text", false>>;
    readonly group_id: ColumnExpression<
      string,
      ExpressionResultType<"text", false>
    >;
    readonly amount: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
  }
>;

type IdAmountRelation = Relation<
  { readonly id: string; readonly amount: number },
  {
    readonly id: ColumnExpression<string, ExpressionResultType<"text", false>>;
    readonly amount: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
  }
>;

type NumericKeyRelation = Relation<
  { readonly value: number; readonly tag: string },
  {
    readonly value: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    readonly tag: ColumnExpression<string, ExpressionResultType<"text", false>>;
  }
>;

type NumericLookupRelation = Relation<
  {
    readonly id: string;
    readonly match_value: number;
    readonly match_tag: string;
    readonly amount: number;
    readonly payload: ArrayBuffer | ArrayBufferView | null;
  },
  {
    readonly id: ColumnExpression<string, ExpressionResultType<"text", false>>;
    readonly match_value: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    readonly match_tag: ColumnExpression<
      string,
      ExpressionResultType<"text", false>
    >;
    readonly amount: ColumnExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    readonly payload: ColumnExpression<
      ArrayBuffer | ArrayBufferView | null,
      ExpressionResultType<"blob", true>
    >;
  }
>;

const databases = new Set<DatabaseSync>();
const fixtureCatalogKey = "__singleton_rank_fixture_test";
const fixtureCatalogKeys = new Set([fixtureCatalogKey]);

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const key of fixtureCatalogKeys) Reflect.deleteProperty(schema, key);
  fixtureCatalogKeys.clear();
  fixtureCatalogKeys.add(fixtureCatalogKey);
});

function column(
  table: string,
  name: string,
  declaredType: string,
  affinity: SchemaColumnReference["affinity"],
  nullable: boolean,
  primaryKeyPosition = 0,
): SchemaColumnReference {
  return {
    kind: "column",
    table,
    sqlName: name,
    propertyName: name,
    declaredType,
    affinity,
    nullable,
    primaryKeyPosition,
    defaultSql: null,
    hidden: 0,
    generated: false,
  };
}

function fixtureTable(): SchemaTableReference {
  const name = "singleton_rank_fixture";
  const table: SchemaTableReference = {
    kind: "table",
    name,
    defaultCollation: "BINARY",
    columns: {
      id: column(name, "id", "TEXT", "text", false, 1),
      group_id: column(name, "group_id", "TEXT", "text", false),
      payload: column(name, "payload", "BLOB", "blob", true),
      amount: column(name, "amount", "INTEGER", "integer", false),
    },
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [],
  };
  Object.defineProperty(schema, fixtureCatalogKey, {
    value: table,
    enumerable: true,
    configurable: true,
  });
  fixtureCatalogKeys.add(fixtureCatalogKey);
  return table;
}

function nullableUniqueTable(): SchemaTableReference {
  const name = "singleton_rank_nullable_unique";
  return registerTable("__singleton_rank_nullable_unique", {
    kind: "table",
    name,
    defaultCollation: "BINARY",
    columns: {
      id: column(name, "id", "INTEGER", "integer", false, 1),
      nullable_key: column(name, "nullable_key", "TEXT", "text", true),
      amount: column(name, "amount", "INTEGER", "integer", false),
    },
    primaryKey: ["id"],
    indexes: [
      {
        name: "singleton_rank_nullable_key_unique",
        unique: true,
        columns: ["nullable_key"],
        collations: ["BINARY"],
        partial: false,
      },
    ],
    foreignKeys: [],
  });
}

function uniqueAmountTable(
  name = "singleton_rank_unique_amount",
  catalogKey = "__singleton_rank_unique_amount",
): SchemaTableReference {
  return registerTable(catalogKey, {
    kind: "table",
    name,
    defaultCollation: "BINARY",
    columns: {
      id: column(name, "id", "TEXT", "text", false, 1),
      group_id: column(name, "group_id", "TEXT", "text", false),
      amount: column(name, "amount", "INTEGER", "integer", false),
    },
    primaryKey: ["id"],
    indexes: [
      {
        name: `${name}_amount_unique`,
        unique: true,
        columns: ["amount"],
        collations: ["BINARY"],
        partial: false,
      },
    ],
    foreignKeys: [],
  });
}

function numericKeyTable(
  name: string,
  catalogKey: string,
): SchemaTableReference {
  return registerTable(catalogKey, {
    kind: "table",
    name,
    defaultCollation: "BINARY",
    columns: {
      value: column(name, "value", "INTEGER", "integer", false),
      tag: column(name, "tag", "TEXT", "text", false),
    },
    primaryKey: [],
    indexes: [],
    foreignKeys: [],
  });
}

function numericLookupTable(): SchemaTableReference {
  const name = "singleton_rank_numeric_lookup";
  return registerTable("__singleton_rank_numeric_lookup", {
    kind: "table",
    name,
    defaultCollation: "BINARY",
    columns: {
      id: column(name, "id", "TEXT", "text", false, 1),
      match_value: column(name, "match_value", "INTEGER", "integer", false),
      match_tag: column(name, "match_tag", "TEXT", "text", false),
      amount: column(name, "amount", "INTEGER", "integer", false),
      payload: column(name, "payload", "BLOB", "blob", true),
    },
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [],
  });
}

function registerTable(
  key: string,
  table: SchemaTableReference,
): SchemaTableReference {
  Object.defineProperty(schema, key, {
    value: table,
    enumerable: true,
    configurable: true,
  });
  fixtureCatalogKeys.add(key);
  return table;
}

function rankOneOutput(source: TestRelation) {
  const ranked = window(source, {
    rank: rowNumber({
      partitionBy: [source.columns.id!],
      orderBy: [{ expression: source.columns.amount!, direction: "ASC" }],
    }),
  });
  const rankOne = filter(ranked, eq(ranked.columns.rank!, constant(1)));
  const guarded = filter(rankOne, eq(rankOne.columns.group_id!, param("keep")));
  return project(guarded, {
    payload: guarded.columns.payload!,
    id: guarded.columns.id!,
    group: guarded.columns.group_id!,
  });
}

function readRows(
  database: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
) {
  const statement = database.prepare(
    `SELECT id, "group" AS group_id, payload, typeof(payload) AS storage FROM (${query.sql}) AS result`,
  );
  statement.setReadBigInts(true);
  const rows = statement.all(...((query.bindings ?? []) as SQLInputValue[]));
  return rows
    .map((row) => ({
      id: row.id,
      group_id: row.group_id,
      storage: row.storage,
      payload:
        typeof row.payload === "bigint"
          ? `${row.payload}n`
          : row.payload instanceof Uint8Array
            ? [...row.payload]
            : row.payload,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function readCompiledRows(
  database: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
  storageColumns: readonly string[] = [],
): readonly Record<string, unknown>[] {
  const storageProjection = storageColumns
    .map((name) => `typeof(result."${name}") AS "__typeof_${name}"`)
    .join(", ");
  const statement = database.prepare(
    `SELECT result.*${storageProjection ? `, ${storageProjection}` : ""} FROM (${query.sql}) AS result`,
  );
  statement.setReadBigInts(true);
  const rows = statement.all(...((query.bindings ?? []) as SQLInputValue[]));
  const normalized = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "bigint"
          ? `${value}n`
          : value instanceof Uint8Array
            ? [...value]
            : value,
      ]),
    ),
  );
  return normalized.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function assertBagParity(
  database: DatabaseSync,
  candidate: { readonly sql: string; readonly bindings?: readonly unknown[] },
  baseline: { readonly sql: string; readonly bindings?: readonly unknown[] },
  storageColumns: readonly string[] = [],
): void {
  expect(readCompiledRows(database, candidate, storageColumns)).toEqual(
    readCompiledRows(database, baseline, storageColumns),
  );
}

function compiledPair(query: ReturnType<typeof rankOneOutput>) {
  return {
    optimized: compileD1Query(query),
    baseline: compileD1QueryWithoutSingletonRankFusionForTest(query),
  };
}

function numericUnionRankOutput(
  input: {
    readonly reverseUnion?: boolean;
    readonly castJoinKey?: boolean;
    readonly leakRight?: boolean;
    readonly expressionQueryParent?: boolean;
    readonly orJoin?: boolean;
    readonly incompleteEquality?: boolean;
  } = {},
) {
  const leftTable = numericKeyTable(
    "singleton_rank_union_left",
    "__singleton_rank_union_left",
  );
  const rightTable = numericKeyTable(
    "singleton_rank_union_right",
    "__singleton_rank_union_right",
  );
  const lookupTable = numericLookupTable();
  const left = scan(
    leftTable as unknown as GeneratedSchemaObject,
  ) as unknown as NumericKeyRelation;
  const right = scan(
    rightTable as unknown as GeneratedSchemaObject,
  ) as unknown as NumericKeyRelation;
  const unionRows = input.reverseUnion
    ? union(
        project(right, {
          value: right.columns.value!,
          tag: right.columns.tag!,
        }),
        project(left, { value: left.columns.value!, tag: left.columns.tag! }),
        false,
      )
    : union(
        project(left, { value: left.columns.value!, tag: left.columns.tag! }),
        project(right, {
          value: right.columns.value!,
          tag: right.columns.tag!,
        }),
        false,
      );
  const distinctRows = distinct(unionRows);
  const buildConsumer = () => {
    const lookup = scan(
      lookupTable as unknown as GeneratedSchemaObject,
    ) as unknown as NumericLookupRelation;
    const valueEquality = input.castJoinKey
      ? eq(
          castText(lookup.columns.match_value!),
          castText(distinctRows.columns.value!),
        )
      : eq(lookup.columns.match_value!, distinctRows.columns.value!);
    const tagEquality = eq(
      lookup.columns.match_tag!,
      distinctRows.columns.tag!,
    );
    const condition = input.orJoin
      ? or(valueEquality, tagEquality)
      : input.incompleteEquality
        ? valueEquality
        : and(valueEquality, tagEquality);
    const joined = join(lookup, distinctRows, condition);
    return project(joined, {
      id: joined.columns.left_id!,
      match_value: joined.columns.left_match_value!,
      amount: joined.columns.left_amount!,
      payload: joined.columns.left_payload!,
      ...(input.leakRight ? { leaked: joined.columns.right_tag! } : {}),
    });
  };
  const primary = buildConsumer();
  const ranked = window(primary, {
    rank: rowNumber({
      partitionBy: [primary.columns.id!],
      orderBy: [{ expression: primary.columns.amount!, direction: "ASC" }],
    }),
  });
  const rankOne = filter(ranked, eq(ranked.columns.rank!, constant(1)));
  let output = project(rankOne, {
    id: rankOne.columns.id!,
    match_value: rankOne.columns.match_value!,
    amount: rankOne.columns.amount!,
    payload: rankOne.columns.payload!,
    ...(input.leakRight ? { leaked: rankOne.columns.leaked! } : {}),
  });
  if (
    !input.leakRight &&
    !input.castJoinKey &&
    !input.expressionQueryParent &&
    !input.orJoin &&
    !input.incompleteEquality
  ) {
    const secondSafeConsumer = buildConsumer();
    output = union(
      output as unknown as Relation,
      secondSafeConsumer as unknown as Relation,
      true,
    ) as unknown as typeof output;
  } else if (input.expressionQueryParent) {
    const rawValues = project(unionRows, { value: unionRows.columns.value! });
    output = filter(
      output,
      inSubquery(output.columns.match_value!, rawValues),
    ) as unknown as typeof output;
  }
  return { output, union: unionRows.node as UnionNode };
}

function unionConsumerGraph(input: {
  readonly leakRight?: boolean;
  readonly castJoinKey?: boolean;
  readonly rawSecondParent?: boolean;
}): { readonly root: LogicalQueryNode; readonly union: UnionNode } {
  const table = fixtureTable();
  const left = scan(
    table as unknown as GeneratedSchemaObject,
  ) as unknown as TestRelation;
  const right = scan(
    table as unknown as GeneratedSchemaObject,
  ) as unknown as TestRelation;
  const unionRows = union(
    project(left, { id: left.columns.id! }),
    project(right, { id: right.columns.id! }),
    false,
  );
  const consumer = (leakRight: boolean, castJoinKey: boolean) => {
    const distinctRows = distinct(unionRows);
    const probe = scan(
      table as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const condition = castJoinKey
      ? eq(castText(probe.columns.id!), distinctRows.columns.id!)
      : eq(probe.columns.id!, distinctRows.columns.id!);
    const joined = join(probe, distinctRows, condition);
    return leakRight
      ? project(joined, {
          id: joined.columns.left_id,
          leaked: joined.columns.right_id,
        })
      : project(joined, { id: joined.columns.left_id });
  };
  const safeConsumer = consumer(
    input.leakRight ?? false,
    input.castJoinKey ?? false,
  );
  const root = input.rawSecondParent
    ? (() => {
        const rawDistinct = distinct(unionRows);
        const rawConsumer = project(rawDistinct, {
          id: rawDistinct.columns.id!,
        });
        return union(consumer(false, false), rawConsumer, true);
      })()
    : safeConsumer;
  return {
    root: root.node as LogicalQueryNode,
    union: unionRows.node as UnionNode,
  };
}

function proveUnionConsumer(root: LogicalQueryNode, unionNode: UnionNode) {
  return proveDistinctUnionConsumerEquivalence({
    root,
    union: unionNode,
    definitions: [],
    interfaces: new Map(),
    consumerProducer: null,
    consumerProducerIndex: 0,
    index: buildPhysicalParentIndex(root),
  });
}

function relationChildren(node: LogicalQueryNode): readonly QuerySource[] {
  switch (node.kind) {
    case "filter":
    case "project":
    case "distinct":
    case "sort":
    case "limit":
    case "window":
      return [node.input];
    case "join":
    case "semi-join":
    case "anti-join":
      return [node.left, node.right];
    case "union":
      return [node.left, node.right];
    case "recursive-closure":
      return [node.seed, node.candidates];
    default:
      return [];
  }
}

function readerProofForDistinctUnion(input: {
  readonly root: LogicalQueryNode;
  readonly union: UnionNode;
  readonly currentMaterializedProducer?: boolean;
}) {
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of relationChildren(node)) visit(source.node);
    postorder.push(node);
  };
  visit(input.root);
  const edges = materializationConsumerEdges(
    postorder,
    relationChildren,
    () => [],
    () => [],
  );
  const candidate = input.union.left.node;
  const candidateDefinition: SharedRelationDefinition = {
    name: "candidate",
    node: candidate,
    scope: candidate.scope,
    fields: candidate.fields,
    dependencies: [],
    materialization: "auto",
  };
  const definitions: SharedRelationDefinition[] = [candidateDefinition];
  const interfaces = new Map<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >();
  if (input.currentMaterializedProducer) {
    const definition: SharedRelationDefinition = {
      name: "current_union_boundary",
      node: input.union,
      scope: input.union.scope,
      fields: input.union.fields,
      dependencies: [],
      materialization: "materialized",
    };
    definitions.push(definition);
    interfaces.set(input.union, {
      definition,
      boundary: { kind: "materialized-relation" },
      selective: true,
      license: { kind: "strict-generic-facts" },
      closure: {
        kind: "scope-and-exported-columns-closed",
        scopeCount: 1,
        referencedScopeCount: 1,
        referencedColumnCount: input.union.fields.length,
      },
      totality: {
        kind: "checked-through-current-boundaries",
        stoppedAt: [],
      },
    });
  }
  return materializationReaderContextProof({
    node: candidate,
    root: input.root,
    definitions,
    edges,
    postorder,
    interfaces,
    licensedBoundaryNodes: new Set(interfaces.keys()),
    sameFields: (left, right) =>
      left.length === right.length &&
      left.every(
        (field, index) =>
          field.name === right[index]?.name &&
          field.affinity === right[index]?.affinity &&
          field.nullable === right[index]?.nullable,
      ),
    isSafeReader: () => true,
  });
}

describe("Generic singleton ROW_NUMBER rank-one fusion", () => {
  it("emits DISTINCT plus integer rank one and preserves bindings, bag values, and storage classes", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_fixture (
        id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
        group_id TEXT COLLATE BINARY NOT NULL,
        payload BLOB,
        amount INTEGER NOT NULL
      )
    `);
    const rows = [
      ["minimum", "keep", -9223372036854775808n, -9223372036854775808n],
      ["integer", "keep", 1n, 1n],
      ["real", "keep", 1.5, 2n],
      ["text", "keep", "001", 3n],
      ["blob", "keep", Uint8Array.from([0, 255, 1]), 4n],
      ["null", "keep", null, 5n],
      ["filtered", "skip", "not selected", 6n],
    ] as const;
    const insert = database.prepare(
      "INSERT INTO singleton_rank_fixture (id, group_id, payload, amount) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) insert.run(...row);

    const table = fixtureTable();
    const source = scan(
      table as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const output = rankOneOutput(source);
    const physical = lowerLogicalPlan(output);
    const { optimized, baseline } = compiledPair(output);

    expect(physical.singletonRankChoices).toHaveLength(1);
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
    expect(optimized.physicalPlanShape?.version).toBe(11);
    if (optimized.physicalPlanShape?.version === 11) {
      expect(optimized.physicalPlanShape.singletonRankFusionCount).toBe(1);
      expect(optimized.physicalPlanShape.singletonRankFusions).toEqual([
        expect.objectContaining({
          partitionFieldCount: 1,
          keyFieldCount: 1,
          consumerCertificateCount: 0,
          emissionCount: 1,
          distinct: true,
        }),
      ]);
    }
    expect(optimized.sql).toContain("SELECT DISTINCT");
    expect(optimized.sql).not.toContain("ROW_NUMBER()");
    expect(baseline.sql).toContain("ROW_NUMBER()");
    expect(baseline.sql).not.toContain("SELECT DISTINCT");
    expect(optimized.bindings).toEqual(["keep"]);
    expect(baseline.bindings).toEqual(optimized.bindings);
    expect(readRows(database, optimized)).toEqual(readRows(database, baseline));
    expect(readRows(database, optimized).map(({ storage }) => storage)).toEqual(
      ["blob", "integer", "integer", "null", "real", "text"],
    );
  });

  it("keeps a multirow non-unique partition on the original ROW_NUMBER path", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_fixture (
        id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
        group_id TEXT COLLATE BINARY NOT NULL,
        payload BLOB,
        amount INTEGER NOT NULL
      )
    `);
    const insert = database.prepare(
      "INSERT INTO singleton_rank_fixture (id, group_id, payload, amount) VALUES (?, ?, ?, ?)",
    );
    insert.run("keep-a", "keep", "first", 1);
    insert.run("keep-b", "keep", "second", 2);
    insert.run("other-a", "other", "third", 3);

    const source = scan(
      fixtureTable() as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const ranked = window(source, {
      rank: rowNumber({
        partitionBy: [source.columns.group_id!],
        orderBy: [{ expression: source.columns.id!, direction: "ASC" }],
      }),
    });
    const rankOne = filter(ranked, eq(ranked.columns.rank!, constant(1)));
    const output = project(rankOne, {
      id: rankOne.columns.id!,
      group: rankOne.columns.group_id!,
      amount: rankOne.columns.amount!,
    });
    const physical = lowerLogicalPlan(output);
    const candidate = compileD1Query(output);
    const baseline = compileD1QueryWithoutSingletonRankFusionForTest(output);

    expect(physical.singletonRankChoices).toHaveLength(0);
    expect(candidate.sql).toContain("ROW_NUMBER()");
    expect(candidate.physicalPlanShape?.version).not.toBe(11);
    expect(candidate.bindings).toEqual(baseline.bindings);
    assertBagParity(database, candidate, baseline);
    expect(readCompiledRows(database, candidate)).toHaveLength(2);
  });

  it("keeps multi-window, key-dropping, sort, and limit barriers on ROW_NUMBER", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_unique_amount (
        id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
        group_id TEXT COLLATE BINARY NOT NULL,
        amount INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX singleton_rank_unique_amount_amount_unique
        ON singleton_rank_unique_amount (amount COLLATE BINARY);
    `);
    database.exec(`
      INSERT INTO singleton_rank_unique_amount VALUES ('a', 'same', 1);
      INSERT INTO singleton_rank_unique_amount VALUES ('b', 'same', 2);
      INSERT INTO singleton_rank_unique_amount VALUES ('c', 'other', 3);
    `);
    const source = scan(
      uniqueAmountTable() as unknown as GeneratedSchemaObject,
    ) as unknown as UniqueAmountRelation;
    const multipleWindows = window(source, {
      rank: rowNumber({
        partitionBy: [source.columns.id!],
        orderBy: [{ expression: source.columns.amount!, direction: "ASC" }],
      }),
      count: windowCountRows({ partitionBy: [source.columns.id!] }),
    });
    const multipleWindowOne = filter(
      multipleWindows,
      eq(multipleWindows.columns.rank!, constant(1)),
    );
    const multipleWindowOutput = project(multipleWindowOne, {
      id: multipleWindowOne.columns.id!,
    });

    const droppedKey = project(source, {
      group_id: source.columns.group_id!,
      amount: source.columns.amount!,
    });
    const droppedRank = window(droppedKey, {
      rank: rowNumber({
        partitionBy: [droppedKey.columns.group_id!],
        orderBy: [{ expression: droppedKey.columns.amount!, direction: "ASC" }],
      }),
    });
    const droppedRankOne = filter(
      droppedRank,
      eq(droppedRank.columns.rank!, constant(1)),
    );
    const droppedKeyOutput = project(droppedRankOne, {
      group_id: droppedRankOne.columns.group_id!,
    });

    const sorted = sort(source, [
      { expression: source.columns.amount!, direction: "DESC" },
    ]);
    const sortedRank = window(sorted, {
      rank: rowNumber({
        partitionBy: [sorted.columns.id!],
        orderBy: [{ expression: sorted.columns.amount!, direction: "ASC" }],
      }),
    });
    const sortedRankOne = filter(
      sortedRank,
      eq(sortedRank.columns.rank!, constant(1)),
    );
    const sortedOutput = project(sortedRankOne, {
      id: sortedRankOne.columns.id!,
    });

    const limited = limit(source, 2);
    const limitedRank = window(limited, {
      rank: rowNumber({
        partitionBy: [limited.columns.id!],
        orderBy: [{ expression: limited.columns.amount!, direction: "ASC" }],
      }),
    });
    const limitedRankOne = filter(
      limitedRank,
      eq(limitedRank.columns.rank!, constant(1)),
    );
    const limitedOutput = project(limitedRankOne, {
      id: limitedRankOne.columns.id!,
    });

    const queries = [
      multipleWindowOutput,
      droppedKeyOutput,
      sortedOutput,
      limitedOutput,
    ] as unknown as Relation[];
    for (const query of queries) {
      const physical = lowerLogicalPlan(query);
      const candidate = compileD1Query(query);
      const baseline = compileD1QueryWithoutSingletonRankFusionForTest(query);
      expect(physical.singletonRankChoices).toHaveLength(0);
      expect(candidate.sql).toContain("ROW_NUMBER()");
      expect(candidate.physicalPlanShape?.version).not.toBe(11);
      assertBagParity(database, candidate, baseline);
    }
  });

  it("does not fuse parameterized, mixed, or non-one rank predicates", () => {
    const table = fixtureTable();
    const source = scan(
      table as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const ranked = window(source, {
      rank: rowNumber({
        partitionBy: [source.columns.id!],
        orderBy: [{ expression: source.columns.amount!, direction: "ASC" }],
      }),
    });
    const parameterized = filter(ranked, eq(ranked.columns.rank!, param(1)));
    const mixed = filter(
      ranked,
      and(
        eq(ranked.columns.rank!, constant(1)),
        eq(ranked.columns.group_id!, param("keep")),
      ),
    );
    const wrongRank = filter(ranked, eq(ranked.columns.rank!, constant(2)));

    for (const query of [parameterized, mixed, wrongRank]) {
      const physical = lowerLogicalPlan(query);
      expect(physical.singletonRankChoices).toHaveLength(0);
      const compiled = compileD1Query(query);
      expect(compiled.sql).toContain("ROW_NUMBER()");
      expect(compiled.physicalPlanShape?.version).not.toBe(11);
    }
  });

  it("requires a nullable unique partition key to be independently non-null and preserves the empty case", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_nullable_unique (
        id INTEGER PRIMARY KEY,
        nullable_key TEXT COLLATE BINARY,
        amount INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX singleton_rank_nullable_key_unique
        ON singleton_rank_nullable_unique (nullable_key COLLATE BINARY);
    `);
    const insert = database.prepare(
      "INSERT INTO singleton_rank_nullable_unique (id, nullable_key, amount) VALUES (?, ?, ?)",
    );
    insert.run(1, null, 1);
    insert.run(2, null, 2);
    insert.run(3, "alpha", 3);
    insert.run(4, "beta", 4);

    const source = scan(
      nullableUniqueTable() as unknown as GeneratedSchemaObject,
    ) as unknown as NullableUniqueRelation;
    const build = (requireNonNull: boolean, empty = false) => {
      let input = source;
      if (requireNonNull)
        input = filter(input, isNotNull(input.columns.nullable_key!));
      if (empty)
        input = filter(input, eq(input.columns.nullable_key!, param("absent")));
      const ranked = window(input, {
        rank: rowNumber({
          partitionBy: [input.columns.nullable_key!],
          orderBy: [{ expression: input.columns.id!, direction: "ASC" }],
        }),
      });
      const rankOne = filter(ranked, eq(ranked.columns.rank!, constant(1)));
      return project(rankOne, {
        id: rankOne.columns.id!,
        nullable_key: rankOne.columns.nullable_key!,
        amount: rankOne.columns.amount!,
      });
    };

    const nullable = build(false);
    const nullablePlan = lowerLogicalPlan(nullable);
    const nullableCandidate = compileD1Query(nullable);
    const nullableBaseline =
      compileD1QueryWithoutSingletonRankFusionForTest(nullable);
    expect(nullablePlan.singletonRankChoices).toHaveLength(0);
    expect(nullableCandidate.sql).toContain("ROW_NUMBER()");
    assertBagParity(database, nullableCandidate, nullableBaseline);
    expect(readCompiledRows(database, nullableCandidate)).toHaveLength(3);

    const nonNull = build(true);
    const nonNullPlan = lowerLogicalPlan(nonNull);
    const nonNullCandidate = compileD1Query(nonNull);
    const nonNullBaseline =
      compileD1QueryWithoutSingletonRankFusionForTest(nonNull);
    expect(nonNullPlan.singletonRankChoices).toHaveLength(1);
    expect(nonNullCandidate.physicalPlanShape?.version).toBe(11);
    expect(nonNullCandidate.sql).toContain("SELECT DISTINCT");
    expect(nonNullCandidate.sql).not.toContain("ROW_NUMBER()");
    assertBagParity(database, nonNullCandidate, nonNullBaseline, ["amount"]);
    expect(readCompiledRows(database, nonNullCandidate)).toHaveLength(2);

    const empty = build(true, true);
    const emptyPlan = lowerLogicalPlan(empty);
    const emptyCandidate = compileD1Query(empty);
    const emptyBaseline =
      compileD1QueryWithoutSingletonRankFusionForTest(empty);
    expect(emptyPlan.singletonRankChoices).toHaveLength(1);
    expect(emptyCandidate.sql).toContain("SELECT DISTINCT");
    expect(emptyCandidate.bindings).toEqual(["absent"]);
    assertBagParity(database, emptyCandidate, emptyBaseline);
    expect(readCompiledRows(database, emptyCandidate)).toHaveLength(0);
  });

  it("rejects sparse and extended proof metadata during fresh plan validation", () => {
    const table = fixtureTable();
    const source = scan(
      table as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const physical = lowerLogicalPlan(rankOneOutput(source));
    const choice = physical.singletonRankChoices[0]!;
    const sparse = {
      ...physical,
      singletonRankChoices: [
        { ...choice, keyFields: new Array(choice.keyFields.length) },
      ],
    };
    const extended = {
      ...physical,
      singletonRankChoices: [{ ...choice, unproven: true }],
    };

    expect(() => validatePhysicalQueryPlan(sparse)).toThrow(/singleton-rank/i);
    expect(() => validatePhysicalQueryPlan(extended)).toThrow(
      /singleton-rank/i,
    );
  });

  it("revalidates singleton rank evidence after the caller mutates its window", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_fixture (
        id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
        group_id TEXT COLLATE BINARY NOT NULL,
        payload BLOB,
        amount INTEGER NOT NULL
      );
      INSERT INTO singleton_rank_fixture VALUES ('a', 'same', 'first', 1);
      INSERT INTO singleton_rank_fixture VALUES ('b', 'same', 'second', 2);
    `);
    const source = scan(
      fixtureTable() as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const output = rankOneOutput(source);
    const physical = lowerLogicalPlan(output);
    const choice = physical.singletonRankChoices[0];
    expect(choice).toBeDefined();
    if (!choice) throw new Error("expected a singleton-rank proof");
    const descriptor = choice.window.windows[0]!;
    if (descriptor.specification.kind !== "row-number")
      throw new Error("expected row-number descriptor");
    Object.defineProperty(choice.window, "windows", {
      configurable: true,
      value: [
        {
          ...descriptor,
          specification: {
            ...descriptor.specification,
            partitionBy: [source.columns.group_id!],
          },
        },
      ],
    });

    expect(() => validatePhysicalQueryPlan(physical)).toThrow(
      /singleton-rank/i,
    );
    const candidate = compileD1Query(output);
    const baseline = compileD1QueryWithoutSingletonRankFusionForTest(output);
    expect(lowerLogicalPlan(output).singletonRankChoices).toHaveLength(0);
    expect(candidate.sql).toContain("ROW_NUMBER()");
    expect(candidate.physicalPlanShape?.version).not.toBe(11);
    assertBagParity(database, candidate, baseline);
  });

  it("fuses one consumer while a second consumer still renders the shared Window", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_fixture (
        id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
        group_id TEXT COLLATE BINARY NOT NULL,
        payload BLOB,
        amount INTEGER NOT NULL
      );
      INSERT INTO singleton_rank_fixture VALUES ('a', 'same', 'first', 1);
      INSERT INTO singleton_rank_fixture VALUES ('b', 'same', 'second', 2);
    `);
    const source = scan(
      fixtureTable() as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const ranked = window(source, {
      rank: rowNumber({
        partitionBy: [source.columns.id!],
        orderBy: [{ expression: source.columns.amount!, direction: "ASC" }],
      }),
    });
    const first = filter(ranked, eq(ranked.columns.rank!, constant(1)));
    const second = filter(ranked, eq(ranked.columns.rank!, constant(2)));
    const firstOutput = project(first, {
      id: first.columns.id!,
      amount: first.columns.amount!,
    });
    const secondOutput = project(second, {
      id: second.columns.id!,
      amount: second.columns.amount!,
    });
    const output = union(firstOutput, secondOutput, true);
    const physical = lowerLogicalPlan(output);
    const candidate = compileD1Query(output);
    const baseline = compileD1QueryWithoutSingletonRankFusionForTest(output);

    expect(physical.singletonRankChoices).toHaveLength(1);
    expect(candidate.physicalPlanShape?.version).toBe(11);
    expect(candidate.sql).toContain("SELECT DISTINCT");
    expect(candidate.sql).toContain("ROW_NUMBER()");
    expect(baseline.sql).toContain("ROW_NUMBER()");
    assertBagParity(database, candidate, baseline);
    expect(readCompiledRows(database, candidate)).toEqual([
      { id: "a", amount: "1n" },
      { id: "b", amount: "2n" },
    ]);
  });

  it("requires current materialized shared interfaces before rank fusion rendering", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_fixture (
        id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
        group_id TEXT COLLATE BINARY NOT NULL,
        payload BLOB,
        amount INTEGER NOT NULL
      );
      INSERT INTO singleton_rank_fixture VALUES ('a', 'same', 'first', 1);
      INSERT INTO singleton_rank_fixture VALUES ('b', 'same', 'second', 2);
    `);
    const source = scan(
      fixtureTable() as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const sharedInput = filter(
      source,
      neq(source.columns.group_id!, constant("ignored")),
    );
    const secondSharedInput = filter(
      source,
      neq(source.columns.group_id!, constant("excluded")),
    );
    const rankBranch = (
      input: typeof sharedInput,
      direction: "ASC" | "DESC",
      rankValue: 1 | 2,
    ) => {
      const ranked = window(input, {
        rank: rowNumber({
          partitionBy: [input.columns.id!],
          orderBy: [{ expression: input.columns.amount!, direction }],
        }),
      });
      const selected = filter(
        ranked,
        eq(ranked.columns.rank!, constant(rankValue)),
      );
      return project(selected, {
        id: selected.columns.id!,
        amount: selected.columns.amount!,
      });
    };
    const rankOneOutput = rankBranch(sharedInput, "ASC", 1);
    const rankTwoOutput = rankBranch(sharedInput, "DESC", 2);
    const secondRankOneOutput = rankBranch(secondSharedInput, "ASC", 1);
    const secondRankTwoOutput = rankBranch(secondSharedInput, "DESC", 2);
    const directSourceOutput = project(source, {
      id: source.columns.id!,
      amount: source.columns.amount!,
    });
    const output = union(
      union(
        union(rankOneOutput, rankTwoOutput, true),
        union(secondRankOneOutput, secondRankTwoOutput, true),
        true,
      ),
      directSourceOutput,
      true,
    );
    const physical = lowerLogicalPlan(output);
    const sharedDefinition = physical.sharedRelations.find(
      ({ node }) => node === sharedInput.node,
    );
    const interfaceView = validatePhysicalQueryPlan(physical);
    const currentInterface = interfaceView.interfaces.find(
      ({ definition }) => definition.node === sharedInput.node,
    );
    const candidate = compileD1Query(output);
    const baseline = compileD1QueryWithoutSingletonRankFusionForTest(output);

    expect(sharedDefinition?.materialization).toBe("materialized");
    expect(currentInterface).toMatchObject({
      boundary: { kind: "materialized-relation" },
      license: { kind: "strict-generic-facts" },
      selective: true,
      closure: { kind: "scope-and-exported-columns-closed" },
      totality: { kind: "checked-through-current-boundaries" },
    });
    expect(physical.sharedRelations.length).toBeGreaterThan(1);
    expect(physical.singletonRankChoices.length).toBeGreaterThan(0);
    expect(
      physical.singletonRankChoices.some((choice) =>
        choice.boundaryDependencies.some(
          (dependency) => dependency.node === sharedInput.node,
        ),
      ),
    ).toBe(true);
    expect(candidate.physicalPlanShape?.version).toBe(12);
    if (candidate.physicalPlanShape?.version !== 12)
      throw new Error("singleton_rank_v12_shape_missing");
    expect(
      candidate.physicalPlanShape.singletonRankFusionCount,
    ).toBeGreaterThan(0);
    expect(
      candidate.physicalPlanShape.directMaterializedReferenceCount,
    ).toBeGreaterThan(0);
    expect(candidate.sql).toContain("SELECT DISTINCT");
    expect(candidate.sql).toContain("ROW_NUMBER()");
    assertBagParity(database, candidate, baseline);

    const reordered = {
      ...physical,
      sharedRelations: [...physical.sharedRelations].reverse(),
    };
    expect(() =>
      validatePhysicalQueryPlan(reordered as typeof physical),
    ).toThrow();

    const firstChoice = physical.singletonRankChoices.find((choice) =>
      choice.boundaryDependencies.some(
        (dependency) =>
          dependency.node === sharedInput.node ||
          dependency.node === secondSharedInput.node,
      ),
    )!;
    const dependencyIndex = firstChoice.boundaryDependencies.findIndex(
      ({ node }) =>
        node === sharedInput.node || node === secondSharedInput.node,
    );
    expect(dependencyIndex).toBeGreaterThanOrEqual(0);
    const forgedDependencies = [...firstChoice.boundaryDependencies];
    const dependency = forgedDependencies[dependencyIndex]!;
    forgedDependencies[dependencyIndex] = {
      ...dependency,
      consumerProducer: dependency.node,
      consumerProducerIndex: dependency.producerIndex,
    };
    const ownProducerBoundary = {
      ...physical,
      singletonRankChoices: [
        { ...firstChoice, boundaryDependencies: forgedDependencies },
        ...physical.singletonRankChoices.slice(1),
      ],
    };
    expect(() =>
      validatePhysicalQueryPlan(ownProducerBoundary as typeof physical),
    ).toThrow(/singleton-rank/i);
  });

  it("rejects unknown and non-BINARY key comparison metadata with matching SQLite DDL", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_nocase_key (
        id TEXT NOT NULL,
        amount INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX singleton_rank_nocase_key_unique
        ON singleton_rank_nocase_key (id COLLATE NOCASE);
      CREATE TABLE singleton_rank_unknown_key (
        id TEXT COLLATE NOCASE NOT NULL PRIMARY KEY,
        amount INTEGER NOT NULL
      );
    `);
    database
      .prepare(
        "INSERT INTO singleton_rank_nocase_key (id, amount) VALUES (?, ?)",
      )
      .run("Alpha", 1);
    database
      .prepare(
        "INSERT INTO singleton_rank_unknown_key (id, amount) VALUES (?, ?)",
      )
      .run("Beta", 2);

    const cases = [
      {
        catalogKey: "__singleton_rank_nocase_key",
        name: "singleton_rank_nocase_key",
        defaultCollation: "BINARY" as const,
        columns: {
          id: column("singleton_rank_nocase_key", "id", "TEXT", "text", false),
          amount: column(
            "singleton_rank_nocase_key",
            "amount",
            "INTEGER",
            "integer",
            false,
          ),
        },
        primaryKey: [] as readonly string[],
        indexes: [
          {
            name: "singleton_rank_nocase_key_unique",
            unique: true,
            columns: ["id"],
            collations: ["NOCASE"],
            partial: false,
          },
        ],
        id: "Alpha",
      },
      {
        catalogKey: "__singleton_rank_unknown_key",
        name: "singleton_rank_unknown_key",
        defaultCollation: "unknown" as const,
        columns: {
          id: column(
            "singleton_rank_unknown_key",
            "id",
            "TEXT",
            "text",
            false,
            1,
          ),
          amount: column(
            "singleton_rank_unknown_key",
            "amount",
            "INTEGER",
            "integer",
            false,
          ),
        },
        primaryKey: ["id"],
        indexes: [],
        id: "Beta",
      },
    ] as const;

    for (const testCase of cases) {
      const table = registerTable(testCase.catalogKey, {
        kind: "table",
        name: testCase.name,
        defaultCollation: testCase.defaultCollation,
        columns: testCase.columns,
        primaryKey: testCase.primaryKey,
        indexes: testCase.indexes,
        foreignKeys: [],
      });
      const source = scan(
        table as unknown as GeneratedSchemaObject,
      ) as unknown as IdAmountRelation;
      const ranked = window(source, {
        rank: rowNumber({
          partitionBy: [source.columns.id!],
          orderBy: [{ expression: source.columns.amount!, direction: "ASC" }],
        }),
      });
      const rankOne = filter(ranked, eq(ranked.columns.rank!, constant(1)));
      const output = project(rankOne, { id: rankOne.columns.id! });
      const physical = lowerLogicalPlan(output);
      const candidate = compileD1Query(output);
      const baseline = compileD1QueryWithoutSingletonRankFusionForTest(output);
      expect(physical.singletonRankChoices).toHaveLength(0);
      expect(candidate.sql).toContain("ROW_NUMBER()");
      assertBagParity(database, candidate, baseline);
      expect(readCompiledRows(database, candidate)).toEqual([
        { id: testCase.id },
      ]);
    }
  });

  it("proves complete DISTINCT UNION consumers in the Generic compiler and SQLite", () => {
    for (const reverseUnion of [false, true]) {
      const database = new DatabaseSync(":memory:");
      databases.add(database);
      database.exec(`
        CREATE TABLE singleton_rank_union_left (
          value INTEGER NOT NULL,
          tag TEXT COLLATE BINARY NOT NULL
        );
        CREATE TABLE singleton_rank_union_right (
          value INTEGER NOT NULL,
          tag TEXT COLLATE BINARY NOT NULL
        );
        CREATE TABLE singleton_rank_numeric_lookup (
          id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
          match_value INTEGER NOT NULL,
          match_tag TEXT COLLATE BINARY NOT NULL,
          amount INTEGER NOT NULL,
          payload BLOB
        );
      `);

      const integerMinimum = -9223372036854775808n;
      const realMinimum = -9223372036854775808;
      const unionRows = [
        [integerMinimum, "minimum"],
        [7n, "integer"],
        [8n, "text"],
        [9n, "blob"],
        [10n, "null"],
      ] as const;
      const insertLeft = database.prepare(
        "INSERT INTO singleton_rank_union_left (value, tag) VALUES (?, ?)",
      );
      const insertRight = database.prepare(
        "INSERT INTO singleton_rank_union_right (value, tag) VALUES (?, ?)",
      );
      for (const [value, tag] of unionRows) insertLeft.run(value, tag);
      insertRight.run(realMinimum, "minimum");
      for (const [value, tag] of unionRows.slice(1))
        insertRight.run(value, tag);

      const storedRepresentations = database
        .prepare(
          "SELECT typeof(value) AS storage FROM singleton_rank_union_left UNION ALL SELECT typeof(value) AS storage FROM singleton_rank_union_right",
        )
        .all() as Array<{ readonly storage: string }>;
      expect(storedRepresentations.map(({ storage }) => storage)).toContain(
        "integer",
      );
      expect(storedRepresentations.map(({ storage }) => storage)).toContain(
        "real",
      );

      const insertLookup = database.prepare(
        "INSERT INTO singleton_rank_numeric_lookup (id, match_value, match_tag, amount, payload) VALUES (?, ?, ?, ?, ?)",
      );
      insertLookup.run(
        "int-min",
        integerMinimum,
        "minimum",
        1,
        Uint8Array.from([0, 255]),
      );
      insertLookup.run("real-min", realMinimum, "minimum", 2, "not-a-digit");
      insertLookup.run("integer", 7n, "integer", 3, 4n);
      insertLookup.run("text", 8n, "text", 4, "001");
      insertLookup.run("blob", 9n, "blob", 5, Uint8Array.from([9, 0]));
      insertLookup.run("null", 10n, "null", 6, null);

      const { output } = numericUnionRankOutput({ reverseUnion });
      const physical = lowerLogicalPlan(output);
      const candidate = compileD1Query(output);
      const baseline = compileD1QueryWithoutSingletonRankFusionForTest(output);
      expect(physical.singletonRankChoices).toHaveLength(1);
      expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
      expect(
        physical.singletonRankChoices[0]?.consumerCertificates,
      ).toHaveLength(1);
      const choice = physical.singletonRankChoices[0]!;
      const certificate = choice.consumerCertificates[0]!;
      expect(certificate).toMatchObject({
        fields: [{}, {}],
        joinEqualities: [{}, {}],
        droppedBy: [{}, {}],
      });
      const sparseNestedCertificate = {
        ...physical,
        singletonRankChoices: [
          {
            ...choice,
            consumerCertificates: [
              { ...certificate, fields: new Array(certificate.fields.length) },
            ],
          },
        ],
      };
      const extendedNestedCertificate = {
        ...physical,
        singletonRankChoices: [
          {
            ...choice,
            consumerCertificates: [{ ...certificate, unproven: true }],
          },
        ],
      };
      expect(() =>
        validatePhysicalQueryPlan(sparseNestedCertificate as typeof physical),
      ).toThrow(/singleton-rank/i);
      expect(() =>
        validatePhysicalQueryPlan(extendedNestedCertificate as typeof physical),
      ).toThrow(/singleton-rank/i);
      expect(candidate.physicalPlanShape?.version).toBe(11);
      if (candidate.physicalPlanShape?.version === 11)
        expect(candidate.physicalPlanShape.singletonRankFusions).toEqual([
          expect.objectContaining({
            consumerCertificateCount: 1,
            emissionCount: 1,
            distinct: true,
          }),
        ]);
      expect(candidate.sql).toContain("SELECT DISTINCT");
      expect(candidate.sql).not.toContain("ROW_NUMBER()");
      expect(baseline.sql).toContain("ROW_NUMBER()");
      assertBagParity(database, candidate, baseline, [
        "match_value",
        "payload",
      ]);
      const rows = readCompiledRows(database, candidate, [
        "match_value",
        "payload",
      ]);
      expect(rows).toHaveLength(12);
      expect(rows.map((row) => row.__typeof_match_value)).toEqual(
        expect.arrayContaining(["integer", "real"]),
      );
      expect(rows.map((row) => row.__typeof_payload)).toEqual(
        expect.arrayContaining(["blob", "integer", "null", "text"]),
      );
    }

    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_union_left (
        value INTEGER NOT NULL,
        tag TEXT COLLATE BINARY NOT NULL
      );
      CREATE TABLE singleton_rank_union_right (
        value INTEGER NOT NULL,
        tag TEXT COLLATE BINARY NOT NULL
      );
      CREATE TABLE singleton_rank_numeric_lookup (
        id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
        match_value INTEGER NOT NULL,
        match_tag TEXT COLLATE BINARY NOT NULL,
        amount INTEGER NOT NULL,
        payload BLOB
      );
      INSERT INTO singleton_rank_union_left VALUES (-9223372036854775808, 'minimum');
      INSERT INTO singleton_rank_union_left VALUES (7, 'integer');
      INSERT INTO singleton_rank_union_left VALUES (8, 'text');
      INSERT INTO singleton_rank_union_left VALUES (9, 'blob');
      INSERT INTO singleton_rank_union_left VALUES (10, 'null');
      INSERT INTO singleton_rank_union_right SELECT * FROM singleton_rank_union_left;
      INSERT INTO singleton_rank_numeric_lookup VALUES ('int-min', -9223372036854775808, 'minimum', 1, x'00ff');
      INSERT INTO singleton_rank_numeric_lookup VALUES ('real-min', -9223372036854775808, 'minimum', 2, 'not-a-digit');
      INSERT INTO singleton_rank_numeric_lookup VALUES ('integer', 7, 'integer', 3, 4);
      INSERT INTO singleton_rank_numeric_lookup VALUES ('text', 8, 'text', 4, '001');
      INSERT INTO singleton_rank_numeric_lookup VALUES ('blob', 9, 'blob', 5, x'0900');
      INSERT INTO singleton_rank_numeric_lookup VALUES ('null', 10, 'null', 6, NULL);
    `);

    for (const options of [
      { castJoinKey: true },
      { orJoin: true },
      { incompleteEquality: true },
      { leakRight: true },
      { expressionQueryParent: true },
    ]) {
      const { output } = numericUnionRankOutput(options);
      const physical = lowerLogicalPlan(output);
      const candidate = compileD1Query(output);
      const baseline = compileD1QueryWithoutSingletonRankFusionForTest(output);
      expect(physical.singletonRankChoices).toHaveLength(0);
      expect(candidate.sql).toContain("ROW_NUMBER()");
      expect(candidate.physicalPlanShape?.version).not.toBe(11);
      assertBagParity(database, candidate, baseline, [
        "match_value",
        "payload",
      ]);
    }
  });

  it("certifies only complete DISTINCT UNION consumers that drop every raw right value", () => {
    const safe = unionConsumerGraph({});
    const certified = proveUnionConsumer(safe.root, safe.union);
    expect(certified.passed).toBe(true);
    if (certified.passed) {
      expect(certified.certificate.fields).toHaveLength(1);
      expect(certified.certificate.joinEqualities).toHaveLength(1);
      expect(certified.certificate.droppedBy).toHaveLength(1);
    }

    for (const options of [
      { leakRight: true },
      { castJoinKey: true },
      { rawSecondParent: true },
    ]) {
      const unsafe = unionConsumerGraph(options);
      expect(proveUnionConsumer(unsafe.root, unsafe.union).passed).toBe(false);
    }
  });

  it("rechecks DISTINCT UNION consumers at root, materialized, and intermediate contexts", () => {
    const rootUnion = unionConsumerGraph({});
    const rootProof = readerProofForDistinctUnion({
      root: rootUnion.union,
      union: rootUnion.union,
    });
    expect(rootProof.passed).toBe(false);
    expect(rootProof.distinctUnionContextCount).toBe(1);
    expect(rootProof.distinctUnionProofs).toMatchObject([{ passed: false }]);
    expect(rootProof.distinctUnionProofs[0]?.reason).toBeTruthy();

    const safe = unionConsumerGraph({});
    const materializedProducerProof = readerProofForDistinctUnion({
      root: safe.root,
      union: safe.union,
      currentMaterializedProducer: true,
    });
    expect(materializedProducerProof.passed).toBe(false);
    expect(materializedProducerProof.distinctUnionContextCount).toBe(1);
    expect(materializedProducerProof.distinctUnionProofs).toMatchObject([
      { passed: false },
    ]);
    expect(
      materializedProducerProof.distinctUnionProofs[0]?.reason,
    ).toBeTruthy();

    const intermediateProof = readerProofForDistinctUnion({
      root: safe.root,
      union: safe.union,
    });
    expect(intermediateProof.passed).toBe(true);
    expect(intermediateProof.distinctUnionProofs).toMatchObject([
      { passed: true },
    ]);

    const unsafe = unionConsumerGraph({ rawSecondParent: true });
    for (const currentMaterializedProducer of [false, true]) {
      const proof = readerProofForDistinctUnion({
        root: unsafe.root,
        union: unsafe.union,
        currentMaterializedProducer,
      });
      expect(proof.passed).toBe(false);
      expect(proof.distinctUnionContextCount).toBe(1);
      expect(proof.distinctUnionProofs).toHaveLength(1);
      expect(proof.distinctUnionProofs[0]?.passed).toBe(false);
      expect(proof.distinctUnionProofs[0]?.reason).toBeTruthy();
    }
  });

  it("keeps integer-overflow evaluation when the input is not total", () => {
    const database = new DatabaseSync(":memory:");
    databases.add(database);
    database.exec(`
      CREATE TABLE singleton_rank_fixture (
        id TEXT COLLATE BINARY NOT NULL PRIMARY KEY,
        group_id TEXT COLLATE BINARY NOT NULL,
        payload BLOB,
        amount INTEGER NOT NULL
      )
    `);
    database
      .prepare(
        "INSERT INTO singleton_rank_fixture (id, group_id, payload, amount) VALUES (?, ?, ?, ?)",
      )
      .run("minimum", "keep", null, -9223372036854775808n);
    const table = fixtureTable();
    const source = scan(
      table as unknown as GeneratedSchemaObject,
    ) as unknown as TestRelation;
    const unsafeInput = filter(
      source,
      gt(callFunction("abs", source.columns.amount!), constant(0)),
    );
    const ranked = window(unsafeInput, {
      rank: rowNumber({
        partitionBy: [unsafeInput.columns.id!],
        orderBy: [
          { expression: unsafeInput.columns.amount!, direction: "ASC" },
        ],
      }),
    });
    const rankOne = filter(ranked, eq(ranked.columns.rank!, constant(1)));
    const output = project(rankOne, { id: rankOne.columns.id! });
    const physical = lowerLogicalPlan(output);
    const optimized = compileD1Query(output);
    const baseline = compileD1QueryWithoutSingletonRankFusionForTest(output);

    expect(physical.singletonRankChoices).toHaveLength(0);
    expect(optimized.sql).toContain("ROW_NUMBER()");
    expect(baseline.sql).toContain("ROW_NUMBER()");
    const run = (query: {
      readonly sql: string;
      readonly bindings?: readonly unknown[];
    }) =>
      database
        .prepare(query.sql)
        .all(...((query.bindings ?? []) as SQLInputValue[]));
    expect(() => run(optimized)).toThrow(/integer overflow/i);
    expect(() => run(baseline)).toThrow(/integer overflow/i);
  });
});
