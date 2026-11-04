import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  add,
  and,
  castReal,
  castText,
  compileD1Mutation,
  compileD1Query,
  constant,
  D1StatementBudgetError,
  deleteFrom,
  distinct,
  div,
  eq,
  filter,
  insertFromQuery,
  inSubquery,
  join,
  jsonScalarArray,
  limit,
  mul,
  param,
  project,
  recursiveClosure,
  scalar,
  scan,
  sort,
  sub,
  textLike,
  textPosition,
  textSubstring,
  union,
  valuesRelation,
} from "@/lib/db";
import { validateLogicalQueryPlan } from "@/lib/db/query/validator";
import { schema } from "@/lib/db/schema";

function database(): DatabaseSync {
  // `node:sqlite` provides an independent SQLite oracle for these SQL semantics.
  return new DatabaseSync(":memory:");
}

function all(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Record<string, unknown>[] {
  return db
    .prepare(query.sql)
    .all(...((query.bindings ?? []) as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
}

function allBigInts(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
): Record<string, unknown>[] {
  const statement = db.prepare(query.sql);
  statement.setReadBigInts(true);
  return statement.all(
    ...((query.bindings ?? []) as SQLInputValue[]),
  ) as Record<string, unknown>[];
}

const seed = valuesRelation({ seed: { affinity: "text", nullable: false } }, [
  { seed: "row" },
]);

describe("legacy scalar SQL primitives", () => {
  it("casts numeric values to REAL and retains correlated scope traversal", () => {
    const db = database();
    try {
      db.exec(
        "CREATE TABLE sites (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, domain TEXT NOT NULL, public_enabled INTEGER NOT NULL, public_slug TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      );
      db.exec(
        "INSERT INTO sites (id, team_id, name, domain, public_enabled, public_slug, created_at, updated_at) VALUES ('site-2', 'team', 'Two', 'two.test', 0, NULL, 2, 2), ('site-3', 'team', 'Three', 'three.test', 0, NULL, 3, 3)",
      );
      const outer = scan(schema.sites);
      const inner = scan(schema.sites);
      const matching = filter(
        inner,
        eq(
          castReal(inner.columns.created_at),
          castReal(outer.columns.created_at),
        ),
      );
      const correlated = scalar(
        project(matching, { value: matching.columns.created_at }),
      );
      const compiled = compileD1Query(
        project(outer, {
          id: outer.columns.id,
          outerValue: outer.columns.created_at,
          countRatio: div(castReal(param(1)), param(2)),
          durationRatio: div(castReal(param(5)), param(2)),
          zeroDenominator: div(castReal(param(1)), param(0)),
          nullNumerator: div(castReal(param(null)), param(2)),
          added: add(param(1), param(2)),
          subtracted: sub(param(5), param(2)),
          multiplied: mul(param(3), param(2)),
          correlated,
        }),
      );

      expect(compiled.sql).toContain("CAST(");
      expect(all(db, compiled)).toEqual([
        {
          id: "site-2",
          outerValue: 2,
          countRatio: 0.5,
          durationRatio: 2.5,
          zeroDenominator: null,
          nullNumerator: null,
          added: 3,
          subtracted: 3,
          multiplied: 6,
          correlated: 2,
        },
        {
          id: "site-3",
          outerValue: 3,
          countRatio: 0.5,
          durationRatio: 2.5,
          zeroDenominator: null,
          nullNumerator: null,
          added: 3,
          subtracted: 3,
          multiplied: 6,
          correlated: 3,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects text, boolean, and forged REAL cast metadata", () => {
    expect(() =>
      compileD1Query(project(seed, { value: castReal(param("2") as never) })),
    ).toThrow(/CAST AS REAL/u);
    expect(() =>
      compileD1Query(project(seed, { value: castReal(param(true) as never) })),
    ).toThrow(/CAST AS REAL/u);

    const wrongMetadata = {
      ...castReal(param(1)),
      resultType: { affinity: "integer", nullable: false },
    } as never;
    expect(() =>
      compileD1Query(project(seed, { value: wrongMetadata })),
    ).toThrow(/result metadata/u);
  });

  it("matches fixed SQLite CAST, INSTR, SUBSTR, and LIKE results", () => {
    const db = database();
    try {
      const compiled = compileD1Query(
        project(seed, {
          casted: castText(param(123)),
          position: textPosition(param("banana"), param("na")),
          slice: textSubstring(param("abcdef"), param(-3), param(-1)),
          like: textLike(param("a_X"), param("a!_%"), "!"),
          quoted: constant("O'Brien"),
          astral: constant("😀"),
          nullConstant: constant(null),
          negativeZero: constant(-0),
        }),
      );
      const expected = all(db, {
        sql: `SELECT CAST(123.0 AS TEXT) AS casted,
          INSTR('banana', 'na') AS position,
          SUBSTR('abcdef', -3, -1) AS slice,
          'a_X' LIKE 'a!_%' ESCAPE '!' AS like,
          'O''Brien' AS quoted,
          '😀' AS astral,
          NULL AS nullConstant,
          0 AS negativeZero`,
      });

      expect(all(db, compiled)).toEqual(expected);
      expect(compiled.sql).toContain("CAST(");
      expect(compiled.sql).toContain("INSTR(");
      expect(compiled.sql).toContain("SUBSTR(");
      expect(compiled.sql).toContain(" LIKE ");
      expect(compiled.sql).toContain(" ESCAPE ?");
      expect(compiled.sql).toContain("'O''Brien'");
    } finally {
      db.close();
    }
  });

  it("preserves NULL, empty, U+0020, NBSP, Unicode, and embedded-NUL SQLite behavior", () => {
    const db = database();
    try {
      const compiled = compileD1Query(
        project(seed, {
          nullPosition: textPosition(param(null), param("x")),
          nullStart: textSubstring(param("x"), param(null)),
          nullLike: textLike(param("x"), param(null)),
          emptyNeedle: textPosition(param("abc"), param("")),
          space: textPosition(param(" \u00a0"), param(" ")),
          nbsp: textPosition(param(" \u00a0"), param("\u00a0")),
          unicode: textPosition(param("x😀y"), param("😀")),
          nul: textPosition(param("a\0b"), param("\0")),
          emptySlice: textSubstring(param(""), param(1)),
        }),
      );
      const expected = all(db, {
        sql: `SELECT
          INSTR(?, ?) AS nullPosition,
          SUBSTR(?, ?) AS nullStart,
          ? LIKE ? AS nullLike,
          INSTR(?, ?) AS emptyNeedle,
          INSTR(?, ?) AS space,
          INSTR(?, ?) AS nbsp,
          INSTR(?, ?) AS unicode,
          INSTR(?, ?) AS nul,
          SUBSTR(?, ?) AS emptySlice`,
        bindings: [
          null,
          "x",
          "x",
          null,
          "x",
          null,
          "abc",
          "",
          " \u00a0",
          " ",
          " \u00a0",
          "\u00a0",
          "x😀y",
          "😀",
          "a\0b",
          "\0",
          "",
          1,
        ],
      });

      expect(all(db, compiled)).toEqual(expected);
      expect(expected[0]).toMatchObject({
        nullPosition: null,
        nullStart: null,
        nullLike: null,
        emptyNeedle: 1,
        space: 1,
        nbsp: 2,
        unicode: 2,
        nul: 2,
        emptySlice: "",
      });
    } finally {
      db.close();
    }
  });

  it("rejects incompatible or forged scalar expression metadata", () => {
    expect(() => textLike(param("x"), param("x"), "ab")).toThrow(
      /one non-NUL Unicode scalar/u,
    );
    expect(() => textLike(param("x"), param("x"), "\uD800")).toThrow(
      /one non-NUL Unicode scalar/u,
    );
    expect(() => constant("nul\0text")).toThrow(/constant\(\)/u);
    expect(() => constant("\uD800")).toThrow(/constant\(\)/u);
    expect(() => constant("\uDC00")).toThrow(/constant\(\)/u);
    expect(() => constant(1.25)).toThrow(/constant\(\)/u);
    expect(() => constant(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /constant\(\)/u,
    );
    expect(() =>
      compileD1Query(
        project(seed, {
          value: castText(param(new Uint8Array([1])) as never),
        }),
      ),
    ).toThrow(/CAST AS TEXT/u);
    expect(() =>
      compileD1Query(
        project(seed, {
          value: textPosition(param(1) as never, param("x")),
        }),
      ),
    ).toThrow(/INSTR/u);

    const invalidBooleanSource = castText(param(true) as never);
    expect(() =>
      compileD1Query(project(seed, { value: invalidBooleanSource })),
    ).toThrow(/CAST AS TEXT/u);

    const invalidStart = textSubstring(param("x"), param("1") as never);
    expect(() =>
      compileD1Query(project(seed, { value: invalidStart })),
    ).toThrow(/SUBSTR/u);

    const wrongMetadata = {
      ...castText(param("x")),
      resultType: { affinity: "blob", nullable: false },
    } as never;
    expect(() =>
      compileD1Query(project(seed, { value: wrongMetadata })),
    ).toThrow(/result metadata/u);

    const malformedArity = {
      kind: "text-substring",
      text: param("x"),
      resultType: { affinity: "text", nullable: false },
    } as never;
    expect(() =>
      compileD1Query(project(seed, { value: malformedArity })),
    ).toThrow(/expression is missing/u);

    const malformedSource = jsonScalarArray("text", ["x"]);
    const forged = {
      ...malformedSource.node,
      fields: [{ name: "value", affinity: "text", nullable: true }],
    } as never;
    expect(() => validateLogicalQueryPlan(forged)).toThrow(
      /JSON scalar array field metadata/u,
    );
    for (const invalidSource of [
      { ...malformedSource.node, valueKind: "blob" },
      { ...malformedSource.node, values: ["x"] },
      {
        ...malformedSource.node,
        valueKind: "numeric",
        values: Object.freeze(["x"]),
      },
      { ...malformedSource.node, fields: [] },
      { ...malformedSource.node, extra: true },
    ]) {
      expect(() => validateLogicalQueryPlan(invalidSource as never)).toThrow(
        /JSON scalar array/u,
      );
    }

    const deletion = compileD1Mutation(
      deleteFrom(schema.site_identities, (columns) =>
        textLike(columns.site_id, param("%site%")),
      ),
    );
    expect(deletion.sql).toContain("LIKE");
  });

  it("decodes copied homogeneous JSON scalar snapshots with bag semantics", () => {
    const db = database();
    try {
      const mutable = ["é", "same", "same", "", "\0", "\ud800"];
      const textValues = jsonScalarArray("text", mutable);
      mutable[0] = "changed";
      const compiledText = compileD1Query(textValues);
      expect(compiledText.sql).toContain("json_each(?)");
      expect(compiledText.sql).not.toContain("CAST(");
      expect(compiledText.bindings).toEqual([
        '["é","same","same","","\\u0000","\\ud800"]',
      ]);
      const oracleText = all(db, {
        sql: `SELECT value AS value FROM json_each('["é","same","same","","\\u0000","\\ud800"]')`,
      });
      expect(all(db, compiledText)).toEqual(oracleText);
      expect(all(db, compiledText).map((row) => row.value)).toContain("é");
      expect(all(db, compiledText).map((row) => row.value)).toContain("same");
      expect(all(db, compiledText).map((row) => row.value)).toContain("");

      const numericValues = jsonScalarArray("numeric", [
        1,
        1.5,
        -0,
        Number.MAX_SAFE_INTEGER + 1,
      ]);
      const compiledNumeric = compileD1Query(numericValues);
      const oracleNumeric = allBigInts(db, {
        sql: `SELECT value AS value FROM json_each('[1,1.5,0,9007199254740992]')`,
      });
      expect(compiledNumeric.bindings).toEqual(["[1,1.5,0,9007199254740992]"]);
      expect(allBigInts(db, compiledNumeric)).toEqual(oracleNumeric);
      expect(
        allBigInts(db, compiledNumeric).map((row) => typeof row.value),
      ).toEqual(["bigint", "number", "bigint", "bigint"]);

      const empty = compileD1Query(jsonScalarArray("text", []));
      expect(empty.bindings).toEqual([]);
      expect(all(db, empty)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects decorated, sparse, accessor, and non-scalar source arrays", () => {
    expect(() => jsonScalarArray("text", ["ok", true] as never)).toThrow(
      /homogeneous text scalars/u,
    );
    expect(() => jsonScalarArray("numeric", [1, "2"] as never)).toThrow(
      /homogeneous numeric scalars/u,
    );
    expect(() => jsonScalarArray("numeric", [Infinity])).toThrow(
      /homogeneous numeric scalars/u,
    );
    expect(() => jsonScalarArray("blob" as never, [])).toThrow(
      /text or numeric value kind/u,
    );

    const sparse = new Array<string>(2);
    sparse[1] = "x";
    expect(() => jsonScalarArray("text", sparse)).toThrow(/dense/u);
    const decorated = ["x"] as string[] & { extra?: string };
    decorated.extra = "no";
    expect(() => jsonScalarArray("text", decorated)).toThrow(/dense/u);
    const accessor = ["x"];
    Object.defineProperty(accessor, "0", {
      get: () => "accessed",
      enumerable: true,
    });
    expect(() => jsonScalarArray("text", accessor)).toThrow(/accessors/u);
  });

  it("splits greedily at complete UTF-8 JSON scalar boundaries", () => {
    const first = "é".repeat(499_998);
    const second = "x";
    const compiled = compileD1Query(jsonScalarArray("text", [first, second]));
    const segments = compiled.bindings as string[];

    expect(segments).toHaveLength(2);
    expect(new TextEncoder().encode(segments[0]!).byteLength).toBe(1_000_000);
    expect(segments[0]!.startsWith('["')).toBe(true);
    expect(segments[0]!.endsWith('"]')).toBe(true);
    expect(segments[1]).toBe('["x"]');
    expect(JSON.parse(segments[0]!)).toEqual([first]);
    expect(JSON.parse(segments[1]!)).toEqual([second]);
    expect(() =>
      compileD1Query(jsonScalarArray("text", ["é".repeat(500_000)])),
    ).toThrow(/per-segment encoding limit/u);
  });

  it("traverses JSON sources through subqueries, CTE sharing, recursive closure, and INSERT SELECT", () => {
    const db = database();
    try {
      const source = jsonScalarArray("text", ["keep", "skip"]);
      const matched = project(source, { value: source.columns.value });
      const membership = compileD1Query(
        project(seed, {
          found: inSubquery(param("keep"), matched),
        }),
      );
      expect(membership.sql).toContain("json_each(?)");
      expect(all(db, membership)).toEqual([{ found: 1 }]);

      const filtered = filter(
        source,
        and(
          eq(source.columns.value, param("keep")),
          eq(castText(source.columns.value), param("keep")),
          eq(textPosition(source.columns.value, param("e")), param(2)),
          eq(
            textSubstring(source.columns.value, param(1), param(4)),
            param("keep"),
          ),
          textLike(source.columns.value, param("%keep%")),
        ),
      );
      const shared = compileD1Query(union(filtered, filtered, true));
      expect(shared.sql).toContain("WITH ");
      expect(shared.bindings).toContain('["keep","skip"]');
      expect(shared.bindings).toContain("%keep%");
      expect(all(db, shared)).toEqual([{ value: "keep" }, { value: "keep" }]);

      const candidateSource = jsonScalarArray("text", ["next"]);
      const candidates = project(candidateSource, {
        nodeId: candidateSource.columns.value,
      });
      const closureSeed = valuesRelation(
        { nodeId: { affinity: "text", nullable: false } },
        [{ nodeId: "seed" }],
      );
      const closure = recursiveClosure(
        closureSeed,
        candidates,
        (current, candidate) =>
          and(
            eq(current.nodeId, candidate.nodeId),
            eq(castText(current.nodeId), param("seed")),
            eq(textPosition(current.nodeId, candidate.nodeId), param(0)),
            eq(textSubstring(current.nodeId, param(1)), param("seed")),
            eq(
              textSubstring(current.nodeId, param(1), param(1)),
              param("seed"),
            ),
            textLike(candidate.nodeId, param("%")),
          ),
      );
      const closureQuery = compileD1Query(closure);
      expect(closureQuery.sql).toContain("WITH RECURSIVE");
      expect(closureQuery.sql).toContain("json_each(?)");
      expect(closureQuery.bindings).toContain('["next"]');

      const leftRows = valuesRelation(
        { value: { affinity: "text", nullable: false } },
        [{ value: "keep" }, { value: "skip" }],
      );
      const rightRows = jsonScalarArray("text", ["keep", "other"]);
      const joined = join(
        leftRows,
        rightRows,
        eq(leftRows.columns.value, rightRows.columns.value),
      );
      const joinQuery = compileD1Query(
        project(joined, {
          left: joined.columns.left_value,
          right: joined.columns.right_value,
        }),
      );
      expect(all(db, joinQuery)).toEqual([{ left: "keep", right: "keep" }]);

      const distinctRows = distinct(
        jsonScalarArray("text", ["skip", "keep", "keep"]),
      );
      const orderedDistinct = sort(distinctRows, [
        { expression: distinctRows.columns.value, direction: "ASC" },
      ]);
      const pagedQuery = compileD1Query(limit(orderedDistinct, 1, 1));
      expect(all(db, pagedQuery)).toEqual([{ value: "skip" }]);

      const insert = compileD1Mutation(
        insertFromQuery(
          schema.site_identities,
          ["site_pk"],
          jsonScalarArray("numeric", [7]),
        ),
      );
      expect(insert.sql).toContain("json_each(?)");
      expect(insert.bindings).toEqual(["[7]"]);
    } finally {
      db.close();
    }
  });

  it("keeps A/B/A inputs as bindings, and enforces final binding and SQL budgets", () => {
    const first = compileD1Query(jsonScalarArray("text", ["A"]));
    const second = compileD1Query(jsonScalarArray("text", ["B"]));
    const third = compileD1Query(jsonScalarArray("text", ["A"]));
    expect(first.sql).toBe(second.sql);
    expect(first.sql).toBe(third.sql);
    expect(first.bindings).toEqual(['["A"]']);
    expect(second.bindings).toEqual(['["B"]']);
    expect(third.bindings).toEqual(first.bindings);
    expect(first.physicalPlanShape).toEqual(second.physicalPlanShape);
    expect(first.physicalPlanShape).toEqual(third.physicalPlanShape);

    let many = jsonScalarArray("text", ["x"]);
    for (let index = 0; index < 100; index++)
      many = union(many, jsonScalarArray("text", [`x-${index}`]), true);
    expect(() => compileD1Query(many)).toThrow(D1StatementBudgetError);

    let repeatedPrimitive = jsonScalarArray("text", ["duplicate"]);
    for (let index = 0; index < 100; index++)
      repeatedPrimitive = union(
        repeatedPrimitive,
        jsonScalarArray("text", ["duplicate"]),
        true,
      );
    const duplicatePrimitive = compileD1Query(repeatedPrimitive);
    expect(duplicatePrimitive.bindings).toEqual(['["duplicate"]']);
    const db = database();
    try {
      expect(all(db, duplicatePrimitive)).toEqual(
        Array.from({ length: 101 }, () => ({ value: "duplicate" })),
      );
    } finally {
      db.close();
    }

    expect(() =>
      compileD1Query(
        project(seed, { oversized: constant("x".repeat(100_100)) }),
      ),
    ).toThrow(D1StatementBudgetError);
  });
});
