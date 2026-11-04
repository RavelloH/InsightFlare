import type { DatabaseSync } from "node:sqlite";
import { type SQLInputValue } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createDatabaseClient, createDatabaseRuntime } from "@/lib/db";
import {
  add,
  aggregate,
  and,
  antiJoin,
  avg,
  callFunction,
  caseWhen,
  castInteger,
  coalesce,
  compileD1Mutation,
  compileD1Query,
  concatText,
  constant,
  count,
  countDistinct,
  D1StatementBudgetError,
  deleteFrom,
  distinct,
  div,
  eq,
  excluded,
  filter,
  gt,
  inList,
  insert,
  insertFromQuery,
  insertOrIgnore,
  inSubquery,
  isNotNull,
  join,
  limit,
  lowerLogicalPlan,
  max,
  not,
  onConflictDoNothing,
  onConflictDoUpdate,
  or,
  param,
  project,
  rowNumber,
  scalar,
  scan,
  semiJoin,
  sort,
  sum,
  trimCharacters,
  trimSpaces,
  union,
  unixepoch,
  update,
  valuesRelation,
  window,
  windowCountRows,
} from "@/lib/db";
import * as d1Budget from "@/lib/db/d1-budget";
import {
  compileD1Expression,
  compileD1QuerySemiMembershipFallbackForTest,
  compileD1QuerySemiMembershipForceSafeForTest,
  compileD1QueryUnoptimizedForTest,
} from "@/lib/db/query/compiler";
import { validatePhysicalQueryPlan } from "@/lib/db/query/physical-plan";
import type { InsertRow, Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type { SchemaRow } from "@/lib/db/schema/types";
import type { DatabaseRuntime } from "@/lib/db/types";

type NonAliasIntegerPrimaryKeyTable = {
  readonly kind: "table";
  readonly name: "inline_desc_non_alias";
  readonly columns: {
    readonly id: {
      readonly kind: "column";
      readonly table: "inline_desc_non_alias";
      readonly sqlName: "id";
      readonly propertyName: "id";
      readonly declaredType: "INTEGER";
      readonly affinity: "integer";
      readonly nullable: false;
      readonly primaryKeyPosition: 1;
      readonly defaultSql: null;
      readonly hidden: 0;
      readonly generated: false;
    };
    readonly value: {
      readonly kind: "column";
      readonly table: "inline_desc_non_alias";
      readonly sqlName: "value";
      readonly propertyName: "value";
      readonly declaredType: "TEXT";
      readonly affinity: "text";
      readonly nullable: false;
      readonly primaryKeyPosition: 0;
      readonly defaultSql: null;
      readonly hidden: 0;
      readonly generated: false;
    };
  };
  readonly primaryKey: readonly ["id"];
  readonly indexes: readonly [
    {
      readonly name: "sqlite_autoindex_inline_desc_non_alias_1";
      readonly unique: true;
      readonly columns: readonly ["id"];
      readonly partial: false;
    },
  ];
  readonly foreignKeys: readonly [];
};

function assertInsertRowTypes(): void {
  const omittedGeneratedRowid: InsertRow<typeof schema.site_identities> = {
    site_id: "site-a",
  };
  const explicitNullGeneratedRowid: InsertRow<typeof schema.site_identities> = {
    site_id: "site-b",
    site_pk: null,
  };
  const explicitNullExpressionGeneratedRowid: InsertRow<
    typeof schema.site_identities
  > = {
    site_id: "site-expression-null",
    site_pk: param(null),
  };
  const nonNullableReadRow: SchemaRow<typeof schema.site_identities> = {
    site_id: "site-c",
    site_pk: 1,
  };
  const nullableReadRow: SchemaRow<typeof schema.site_identities> = {
    site_id: "site-d",
    // @ts-expect-error Read rows keep actual rowid aliases non-nullable.
    site_pk: null,
  };
  // @ts-expect-error Non-alias INTEGER primary keys remain required.
  const missingNonAliasKey: InsertRow<NonAliasIntegerPrimaryKeyTable> = {
    value: "required",
  };
  void [
    omittedGeneratedRowid,
    explicitNullGeneratedRowid,
    explicitNullExpressionGeneratedRowid,
    nonNullableReadRow,
    nullableReadRow,
    missingNonAliasKey,
  ];
}

void assertInsertRowTypes;

function executeAll(
  db: DatabaseSync,
  query: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[]));
}

function executeRun(
  db: DatabaseSync,
  mutation: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(mutation.sql)
    .run(...((mutation.bindings ?? []) as SQLInputValue[]));
}

