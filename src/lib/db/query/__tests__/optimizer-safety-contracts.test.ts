import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  callFunction,
  caseWhen,
  coalesce,
  compileD1Query,
  constant,
  count,
  eq,
  filter,
  isNull,
  join,
  jsonScalarArray,
  lowerLogicalPlan,
  neq,
  or,
  param,
  project,
  rowNumber,
  scan,
  schema,
  union,
  window,
} from "@/lib/db";
import { compileD1QueryUnoptimizedForTest } from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import type { Relation } from "@/lib/db/query/plan";
import { analyzeRelationalKeyFacts } from "@/lib/db/query/relational-key-facts";
import type {
  GeneratedSchemaObject,
  SchemaColumnReference,
  SchemaTableReference,
} from "@/lib/db/schema";

type AnyRelation = Relation<object, Readonly<Record<string, AnyExpression>>>;
type Row = Record<string, unknown>;

function anyRelation(
  relation: Relation<object, Readonly<Record<string, AnyExpression>>>,
): AnyRelation {
  return relation;
}

function runAll(
  database: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Row[] {
  return database
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Row[];
}

function rowBag(rows: readonly Row[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function addSite(database: DatabaseSync, siteId: string): number {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  return Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number }
    ).site_pk,
  );
}

function addVisit(
  database: DatabaseSync,
  input: {
    readonly visitId: string;
    readonly siteId: string;
    readonly sitePk: number;
    readonly durationMs?: number | null;
  },
): void {
  database
    .prepare(
      "INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, duration_ms, pathname, hostname) " +
        "VALUES (?, ?, ?, ?, ?, 'complete', 500, 500, ?, ?, 'contract.test')",
    )
    .run(
      input.visitId,
      input.siteId,
      input.sitePk,
      `visitor-${input.siteId}`,
      `session-${input.visitId}`,
      input.durationMs ?? null,
      `/${input.visitId}`,
    );
}

function column(
  table: string,
  name: string,
  affinity: SchemaColumnReference["affinity"],
  options: {
    readonly nullable?: boolean;
    readonly primaryKeyPosition?: number;
  } = {},
): SchemaColumnReference {
  const declaredType =
    affinity === "integer"
      ? "INTEGER"
      : affinity === "numeric"
        ? "NUMERIC"
        : affinity === "real"
          ? "REAL"
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
  readonly defaultCollation: SchemaTableReference["defaultCollation"];
  readonly columns: Readonly<Record<string, SchemaColumnReference>>;
  readonly primaryKey: readonly string[];
  readonly indexes?: SchemaTableReference["indexes"];
}): SchemaTableReference {
  return {
    kind: "table",
    name: input.name,
    defaultCollation: input.defaultCollation,
    columns: input.columns,
    primaryKey: input.primaryKey,
    indexes: input.indexes ?? [],
    foreignKeys: [],
  };
}

function hasKey(source: AnyRelation, fields: readonly number[]): boolean {
  return analyzeRelationalKeyFacts(source).keys.some(
    (key) =>
      key.fields.length === fields.length &&
      key.fields.every((field, index) => field === fields[index]),
  );
}

function withRegisteredTables<T>(
  tables: readonly SchemaTableReference[],
  operation: () => T,
): T {
  const registry = schema as unknown as Record<string, unknown>;
  const previous = new Map(
    tables.map((table) => [
      table.name,
      Object.getOwnPropertyDescriptor(registry, table.name),
    ]),
  );
  try {
    for (const table of tables)
      Object.defineProperty(registry, table.name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: table,
      });
    return operation();
  } finally {
    for (const table of tables) {
      const descriptor = previous.get(table.name);
      if (descriptor) Object.defineProperty(registry, table.name, descriptor);
      else Reflect.deleteProperty(registry, table.name);
    }
  }
}

