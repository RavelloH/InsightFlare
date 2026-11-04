import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  distinct,
  eq,
  filter,
  isNotNull,
  join,
  param,
  project,
  scan,
  schema,
  semiJoin,
  union,
  window,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import {
  createProvenPartitionedRowNumberWindowAnalysisContext,
  isMaterializationSafePartitionedRowNumberWindow,
  isMaterializationSafeProvenPartitionedRowNumberWindow,
} from "@/lib/db/query/materialization-safety";
import {
  analyzeRelationalKeyFacts,
  hasStableRowNumberOrdering,
} from "@/lib/db/query/relational-key-facts";
import type {
  GeneratedSchemaObject,
  SchemaColumnReference,
  SchemaTableReference,
} from "@/lib/db/schema";

function testColumn(
  table: string,
  name: string,
  options: {
    readonly affinity?: SchemaColumnReference["affinity"];
    readonly nullable?: boolean;
    readonly primaryKeyPosition?: number;
  } = {},
): SchemaColumnReference {
  const affinity = options.affinity ?? "text";
  const declaredType =
    affinity === "integer"
      ? "INTEGER"
      : affinity === "real"
        ? "REAL"
        : affinity === "numeric"
          ? "NUMERIC"
          : affinity === "blob"
            ? "BLOB"
            : "TEXT";
  return {
    kind: "column",
    table,
    sqlName: name,
    propertyName: name,
    declaredType,
    affinity,
    nullable: options.nullable ?? false,
    primaryKeyPosition: options.primaryKeyPosition ?? 0,
    defaultSql: null,
    hidden: 0,
    generated: false,
  };
}

function testTable(input: {
  readonly name: string;
  readonly columns: Readonly<Record<string, SchemaColumnReference>>;
  readonly primaryKey?: readonly string[];
  readonly defaultCollation?: SchemaTableReference["defaultCollation"];
  readonly indexes?: SchemaTableReference["indexes"];
}): SchemaTableReference {
  return {
    kind: "table",
    name: input.name,
    defaultCollation: input.defaultCollation ?? "BINARY",
    columns: input.columns,
    primaryKey: input.primaryKey ?? [],
    indexes: input.indexes ?? [],
    foreignKeys: [],
  };
}

function testScan(table: SchemaTableReference) {
  return scan(table as unknown as GeneratedSchemaObject);
}

function column(
  relation: { readonly columns: Readonly<Record<string, AnyExpression>> },
  name: string,
): AnyExpression {
  return relation.columns[name]!;
}

function rowNumberSpec(input: {
  readonly partitionBy?: readonly AnyExpression[];
  readonly orderBy: readonly AnyExpression[];
}) {
  return {
    kind: "row-number" as const,
    partitionBy: input.partitionBy ?? [],
    orderBy: input.orderBy.map((expression) => ({
      expression,
      direction: "ASC" as const,
    })) as [
      { readonly expression: AnyExpression; readonly direction: "ASC" },
      ...{ readonly expression: AnyExpression; readonly direction: "ASC" }[],
    ],
  };
}

function hasKey(
  facts: ReturnType<typeof analyzeRelationalKeyFacts>,
  fields: number[],
) {
  return facts.keys.some(
    (key) =>
      key.fields.length === fields.length &&
      key.fields.every((field, index) => field === fields[index]),
  );
}