describe("typed D1 query compiler", () => {
  it("shortens only generated aliases and preserves user identifiers and row labels", () => {
    const identities = scan(schema.site_identities);
    const selected = filter(
      identities,
      eq(identities.columns.site_id, param("identifier-test")),
    );
    const output = project(selected, {
      "space name": selected.columns.site_id,
      select: selected.columns.site_pk,
    });
    const query = compileD1Query(output);

    expect(query.sql).toContain('FROM "site_identities" AS t0');
    expect(query.sql).toContain('t0."site_id" AS _c1');
    expect(query.sql).toContain('q0."_c1" = ?');
    expect(query.sql).toContain('AS "space name"');
    expect(query.sql).toContain('AS "select"');
    expect(query.bindings).toEqual(["identifier-test"]);

    const userScope = identities.columns.site_id.scope;
    expect(
      compileD1Expression(
        identities.columns.site_id,
        new Map([[userScope, { alias: "q0" }]]),
      ).text,
    ).toBe('"q0"._c1');
  });

  it("does not compact generated aliases after a binding-budget failure", () => {
    const identities = scan(schema.site_identities);
    const query = project(identities, {
      siteId: identities.columns.site_id,
    });
    const budgetError = new D1StatementBudgetError(
      "bindings",
      101,
      100,
      "query.binding-budget-retry",
    );
    const statements: Array<{ readonly sql: string }> = [];
    const budgetSpy = vi
      .spyOn(d1Budget, "assertD1StatementBudget")
      .mockImplementation((statement) => {
        statements.push({ sql: statement.sql });
        throw budgetError;
      });
    try {
      expect(() =>
        compileD1Query(query, { tag: "query.binding-budget-retry" }),
      ).toThrow(budgetError);
      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toContain(" AS _c");
    } finally {
      budgetSpy.mockRestore();
    }
  });

  it("returns the compact SQL-byte budget failure without retrying again", () => {
    const identities = scan(schema.site_identities);
    const query = project(identities, {
      siteId: identities.columns.site_id,
    });
    const budgetError = new D1StatementBudgetError(
      "sql_bytes",
      100_001,
      100_000,
      "query.sql-byte-retry",
    );
    const statements: Array<{ readonly sql: string }> = [];
    const budgetSpy = vi
      .spyOn(d1Budget, "assertD1StatementBudget")
      .mockImplementation((statement) => {
        statements.push({ sql: statement.sql });
        throw budgetError;
      });
    try {
      expect(() =>
        compileD1Query(query, { tag: "query.sql-byte-retry" }),
      ).toThrow(budgetError);
      expect(statements).toHaveLength(2);
      expect(statements[0]?.sql).toContain(" AS _c");
      expect(statements[1]?.sql).not.toMatch(/\bAS _c\d+\b/u);
    } finally {
      budgetSpy.mockRestore();
    }
  });

  it("compacts generated aliases while preserving a representative SQLite query", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, [
            { site_id: "κ? AS one" },
            { site_id: "λ? AS two" },
          ]),
        ),
      );

      const sites = scan(schema.site_identities);
      const selected = filter(
        sites,
        inList(sites.columns.site_id, ["κ? AS one", "λ? AS two"]),
      );
      const sharedOnce = union(selected, selected, true);
      const sharedTwice = union(sharedOnce, sharedOnce, true);
      const ranked = window(sharedTwice, {
        rank: rowNumber({
          orderBy: [
            { expression: sharedTwice.columns.site_id, direction: "ASC" },
          ],
        }),
      });
      const scalarSites = scan(schema.site_identities);
      const scalarSource = filter(
        scalarSites,
        eq(scalarSites.columns.site_id, ranked.columns.site_id),
      );
      const projected = project(ranked, {
        siteId: ranked.columns.site_id,
        formatted: concatText(
          param("κ? AS"),
          ranked.columns.site_id,
          param("κ? AS"),
        ),
        sitePk: castInteger(ranked.columns.site_pk),
        branch: caseWhen(
          [
            {
              when: eq(ranked.columns.site_id, param("κ? AS one")),
              then: param("match 雪? AS"),
            },
          ],
          param("fallback ? AS"),
        ),
        rank: ranked.columns.rank,
        scalarPk: scalar(
          project(scalarSource, { site_pk: scalarSource.columns.site_pk }),
        ),
        nullable: param(null),
      });
      const physical = lowerLogicalPlan(projected);
      expect(physical.sharedRelations.length).toBeGreaterThan(0);

      const normal = compileD1Query(physical, {
        tag: "query.generated-alias-compact-contract",
      });
      const normalBindings = normal.bindings ?? [];
      expect(normal.sql).toContain("WITH _d1_shared_0 AS MATERIALIZED (");
      expect(normal.sql).toContain("CAST(");
      expect(normal.sql).toContain(" AS INTEGER)");
      expect(normal.sql).toContain("ROW_NUMBER() OVER");
      expect(normal.sql).toContain('AS "formatted"');
      expect(
        normalBindings.filter((binding) => binding === "κ? AS"),
      ).toHaveLength(2);

      const budgetError = new D1StatementBudgetError(
        "sql_bytes",
        100_001,
        100_000,
        "query.generated-alias-compact-contract",
      );
      const attempts: Array<{
        readonly sql: string;
        readonly bindings?: readonly unknown[];
      }> = [];
      const originalAssert = d1Budget.assertD1StatementBudget;
      const budgetSpy = vi
        .spyOn(d1Budget, "assertD1StatementBudget")
        .mockImplementation((statement) => {
          attempts.push({ sql: statement.sql, bindings: statement.bindings });
          if (attempts.length === 1) throw budgetError;
          originalAssert(statement);
        });
      let compact: ReturnType<typeof compileD1Query>;
      try {
        compact = compileD1Query(physical, {
          tag: "query.generated-alias-compact-contract",
        });
      } finally {
        budgetSpy.mockRestore();
      }

      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.sql).toBe(normal.sql);
      expect(attempts[0]?.bindings).toEqual(normalBindings);
      expect(attempts[1]?.sql).toBe(compact.sql);
      expect(attempts[1]?.bindings).toEqual(compact.bindings);
      expect(compact.sql).not.toMatch(/\bAS _c\d+\b/u);
      expect(compact.sql).toContain("WITH _d1_shared_0 AS MATERIALIZED (");
      expect(compact.sql).toContain("CAST(");
      expect(compact.sql).toContain(" AS INTEGER)");
      expect(compact.sql).toContain("ROW_NUMBER() OVER");
      expect(compact.sql).toContain('AS "formatted"');
      expect(compact.physicalPlanShape).toEqual(normal.physicalPlanShape);
      expect(compact.bindings).toEqual(normalBindings);

      const sortedRows = (query: ReturnType<typeof compileD1Query>) =>
        (executeAll(db, query) as Record<string, unknown>[]).sort(
          (left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
        );
      const normalRows = sortedRows(normal);
      const compactRows = sortedRows(compact);
      expect(compactRows).toEqual(normalRows);
      expect(normalRows).toHaveLength(8);
      expect(normalRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            siteId: "κ? AS one",
            formatted: "κ? ASκ? AS oneκ? AS",
            sitePk: 1,
            branch: "match 雪? AS",
            scalarPk: 1,
            nullable: null,
          }),
          expect.objectContaining({
            siteId: "λ? AS two",
            formatted: "κ? ASλ? AS twoκ? AS",
            sitePk: 2,
            branch: "fallback ? AS",
            scalarPk: 2,
            nullable: null,
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("compiles only static bounded ROUND precision and matches SQLite values", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "round-test-site",
      );
      const sites = scan(schema.site_identities);
      const rounded = project(sites, {
        roundZero: callFunction("round", param(1.5), constant(0)),
        roundPositive: callFunction("round", param(1.2345), constant(3)),
        roundNegative: callFunction("round", param(-1.2345), constant(3)),
        roundFifteen: callFunction(
          "round",
          param(1.123456789012345),
          constant(15),
        ),
        roundNull: callFunction("round", param(null), constant(3)),
      });
      const query = compileD1Query(rounded);
      expect(query.sql.match(/ROUND\(/gu)).toHaveLength(5);
      expect(query.bindings).toEqual([
        1.5,
        1.2345,
        -1.2345,
        1.123456789012345,
        null,
      ]);
      expect(executeAll(db, query)).toEqual([
        {
          roundZero: 2,
          roundPositive: 1.234,
          roundNegative: -1.234,
          roundFifteen: 1.123456789012345,
          roundNull: null,
        },
      ]);

      const malformed = project(sites, {
        rounded: {
          kind: "function",
          name: "round",
          arguments: [param(1), param(3)],
          resultType: { affinity: "numeric", nullable: false },
        } as never,
      });
      expect(() => compileD1Query(malformed)).toThrowError(
        /ROUND\(\) precision must be a static integer/u,
      );
      for (const precision of [
        sites.columns.site_id,
        constant(null),
        constant("3"),
        {
          kind: "constant",
          value: 3.5,
          resultType: { affinity: "real", nullable: false },
        },
        constant(16),
      ]) {
        const malformedPrecision = project(sites, {
          rounded: {
            kind: "function",
            name: "round",
            arguments: [param(1), precision],
            resultType: { affinity: "numeric", nullable: false },
          } as never,
        });
        expect(() => compileD1Query(malformedPrecision)).toThrow();
      }
      const excessArguments = project(sites, {
        rounded: {
          kind: "function",
          name: "round",
          arguments: [param(1), constant(3), constant(2)],
          resultType: { affinity: "numeric", nullable: false },
        } as never,
      });
      expect(() => compileD1Query(excessArguments)).toThrowError(
        /ROUND\(\) requires one argument and an optional static precision/u,
      );
    } finally {
      db.close();
    }
  });

  it("attaches bounded value-free metadata for the selected final emission", () => {
    const sites = scan(schema.site_identities);
    const native = compileD1Query(
      project(sites, {
        contains: inList(sites.columns.site_id, ["a", "b"]),
      }),
    );
    const jsonValues = (prefix: string) =>
      Array.from({ length: 101 }, (_unused, index) => `${prefix}-${index}`);
    const packedA = compileD1Query(
      project(sites, {
        contains: inList(sites.columns.site_id, jsonValues("private-a")),
      }),
    );
    const packedB = compileD1Query(
      project(sites, {
        contains: inList(sites.columns.site_id, jsonValues("private-b")),
      }),
    );

    expect(native.physicalPlanShape).toMatchObject({
      version: 1,
      nativeMembershipCount: 1,
      jsonMembershipCount: 0,
    });
    expect(packedA.sql).toContain("json_each(?)");
    expect(packedA.bindings).toHaveLength(1);
    expect(packedA.physicalPlanShape).toMatchObject({
      version: 1,
      nativeMembershipCount: 0,
      jsonMembershipCount: 1,
    });
    expect(packedA.physicalPlanShape).toEqual(packedB.physicalPlanShape);
    expect(packedA.sql).toBe(packedB.sql);
    expect(packedA.bindings).not.toEqual(packedB.bindings);
    expect(JSON.stringify(packedA.physicalPlanShape)).not.toContain(
      "private-a",
    );
  });

  it("casts numeric hour expressions with SQLite integer truncation semantics", () => {
    const database = createMigratedDatabase();
    database
      .prepare(
        "INSERT INTO users (id, email, name, username) VALUES ('owner', 'owner@example.test', 'Owner', 'owner')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO teams (id, name, slug, owner_user_id) VALUES ('t', 'T', 't', 'owner')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO sites (id, team_id, name, domain) VALUES ('s', 't', 'S', 's.test')",
      )
      .run();

    try {
      const sites = scan(schema.sites);
      const compiled = compileD1Query(
        project(sites, {
          negativeFraction: castInteger(param(-1.9)),
          positiveFraction: castInteger(param(1.9)),
          negativeHour: castInteger(div(param(-3_600_001), param(3_600_000))),
          zeroDivisor: castInteger(div(param(1), param(0))),
          nullInput: castInteger(param(null)),
        }),
      );
      expect(compiled.sql).toContain("CAST(");
      expect(compiled.sql).toContain(" AS INTEGER)");
      expect(compiled.bindings).toEqual([
        -1.9,
        1.9,
        -3_600_001,
        3_600_000,
        1,
        0,
        null,
      ]);
      expect(executeAll(database, compiled)).toEqual([
        {
          negativeFraction: -1,
          positiveFraction: 1,
          negativeHour: -1,
          zeroDivisor: null,
          nullInput: null,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("returns SQLite storage classes as non-null text for NULL, TEXT, and BLOB", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "storage-class-test",
      );
      const identities = scan(schema.site_identities);
      const query = compileD1Query(
        project(identities, {
          nullType: callFunction("storage-class", param(null)),
          textType: callFunction("storage-class", param("value")),
          blobType: callFunction(
            "storage-class",
            param(new Uint8Array([0x2f, 0x78])),
          ),
        }),
      );

      expect(query.sql.match(/typeof\(/gu)).toHaveLength(3);
      expect(executeAll(db, query)).toEqual([
        { nullType: "null", textType: "text", blobType: "blob" },
      ]);
    } finally {
      db.close();
    }
  });

  it("counts UTF-8 bytes without decoding text", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "byte-length-test",
      );
      const identities = scan(schema.site_identities);
      const query = compileD1Query(
        project(identities, {
          asciiBytes: callFunction("byte-length", param("US")),
          unicodeBytes: callFunction("byte-length", param("é")),
          embeddedNulBytes: callFunction("byte-length", param("a\0b")),
          blobBytes: callFunction(
            "byte-length",
            param(new Uint8Array([0x41, 0x80, 0x00])),
          ),
          nullBytes: callFunction("byte-length", param(null)),
        }),
      );

      expect(query.sql).toContain("LENGTH(CAST(");
      expect(query.sql).toContain(" AS BLOB))");
      expect(executeAll(db, query)).toEqual([
        {
          asciiBytes: 2,
          unicodeBytes: 2,
          embeddedNulBytes: 3,
          blobBytes: 3,
          nullBytes: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("revalidates storage-class scope and wire metadata when compiling a query", () => {
    const identities = scan(schema.site_identities);
    const users = scan(schema.users);
    const externalOperand = project(identities, {
      storageClass: callFunction("storage-class", users.columns.id),
    });
    expect(() => compileD1Query(externalOperand)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );

    const valid = project(identities, {
      storageClass: callFunction("storage-class", param("value")),
    });
    const wireQuery = JSON.parse(JSON.stringify(valid)) as Relation;
    if (wireQuery.node.kind !== "project")
      throw new Error("storage-class-test-project-missing");
    const corrupted = {
      ...wireQuery,
      node: {
        ...wireQuery.node,
        projections: wireQuery.node.projections.map((projection) => ({
          ...projection,
          expression: {
            ...projection.expression,
            resultType: { affinity: "text", nullable: true },
          },
        })),
      },
    } as Relation;
    expect(() => compileD1Query(corrupted)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );

    const invalidOperand = {
      ...wireQuery,
      node: {
        ...wireQuery.node,
        projections: wireQuery.node.projections.map((projection) => ({
          ...projection,
          expression: {
            ...projection.expression,
            arguments: [null],
          },
        })),
      },
    } as unknown as Relation;
    expect(() => compileD1Query(invalidOperand)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });

  it("implements ECMAScript trim semantics for text expressions", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "trim-test",
      );
      const sites = scan(schema.site_identities);
      const whitespace = [
        0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000,
        0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
        0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
      ];

      for (const codePoint of whitespace) {
        const character = String.fromCodePoint(codePoint);
        const query = compileD1Query(
          project(sites, {
            value: callFunction("trim", param(`${character}value${character}`)),
          }),
        );
        expect(query.sql).toContain("char(9, 10, 11, 12, 13, 32, 160");
        expect(executeAll(db, query)).toEqual([{ value: "value" }]);
      }
    } finally {
      db.close();
    }
  });

  it("keeps default SQLite TRIM limited to U+0020 without changing ECMAScript trim", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "trim-spaces-test",
      );
      const sites = scan(schema.site_identities);
      const cases = [
        { input: "  value  ", sqlite: "value", ecma: "value" },
        { input: "\tvalue\t", sqlite: "\tvalue\t", ecma: "value" },
        { input: "\nvalue\n", sqlite: "\nvalue\n", ecma: "value" },
        {
          input: "\u00a0value\u00a0",
          sqlite: "\u00a0value\u00a0",
          ecma: "value",
        },
        { input: "   ", sqlite: "", ecma: "" },
        { input: "", sqlite: "", ecma: "" },
        { input: null, sqlite: null, ecma: null },
      ] as const;

      for (const { input, sqlite, ecma } of cases) {
        const query = compileD1Query(
          project(sites, {
            spaces: trimSpaces(param(input)),
            ecma: callFunction("trim", param(input)),
          }),
        );
        expect(query.sql).toContain("TRIM(");
        if (input !== null)
          expect(query.sql).toContain("char(9, 10, 11, 12, 13, 32, 160");
        expect(executeAll(db, query)).toEqual([{ spaces: sqlite, ecma }]);
      }

      const asciiOnly = compileD1Query(
        project(sites, { spaces: trimSpaces(param("  value  ")) }),
      );
      expect(asciiOnly.sql).toContain("TRIM(?)");
      expect(asciiOnly.bindings).toEqual(["  value  "]);
    } finally {
      db.close();
    }
  });

  it("trims an explicit typed character set with SQLite NULL semantics", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "trim-characters-test",
      );
      const sites = scan(schema.site_identities);
      const ecmaTrimCharacters =
        "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
      const trimCharactersCases = [
        ...Array.from(
          ecmaTrimCharacters,
          (character) => `${character}x${character}`,
        ),
        "\u0085x\u0085",
        "\u180ex\u180e",
        "\u200bx\u200b",
        "😀 \"' \u00a0x\u00a0 \"' 😀",
        "\0 \u00a0x\u00a0 \0",
        " \n  internal\t whitespace \r ",
        "",
        " \u00a0\ufeff\u2028 ",
        "\ud800x\udc00",
      ];

      for (const input of trimCharactersCases) {
        const sqliteInput = db.prepare("SELECT ? AS value").get(input) as {
          readonly value: string;
        };
        const expected = sqliteInput.value.trim();
        const query = compileD1Query(
          project(sites, {
            trimmed: trimCharacters(param(input), constant(ecmaTrimCharacters)),
          }),
        );
        expect(query.sql).toContain("TRIM(");
        expect(query.sql).not.toContain("TRIM(?)");
        expect(query.bindings).toEqual([input]);
        expect(executeAll(db, query)).toEqual([{ trimmed: expected }]);
      }

      const nullInput = compileD1Query(
        project(sites, {
          trimmed: trimCharacters(param(null), constant(" ")),
        }),
      );
      const nullCharacters = compileD1Query(
        project(sites, {
          trimmed: trimCharacters(param("value"), param(null)),
        }),
      );
      expect(executeAll(db, nullInput)).toEqual([{ trimmed: null }]);
      expect(executeAll(db, nullCharacters)).toEqual([{ trimmed: null }]);
    } finally {
      db.close();
    }
  });

  it("concatenates typed text operands with SQLite coercion and NULL semantics", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "concat-text-test",
      );
      const identities = scan(schema.site_identities);
      const compiled = compileD1Query(
        project(identities, {
          numeric: concatText(param("job:'"), param(-3.75), param("雪")),
          nullValue: concatText(param("prefix"), param(null)),
        }),
      );
      expect(compiled.sql).toContain(" || ");
      expect(compiled.sql).not.toContain("CONCAT(");
      expect(compiled.bindings).toEqual(["job:'", -3.75, "雪", "prefix", null]);
      expect(executeAll(db, compiled)).toEqual([
        { numeric: "job:'-3.75雪", nullValue: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("ranks rows with a rank-only window and filters the appended rank afterward", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare(
        `INSERT INTO scheduled_task_runs
          (id, invocation_id, task_key, task_name, trigger_type, status,
           started_at_ms, scope_type, summary_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'system', '{}', 9999999999)`,
      ).run("a-old", "ia", "task-a", "Task A", "manual", "success", 10);
      db.prepare(
        `INSERT INTO scheduled_task_runs
          (id, invocation_id, task_key, task_name, trigger_type, status,
           started_at_ms, scope_type, summary_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'system', '{}', 9999999999)`,
      ).run("a-new", "ib", "task-a", "Task A", "manual", "success", 20);
      db.prepare(
        `INSERT INTO scheduled_task_runs
          (id, invocation_id, task_key, task_name, trigger_type, status,
           started_at_ms, scope_type, summary_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'system', '{}', 9999999999)`,
      ).run("b-only", "ic", "task-b", "Task B", "manual", "running", 5);
      db.prepare(
        `INSERT INTO scheduled_task_runs
          (id, invocation_id, task_key, task_name, trigger_type, status,
           started_at_ms, finished_at_ms, scope_type, summary_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', '{}', 9999999999)`,
      ).run("b-finished", "id", "task-b", "Task B", "manual", "success", 6, 7);

      const runs = scan(schema.scheduled_task_runs);
      const base = project(runs, {
        id: runs.columns.id,
        taskKey: runs.columns.task_key,
        startedAt: runs.columns.started_at_ms,
        finishedAt: runs.columns.finished_at_ms,
      });
      const repeatedRows = union(base, base, true);
      const ranked = window(repeatedRows, {
        row: rowNumber({
          partitionBy: [repeatedRows.columns.taskKey],
          orderBy: [
            { expression: repeatedRows.columns.startedAt, direction: "DESC" },
          ],
        }),
      });
      const all = compileD1Query(ranked);
      expect(all.sql).toContain("ROW_NUMBER() OVER (PARTITION BY");
      expect(all.sql).toContain("ORDER BY q");
      expect(all.sql).not.toMatch(/OVER \([^)]*id.*(?:ASC|DESC)/iu);
      expect(executeAll(db, all)).toHaveLength(8);

      const latest = filter(ranked, eq(ranked.columns.row, param(1)));
      const latestRows = executeAll(db, compileD1Query(latest));
      expect(latestRows).toHaveLength(2);
      expect(latestRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "a-new", taskKey: "task-a", row: 1 }),
          expect.objectContaining({
            id: "b-finished",
            taskKey: "task-b",
            row: 1,
          }),
        ]),
      );
      expect(lowerLogicalPlan(ranked).sharedRelations).toEqual([]);

      const nullOrdered = window(base, {
        finishRank: rowNumber({
          partitionBy: [base.columns.taskKey],
          orderBy: [{ expression: base.columns.finishedAt, direction: "ASC" }],
        }),
      });
      const nullFirst = filter(
        nullOrdered,
        and(
          eq(nullOrdered.columns.taskKey, param("task-b")),
          eq(nullOrdered.columns.finishRank, param(1)),
        ),
      );
      expect(executeAll(db, compileD1Query(nullFirst))).toEqual([
        expect.objectContaining({ id: "b-only", finishRank: 1 }),
      ]);

      const narrow = project(runs, {
        id: runs.columns.id,
        taskKey: runs.columns.task_key,
        startedAt: runs.columns.started_at_ms,
      });
      const selected = filter(
        narrow,
        inList(narrow.columns.taskKey, ["task-a", "task-b"]),
      );
      const selectedRanked = window(selected, {
        row: rowNumber({
          partitionBy: [selected.columns.taskKey],
          orderBy: [
            { expression: selected.columns.startedAt, direction: "DESC" },
          ],
        }),
      });
      const scalarSource = project(selected, { id: selected.columns.id });
      const rankAndSharedInput = project(selectedRanked, {
        id: selectedRanked.columns.id,
        selectedId: scalar(scalarSource),
      });
      expect(lowerLogicalPlan(rankAndSharedInput).sharedRelations).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("counts every row in independent whole and partition windows", () => {
    const db = createMigratedDatabase();
    try {
      const insert = db.prepare(
        `INSERT INTO scheduled_task_runs
          (id, invocation_id, task_key, task_name, trigger_type, status,
           started_at_ms, finished_at_ms, scope_type, summary_json, expires_at)
         VALUES (?, ?, ?, ?, 'manual', 'success', ?, ?, 'system', '{}', 9999999999)`,
      );
      insert.run("null-a", "group-null", "task-a", "Task A", 10, null);
      insert.run("null-b", "group-null", "task-b", "Task B", 20, null);
      insert.run("seven-a", "group-seven", "task-c", "Task C", 30, 7);
      insert.run("seven-b", "group-seven", "task-d", "Task D", 30, 7);
      insert.run("eight-a", "group-eight", "task-e", "Task E", 40, 8);

      const runs = scan(schema.scheduled_task_runs);
      const base = project(runs, {
        id: runs.columns.id,
        finishedAt: runs.columns.finished_at_ms,
        startedAt: runs.columns.started_at_ms,
      });
      const counted = window(base, {
        rank: rowNumber({
          partitionBy: [base.columns.finishedAt],
          orderBy: [{ expression: base.columns.startedAt, direction: "ASC" }],
        }),
        partitionCount: windowCountRows({
          partitionBy: [base.columns.finishedAt],
        }),
        totalCount: windowCountRows(),
      });
      const compiled = compileD1Query(counted);
      expect(compiled.sql).toContain("ROW_NUMBER() OVER (");
      expect(compiled.sql).toContain("COUNT(*) OVER (");
      expect(compiled.sql).toContain("COUNT(*) OVER ()");
      expect(compiled.sql).not.toMatch(/COUNT\(\*\) OVER \([^)]*ORDER BY/u);

      const rows = executeAll(db, compiled);
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.totalCount === 5)).toBe(true);
      expect(
        rows.filter((row) => row.finishedAt === null).map((row) => row.rank),
      ).toEqual([1, 2]);
      expect(
        rows
          .filter((row) => row.finishedAt === null)
          .map((row) => row.partitionCount),
      ).toEqual([2, 2]);
      expect(
        rows
          .filter((row) => row.finishedAt === 7)
          .map((row) => row.partitionCount),
      ).toEqual([2, 2]);
      expect(
        rows
          .filter((row) => row.finishedAt === 8)
          .map((row) => row.partitionCount),
      ).toEqual([1]);
      expect(
        rows
          .filter((row) => row.finishedAt === 7)
          .map((row) => row.rank)
          .sort(),
      ).toEqual([1, 2]);

      const empty = filter(base, eq(base.columns.id, param("missing")));
      expect(
        executeAll(
          db,
          compileD1Query(window(empty, { totalCount: windowCountRows() })),
        ),
      ).toEqual([]);
      const single = filter(base, eq(base.columns.id, param("seven-a")));
      expect(
        executeAll(
          db,
          compileD1Query(window(single, { totalCount: windowCountRows() })),
        ),
      ).toMatchObject([{ totalCount: 1 }]);
    } finally {
      db.close();
    }
  });

  it("rejects malformed rank descriptors, output collisions, and out-of-scope keys", () => {
    const runs = scan(schema.scheduled_task_runs);
    const otherRuns = scan(schema.scheduled_task_runs);
    const base = project(runs, {
      id: runs.columns.id,
      taskKey: runs.columns.task_key,
      startedAt: runs.columns.started_at_ms,
    });
    const valid = rowNumber({
      orderBy: [{ expression: base.columns.startedAt, direction: "DESC" }],
    });
    expect(() => window(base, { id: valid } as never)).toThrow(
      /Duplicate output field/u,
    );
    expect(() =>
      compileD1Query(
        window(base, {
          invalidScope: rowNumber({
            partitionBy: [otherRuns.columns.task_key],
            orderBy: [
              { expression: base.columns.startedAt, direction: "DESC" },
            ],
          }),
        }),
      ),
    ).toThrow(/outside the visible relation scope/u);

    const forged = window(base, { rank: valid });
    const forgedNode = forged.node as unknown as {
      readonly windows: {
        readonly specification: { readonly orderBy: readonly unknown[] };
      }[];
    };
    const forgedSpecification = forgedNode.windows[0]!
      .specification as unknown as { orderBy: readonly unknown[] };
    forgedSpecification.orderBy = [];
    expect(() => compileD1Query(forged)).toThrow(
      /row-number requires at least one ordering key/u,
    );

    const countWindow = window(base, { count: windowCountRows() });
    const countNode = countWindow.node as unknown as {
      readonly windows: {
        readonly specification: Record<string, unknown>;
      }[];
    };
    Object.assign(countNode.windows[0]!.specification, { orderBy: [] });
    expect(() => compileD1Query(countWindow)).toThrow(
      /count-rows specification contains unsupported options/u,
    );

    const unknownWindow = window(base, { count: windowCountRows() });
    const unknownNode = unknownWindow.node as unknown as {
      readonly windows: {
        readonly specification: { kind: string };
      }[];
    };
    unknownNode.windows[0]!.specification.kind = "count-rows-frame";
    expect(() => compileD1Query(unknownWindow)).toThrow(
      /unsupported specification/u,
    );

    expect(() =>
      compileD1Query(
        window(base, {
          invalidCountScope: windowCountRows({
            partitionBy: [otherRuns.columns.task_key],
          }),
        }),
      ),
    ).toThrow(/outside the visible relation scope/u);
    expect(() => windowCountRows({ orderBy: [] } as never)).toThrow(
      /only supports partitionBy/u,
    );
  });

  it("compiles excluded values and rejects columns without a SQL scope", () => {
    expect(
      compileD1Expression(
        excluded(schema.site_identities.columns.site_id),
        new Map(),
      ).text,
    ).toBe('"excluded"."site_id"');

    const relation = scan(schema.site_identities);
    expect(() =>
      compileD1Expression(relation.columns.site_id, new Map()),
    ).toThrowError(/No SQL scope is available/);
  });

  it("compiles representative query IR nodes with stable SQL and bindings", () => {
    const users = scan(schema.users);
    const lookup = limit(filter(users, eq(users.columns.id, param("u-1"))), 1);
    const query = compileD1Query(lookup, { tag: "users.lookup" });
    expect(query.sql).toContain('FROM "users"');
    expect(query.sql).toContain("WHERE (q0._c0 = ?)");
    expect(query.bindings).toEqual(["u-1", 1]);
    expect(query.tag).toBe("users.lookup");
    expect(compileD1Query(lookup)).toEqual(compileD1Query(lookup));
    expect(compileD1Query(lowerLogicalPlan(lookup)).sql).toBe(query.sql);

    const visits = scan(schema.visits);
    const range = filter(
      visits,
      and(
        eq(visits.columns.site_pk, param(7)),
        gt(visits.columns.started_at, param(100)),
      ),
    );
    const rangeQuery = compileD1Query(range);
    expect(rangeQuery.sql).toContain('"site_pk"');
    expect(rangeQuery.bindings).toEqual([7, 100]);

    const totals = aggregate(visits, {
      groupBy: { country: visits.columns.country },
      aggregates: {
        visitors: countDistinct(visits.columns.visitor_id),
        averageDuration: avg(visits.columns.duration_ms),
        latestVisit: max(visits.columns.started_at),
      },
    });
    const aggregateQuery = compileD1Query(totals);
    expect(aggregateQuery.sql).toContain("COUNT(DISTINCT");
    expect(aggregateQuery.sql).toContain("GROUP BY");

    const events = scan(schema.custom_events);
    const names = scan(schema.custom_event_names);
    const joined = join(
      events,
      names,
      eq(events.columns.event_name_id, names.columns.id),
    );
    expect(compileD1Query(joined).sql).toContain("INNER JOIN");
    const positiveMembership = compileD1Query(
      semiJoin(
        events,
        names,
        eq(events.columns.event_name_id, names.columns.id),
      ),
    );
    expect(positiveMembership.sql).toContain("EXISTS");
    expect(positiveMembership.physicalPlanShape?.version).not.toBe(10);
    expect(
      compileD1Query(
        antiJoin(
          events,
          names,
          eq(events.columns.event_name_id, names.columns.id),
        ),
      ).sql,
    ).toContain("NOT EXISTS");

    const pages = project(visits, {
      item_id: visits.columns.visit_id,
      occurred_at: visits.columns.started_at,
    });
    const activity = project(events, {
      item_id: events.columns.event_id,
      occurred_at: events.columns.occurred_at,
    });
    expect(compileD1Query(union(pages, activity, true)).sql).toContain(
      "UNION ALL",
    );
    expect(compileD1Query(distinct(pages)).sql).toContain("SELECT DISTINCT");
    expect(
      compileD1Query(
        sort(pages, [
          { expression: pages.columns.occurred_at, direction: "DESC" },
        ]),
      ).sql,
    ).toContain("ORDER BY");

    const numeric = project(visits, {
      next_time: add(visits.columns.started_at, param(1)),
    });
    expect(compileD1Query(numeric).bindings).toEqual([1]);
  });

  it("shares only repeated closed filtered relations and preserves row semantics", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, [
            { site_id: "site-a" },
            { site_id: "site-b" },
          ]),
        ),
      );

      const sites = scan(schema.site_identities);
      const selected = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const repeatedUnion = union(selected, selected, true);
      const physical = lowerLogicalPlan(repeatedUnion);
      expect(physical.sharedRelations).toHaveLength(1);
      expect(physical.sharedRelations[0]?.dependencies).toEqual([]);

      const query = compileD1Query(repeatedUnion);
      expect(query.sql).toContain("WITH _d1_shared_0 AS (");
      expect(query.bindings).toEqual(["site-a"]);
      expect(compileD1Query(physical)).toEqual(query);
      expect(executeAll(db, query)).toEqual([
        { site_pk: 1, site_id: "site-a" },
        { site_pk: 1, site_id: "site-a" },
      ]);
      const unoptimized = compileD1QueryUnoptimizedForTest(repeatedUnion);
      expect(unoptimized.sql).not.toContain("WITH ");
      expect(unoptimized.bindings).toEqual(["site-a", "site-a"]);
      expect(executeAll(db, unoptimized)).toEqual(executeAll(db, query));

      const forged = { ...physical, sharedRelations: [] };
      expect(() => compileD1Query(forged)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );

      const separateLeft = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const separateRight = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const equivalentButDistinct = compileD1Query(
        union(separateLeft, separateRight, true),
      );
      expect(equivalentButDistinct.sql).not.toContain("WITH ");
      expect(equivalentButDistinct.bindings).toEqual(["site-a", "site-a"]);

      const siteA = filter(sites, eq(sites.columns.site_id, param("site-a")));
      const siteB = filter(sites, eq(sites.columns.site_id, param("site-b")));
      const separateParameters = compileD1Query(union(siteA, siteB, true));
      expect(separateParameters.sql).not.toContain("WITH ");
      expect(separateParameters.bindings).toEqual(["site-a", "site-b"]);
      expect(executeAll(db, separateParameters)).toEqual([
        { site_pk: 1, site_id: "site-a" },
        { site_pk: 2, site_id: "site-b" },
      ]);

      expect(compileD1Query(union(sites, sites, true)).sql).not.toContain(
        "WITH ",
      );
      const renamedFullScan = project(sites, {
        renamed_site_id: sites.columns.site_id,
      });
      expect(
        compileD1Query(union(renamedFullScan, renamedFullScan, true)).sql,
      ).not.toContain("WITH ");

      const correlatedRows = scan(schema.site_identities);
      const correlatedMatch = filter(
        correlatedRows,
        eq(correlatedRows.columns.site_id, sites.columns.site_id),
      );
      const correlatedTwice = compileD1Query(
        project(sites, {
          site_id: sites.columns.site_id,
          first_match: scalar(
            project(correlatedMatch, {
              site_pk: correlatedMatch.columns.site_pk,
            }),
          ),
          second_match: scalar(
            project(correlatedMatch, {
              site_pk: correlatedMatch.columns.site_pk,
            }),
          ),
        }),
      );
      expect(correlatedTwice.sql).not.toContain("WITH ");
      expect(executeAll(db, correlatedTwice)).toEqual([
        { site_id: "site-a", first_match: 1, second_match: 1 },
        { site_id: "site-b", first_match: 2, second_match: 2 },
      ]);

      const inner = filter(sites, eq(sites.columns.site_id, param("site-a")));
      const sharedDependency = union(inner, inner, true);
      const nestedShares = union(sharedDependency, sharedDependency, true);
      const nestedPhysical = lowerLogicalPlan(nestedShares);
      expect(
        nestedPhysical.sharedRelations.map(({ name, dependencies }) => ({
          name,
          dependencies,
        })),
      ).toEqual([
        { name: "_d1_shared_0", dependencies: [] },
        { name: "_d1_shared_1", dependencies: ["_d1_shared_0"] },
      ]);
      const nestedQuery = compileD1Query(nestedShares);
      expect(nestedQuery.bindings).toEqual(["site-a"]);
      expect(executeAll(db, nestedQuery)).toHaveLength(4);

      const selectedWithNull = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const nullProjection = project(selectedWithNull, { value: param(null) });
      const repeatedNulls = compileD1Query(
        union(nullProjection, nullProjection, true),
      );
      expect(repeatedNulls.sql).toContain("WITH ");
      expect(executeAll(db, repeatedNulls)).toEqual([
        { value: null },
        { value: null },
      ]);

      const selectedForMembership = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const matching = semiJoin(
        sites,
        selectedForMembership,
        eq(sites.columns.site_pk, selectedForMembership.columns.site_pk),
      );
      const unmatched = antiJoin(
        sites,
        selectedForMembership,
        eq(sites.columns.site_pk, selectedForMembership.columns.site_pk),
      );
      const matchingCount = aggregate(matching, {
        groupBy: {},
        aggregates: { rows: count() },
      });
      const unmatchedCount = aggregate(unmatched, {
        groupBy: {},
        aggregates: { rows: count() },
      });
      const membershipCounts = join(
        matchingCount,
        unmatchedCount,
        eq(param(1), param(1)),
      );
      const membershipQuery = compileD1Query(membershipCounts);
      expect(membershipQuery.sql).toContain("_d1_shared_0");
      expect(membershipQuery.bindings).toEqual(["site-a", 1, 1]);
      expect(executeAll(db, membershipQuery)).toEqual([
        { left_rows: 1, right_rows: 1 },
      ]);

      const missing = filter(
        sites,
        eq(sites.columns.site_id, param("missing")),
      );
      const emptyCount = aggregate(missing, {
        groupBy: {},
        aggregates: { rows: count() },
      });
      const repeatedEmptyCount = join(
        emptyCount,
        emptyCount,
        eq(param(1), param(1)),
      );
      const repeatedEmptyPhysical = lowerLogicalPlan(repeatedEmptyCount);
      expect(
        repeatedEmptyPhysical.sharedRelations.some(
          ({ node }) => node === emptyCount.node,
        ),
      ).toBe(false);
      const repeatedEmptyQuery = compileD1Query(repeatedEmptyPhysical);
      expect(executeAll(db, repeatedEmptyQuery)).toEqual([
        { left_rows: 0, right_rows: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("preserves bags through Generic semi and anti joins with filtered composite membership", () => {
    const db = createMigratedDatabase();
    try {
      const left = valuesRelation(
        {
          marker: { affinity: "text", nullable: false },
          key_a: { affinity: "text", nullable: true },
          key_b: { affinity: "text", nullable: true },
          region: { affinity: "text", nullable: false },
        },
        [
          { marker: "match-1", key_a: "site-a", key_b: "x", region: "west" },
          { marker: "match-2", key_a: "site-a", key_b: "x", region: "west" },
          {
            marker: "residual-miss",
            key_a: "site-a",
            key_b: "x",
            region: "east",
          },
          { marker: "null-first-key", key_a: null, key_b: "x", region: "west" },
          {
            marker: "null-second-key",
            key_a: "site-b",
            key_b: null,
            region: "west",
          },
          {
            marker: "right-filtered",
            key_a: "site-z",
            key_b: "x",
            region: "west",
          },
          { marker: "unmatched", key_a: "missing", key_b: "x", region: "west" },
        ],
      );
      const right = valuesRelation(
        {
          key_a: { affinity: "text", nullable: true },
          key_b: { affinity: "text", nullable: true },
          region: { affinity: "text", nullable: false },
          accepted: { affinity: "text", nullable: false },
        },
        [
          { key_a: "site-a", key_b: "x", region: "west", accepted: "yes" },
          { key_a: "site-a", key_b: "x", region: "west", accepted: "yes" },
          { key_a: "site-a", key_b: "x", region: "west", accepted: "no" },
          { key_a: null, key_b: "x", region: "west", accepted: "yes" },
          { key_a: "site-b", key_b: null, region: "west", accepted: "yes" },
          { key_a: "site-z", key_b: "x", region: "west", accepted: "no" },
        ],
      );
      const filteredRight = filter(
        right,
        eq(right.columns.accepted, param("yes")),
      );
      const condition = and(
        eq(left.columns.key_a, filteredRight.columns.key_a),
        eq(left.columns.key_b, filteredRight.columns.key_b),
        eq(left.columns.region, filteredRight.columns.region),
      );
      const included = semiJoin(left, filteredRight, condition);
      const excluded = antiJoin(left, filteredRight, condition);
      const includedDefaultQuery = compileD1Query(included);
      const includedQuery =
        compileD1QuerySemiMembershipForceSafeForTest(included);
      const includedFallbackQuery =
        compileD1QuerySemiMembershipFallbackForTest(included);
      const excludedQuery = compileD1Query(excluded);
      expect(includedDefaultQuery.sql).toContain("EXISTS");
      expect(includedDefaultQuery.sql).not.toContain(" IN (SELECT ");
      expect(includedQuery.sql).toContain(" IN (SELECT ");
      expect(includedQuery.sql).not.toContain("EXISTS");
      expect(includedFallbackQuery.sql).toContain("EXISTS");
      expect(includedQuery.physicalPlanShape?.version).toBe(10);
      expect(includedFallbackQuery.physicalPlanShape?.version).not.toBe(10);
      expect(excludedQuery.sql).toContain("NOT EXISTS");
      expect(includedQuery.sql).not.toContain("DISTINCT");
      expect(excludedQuery.sql).not.toContain("DISTINCT");

      const markers = (query: ReturnType<typeof compileD1Query>) =>
        executeAll(db, query)
          .map((row) => String(row.marker))
          .sort();
      expect(markers(includedQuery)).toEqual(["match-1", "match-2"]);
      expect(markers(includedFallbackQuery)).toEqual(markers(includedQuery));
      expect(markers(excludedQuery)).toEqual([
        "null-first-key",
        "null-second-key",
        "residual-miss",
        "right-filtered",
        "unmatched",
      ]);

      const scalarLeft = valuesRelation(
        {
          marker: { affinity: "text", nullable: false },
          key: { affinity: "text", nullable: true },
        },
        [
          { marker: "scalar-first", key: "same" },
          { marker: "scalar-second", key: "same" },
          { marker: "scalar-null", key: null },
          { marker: "scalar-miss", key: "other" },
        ],
      );
      const scalarRight = valuesRelation(
        { key: { affinity: "text", nullable: true } },
        [{ key: "same" }, { key: "same" }, { key: null }],
      );
      const scalarSemi = semiJoin(
        scalarLeft,
        scalarRight,
        eq(scalarLeft.columns.key, scalarRight.columns.key),
      );
      const scalarDefaultQuery = compileD1Query(scalarSemi);
      const scalarQuery =
        compileD1QuerySemiMembershipForceSafeForTest(scalarSemi);
      const scalarFallbackQuery =
        compileD1QuerySemiMembershipFallbackForTest(scalarSemi);
      expect(scalarDefaultQuery.sql).toContain("EXISTS");
      expect(scalarDefaultQuery.sql).not.toContain(" IN (SELECT ");
      expect(scalarQuery.sql).toContain(" IN (SELECT ");
      expect(scalarQuery.physicalPlanShape?.version).toBe(10);
      expect(
        executeAll(db, scalarQuery)
          .map((row) => row.marker)
          .sort(),
      ).toEqual(["scalar-first", "scalar-second"]);
      expect(executeAll(db, scalarFallbackQuery)).toEqual(
        executeAll(db, scalarQuery),
      );
    } finally {
      db.close();
    }
  });

  it("vetoes non-total and non-conjunctive SemiJoin membership and rejects forged choices", () => {
    const sites = scan(schema.site_identities);
    const transformedRight = project(sites, {
      site_pk: callFunction("abs", sites.columns.site_pk),
    });
    const nonTotal = semiJoin(
      sites,
      transformedRight,
      eq(sites.columns.site_pk, transformedRight.columns.site_pk),
    );
    const nonTotalPhysical = lowerLogicalPlan(nonTotal);
    expect(nonTotalPhysical.semiMembershipChoices).toEqual([]);
    expect(compileD1Query(nonTotal).sql).toContain("EXISTS");

    const right = scan(schema.site_identities);
    const extraPredicate = semiJoin(
      sites,
      right,
      and(
        eq(sites.columns.site_pk, right.columns.site_pk),
        eq(param(1), param(1)),
      ),
    );
    expect(lowerLogicalPlan(extraPredicate).semiMembershipChoices).toEqual([]);
    expect(compileD1Query(extraPredicate).sql).toContain("EXISTS");

    const disjunction = semiJoin(
      sites,
      right,
      or(
        eq(sites.columns.site_pk, right.columns.site_pk),
        eq(sites.columns.site_id, right.columns.site_id),
      ),
    );
    expect(lowerLogicalPlan(disjunction).semiMembershipChoices).toEqual([]);
    expect(compileD1Query(disjunction).sql).toContain("EXISTS");

    const eligible = semiJoin(
      sites,
      right,
      eq(sites.columns.site_pk, right.columns.site_pk),
    );
    const physical = lowerLogicalPlan(eligible);
    expect(physical.semiMembershipChoices).toHaveLength(1);
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
    const choice = physical.semiMembershipChoices[0]!;
    expect(() =>
      validatePhysicalQueryPlan({
        ...physical,
        semiMembershipChoices: [
          { ...choice, leftKeyIndexes: [choice.leftKeyIndexes[0]! + 1] },
        ],
      }),
    ).toThrow(/semi membership choices/u);
    const sparse = new Array(1);
    expect(() =>
      validatePhysicalQueryPlan({
        ...physical,
        semiMembershipChoices: sparse,
      }),
    ).toThrow(/semi membership choices/u);
    expect(() => validatePhysicalQueryPlan(physical)).not.toThrow();
  });

  it("keeps SemiJoin as EXISTS when a key collation is unknown", () => {
    const table = schema.site_identities;
    const originalCollation = table.defaultCollation;
    Object.assign(table, { defaultCollation: "unknown" });
    try {
      const left = scan(table);
      const right = scan(table);
      const relation = semiJoin(
        left,
        right,
        eq(left.columns.site_id, right.columns.site_id),
      );

      expect(lowerLogicalPlan(relation).semiMembershipChoices).toEqual([]);
      expect(compileD1Query(relation).sql).toContain("EXISTS");
    } finally {
      Object.assign(table, { defaultCollation: originalCollation });
    }
  });

  it("keeps ordinary INTEGER storage outside the exact membership domain", () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec(`
        INSERT INTO site_identities (site_pk, site_id) VALUES
          (-9223372036854775808, 'int64-min'),
          (-9223372036854774784, 'int64-neighbor'),
          (42, 'ordinary-integer')
      `);
      db.exec(`
        INSERT INTO custom_event_json_values (
          event_pk, node_id, site_id, event_name_id, path_id, occurred_at,
          value_type, number_value, site_pk
        ) VALUES
          (-9223372036854775808, 1, 'int64-min', 1, 1, 0, 'number',
            -9223372036854775808.0, -9223372036854775808.0),
          (-9223372036854774784, 1, 'int64-neighbor', 1, 1, 0, 'number',
            -9223372036854774784.0, -9223372036854774784.0),
          (42, 1, 'ordinary-integer', 1, 1, 0, 'number', 42, 42),
          (43, 1, 'ordinary-real', 1, 1, 0, 'number', 42.5, 42.5)
      `);
      expect(
        db
          .prepare(
            "SELECT typeof(site_pk) AS integerType FROM site_identities WHERE site_id = 'int64-min'",
          )
          .get(),
      ).toEqual({ integerType: "integer" });
      const storedTypesStatement = db.prepare(
        "SELECT event_pk, typeof(site_pk) AS sitePkType FROM custom_event_json_values ORDER BY event_pk",
      );
      storedTypesStatement.setReadBigInts(true);
      const storedTypes = storedTypesStatement.all();
      expect(storedTypes.map(({ sitePkType }) => sitePkType)).toEqual([
        "real",
        "integer",
        "integer",
        "real",
      ]);

      const sites = scan(schema.site_identities);
      const values = scan(schema.custom_event_json_values);
      const integerMinimum = semiJoin(
        sites,
        values,
        eq(sites.columns.site_pk, values.columns.site_pk),
      );
      const textToInteger = semiJoin(
        sites,
        values,
        // This intentionally bypasses the expression helper's static check
        // so the runtime validator's incompatible-affinity refusal is tested.
        eq(sites.columns.site_id, values.columns.site_pk as never),
      );
      const candidate = compileD1Query(integerMinimum);
      const baseline =
        compileD1QuerySemiMembershipFallbackForTest(integerMinimum);
      const executeIntegerRows = (query: ReturnType<typeof compileD1Query>) => {
        const statement = db.prepare(query.sql);
        statement.setReadBigInts(true);
        return statement.all(...((query.bindings ?? []) as SQLInputValue[]));
      };
      expect(candidate.sql).toContain("EXISTS");
      expect(candidate.physicalPlanShape?.version).not.toBe(10);
      expect(executeIntegerRows(candidate)).toEqual(
        executeIntegerRows(baseline),
      );
      expect(
        executeIntegerRows(candidate)
          .map(({ site_id }) => site_id)
          .sort(),
      ).toEqual(["int64-min", "int64-neighbor", "ordinary-integer"]);

      const reverse = semiJoin(
        values,
        sites,
        eq(values.columns.site_pk, sites.columns.site_pk),
      );
      const reverseCandidate = compileD1Query(reverse);
      const reverseBaseline =
        compileD1QuerySemiMembershipFallbackForTest(reverse);
      expect(reverseCandidate.sql).toContain("EXISTS");
      expect(executeIntegerRows(reverseCandidate)).toEqual(
        executeIntegerRows(reverseBaseline),
      );
      expect(
        executeIntegerRows(reverseCandidate).map(({ event_pk }) => event_pk),
      ).toEqual([-9_223_372_036_854_774_784n, 42n]);

      const tuple = semiJoin(
        sites,
        values,
        and(
          eq(sites.columns.site_pk, values.columns.site_pk),
          eq(sites.columns.site_pk, values.columns.event_pk),
        ),
      );
      const tupleCandidate = compileD1Query(tuple);
      const tupleBaseline = compileD1QuerySemiMembershipFallbackForTest(tuple);
      expect(tupleCandidate.sql).toContain("EXISTS");
      expect(executeIntegerRows(tupleCandidate)).toEqual(
        executeIntegerRows(tupleBaseline),
      );
      expect(
        executeIntegerRows(tupleCandidate)
          .map(({ site_id }) => site_id)
          .sort(),
      ).toEqual(["int64-min", "int64-neighbor", "ordinary-integer"]);

      expect(() => compileD1Query(textToInteger)).toThrow(
        /incompatible SQL affinities/u,
      );
      const integerToReal = semiJoin(
        sites,
        values,
        eq(sites.columns.site_pk, values.columns.number_value),
      );
      expect(lowerLogicalPlan(integerToReal).semiMembershipChoices).toEqual([]);
      const realCandidate = compileD1Query(integerToReal);
      const realBaseline =
        compileD1QuerySemiMembershipFallbackForTest(integerToReal);
      expect(realCandidate.sql).toContain("EXISTS");
      expect(realCandidate.physicalPlanShape?.version).not.toBe(10);
      expect(executeIntegerRows(realCandidate)).toEqual(
        executeIntegerRows(realBaseline),
      );
    } finally {
      db.close();
    }
  });

  it("optimizes proven rowid domains and rejects an inline DESC primary key", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "rowid-a",
      );
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "rowid-b",
      );
      const duplicateSites = valuesRelation(
        { siteId: { affinity: "text", nullable: false } },
        [{ siteId: "rowid-a" }, { siteId: "rowid-a" }, { siteId: "rowid-b" }],
      );
      const siteRows = scan(schema.site_identities);
      const duplicatedLeft = join(
        duplicateSites,
        siteRows,
        eq(duplicateSites.columns.siteId, siteRows.columns.site_id),
      );
      const rightSiteRows = scan(schema.site_identities);
      const selectedRight = filter(
        rightSiteRows,
        eq(rightSiteRows.columns.site_id, param("rowid-a")),
      );
      const valid = semiJoin(
        duplicatedLeft,
        selectedRight,
        eq(duplicatedLeft.columns.right_site_pk, selectedRight.columns.site_pk),
      );
      const validDefault = compileD1Query(valid);
      const validCandidate =
        compileD1QuerySemiMembershipForceSafeForTest(valid);
      const validBaseline = compileD1QuerySemiMembershipFallbackForTest(valid);
      expect(validDefault.sql).toContain("EXISTS");
      expect(validDefault.sql).not.toContain(" IN (SELECT ");
      expect(validCandidate.sql).toContain(" IN (SELECT ");
      expect(validCandidate.physicalPlanShape?.version).toBe(10);
      expect(executeAll(db, validCandidate)).toEqual(
        executeAll(db, validBaseline),
      );
      expect(executeAll(db, validCandidate)).toHaveLength(2);

      const descTable = {
        kind: "table",
        name: "inline_desc_non_alias",
        defaultCollation: "BINARY",
        columns: {
          id: {
            kind: "column",
            table: "inline_desc_non_alias",
            sqlName: "id",
            propertyName: "id",
            declaredType: "INTEGER",
            affinity: "integer",
            nullable: false,
            primaryKeyPosition: 1,
            defaultSql: null,
            hidden: 0,
            generated: false,
          },
          value: {
            kind: "column",
            table: "inline_desc_non_alias",
            sqlName: "value",
            propertyName: "value",
            declaredType: "TEXT",
            affinity: "text",
            nullable: false,
            primaryKeyPosition: 0,
            defaultSql: null,
            hidden: 0,
            generated: false,
          },
        },
        primaryKey: ["id"],
        indexes: [
          {
            name: "sqlite_autoindex_inline_desc_non_alias_1",
            unique: true,
            columns: ["id"],
            partial: false,
          },
        ],
        foreignKeys: [],
      } as const satisfies NonAliasIntegerPrimaryKeyTable & {
        readonly defaultCollation: "BINARY";
      };
      const schemaCatalog = schema as unknown as Record<string, unknown>;
      schemaCatalog[descTable.name] = descTable;
      try {
        const descLeft = scan(
          descTable as unknown as typeof schema.site_identities,
        );
        const descRight = scan(
          descTable as unknown as typeof schema.site_identities,
        );
        const descLeftKey = Object.values(descLeft.columns)[0]!;
        const descRightKey = Object.values(descRight.columns)[0]!;
        const descSemi = semiJoin(
          descLeft,
          descRight,
          eq(descLeftKey, descRightKey),
        );
        expect(lowerLogicalPlan(descSemi).semiMembershipChoices).toEqual([]);
        expect(compileD1Query(descSemi).sql).toContain("EXISTS");
      } finally {
        Reflect.deleteProperty(schemaCatalog, descTable.name);
      }
    } finally {
      db.close();
    }
  });

  it("preserves positive SemiJoin filtering with an empty RHS", () => {
    const db = createMigratedDatabase();
    try {
      const left = valuesRelation(
        {
          marker: { affinity: "text", nullable: false },
          key: { affinity: "text", nullable: true },
        },
        [
          { marker: "left-a", key: "a" },
          { marker: "left-null", key: null },
        ],
      );
      const right = valuesRelation(
        { key: { affinity: "text", nullable: true } },
        [],
      );
      const relation = semiJoin(
        left,
        right,
        eq(left.columns.key, right.columns.key),
      );
      const defaultQuery = compileD1Query(relation);
      const candidate = compileD1QuerySemiMembershipForceSafeForTest(relation);
      const baseline = compileD1QuerySemiMembershipFallbackForTest(relation);

      expect(defaultQuery.sql).toContain("EXISTS");
      expect(defaultQuery.sql).not.toContain(" IN (SELECT ");
      expect(candidate.sql).toContain(" IN (SELECT ");
      expect(candidate.physicalPlanShape?.version).toBe(10);
      expect(executeAll(db, candidate)).toEqual([]);
      expect(executeAll(db, baseline)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("proves values-relation keys through a Generic Join for nullable self-membership", () => {
    const database = createMigratedDatabase();
    try {
      const left = valuesRelation(
        {
          marker: { affinity: "text", nullable: false },
          bucket: { affinity: "text", nullable: false },
        },
        [
          { marker: "left-first", bucket: "all" },
          { marker: "left-second", bucket: "all" },
        ],
      );
      const right = valuesRelation(
        {
          keyA: { affinity: "text", nullable: true },
          keyB: { affinity: "text", nullable: true },
          tag: { affinity: "text", nullable: false },
          bucket: { affinity: "text", nullable: false },
        },
        [
          { keyA: "a", keyB: "x", tag: "duplicate-one", bucket: "all" },
          { keyA: "a", keyB: "x", tag: "duplicate-two", bucket: "all" },
          { keyA: null, keyB: "x", tag: "null-key", bucket: "all" },
          { keyA: "b", keyB: "y", tag: "other-key", bucket: "all" },
        ],
      );
      const source = join(
        left,
        right,
        eq(left.columns.bucket, right.columns.bucket),
      );
      const keys = distinct(
        project(source, {
          keyA: source.columns.right_keyA,
          keyB: source.columns.right_keyB,
        }),
      );
      const selfJoin = join(
        source,
        keys,
        and(
          eq(source.columns.right_keyA, keys.columns.keyA),
          eq(source.columns.right_keyB, keys.columns.keyB),
        ),
      );
      const result = project(selfJoin, {
        marker: selfJoin.columns.left_left_marker,
        tag: selfJoin.columns.left_right_tag,
      });
      const physical = lowerLogicalPlan(result);
      expect(physical.selfMembershipChoices).toHaveLength(1);

      const optimized = compileD1Query(physical);
      const unoptimized = compileD1QueryUnoptimizedForTest(result);
      const bag = (query: ReturnType<typeof compileD1Query>) =>
        executeAll(database, query)
          .map((row) => JSON.stringify(row))
          .sort();
      expect(bag(optimized)).toEqual(bag(unoptimized));
      expect(bag(optimized)).toEqual(
        [
          { marker: "left-first", tag: "duplicate-one" },
          { marker: "left-first", tag: "duplicate-two" },
          { marker: "left-first", tag: "other-key" },
          { marker: "left-second", tag: "duplicate-one" },
          { marker: "left-second", tag: "duplicate-two" },
          { marker: "left-second", tag: "other-key" },
        ]
          .map((row) => JSON.stringify(row))
          .sort(),
      );
    } finally {
      database.close();
    }
  });

  it("selects direct Scan projection columns without changing DAL row semantics", () => {
    const db = createMigratedDatabase();
    try {
      for (const [id, email] of [
        ["projection-match-1", "shared-site"],
        ["projection-match-2", "shared-site"],
        ["projection-unmatched", "missing-site"],
        ["projection-null", null],
      ] as const)
        db.prepare(
          "INSERT INTO account_action_tokens (id, type, token_hash, email, expires_at) VALUES (?, 'team_invite', ?, ?, 2000000000)",
        ).run(id, `hash-${id}`, email);
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "shared-site",
      );

      const tokenRows = scan(schema.account_action_tokens);
      const namedTokens = project(tokenRows, {
        tokenKey: tokenRows.columns.email,
        tokenId: tokenRows.columns.id,
        repeatedTokenKey: tokenRows.columns.email,
        kind: tokenRows.columns.type,
      });
      const filteredTokens = filter(
        namedTokens,
        eq(namedTokens.columns.kind, param("team_invite")),
      );
      const siteRows = scan(schema.site_identities);
      const namedSites = project(siteRows, {
        lookupKey: siteRows.columns.site_id,
      });
      const joined = join(
        filteredTokens,
        namedSites,
        eq(filteredTokens.columns.tokenKey, namedSites.columns.lookupKey),
        "left",
      );
      const relation = project(joined, {
        matchedSite: joined.columns.right_lookupKey,
        email: joined.columns.left_tokenKey,
        tokenId: joined.columns.left_tokenId,
        duplicateEmail: joined.columns.left_repeatedTokenKey,
      });

      const physical = lowerLogicalPlan(relation);
      expect(
        physical.directScanProjections.map(({ sqlColumnNames }) => [
          ...sqlColumnNames,
        ]),
      ).toEqual([["email", "id", "email", "type"], ["site_id"]]);
      const optimized = compileD1Query(physical);
      const mechanical = compileD1QueryUnoptimizedForTest(relation);
      expect(optimized.sql).not.toBe(mechanical.sql);
      expect(optimized.sql).not.toContain('"token_hash"');
      expect(optimized.sql).not.toContain('"payload_json"');
      expect(mechanical.sql).toContain('"token_hash"');
      expect(optimized.bindings).toEqual(mechanical.bindings);

      const run = (query: { sql: string; bindings?: readonly unknown[] }) =>
        db
          .prepare(query.sql)
          .all(...((query.bindings ?? []) as SQLInputValue[]));
      const optimizedRows = run(optimized).sort((left, right) =>
        String(left.tokenId).localeCompare(String(right.tokenId)),
      );
      const mechanicalRows = run(mechanical).sort((left, right) =>
        String(left.tokenId).localeCompare(String(right.tokenId)),
      );
      expect(optimizedRows).toEqual(mechanicalRows);
      expect(optimizedRows).toEqual([
        {
          matchedSite: "shared-site",
          email: "shared-site",
          tokenId: "projection-match-1",
          duplicateEmail: "shared-site",
        },
        {
          matchedSite: "shared-site",
          email: "shared-site",
          tokenId: "projection-match-2",
          duplicateEmail: "shared-site",
        },
        {
          matchedSite: null,
          email: null,
          tokenId: "projection-null",
          duplicateEmail: null,
        },
        {
          matchedSite: null,
          email: "missing-site",
          tokenId: "projection-unmatched",
          duplicateEmail: "missing-site",
        },
      ]);

      const duplicateProjection = project(tokenRows, {
        onlyEmail: tokenRows.columns.email,
      });
      const duplicateOptimizedRows = run(
        compileD1Query(duplicateProjection),
      ).sort((left, right) =>
        String(left.onlyEmail).localeCompare(String(right.onlyEmail)),
      );
      const duplicateMechanicalRows = run(
        compileD1QueryUnoptimizedForTest(duplicateProjection),
      ).sort((left, right) =>
        String(left.onlyEmail).localeCompare(String(right.onlyEmail)),
      );
      expect(duplicateOptimizedRows).toEqual(duplicateMechanicalRows);
      expect(duplicateOptimizedRows).toHaveLength(4);
      expect(
        duplicateOptimizedRows.filter((row) => row.onlyEmail === "shared-site"),
      ).toHaveLength(2);

      const forged = {
        ...physical,
        directScanProjections: physical.directScanProjections.map(
          (choice, index) =>
            index === 0
              ? {
                  ...choice,
                  sqlColumnNames: [
                    "token_hash",
                    ...choice.sqlColumnNames.slice(1),
                  ],
                }
              : choice,
        ),
      };
      expect(() => compileD1Query(forged)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );

      const computedRows = scan(schema.site_identities);
      const computedProjection = project(computedRows, {
        normalized: callFunction("lower", computedRows.columns.site_id),
      });
      expect(
        lowerLogicalPlan(computedProjection).directScanProjections,
      ).toEqual([]);
      const optimizedComputedProjection = compileD1Query(computedProjection);
      const mechanicalComputedProjection =
        compileD1QueryUnoptimizedForTest(computedProjection);
      expect(optimizedComputedProjection.sql).toBe(
        mechanicalComputedProjection.sql,
      );
      expect(optimizedComputedProjection.bindings).toEqual(
        mechanicalComputedProjection.bindings,
      );

      const outerSites = scan(schema.site_identities);
      const correlatedSites = scan(schema.site_identities);
      const correlatedProjection = project(correlatedSites, {
        outerValue: outerSites.columns.site_id,
      });
      const correlatedMembership = project(outerSites, {
        siteId: outerSites.columns.site_id,
        matched: inSubquery(outerSites.columns.site_id, correlatedProjection),
      });
      expect(
        lowerLogicalPlan(correlatedMembership).directScanProjections,
      ).toEqual([]);
      const optimizedCorrelatedMembership =
        compileD1Query(correlatedMembership);
      const mechanicalCorrelatedMembership =
        compileD1QueryUnoptimizedForTest(correlatedMembership);
      expect(optimizedCorrelatedMembership.sql).toBe(
        mechanicalCorrelatedMembership.sql,
      );
      expect(optimizedCorrelatedMembership.bindings).toEqual(
        mechanicalCorrelatedMembership.bindings,
      );
    } finally {
      db.close();
    }
  });

  it("expands compiler-owned stars and identity projections with equal SQLite rows", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?), (?)").run(
        "compiler-left",
        "compiler-right",
      );

      const buildQuery = (kind: "inner" | "left") => {
        const sites = scan(schema.site_identities);
        const selectedSites = filter(
          sites,
          gt(sites.columns.site_pk, param(0)),
        );
        const leftIdentity = project(selectedSites, {
          sitePk: selectedSites.columns.site_pk,
          siteId: selectedSites.columns.site_id,
        });

        const rightSites = scan(schema.site_identities);
        const selectedRightSites = filter(
          rightSites,
          eq(rightSites.columns.site_id, param("compiler-left")),
        );
        const rightIdentity = project(selectedRightSites, {
          sitePk: selectedRightSites.columns.site_pk,
          siteId: selectedRightSites.columns.site_id,
        });
        const joined = join(
          leftIdentity,
          rightIdentity,
          eq(leftIdentity.columns.sitePk, rightIdentity.columns.sitePk),
          kind,
        );
        const visible = distinct(
          project(joined, {
            siteId: joined.columns.left_siteId,
            maybeSitePk: joined.columns.right_sitePk,
          }),
        );
        const ascending = window(visible, {
          rank: rowNumber({
            orderBy: [{ expression: visible.columns.siteId, direction: "ASC" }],
          }),
        });
        const descending = window(visible, {
          rank: rowNumber({
            orderBy: [
              { expression: visible.columns.siteId, direction: "DESC" },
            ],
          }),
        });
        const bothOrders = union(ascending, descending, false);
        const ordered = sort(bothOrders, [
          { expression: bothOrders.columns.rank, direction: "ASC" },
          { expression: bothOrders.columns.siteId, direction: "ASC" },
        ]);
        const limited = limit(ordered, 10);
        return project(limited, {
          siteId: limited.columns.siteId,
          maybeSitePk: limited.columns.maybeSitePk,
          rank: limited.columns.rank,
        });
      };

      const run = (query: { sql: string; bindings?: readonly unknown[] }) =>
        db
          .prepare(query.sql)
          .all(...((query.bindings ?? []) as SQLInputValue[]));
      for (const kind of ["inner", "left"] as const) {
        const relation = buildQuery(kind);
        const optimized = compileD1Query(relation);
        const repeated = compileD1Query(relation);
        const mechanical = compileD1QueryUnoptimizedForTest(relation);

        expect(optimized.sql).not.toBe(mechanical.sql);
        expect(optimized.sql).toContain(".*");
        expect(optimized.sql).toContain('"site_pk" AS _c0');
        expect(optimized.sql).toContain("AS _c2");
        expect(mechanical.sql).not.toContain(".*");
        expect(optimized.bindings).toEqual(mechanical.bindings);
        expect(repeated.sql).toBe(optimized.sql);
        expect(repeated.bindings).toEqual(optimized.bindings);
        expect(repeated.physicalPlanShape).toEqual(optimized.physicalPlanShape);
        expect(run(optimized)).toEqual(run(mechanical));
        if (kind === "left")
          expect(run(optimized)).toContainEqual({
            siteId: "compiler-right",
            maybeSitePk: null,
            rank: 1,
          });
      }
    } finally {
      db.close();
    }
  });

  it("hoists shared filtered expression plans and keeps subquery or volatile plans inline", () => {
    const db = createMigratedDatabase();
    try {
      for (const siteId of ["facts-a", "facts-b"])
        executeRun(db, {
          sql: "INSERT INTO site_identities (site_id) VALUES (?)",
          bindings: [siteId],
        });

      const sites = scan(schema.site_identities);
      const siteId = sites.columns.site_id;
      const filtered = filter(
        sites,
        and(
          eq(siteId, param("facts-a")),
          not(eq(siteId, param("not-present"))),
          isNotNull(siteId),
          inList(siteId, ["facts-a", "facts-b"]),
        ),
      );
      const labels = project(filtered, {
        siteId: filtered.columns.site_id,
        normalized: callFunction("lower", filtered.columns.site_id),
        fallback: coalesce(filtered.columns.site_id, param("fallback")),
        label: caseWhen(
          [
            {
              when: eq(filtered.columns.site_id, param("facts-a")),
              then: param("A"),
            },
          ],
          param("other"),
        ),
      });
      const totals = aggregate(filtered, {
        groupBy: { siteId: filtered.columns.site_id },
        aggregates: { total: sum(filtered.columns.site_pk) },
      });
      const joined = join(
        labels,
        totals,
        eq(labels.columns.siteId, totals.columns.siteId),
      );
      const shared = project(joined, {
        siteId: joined.columns.left_siteId,
        fallback: joined.columns.left_fallback,
        label: joined.columns.left_label,
        total: joined.columns.right_total,
      });
      const repeated = union(shared, shared);
      const physical = lowerLogicalPlan(repeated);
      expect(physical.sharedRelations.map(({ node }) => node)).toContain(
        shared.node,
      );
      expect(() =>
        compileD1Query({ ...physical, sharedRelations: [] }),
      ).toThrowError(expect.objectContaining({ code: "invalid_plan" }));
      const optimized = compileD1Query(physical);
      const mechanical = compileD1QueryUnoptimizedForTest(repeated);
      expect(optimized.sql).toContain("_d1_shared_0");
      expect(optimized.bindings).not.toEqual(mechanical.bindings);
      expect(executeAll(db, optimized)).toEqual([
        {
          siteId: "facts-a",
          fallback: "facts-a",
          label: "A",
          total: 1,
        },
      ]);
      expect(executeAll(db, optimized)).toEqual(executeAll(db, mechanical));

      const outerSites = scan(schema.site_identities);
      const selected = filter(
        outerSites,
        eq(outerSites.columns.site_id, param("facts-a")),
      );
      const innerSites = scan(schema.site_identities);
      const innerIds = project(innerSites, {
        candidate: innerSites.columns.site_id,
      });
      const totalSites = aggregate(innerSites, {
        groupBy: {},
        aggregates: { rows: count() },
      });
      const guarded = project(selected, {
        siteId: selected.columns.site_id,
        included: inSubquery(selected.columns.site_id, innerIds),
        total: scalar(totalSites),
        evaluatedAt: unixepoch(),
      });
      const repeatedGuarded = union(guarded, guarded, true);
      const guardedPhysical = lowerLogicalPlan(repeatedGuarded);
      expect(guardedPhysical.sharedRelations).toEqual([]);
      const guardedQuery = compileD1Query(guardedPhysical);
      expect(guardedQuery.sql).not.toContain("_d1_shared_");
      const guardedRows = executeAll(db, guardedQuery);
      expect(guardedRows).toHaveLength(2);
      for (const row of guardedRows)
        expect(row).toMatchObject({ siteId: "facts-a", included: 1, total: 2 });
      expect(
        guardedRows.every((row) => Number.isInteger(row.evaluatedAt)),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("packs the highest saving text membership before lower saving lists", () => {
    const db = createMigratedDatabase();
    try {
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        "membership-target",
      );
      const largestList = Array.from(
        { length: 70 },
        (_, index) => `largest-miss-${index}`,
      );
      largestList[17] = "membership-target";
      const smallerList = Array.from(
        { length: 40 },
        (_, index) => `smaller-miss-${index}`,
      );
      smallerList[5] = "membership-target";
      const sites = scan(schema.site_identities);
      const matches = filter(
        sites,
        and(
          inList(sites.columns.site_id, largestList),
          inList(sites.columns.site_id, smallerList),
        ),
      );
      const query = compileD1Query(
        project(matches, { site_id: matches.columns.site_id }),
      );
      expect(query.bindings).toEqual([
        JSON.stringify(largestList),
        ...smallerList,
      ]);
      expect(query.sql.match(/json_each\(\?\)/gu)).toHaveLength(1);

      const nativeSql = `SELECT site_id FROM site_identities WHERE site_id IN (${largestList.map(() => "?").join(",")}) AND site_id IN (${smallerList.map(() => "?").join(",")})`;
      const nativeRows = db
        .prepare(nativeSql)
        .all(...([...largestList, ...smallerList] as SQLInputValue[]));
      expect(executeAll(db, query)).toEqual(nativeRows);
      expect(executeAll(db, query)).toEqual([{ site_id: "membership-target" }]);
    } finally {
      db.close();
    }
  });

  it("enforces the common binding budget for query and mutation compilation", () => {
    const sites = scan(schema.site_identities);
    const projections = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `value_${index}`,
        param(`private-value-${index}`),
      ]),
    );

    try {
      compileD1Query(project(sites, projections), { tag: "query.budget" });
      throw new Error("expected query budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(D1StatementBudgetError);
      expect(error).toMatchObject({
        code: "d1_statement_budget_exceeded",
        item: "bindings",
        actual: 101,
        limit: 100,
        tag: "query.budget",
      });
      expect((error as Error).message).not.toContain("private-value");
    }
    expect(() =>
      compileD1QueryUnoptimizedForTest(project(sites, projections)),
    ).toThrowError(D1StatementBudgetError);

    try {
      compileD1Mutation(
        insert(
          schema.site_identities,
          Array.from({ length: 101 }, (_, index) => ({
            site_id: `site-${index}`,
          })),
        ),
        { tag: "mutation.budget" },
      );
      throw new Error("expected mutation budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(D1StatementBudgetError);
      expect(error).toMatchObject({
        code: "d1_statement_budget_exceeded",
        item: "bindings",
        actual: 101,
        limit: 100,
        tag: "mutation.budget",
      });
    }

    const sourceSites = scan(schema.site_identities);
    const filteredSourceSites = filter(
      sourceSites,
      inList(
        sourceSites.columns.site_id,
        Array.from(
          { length: 101 },
          (_, index) => `site-${index}-${"x".repeat(10_000)}`,
        ),
      ),
    );
    const source = project(filteredSourceSites, {
      site_id: filteredSourceSites.columns.site_id,
    });
    try {
      compileD1Mutation(
        insertFromQuery(schema.site_identities, ["site_id"], source),
        { tag: "mutation.query.budget" },
      );
      throw new Error("expected insert-from-query budget error");
    } catch (error) {
      expect(error).toBeInstanceOf(D1StatementBudgetError);
      expect(error).toMatchObject({
        item: "bindings",
        actual: 101,
        limit: 100,
        tag: "mutation.query.budget",
      });
    }
  });

  it("packs safe text membership from final query binding costs", () => {
    const db = createMigratedDatabase();
    try {
      const specialValues = [
        "match",
        "",
        'quote"value',
        "back\\slash",
        "nul\u0000value",
        "中文🙂",
        "01",
        "1",
        "1.0",
        "1e0",
      ];
      const values = [
        ...specialValues,
        ...Array.from({ length: 118 }, (_, index) => `distractor-${index}`),
      ];
      values[73] = "match";
      expect(values).toHaveLength(128);
      for (const value of specialValues)
        db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
          value,
        );

      const sites = scan(schema.site_identities);
      const nativeSql = `SELECT site_id FROM site_identities WHERE site_id IN (${values.map(() => "?").join(",")})`;
      const matchedRows = filter(sites, inList(sites.columns.site_id, values));
      const matched = project(matchedRows, {
        site_id: matchedRows.columns.site_id,
      });
      const packed = compileD1Query(matched);
      expect(packed.bindings).toEqual([JSON.stringify(values)]);
      expect(packed.sql).toContain("json_each(?)");
      expect(new TextEncoder().encode(packed.sql).byteLength).toBeLessThan(
        100_000,
      );
      const packedExplain = executeAll(db, {
        sql: `EXPLAIN QUERY PLAN ${packed.sql}`,
        bindings: packed.bindings,
      });
      const nativeExplain = executeAll(db, {
        sql: `EXPLAIN QUERY PLAN ${nativeSql}`,
        bindings: values,
      });
      const usesSiteIdentityIndex = (plan: Array<Record<string, unknown>>) =>
        plan.some(
          (row) =>
            typeof row.detail === "string" &&
            row.detail.includes("sqlite_autoindex_site_identities_1"),
        );
      expect(usesSiteIdentityIndex(nativeExplain)).toBe(true);
      expect(usesSiteIdentityIndex(packedExplain)).toBe(true);

      const nativeOracle = db
        .prepare(nativeSql)
        .all(...(values as SQLInputValue[])) as Array<{ site_id: string }>;
      const actual = executeAll(db, packed).map((row) => row.site_id);
      expect(actual.sort()).toEqual(
        nativeOracle.map((row) => row.site_id).sort(),
      );
      expect(actual).toHaveLength(specialValues.length);

      const exactOneValues = [
        "1",
        ...Array.from({ length: 127 }, (_, index) => `one-miss-${index}`),
      ];
      const exactOneQuery = compileD1Query(
        filter(sites, inList(sites.columns.site_id, exactOneValues)),
      );
      const exactOneNativeOracle = db
        .prepare(
          `SELECT site_id FROM site_identities WHERE site_id IN (${exactOneValues.map(() => "?").join(",")})`,
        )
        .all(...(exactOneValues as SQLInputValue[])) as Array<{
        site_id: string;
      }>;
      const exactOnePackedRows = executeAll(db, exactOneQuery).map(
        (row) => row.site_id,
      );
      expect(exactOneQuery.sql).toContain("json_each(?)");
      expect(exactOnePackedRows).toEqual(
        exactOneNativeOracle.map((row) => row.site_id),
      );
      expect(exactOnePackedRows).toEqual(["1"]);
      expect(exactOnePackedRows).not.toContain("01");
      expect(exactOnePackedRows).not.toContain("1.0");
      expect(exactOnePackedRows).not.toContain("1e0");

      const insertFromQueryStatement = compileD1Mutation(
        insertFromQuery(schema.site_identities, ["site_id"], matched),
      );
      expect(insertFromQueryStatement.sql).toContain("json_each(?)");
      expect(insertFromQueryStatement.bindings).toEqual(packed.bindings);

      const small = compileD1Query(
        filter(sites, inList(sites.columns.site_id, ["match", "missing"])),
      );
      expect(small.sql).not.toContain("json_each");
      expect(small.bindings).toEqual(["match", "missing"]);
      const emptyMembership = compileD1Query(
        filter(sites, inList(sites.columns.site_id, [])),
      );
      expect(emptyMembership.sql).toContain("(0)");
      expect(emptyMembership.bindings).toEqual([]);

      const nullableTable = schema.account_action_tokens;
      for (const [id, email] of [
        ["null-email", null],
        ["outside-email", "outside"],
        ["inside-email", "inside"],
      ] as const)
        db.prepare(
          "INSERT INTO account_action_tokens (id, type, token_hash, email, expires_at) VALUES (?, 'team_invite', ?, ?, 2000000000)",
        ).run(id, `hash-${id}`, email);
      const nullableTokens = scan(nullableTable);
      const nullableValues = [
        "inside",
        ...Array.from({ length: 127 }, (_, index) => `email-${index}`),
      ];
      const nullableOutside = filter(
        nullableTokens,
        not(inList(nullableTokens.columns.email, nullableValues)),
      );
      const notIn = compileD1Query(
        project(nullableOutside, { id: nullableOutside.columns.id }),
      );
      expect(notIn.sql).toContain("NOT (");
      expect(notIn.sql).toContain("json_each(?)");
      expect(notIn.bindings).toEqual([JSON.stringify(nullableValues)]);
      expect(executeAll(db, notIn)).toEqual([{ id: "outside-email" }]);

      const listA = values.slice(0, 40);
      const listB = values.slice(40, 70);
      const listBHit = values[45]!;
      db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(
        listBHit,
      );
      const repeatedMembership = inList(sites.columns.site_id, listA);
      const multiList = compileD1Query(
        project(sites, {
          site_id: sites.columns.site_id,
          first: not(repeatedMembership),
          repeated: not(repeatedMembership),
          distinct: not(inList(sites.columns.site_id, listB)),
        }),
      );
      const multiListBindings = multiList.bindings ?? [];
      expect(multiListBindings).toHaveLength(32);
      expect(multiListBindings.slice(0, 2)).toEqual([
        JSON.stringify(listA),
        JSON.stringify(listA),
      ]);
      expect(multiListBindings.slice(2)).toEqual(listB);
      const multiListRows = executeAll(db, multiList);
      expect(multiListRows).toHaveLength(specialValues.length + 1);
      const nativeMultiListSql = `SELECT site_id, NOT (site_id IN (${listA.map(() => "?").join(",")})) AS first, NOT (site_id IN (${listA.map(() => "?").join(",")})) AS repeated, NOT (site_id IN (${listB.map(() => "?").join(",")})) AS "distinct" FROM site_identities`;
      const nativeMultiListRows = db
        .prepare(nativeMultiListSql)
        .all(...([...listA, ...listA, ...listB] as SQLInputValue[])) as Array<{
        site_id: string;
        first: number;
        repeated: number;
        distinct: number;
      }>;
      const normalizedMultiListRows = (rows: Array<Record<string, unknown>>) =>
        rows
          .map((row) => ({
            site_id: String(row.site_id),
            first: Number(row.first),
            repeated: Number(row.repeated),
            distinct: Number(row.distinct),
          }))
          .sort((left, right) => left.site_id.localeCompare(right.site_id));
      expect(normalizedMultiListRows(multiListRows)).toEqual(
        normalizedMultiListRows(nativeMultiListRows),
      );
      expect(
        multiListRows.find((row) => row.site_id === listBHit)?.distinct,
      ).toBe(0);

      const hundredNative = compileD1Query(
        filter(
          sites,
          inList(
            sites.columns.site_id,
            Array.from({ length: 100 }, (_, index) => `native-${index}`),
          ),
        ),
      );
      expect(hundredNative.bindings).toHaveLength(100);
      expect(hundredNative.sql).not.toContain("json_each");

      const numericSites = scan(schema.visits);
      const numericValues = Array.from({ length: 101 }, (_, index) => index);
      const numericPacked = compileD1Query(
        filter(
          numericSites,
          inList(numericSites.columns.started_at, numericValues),
        ),
      );
      expect(numericPacked.sql).toContain("json_each(?)");
      expect(numericPacked.bindings).toEqual([JSON.stringify(numericValues)]);

      const mixedList = compileD1Query(
        filter(sites, inList(sites.columns.site_id, ["text", 1] as never)),
      );
      expect(mixedList.sql).not.toContain("json_each");
      expect(mixedList.bindings).toEqual(["text", 1]);

      const unsafeMembershipLists: readonly {
        readonly name: string;
        readonly values: readonly unknown[];
      }[] = [
        {
          name: "mixed text and number",
          values: [
            ...Array.from({ length: 100 }, (_, index) => `mixed-${index}`),
            1,
          ],
        },
        {
          name: "NULL member",
          values: [
            ...Array.from({ length: 100 }, (_, index) => `null-${index}`),
            null,
          ],
        },
        {
          name: "ill-formed surrogate",
          values: [
            String.fromCharCode(0xd800),
            ...Array.from({ length: 100 }, (_, index) => `surrogate-${index}`),
          ],
        },
      ];
      for (const unsafe of unsafeMembershipLists) {
        expect(
          () =>
            compileD1Query(
              filter(
                sites,
                inList(sites.columns.site_id, unsafe.values as never),
              ),
            ),
          unsafe.name,
        ).toThrowError(
          expect.objectContaining({
            code: "d1_statement_budget_exceeded",
            item: "bindings",
            actual: 101,
          }),
        );
      }

      const malformedLowSurrogate = String.fromCharCode(0xdc00);
      const unsafeHighSavingValues = [
        malformedLowSurrogate,
        ...Array.from({ length: 98 }, (_, index) => `low-surrogate-${index}`),
      ];
      const safeFollowupValues = [
        "safe-followup-a",
        "safe-followup-b",
        "safe-followup-c",
      ];
      const skipsUnsafeMembership = compileD1Query(
        filter(
          sites,
          and(
            inList(sites.columns.site_id, unsafeHighSavingValues),
            inList(sites.columns.site_id, safeFollowupValues),
          ),
        ),
      );
      expect(skipsUnsafeMembership.bindings).toHaveLength(100);
      expect(skipsUnsafeMembership.bindings).toContain(malformedLowSurrogate);
      expect(skipsUnsafeMembership.bindings).toContain(
        JSON.stringify(safeFollowupValues),
      );
      expect(skipsUnsafeMembership.sql.match(/json_each\(\?\)/gu)).toHaveLength(
        1,
      );

      const selected = filter(sites, inList(sites.columns.site_id, values));
      const repeated = union(selected, selected, true);
      const withTailParameter = project(repeated, {
        site_id: repeated.columns.site_id,
        marker: param("tail"),
      });
      const cteQuery = compileD1Query(withTailParameter);
      expect(cteQuery.sql.match(/_d1_shared_\d+/g)).not.toBeNull();
      expect(cteQuery.bindings).toEqual([JSON.stringify(values), "tail"]);
      expect(executeAll(db, cteQuery)).toHaveLength(
        (specialValues.length + 1) * 2,
      );

      const nested = compileD1Query(
        filter(
          sites,
          and(
            inList(sites.columns.site_id, values),
            eq(sites.columns.site_id, param("match")),
          ),
        ),
      );
      expect(nested.bindings).toEqual([JSON.stringify(values), "match"]);
      const nestedNativeSql = `SELECT site_id FROM site_identities WHERE site_id IN (${values.map(() => "?").join(",")}) AND site_id = ?`;
      const nestedNativeOracle = db
        .prepare(nestedNativeSql)
        .all(...([...values, "match"] as SQLInputValue[])) as Array<{
        site_id: string;
      }>;
      const nestedActual = executeAll(db, nested).map((row) => row.site_id);
      expect(nestedActual).toEqual(
        nestedNativeOracle.map((row) => row.site_id),
      );
      expect(nestedActual).toEqual(["match"]);

      const malformedSurrogate = String.fromCharCode(0xd800);
      const unchangedMalformed = compileD1Query(
        filter(
          sites,
          inList(sites.columns.site_id, [malformedSurrogate, "ordinary"]),
        ),
      );
      expect(unchangedMalformed.sql).not.toContain("json_each");
      expect(unchangedMalformed.bindings).toEqual([
        malformedSurrogate,
        "ordinary",
      ]);

      const forgedRelation = filter(
        sites,
        inList(sites.columns.site_id, values),
      );
      const physical = lowerLogicalPlan(forgedRelation);
      if (physical.root.kind !== "filter")
        throw new Error("expected a filter physical root");
      const jsonText = JSON.stringify(values);
      const jsonUtf8Bytes = new TextEncoder().encode(jsonText).byteLength;
      const validPhysicalWithMetadata = {
        ...physical,
        membershipOptimization: {
          nativeBindingCount: 128,
          selectedBindingCount: 1,
          strategies: [
            {
              expression: physical.root.predicate as Extract<
                typeof physical.root.predicate,
                { kind: "in-list" }
              >,
              occurrences: 1,
              strategy: "json-text" as const,
              jsonText,
              jsonUtf8Bytes,
              nativeBindingsSaved: 127,
            },
          ],
        },
      };
      expect(compileD1Query(validPhysicalWithMetadata)).toEqual(
        compileD1Query(forgedRelation),
      );
      const forged = {
        ...physical,
        membershipOptimization: {
          nativeBindingCount: 128,
          selectedBindingCount: 1,
          strategies: [
            {
              expression: physical.root.predicate as Extract<
                typeof physical.root.predicate,
                { kind: "in-list" }
              >,
              occurrences: 1,
              strategy: "json-text" as const,
              jsonText: '["forged"]',
              jsonUtf8Bytes: 10,
              nativeBindingsSaved: 127,
            },
          ],
        },
      };
      expect(() => compileD1Query(forged)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );

      const forgedCost = {
        ...forged,
        membershipOptimization: {
          ...forged.membershipOptimization,
          nativeBindingCount: 129,
          strategies: [
            {
              ...forged.membershipOptimization.strategies[0]!,
              jsonText,
              jsonUtf8Bytes,
            },
          ],
        },
      };
      expect(() => compileD1Query(forgedCost)).toThrowError(
        expect.objectContaining({ code: "invalid_plan" }),
      );

      const oversizedPayloadValues = [
        "x".repeat(999_696),
        ...Array.from({ length: 100 }, () => ""),
      ];
      const boundaryQuery = compileD1Query(
        filter(sites, inList(sites.columns.site_id, oversizedPayloadValues)),
      );
      expect(boundaryQuery.bindings ?? []).toHaveLength(1);
      expect(
        new TextEncoder().encode((boundaryQuery.bindings ?? [])[0] as string)
          .byteLength,
      ).toBe(1_000_000);

      const overBoundaryValues = [
        "x".repeat(999_697),
        ...Array.from({ length: 100 }, () => ""),
      ];
      const overBoundaryQuery = compileD1Query(
        filter(sites, inList(sites.columns.site_id, overBoundaryValues)),
      );
      expect(overBoundaryQuery.bindings).toEqual(["x".repeat(999_697), ""]);
      expect(overBoundaryQuery.physicalPlanShape).toMatchObject({
        version: 3,
        parameterStrategy: "numbered-reuse",
        parameterOccurrenceCount: 101,
        parameterSlotCount: 2,
      });

      const rowValues = Array.from({ length: 101 }, (_unused, index) => ({
        site_id: `row-source-${index}`,
      }));
      const rowSource = valuesRelation(
        { site_id: { affinity: "text", nullable: false } } as const,
        rowValues,
      );
      const insertRows = compileD1Mutation(
        insertFromQuery(schema.site_identities, ["site_id"], rowSource),
      );
      expect(insertRows.bindings).toHaveLength(1);
      expect(insertRows.sql).toContain('json_each("_segments".column1)');
      executeRun(db, insertRows);
      expect(
        db
          .prepare(
            "SELECT site_id FROM site_identities WHERE site_id LIKE 'row-source-%' ORDER BY site_id",
          )
          .all(),
      ).toHaveLength(101);
    } finally {
      db.close();
    }
  });

  it("does not hoist relations across subquery, sort, or limit boundaries", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, [
            { site_id: "site-a" },
            { site_id: "site-b" },
          ]),
        ),
      );
      const sites = scan(schema.site_identities);
      const selected = filter(
        sites,
        inList(sites.columns.site_id, ["site-a", "site-b"]),
      );
      const assertNoHoistAndCompare = (relation: Relation<object>) => {
        expect(lowerLogicalPlan(relation).sharedRelations).toEqual([]);
        const optimized = compileD1Query(relation);
        const mechanical = compileD1QueryUnoptimizedForTest(relation);
        expect(optimized.sql).not.toContain("WITH ");
        expect(executeAll(db, optimized)).toEqual(executeAll(db, mechanical));
      };

      const firstScalarSource = project(selected, {
        site_id: selected.columns.site_id,
      });
      const secondScalarSource = project(selected, {
        site_id: selected.columns.site_id,
      });
      const repeatedScalars = project(sites, {
        site_id: sites.columns.site_id,
        first_match: scalar(firstScalarSource),
        second_match: scalar(secondScalarSource),
      });
      expect(lowerLogicalPlan(repeatedScalars).directScanProjections).toEqual(
        [],
      );
      assertNoHoistAndCompare(repeatedScalars);
      expect(executeAll(db, compileD1Query(firstScalarSource))).toHaveLength(2);

      const firstInSource = project(selected, {
        site_id: selected.columns.site_id,
      });
      const secondInSource = project(selected, {
        site_id: selected.columns.site_id,
      });
      const repeatedInSubqueries = project(sites, {
        site_id: sites.columns.site_id,
        first_contains: inSubquery(sites.columns.site_id, firstInSource),
        second_contains: inSubquery(sites.columns.site_id, secondInSource),
      });
      expect(
        lowerLogicalPlan(repeatedInSubqueries).directScanProjections,
      ).toEqual([]);
      assertNoHoistAndCompare(repeatedInSubqueries);

      const limited = union(limit(selected, 1), selected, true);
      assertNoHoistAndCompare(limited);

      const sorted = sort(selected, [
        { expression: selected.columns.site_id, direction: "DESC" },
      ]);
      const sortedAndUnsorted = union(sorted, selected, true);
      assertNoHoistAndCompare(sortedAndUnsorted);
    } finally {
      db.close();
    }
  });

  it("executes compiled reads and writes against an in-memory migration database", () => {
    const db = createMigratedDatabase();
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const sites = scan(schema.site_identities);
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "site-a" }),
        ),
      );
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "site-b" }),
        ),
      );

      const selectedSiteRows = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const selectedSite = project(selectedSiteRows, {
        site_pk: selectedSiteRows.columns.site_pk,
      });
      const membershipProjection = () =>
        project(sites, {
          site_id: sites.columns.site_id,
          is_selected: inSubquery(sites.columns.site_pk, selectedSite),
        });
      const memberships = compileD1Query(membershipProjection());
      expect(memberships.sql).toContain(" IN (SELECT ");
      expect(memberships.bindings).toEqual(["site-a"]);
      expect(executeAll(db, memberships)).toEqual([
        { site_id: "site-a", is_selected: 1 },
        { site_id: "site-b", is_selected: 0 },
      ]);
      expect(memberships).toEqual(compileD1Query(membershipProjection()));

      const missingSiteRows = filter(
        sites,
        eq(sites.columns.site_id, param("missing")),
      );
      const emptySites = project(missingSiteRows, {
        site_pk: missingSiteRows.columns.site_pk,
      });
      const nullableMemberships = compileD1Query(
        project(sites, {
          site_id: sites.columns.site_id,
          null_lhs_in_empty: inSubquery(param(null), emptySites),
        }),
      );
      expect(executeAll(db, nullableMemberships)).toEqual([
        { site_id: "site-a", null_lhs_in_empty: 0 },
        { site_id: "site-b", null_lhs_in_empty: 0 },
      ]);

      const innerSites = scan(schema.site_identities);
      const matchingSites = filter(
        innerSites,
        eq(innerSites.columns.site_id, sites.columns.site_id),
      );
      const correlatedScalar = scalar(
        project(matchingSites, {
          matched_pk: matchingSites.columns.site_pk,
        }),
      );
      const correlatedProjection = project(sites, {
        site_id: sites.columns.site_id,
        matched_pk: correlatedScalar,
      });
      const correlatedQuery = compileD1Query(correlatedProjection);
      expect(correlatedQuery).toEqual(compileD1Query(correlatedProjection));
      expect(executeAll(db, correlatedQuery)).toEqual([
        { site_id: "site-a", matched_pk: 1 },
        { site_id: "site-b", matched_pk: 2 },
      ]);

      const innerIdentities = scan(schema.site_identities);
      const correlatedIdentities = filter(
        innerIdentities,
        eq(innerIdentities.columns.site_id, sites.columns.site_id),
      );
      const correlatedMembership = compileD1Query(
        project(sites, {
          site_id: sites.columns.site_id,
          contains_matching_id: inSubquery(
            sites.columns.site_id,
            project(correlatedIdentities, {
              site_id: correlatedIdentities.columns.site_id,
            }),
          ),
        }),
      );
      expect(correlatedMembership.sql).toContain("q0._c1");
      expect(executeAll(db, correlatedMembership)).toEqual([
        { site_id: "site-a", contains_matching_id: 1 },
        { site_id: "site-b", contains_matching_id: 1 },
      ]);

      const updateSubquerySource = scan(schema.site_identities);
      const correlatedUpdate = update(schema.site_identities, (columns) => {
        const matchingRow = filter(
          updateSubquerySource,
          eq(updateSubquerySource.columns.site_pk, columns.site_pk),
        );
        return {
          set: {
            site_id: coalesce(
              scalar(
                project(matchingRow, {
                  site_id: matchingRow.columns.site_id,
                }),
              ),
              param("site-a"),
            ),
          },
          where: eq(columns.site_pk, param(1)),
        };
      });
      const compiledCorrelatedUpdate = compileD1Mutation(correlatedUpdate);
      expect(compiledCorrelatedUpdate.sql).toContain('"t0"."site_pk"');
      executeRun(db, compiledCorrelatedUpdate);
      expect(
        db
          .prepare("SELECT site_id FROM site_identities WHERE site_pk = 1")
          .get(),
      ).toEqual({ site_id: "site-a" });

      const emptyScalarSource = scan(schema.site_identities);
      const missingSites = filter(
        emptyScalarSource,
        eq(emptyScalarSource.columns.site_id, param("missing")),
      );
      const emptyScalar = scalar(
        project(missingSites, { missing: missingSites.columns.site_id }),
      );
      expect(
        executeAll(
          db,
          compileD1Query(
            project(sites, {
              site_id: sites.columns.site_id,
              missing: emptyScalar,
            }),
          ),
        ),
      ).toEqual([
        { site_id: "site-a", missing: null },
        { site_id: "site-b", missing: null },
      ]);

      const find = limit(
        filter(sites, eq(sites.columns.site_id, param("site-a"))),
        1,
      );
      const compiled = compileD1Query(find);
      const actual = executeAll(db, compiled);
      const expected = db
        .prepare("SELECT * FROM site_identities WHERE site_id = ? LIMIT 1")
        .all("site-a");
      expect(actual).toEqual(expected);

      const selectedSites = filter(
        sites,
        eq(sites.columns.site_id, param("site-a")),
      );
      const copied = project(selectedSites, {
        site_id: selectedSites.columns.site_id,
      });
      const copyInsert = onConflictDoNothing(
        insertFromQuery(schema.site_identities, ["site_id"], copied),
        ["site_id"],
      );
      executeRun(db, compileD1Mutation(copyInsert));
      executeRun(
        db,
        compileD1Mutation(
          insertOrIgnore(schema.site_identities, { site_id: "site-a" }),
        ),
      );
      executeRun(
        db,
        compileD1Mutation(
          onConflictDoUpdate(
            insert(schema.site_identities, { site_id: "site-updated" }),
            ["site_id"],
            { site_id: "site-updated" },
          ),
        ),
      );

      const updatePlan = update(schema.site_identities, (columns) => ({
        set: { site_id: "site-renamed" },
        where: eq(columns.site_pk, param(2)),
      }));
      executeRun(db, compileD1Mutation(updatePlan));
      expect(
        db
          .prepare("SELECT site_id FROM site_identities WHERE site_pk = 2")
          .get(),
      ).toEqual({ site_id: "site-renamed" });

      const deletePlan = deleteFrom(schema.site_identities, (columns) =>
        eq(columns.site_pk, param(1)),
      );
      executeRun(db, compileD1Mutation(deletePlan));
      expect(
        db
          .prepare("SELECT site_id FROM site_identities WHERE site_pk = 1")
          .get(),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM site_identities").get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("executes searched CASE expressions in projections, functions, aggregates, and updates", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "site-a" }),
        ),
      );
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "site-b" }),
        ),
      );

      const sites = scan(schema.site_identities);
      const label = caseWhen(
        [
          {
            when: eq(sites.columns.site_id, param("site-a")),
            then: param("alpha"),
          },
          {
            when: eq(sites.columns.site_id, param("site-b")),
            then: param("beta"),
          },
        ],
        param("fallback"),
      );
      const nested = caseWhen(
        [
          {
            when: eq(sites.columns.site_id, param("site-a")),
            then: caseWhen(
              [
                {
                  when: isNotNull(sites.columns.site_id),
                  then: param("inner"),
                },
              ],
              param("inner-fallback"),
            ),
          },
        ],
        param("outer"),
      );
      const noElse = caseWhen([
        {
          when: eq(sites.columns.site_id, param("site-a")),
          then: param("only-a"),
        },
      ]);
      const functionArgument = callFunction(
        "lower",
        caseWhen(
          [
            {
              when: eq(sites.columns.site_id, param("site-a")),
              then: param("ALPHA"),
            },
          ],
          param("OTHER"),
        ),
      );
      const projection = project(sites, {
        site_id: sites.columns.site_id,
        label,
        no_else: noElse,
        nested,
        function_value: functionArgument,
      });
      const compiledProjection = compileD1Query(
        sort(projection, [
          { expression: projection.columns.site_id, direction: "ASC" },
        ]),
      );
      expect(compiledProjection.sql).toContain("CASE WHEN");
      expect(compiledProjection.sql).toContain("ELSE");
      expect(compiledProjection.bindings).toEqual([
        "site-a",
        "alpha",
        "site-b",
        "beta",
        "fallback",
        "site-a",
        "only-a",
        "site-a",
        "inner",
        "inner-fallback",
        "outer",
        "site-a",
        "ALPHA",
        "OTHER",
      ]);
      expect(executeAll(db, compiledProjection)).toEqual([
        {
          site_id: "site-a",
          label: "alpha",
          no_else: "only-a",
          nested: "inner",
          function_value: "alpha",
        },
        {
          site_id: "site-b",
          label: "beta",
          no_else: null,
          nested: "outer",
          function_value: "other",
        },
      ]);

      const totalMatched = aggregate(sites, {
        groupBy: {},
        aggregates: {
          matched: sum(
            caseWhen(
              [
                {
                  when: eq(sites.columns.site_id, param("site-a")),
                  then: param(1),
                },
              ],
              param(0),
            ),
          ),
        },
      });
      expect(executeAll(db, compileD1Query(totalMatched))).toEqual([
        { matched: 1 },
      ]);

      const updateStatement = compileD1Mutation(
        update(schema.site_identities, (columns) => ({
          set: {
            site_id: caseWhen(
              [
                {
                  when: eq(columns.site_id, param("site-a")),
                  then: param("site-renamed"),
                },
              ],
              columns.site_id,
            ),
          },
          where: eq(columns.site_id, param("site-a")),
        })),
      );
      expect(updateStatement.bindings).toEqual([
        "site-a",
        "site-renamed",
        "site-a",
      ]);
      executeRun(db, updateStatement);
      const renamedSites = scan(schema.site_identities);
      const renamed = compileD1Query(
        project(renamedSites, { site_id: renamedSites.columns.site_id }),
      );
      expect(executeAll(db, renamed)).toContainEqual({
        site_id: "site-renamed",
      });
    } finally {
      db.close();
    }
  });

  it("compiles and executes unixepoch in projections and mutations without binding it", () => {
    const db = createMigratedDatabase();
    try {
      const configs = scan(schema.configs);
      const clockProjection = compileD1Query(
        project(configs, { now: unixepoch() }),
      );
      expect(clockProjection.sql).toContain("unixepoch()");
      expect(clockProjection.bindings).toEqual([]);

      const insertPlan = insert(schema.configs, {
        config_key: "clock",
        value_json: "{}",
        created_at: unixepoch(),
        updated_at: unixepoch(),
      });
      const compiledInsert = compileD1Mutation(insertPlan);
      expect(compiledInsert.sql).toContain("unixepoch()");
      expect(compiledInsert.bindings).toEqual(["clock", "{}"]);
      executeRun(db, compiledInsert);

      const updatePlan = update(schema.configs, (columns) => ({
        set: { updated_at: unixepoch() },
        where: eq(columns.config_key, param("clock")),
      }));
      const compiledUpdate = compileD1Mutation(updatePlan);
      expect(compiledUpdate.sql).toContain('"updated_at" = unixepoch()');
      executeRun(db, compiledUpdate);

      const upsert = onConflictDoUpdate(
        insert(schema.configs, {
          config_key: "clock",
          value_json: '{"updated":true}',
        }),
        ["config_key"],
        {
          value_json: '{"updated":true}',
          updated_at: unixepoch(),
        },
      );
      const compiledUpsert = compileD1Mutation(upsert);
      expect(compiledUpsert.sql).toContain("unixepoch()");
      expect(compiledUpsert.bindings).toEqual([
        "clock",
        '{"updated":true}',
        '{"updated":true}',
      ]);
      executeRun(db, compiledUpsert);
      expect(
        db
          .prepare("SELECT value_json FROM configs WHERE config_key = ?")
          .get("clock"),
      ).toEqual({ value_json: '{"updated":true}' });

      const currentTime = db.prepare("SELECT unixepoch() AS now").get() as {
        now: number;
      };
      expect(
        db
          .prepare("SELECT updated_at FROM configs WHERE config_key = ?")
          .get("clock"),
      ).toEqual({ updated_at: currentTime.now });
    } finally {
      db.close();
    }
  });

  it("preserves compiled mutation order at the typed client batch boundary", async () => {
    const first = compileD1Mutation(
      insert(schema.site_identities, { site_id: "first" }),
    );
    const second = compileD1Mutation(
      insert(schema.site_identities, { site_id: "second" }),
    );
    const batch = vi.fn(async () => [] as D1Result[]);
    const runtime = { batch } as unknown as DatabaseRuntime;
    await createDatabaseClient(runtime).batch([first, second]);
    expect(batch).toHaveBeenCalledExactlyOnceWith([first, second]);
  });

  it("dispatches typed reads and writes through the unchanged runtime", async () => {
    const result = {
      success: true,
      results: [{ email: "user@example.test" }],
    } as D1Result<{ email: string }>;
    const users = scan(schema.users);
    const query = compileD1Query(
      project(users, { email: users.columns.email }),
    );
    const mutation = compileD1Mutation(
      insert(schema.site_identities, { site_id: "site-a" }),
    );
    const runtime = {
      all: vi.fn(async () => result),
      first: vi.fn(async () => result.results[0] ?? null),
      run: vi.fn(async () => result),
      batch: vi.fn(async () => [result]),
      exec: vi.fn(),
    } as unknown as DatabaseRuntime;
    const client = createDatabaseClient(runtime);

    await expect(client.all(query)).resolves.toBe(result);
    await expect(client.first(query)).resolves.toBe(result.results[0]);
    await expect(client.run(mutation)).resolves.toBe(result);
    expect(runtime.all).toHaveBeenCalledExactlyOnceWith(query);
    expect(runtime.first).toHaveBeenCalledExactlyOnceWith(query);
    expect(runtime.run).toHaveBeenCalledExactlyOnceWith(mutation);
  });

  it("compiles multi-row and default-value inserts and rejects inconsistent rows", () => {
    const multiple = compileD1Mutation(
      insert(schema.site_identities, [
        { site_id: "site-a" },
        { site_id: "site-b" },
      ]),
    );
    expect(multiple.sql).toContain("VALUES (?), (?)");
    expect(multiple.bindings).toEqual(["site-a", "site-b"]);

    const defaults = compileD1Mutation(
      insert(schema.site_identities, {} as never),
    );
    expect(defaults.sql).toContain("DEFAULT VALUES");

    expect(() => insert(schema.site_identities, [] as never)).toThrowError();
    expect(() =>
      insert(schema.site_identities, [
        { site_id: "a" },
        { site_id: "b", site_pk: 2 },
      ] as never),
    ).toThrowError();
    expect(() =>
      insert(schema.site_identities, { site_id: "a", missing: "b" } as never),
    ).toThrowError();
  });

  it("rejects references that do not come from the generated catalog", () => {
    const forged = { ...schema.site_identities };
    expect(() =>
      compileD1Query(scan(forged as typeof schema.site_identities)),
    ).toThrowError(expect.objectContaining({ code: "invalid_plan" }));
  });
});