describe("optimizer safety contracts", () => {
  it.each([
    {
      name: "duplicate and NULL input rows",
      durations: [12, 12, null],
      expected: [
        { kind: "all-rows", value: 3 },
        { kind: "non-NULL-values", value: 2 },
      ],
    },
    {
      name: "empty input",
      durations: [],
      expected: [
        { kind: "all-rows", value: 0 },
        { kind: "non-NULL-values", value: 0 },
      ],
    },
  ] as const)(
    "preserves scalar aggregate results for $name input",
    ({ durations, expected }) => {
      const visits = scan(schema.visits);
      const duration = visits.columns.duration_ms!;
      const common = filter(
        visits,
        or(neq(duration, constant(-1)), isNull(duration)),
      );
      const rowTotals = aggregate(common, {
        groupBy: {},
        aggregates: { rows: count() },
      });
      const nonNullTotals = aggregate(common, {
        groupBy: {},
        aggregates: { rows: count(common.columns.duration_ms!) },
      });
      const allRows = project(rowTotals, {
        kind: constant("all-rows"),
        value: rowTotals.columns.rows,
      });
      const nonNullRows = project(nonNullTotals, {
        kind: constant("non-NULL-values"),
        value: nonNullTotals.columns.rows,
      });
      const output = anyRelation(union(allRows, nonNullRows, true));
      const physical = lowerLogicalPlan(output);

      const database = createMigratedDatabase();
      try {
        const siteId = "optimizer-scalar-contract-site";
        const sitePk = addSite(database, siteId);
        durations.forEach((durationMs, index) =>
          addVisit(database, {
            visitId: `scalar-visit-${index}`,
            siteId,
            sitePk,
            durationMs,
          }),
        );
        const optimized = compileD1Query(physical);
        const unoptimized = compileD1QueryUnoptimizedForTest(output);
        const actual = runAll(database, optimized);
        expect(rowBag(actual)).toEqual(rowBag(runAll(database, unoptimized)));
        expect(rowBag(actual)).toEqual(rowBag(expected));
      } finally {
        database.close();
      }
    },
  );

  it("keeps a BINARY-unique lookup unproven under a NOCASE join comparison", () => {
    const ownerTable = testTable({
      name: "nocase_owner",
      defaultCollation: "unknown",
      columns: {
        id: column("nocase_owner", "id", "integer", {
          primaryKeyPosition: 1,
        }),
        lookup_key: column("nocase_owner", "lookup_key", "text"),
      },
      primaryKey: ["id"],
    });
    const rightTable = testTable({
      name: "binary_lookup",
      defaultCollation: "BINARY",
      columns: {
        id: column("binary_lookup", "id", "integer", {
          primaryKeyPosition: 1,
        }),
        lookup_key: column("binary_lookup", "lookup_key", "text"),
      },
      primaryKey: ["id"],
      indexes: [
        {
          name: "binary_lookup_key_unique",
          unique: true,
          columns: ["lookup_key"],
          collations: ["BINARY"],
          partial: false,
        },
      ],
    });
    withRegisteredTables([ownerTable, rightTable], () => {
      const owner = scan(ownerTable as unknown as GeneratedSchemaObject);
      const lookup = scan(rightTable as unknown as GeneratedSchemaObject);
      const ownerColumns = owner.columns as unknown as Readonly<
        Record<string, AnyExpression>
      >;
      const lookupColumns = lookup.columns as unknown as Readonly<
        Record<string, AnyExpression>
      >;
      const joined = join(
        owner,
        lookup,
        eq(ownerColumns["lookup_key"]!, lookupColumns["lookup_key"]!),
      );
      const joinedColumns = joined.columns as unknown as Readonly<
        Record<string, AnyExpression>
      >;
      const output = project(joined, {
        ownerId: joinedColumns["left_id"]!,
        lookupId: joinedColumns["right_id"]!,
      });

      expect(hasKey(anyRelation(joined), [0])).toBe(false);

      const database = new DatabaseSync(":memory:");
      try {
        database.exec(`
          CREATE TABLE nocase_owner (
            id INTEGER PRIMARY KEY,
            lookup_key TEXT COLLATE NOCASE NOT NULL
          );
          INSERT INTO nocase_owner VALUES (1, 'a');
          CREATE TABLE binary_lookup (
            id INTEGER PRIMARY KEY,
            lookup_key TEXT COLLATE BINARY NOT NULL UNIQUE
          );
          INSERT INTO binary_lookup VALUES (1, 'a'), (2, 'A');
        `);
        const optimized = compileD1Query(lowerLogicalPlan(output));
        const unoptimized = compileD1QueryUnoptimizedForTest(output);
        const actual = runAll(database, optimized);
        expect(rowBag(actual)).toEqual(rowBag(runAll(database, unoptimized)));
        expect(rowBag(actual)).toEqual(
          rowBag([
            { ownerId: 1, lookupId: 1 },
            { ownerId: 1, lookupId: 2 },
          ]),
        );
      } finally {
        database.close();
      }
    });
  });

  it("admits the current materialized reader and rejects a stale physical layout", () => {
    const visits = scan(schema.visits);
    const sharedInput = filter(
      visits,
      neq(visits.columns.site_id!, constant("ignored")),
    );
    const projected = project(sharedInput, {
      visitId: sharedInput.columns.visit_id!,
      sitePk: sharedInput.columns.site_pk!,
    });
    const ascending = window(projected, {
      rank: rowNumber({
        partitionBy: [projected.columns.sitePk!],
        orderBy: [{ expression: projected.columns.visitId!, direction: "ASC" }],
      }),
    });
    const descending = window(projected, {
      rank: rowNumber({
        partitionBy: [projected.columns.sitePk!],
        orderBy: [
          { expression: projected.columns.visitId!, direction: "DESC" },
        ],
      }),
    });
    const output = union(
      project(ascending, {
        visitId: ascending.columns.visitId!,
        rank: ascending.columns.rank!,
      }),
      project(descending, {
        visitId: descending.columns.visitId!,
        rank: descending.columns.rank!,
      }),
      true,
    );
    const physical = lowerLogicalPlan(output);
    const definition = physical.sharedRelations.find(
      ({ node }) => node === projected.node,
    );
    expect(definition?.materialization).toBe("materialized");
    if (!definition) throw new Error("materialized_reader_fixture_missing");

    const database = createMigratedDatabase();
    try {
      const siteA = addSite(database, "site-a");
      const siteB = addSite(database, "site-b");
      const siteC = addSite(database, "site-c");
      addVisit(database, {
        visitId: "visit-1",
        siteId: "site-a",
        sitePk: siteA,
      });
      addVisit(database, {
        visitId: "visit-2",
        siteId: "site-b",
        sitePk: siteB,
      });
      addVisit(database, {
        visitId: "visit-3",
        siteId: "site-b",
        sitePk: siteB,
      });
      addVisit(database, {
        visitId: "visit-4",
        siteId: "site-c",
        sitePk: siteC,
      });
      const optimized = compileD1Query(physical);
      const unoptimized = compileD1QueryUnoptimizedForTest(output);
      const optimizedRows = runAll(database, optimized);
      const unoptimizedRows = runAll(database, unoptimized);
      expect(rowBag(optimizedRows)).toEqual(rowBag(unoptimizedRows));
      expect(rowBag(optimizedRows)).toEqual(
        rowBag([
          { visitId: "visit-1", rank: 1 },
          { visitId: "visit-2", rank: 1 },
          { visitId: "visit-3", rank: 2 },
          { visitId: "visit-4", rank: 1 },
          { visitId: "visit-1", rank: 1 },
          { visitId: "visit-2", rank: 2 },
          { visitId: "visit-3", rank: 1 },
          { visitId: "visit-4", rank: 1 },
        ]),
      );

      const stale = {
        ...physical,
        sharedRelations: physical.sharedRelations.filter(
          ({ node }) => node !== projected.node,
        ),
      };
      expect(() => compileD1Query(stale)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );
    } finally {
      database.close();
    }
  });

  it("validates every nested function, coalesce, and CASE source scope", () => {
    const database = createMigratedDatabase();
    try {
      const local = jsonScalarArray("numeric", [1.4]);
      const foreign = jsonScalarArray("numeric", [9.5]);
      const localValue = local.columns.value;
      const foreignValue = foreign.columns.value;
      const cases: readonly {
        readonly name: string;
        readonly localExpression: AnyExpression;
        readonly foreignExpression: AnyExpression;
        readonly expected: number;
      }[] = [
        {
          name: "function argument",
          localExpression: callFunction("round", localValue),
          foreignExpression: callFunction("round", foreignValue),
          expected: 1,
        },
        {
          name: "coalesce child",
          localExpression: coalesce(localValue, constant(0)),
          foreignExpression: coalesce(localValue, foreignValue),
          expected: 1.4,
        },
        {
          name: "CASE branch",
          localExpression: caseWhen(
            [{ when: eq(localValue, param(1.4)), then: localValue }],
            constant(0),
          ),
          foreignExpression: caseWhen(
            [{ when: eq(localValue, param(1.4)), then: foreignValue }],
            localValue,
          ),
          expected: 1.4,
        },
      ];

      for (const candidate of cases) {
        const validOutput = project(anyRelation(local), {
          value: candidate.localExpression,
        });
        const validPhysical = lowerLogicalPlan(validOutput);
        expect(
          runAll(database, compileD1Query(validPhysical)),
          candidate.name,
        ).toEqual([{ value: candidate.expected }]);

        const invalidOutput = project(anyRelation(local), {
          value: candidate.foreignExpression,
        });
        expect(() => lowerLogicalPlan(invalidOutput), candidate.name).toThrow();
      }
    } finally {
      database.close();
    }
  });
});