describe("relational key facts", () => {
  it("keeps a nullable UNIQUE key conditional until IS NOT NULL", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE nullable_unique (key TEXT UNIQUE);
        INSERT INTO nullable_unique VALUES (NULL), (NULL), ('x');
      `);
      const duplicateNulls = database
        .prepare(
          `SELECT count(*) AS count FROM nullable_unique WHERE key IS NULL`,
        )
        .get() as { readonly count: number };
      const filteredRows = database
        .prepare(
          `SELECT count(*) AS count FROM nullable_unique WHERE key IS NOT NULL`,
        )
        .get() as { readonly count: number };

      expect(duplicateNulls.count).toBe(2);
      expect(filteredRows.count).toBe(1);

      const relation = testScan(
        testTable({
          name: "nullable_unique",
          columns: {
            key: testColumn("nullable_unique", "key", { nullable: true }),
          },
          indexes: [
            {
              name: "nullable_unique_key",
              unique: true,
              columns: ["key"],
              collations: ["BINARY"],
              partial: false,
            },
          ],
        }),
      );
      expect(
        hasStableRowNumberOrdering(relation, {
          kind: "row-number",
          partitionBy: [],
          orderBy: [{ expression: column(relation, "key"), direction: "ASC" }],
        }),
      ).toBe(false);
      const nonNullRelation = filter(
        relation,
        isNotNull(column(relation, "key")),
      );
      expect(
        hasStableRowNumberOrdering(nonNullRelation, {
          kind: "row-number",
          partitionBy: [],
          orderBy: [
            { expression: column(nonNullRelation, "key"), direction: "ASC" },
          ],
        }),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("uses actual nullable TEXT primary-key facts only after IS NOT NULL", () => {
    const visits = scan(schema.visits);
    const visitId = visits.columns.visit_id;
    const beforeFilter = rowNumberSpec({ orderBy: [visitId] });

    expect(visitId.resultType.nullable).toBe(true);
    expect(hasStableRowNumberOrdering(visits, beforeFilter)).toBe(false);

    const nonNullVisits = filter(visits, isNotNull(visitId));
    expect(
      hasStableRowNumberOrdering(nonNullVisits, {
        kind: "row-number",
        partitionBy: [],
        orderBy: [
          { expression: nonNullVisits.columns.visit_id, direction: "ASC" },
        ],
      }),
    ).toBe(true);
  });

  it("uses the actual non-null BINARY UNIQUE event id through a direct projection", () => {
    const events = scan(schema.custom_events);
    const projected = project(events, { localId: events.columns.event_id });

    expect(
      hasStableRowNumberOrdering(projected, {
        kind: "row-number",
        partitionBy: [],
        orderBy: [{ expression: projected.columns.localId, direction: "ASC" }],
      }),
    ).toBe(true);
  });

  it("preserves the event key through a unique nullable owner lookup without null-extending the owner key", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE events (event_id INTEGER PRIMARY KEY, visit_id TEXT);
        CREATE TABLE visits (visit_id TEXT UNIQUE);
        INSERT INTO events VALUES (1, NULL), (2, NULL), (3, 'visit-1');
        INSERT INTO visits VALUES ('visit-1');
      `);
      const rows = database
        .prepare(
          `SELECT visits.visit_id AS right_visit_id
           FROM events LEFT JOIN visits ON events.visit_id = visits.visit_id`,
        )
        .all() as { readonly right_visit_id: string | null }[];
      expect(rows).toHaveLength(3);
      expect(
        rows.filter(({ right_visit_id }) => right_visit_id === null),
      ).toHaveLength(2);
    } finally {
      database.close();
    }

    const events = scan(schema.custom_events);
    const visits = scan(schema.visits);
    const joined = join(
      events,
      visits,
      eq(events.columns.visit_id, visits.columns.visit_id),
      "left",
    );
    const facts = analyzeRelationalKeyFacts(joined);
    const eventIdField = events.fields.findIndex(
      (field) => field.name === "event_id",
    );
    const rightVisitIdField =
      events.fields.length +
      visits.fields.findIndex((field) => field.name === "visit_id");

    expect(hasKey(facts, [eventIdField])).toBe(true);
    expect(facts.nonNullFields.has(rightVisitIdField)).toBe(false);
    expect(hasKey(facts, [rightVisitIdField])).toBe(false);
  });

  it("drops a left key on a non-unique one-to-many join and keeps only a tuple key", () => {
    const left = testScan(
      testTable({
        name: "left_rows",
        columns: {
          id: testColumn("left_rows", "id", { primaryKeyPosition: 1 }),
          group_id: testColumn("left_rows", "group_id"),
        },
        primaryKey: ["id"],
      }),
    );
    const right = testScan(
      testTable({
        name: "right_rows",
        columns: {
          id: testColumn("right_rows", "id", { primaryKeyPosition: 1 }),
          group_id: testColumn("right_rows", "group_id"),
        },
        primaryKey: ["id"],
      }),
    );
    const joined = join(
      left,
      right,
      eq(column(left, "group_id"), column(right, "group_id")),
    );
    const facts = analyzeRelationalKeyFacts(joined);

    expect(hasKey(facts, [0])).toBe(false);
    expect(hasKey(facts, [0, 2])).toBe(true);
  });

  it("keeps a left key across semi-join membership even when the right side is a bag", () => {
    const left = testScan(
      testTable({
        name: "left_rows",
        columns: {
          id: testColumn("left_rows", "id", { primaryKeyPosition: 1 }),
          group_id: testColumn("left_rows", "group_id"),
        },
        primaryKey: ["id"],
      }),
    );
    const right = testScan(
      testTable({
        name: "right_bag",
        columns: {
          group_id: testColumn("right_bag", "group_id"),
        },
      }),
    );
    const matched = semiJoin(
      left,
      right,
      eq(column(left, "group_id"), column(right, "group_id")),
    );

    expect(hasKey(analyzeRelationalKeyFacts(matched), [0])).toBe(true);
  });

  it("rejects a derived lookup key when SQLite affinity can merge DISTINCT values", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE raw_values (lookup_key BLOB);
        INSERT INTO raw_values VALUES (1), ('1');
        CREATE TABLE numeric_lookup (
          id INTEGER PRIMARY KEY,
          lookup_key NUMERIC
        );
        INSERT INTO numeric_lookup VALUES (1, 1);
      `);
      const distinctRows = database
        .prepare(
          `SELECT typeof(lookup_key) AS storage_class, quote(lookup_key) AS value
           FROM (SELECT DISTINCT lookup_key FROM raw_values)
           ORDER BY storage_class`,
        )
        .all();
      const matchingRows = database
        .prepare(
          `SELECT count(*) AS count
           FROM numeric_lookup AS lookup
           JOIN (SELECT DISTINCT lookup_key FROM raw_values) AS derived
             ON lookup.lookup_key = derived.lookup_key`,
        )
        .get() as { readonly count: number };

      expect(distinctRows).toHaveLength(2);
      expect(matchingRows.count).toBe(2);

      const raw = testScan(
        testTable({
          name: "raw_values",
          columns: {
            lookup_key: testColumn("raw_values", "lookup_key", {
              affinity: "blob",
            }),
          },
        }),
      );
      const lookup = testScan(
        testTable({
          name: "numeric_lookup",
          columns: {
            id: testColumn("numeric_lookup", "id", {
              affinity: "integer",
              primaryKeyPosition: 1,
            }),
            lookup_key: testColumn("numeric_lookup", "lookup_key", {
              affinity: "numeric",
            }),
          },
          primaryKey: ["id"],
        }),
      );
      const derived = distinct(raw);
      const joined = join(
        lookup,
        derived,
        eq(column(lookup, "lookup_key"), column(derived, "lookup_key")),
      );
      expect(hasKey(analyzeRelationalKeyFacts(joined), [0])).toBe(false);
    } finally {
      database.close();
    }
  });

  it("allows a DISTINCT lookup key when the stored affinity domain matches on both sides", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE raw_text (lookup_key TEXT);
        INSERT INTO raw_text VALUES (x'31'), (1), ('1');
        CREATE TABLE text_lookup (
          id INTEGER PRIMARY KEY,
          lookup_key TEXT
        );
        INSERT INTO text_lookup VALUES (1, '1');
      `);
      const distinctRows = database
        .prepare(
          `SELECT typeof(lookup_key) AS storage_class, quote(lookup_key) AS value
           FROM (SELECT DISTINCT lookup_key FROM raw_text)
           ORDER BY storage_class`,
        )
        .all();
      const matchingRows = database
        .prepare(
          `SELECT count(*) AS count
           FROM text_lookup AS lookup
           JOIN (SELECT DISTINCT lookup_key FROM raw_text) AS derived
             ON lookup.lookup_key = derived.lookup_key`,
        )
        .get() as { readonly count: number };

      expect(distinctRows).toHaveLength(2);
      expect(matchingRows.count).toBe(1);

      const raw = testScan(
        testTable({
          name: "raw_text",
          columns: {
            lookup_key: testColumn("raw_text", "lookup_key", {
              affinity: "text",
            }),
          },
        }),
      );
      const lookup = testScan(
        testTable({
          name: "text_lookup",
          columns: {
            id: testColumn("text_lookup", "id", {
              affinity: "integer",
              primaryKeyPosition: 1,
            }),
            lookup_key: testColumn("text_lookup", "lookup_key", {
              affinity: "text",
            }),
          },
          primaryKey: ["id"],
        }),
      );
      const derived = distinct(raw);
      const joined = join(
        lookup,
        derived,
        eq(column(lookup, "lookup_key"), column(derived, "lookup_key")),
      );
      expect(hasKey(analyzeRelationalKeyFacts(joined), [0])).toBe(true);
    } finally {
      database.close();
    }
  });

  it("proves a UNION ALL key from distinct integer branch tags and waits for the nullable id filter", () => {
    const visits = scan(schema.visits);
    const events = scan(schema.custom_events);
    const pages = project(visits, {
      source_id: visits.columns.visit_id,
      source_rank: param(0),
    });
    const eventRows = project(events, {
      source_id: events.columns.event_id,
      source_rank: param(1),
    });
    const combined = union(pages, eventRows, true);
    const ordering = {
      kind: "row-number" as const,
      partitionBy: [combined.columns.source_rank],
      orderBy: [
        { expression: combined.columns.source_id, direction: "ASC" as const },
      ] as const,
    };

    expect(hasStableRowNumberOrdering(combined, ordering)).toBe(false);
    const nonNullRows = filter(combined, isNotNull(combined.columns.source_id));
    const ranked = window(nonNullRows, {
      rank: {
        kind: "row-number",
        partitionBy: [nonNullRows.columns.source_rank],
        orderBy: [
          { expression: nonNullRows.columns.source_id, direction: "ASC" },
        ],
      },
    });
    expect(
      hasStableRowNumberOrdering(nonNullRows, {
        kind: "row-number",
        partitionBy: [nonNullRows.columns.source_rank],
        orderBy: [
          { expression: nonNullRows.columns.source_id, direction: "ASC" },
        ],
      }),
    ).toBe(true);
    expect(isMaterializationSafePartitionedRowNumberWindow(ranked.node)).toBe(
      false,
    );
    expect(
      isMaterializationSafeProvenPartitionedRowNumberWindow(ranked.node),
    ).toBe(true);
  });

  it("reuses a proven row-number fact only inside one fresh analysis context", () => {
    const visits = scan(schema.visits);
    const events = scan(schema.custom_events);
    const pages = project(visits, {
      source_id: visits.columns.visit_id,
      source_rank: param(0),
    });
    const eventRows = project(events, {
      source_id: events.columns.event_id,
      source_rank: param(1),
    });
    const combined = union(pages, eventRows, true);
    const nonNullRows = filter(combined, isNotNull(combined.columns.source_id));
    const ranked = window(nonNullRows, {
      rank: {
        kind: "row-number",
        partitionBy: [nonNullRows.columns.source_rank],
        orderBy: [
          { expression: nonNullRows.columns.source_id, direction: "ASC" },
        ],
      },
    });
    const analyzedWindows: object[] = [];
    const loweringAnalysis =
      createProvenPartitionedRowNumberWindowAnalysisContext((node) =>
        analyzedWindows.push(node),
      );

    expect(loweringAnalysis.isSafe(ranked.node)).toBe(true);
    expect(loweringAnalysis.isSafe(ranked.node)).toBe(true);
    expect(analyzedWindows).toEqual([ranked.node]);

    const validationAnalysis =
      createProvenPartitionedRowNumberWindowAnalysisContext((node) =>
        analyzedWindows.push(node),
      );
    expect(validationAnalysis.isSafe(ranked.node)).toBe(true);
    expect(analyzedWindows).toEqual([ranked.node, ranked.node]);
  });

  it("fails closed when UNION ALL tags collide or are projected away", () => {
    const visits = scan(schema.visits);
    const events = scan(schema.custom_events);
    const pageBranch = project(visits, {
      source_id: visits.columns.visit_id,
      tag: param(1),
    });
    const eventBranch = project(events, {
      source_id: events.columns.event_id,
      tag: param(1.0),
    });
    const collidingUnion = union(pageBranch, eventBranch, true);
    const colliding = filter(
      collidingUnion,
      isNotNull(collidingUnion.columns.source_id),
    );
    expect(
      hasStableRowNumberOrdering(colliding, {
        kind: "row-number",
        partitionBy: [column(colliding, "tag")],
        orderBy: [
          { expression: column(colliding, "source_id"), direction: "ASC" },
        ],
      }),
    ).toBe(false);

    const combined = union(
      project(visits, { source_id: visits.columns.visit_id }),
      project(events, { source_id: events.columns.event_id }),
      true,
    );
    const withoutTag = project(combined, {
      source_id: combined.columns.source_id,
    });
    const nonNull = filter(withoutTag, isNotNull(withoutTag.columns.source_id));
    expect(
      hasStableRowNumberOrdering(nonNull, {
        kind: "row-number",
        partitionBy: [],
        orderBy: [{ expression: nonNull.columns.source_id, direction: "ASC" }],
      }),
    ).toBe(false);
  });

  it("does not use unknown table or index collation as a key contract", () => {
    const unknownTable = testTable({
      name: "unknown_collation",
      defaultCollation: "unknown",
      columns: {
        id: testColumn("unknown_collation", "id", { primaryKeyPosition: 1 }),
      },
      primaryKey: ["id"],
      indexes: [
        {
          name: "unknown_collation_unique",
          unique: true,
          columns: ["id"],
          collations: ["BINARY"],
          partial: false,
        },
      ],
    });
    const noCaseIndex = testTable({
      name: "nocase_index",
      columns: { id: testColumn("nocase_index", "id") },
      indexes: [
        {
          name: "nocase_unique",
          unique: true,
          columns: ["id"],
          collations: ["NOCASE"],
          partial: false,
        },
      ],
    });

    for (const relation of [testScan(unknownTable), testScan(noCaseIndex)]) {
      expect(
        hasStableRowNumberOrdering(relation, {
          kind: "row-number",
          partitionBy: [],
          orderBy: [{ expression: column(relation, "id"), direction: "ASC" }],
        }),
      ).toBe(false);
    }
  });

  it("records a rank-one partition key without treating the preceding order as stable", () => {
    const source = testScan(
      testTable({
        name: "rank_source",
        columns: {
          group_id: testColumn("rank_source", "group_id"),
          value: testColumn("rank_source", "value"),
        },
      }),
    );
    const specification = rowNumberSpec({
      partitionBy: [column(source, "group_id")],
      orderBy: [column(source, "value")],
    });
    const ranked = window(source, { rank: specification });
    const rankOne = filter(ranked, eq(ranked.columns.rank, param(1)));
    const facts = analyzeRelationalKeyFacts(rankOne);

    expect(hasStableRowNumberOrdering(source, specification)).toBe(false);
    expect(hasKey(facts, [0])).toBe(true);
  });

  it("requires every row-number window in a node to have an independent proof", () => {
    const source = testScan(
      testTable({
        name: "multi_window_source",
        columns: {
          id: testColumn("multi_window_source", "id", {
            primaryKeyPosition: 1,
          }),
          group_id: testColumn("multi_window_source", "group_id"),
          value: testColumn("multi_window_source", "value"),
        },
        primaryKey: ["id"],
      }),
    );
    const mixedWindows = window(source, {
      stable_rank: {
        kind: "row-number",
        partitionBy: [column(source, "group_id")],
        orderBy: [{ expression: column(source, "id"), direction: "ASC" }],
      },
      unstable_rank: {
        kind: "row-number",
        partitionBy: [column(source, "group_id")],
        orderBy: [{ expression: column(source, "value"), direction: "ASC" }],
      },
    });

    expect(
      isMaterializationSafeProvenPartitionedRowNumberWindow(mixedWindows.node),
    ).toBe(false);
  });
});
