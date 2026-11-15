import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  aggregate,
  and,
  avg,
  callFunction,
  caseWhen,
  compileD1Query,
  constant,
  count,
  distinct,
  eq,
  filter,
  gt,
  join,
  limit,
  lowerLogicalPlan,
  lt,
  max,
  min,
  or,
  param,
  project,
  rowNumber,
  scan,
  semiJoin,
  sort,
  sum,
  union,
  window,
} from "@/lib/db";
import { compileD1QueryTupleMembershipFallbackForTest as unconstrained } from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import { hasExposedCatalogIndexedLookup } from "@/lib/db/query/physical/catalog-indexed-lookup";
import { semiMembershipComparisonDomain } from "@/lib/db/query/physical/comparison-domains";
import { computedMembershipLookupStrategy } from "@/lib/db/query/physical/computed-membership-lookup";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type { SchemaTableReference } from "@/lib/db/schema/types";

type TestRelation = Relation<
  Record<string, unknown>,
  Readonly<Record<string, AnyExpression>>
>;

const registeredTables = new Set<string>();

function source(
  name = "computed_membership",
  collation: "BINARY" | "unknown" = "BINARY",
  memberAffinity: "text" | "integer" = "text",
  compositeUnique = false,
  extraIndex?: SchemaTableReference["indexes"][number],
  valueAffinity?: "integer" | "text" | "real",
): TestRelation {
  const column = (
    sqlName: string,
    affinity: "text" | "integer" | "real",
    nullable: boolean,
  ) => ({
    kind: "column" as const,
    table: name,
    sqlName,
    propertyName: sqlName,
    declaredType: affinity.toUpperCase(),
    affinity,
    nullable,
    primaryKeyPosition: sqlName === "id" ? 1 : 0,
    ...(sqlName === "id" ? { rowidAlias: true as const } : {}),
    defaultSql: null,
    hidden: 0,
    generated: false,
  });
  const table: SchemaTableReference = {
    kind: "table",
    name,
    defaultCollation: collation,
    columns: {
      id: column("id", "integer", false),
      site: column("site", "text", false),
      member: column("member", memberAffinity, true),
      ...(valueAffinity
        ? { value: column("value", valueAffinity, false) }
        : {}),
    },
    primaryKey: ["id"],
    indexes: [
      ...(compositeUnique
        ? [
            {
              name: "computed_site_member_unique",
              unique: true,
              partial: false,
              columns: ["site", "member"],
            },
          ]
        : []),
      ...(extraIndex ? [extraIndex] : []),
    ],
    foreignKeys: [],
  };
  (schema as unknown as Record<string, unknown>)[name] = table;
  registeredTables.add(name);
  return scan(
    table as unknown as typeof schema.site_identities,
  ) as TestRelation;
}

function col(relation: TestRelation, name: string) {
  return relation.columns[name] as never;
}

function keys(relation: TestRelation): TestRelation {
  return project(relation, {
    site: col(relation, "site"),
    member: col(relation, "member"),
  }) as TestRelation;
}

function membership(left: TestRelation, right: TestRelation): TestRelation {
  const joined = join(
    left,
    right,
    and(
      // Reverse key order to verify complete-key correspondence is respected.
      eq(col(left, "member"), col(right, "member")),
      eq(col(left, "site"), col(right, "site")),
    ),
  );
  return project(
    joined,
    Object.fromEntries(
      left.fields.map(({ name }) => [name, joined.columns[`left_${name}`]!]),
    ),
  ) as TestRelation;
}

function compound(first: TestRelation, second = first): TestRelation {
  return distinct(union(keys(first), keys(second))) as TestRelation;
}

function rows(
  db: DatabaseSync,
  query: { readonly sql: string; readonly bindings?: readonly unknown[] },
) {
  const statement = db.prepare(query.sql);
  statement.setReadBigInts(true);
  return statement
    .all(...((query.bindings ?? []) as never[]))
    .sort((a, b) =>
      JSON.stringify(a, (_key, value) =>
        typeof value === "bigint" ? `bigint:${value}` : value,
      ).localeCompare(
        JSON.stringify(b, (_key, value) =>
          typeof value === "bigint" ? `bigint:${value}` : value,
        ),
      ),
    );
}

describe("computed membership indexed lookup", () => {
  afterEach(() => {
    for (const name of registeredTables) Reflect.deleteProperty(schema, name);
    registeredTables.clear();
  });

  it("builds complete same-site membership once while preserving left duplicates, NULL, BLOB and NUL", () => {
    const base = source();
    const left = union(base, base, true) as TestRelation;
    const first = filter(base, lt(col(base, "id"), param(3))) as TestRelation;
    const second = filter(base, gt(col(base, "id"), param(4))) as TestRelation;
    const result = membership(left, compound(first, second));
    const physical = lowerLogicalPlan(result);
    expect(physical.joinOrderStrategies).toHaveLength(1);
    expect(physical.joinOrderStrategies[0]).toMatchObject({
      kind: "computed-key-lookup",
      driver: "preserve",
    });
    const optimized = compileD1Query(physical);
    const fallback = unconstrained(physical);
    expect(optimized.sql).toContain(" GROUP BY ");
    expect(fallback.sql).not.toContain(" GROUP BY ");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT)",
      );
      const insert = db.prepare(
        "INSERT INTO computed_membership VALUES(?, ?, ?)",
      );
      for (const [id, site, member] of [
        [1, "a", "same"],
        [2, "a", "same"],
        [3, "b", "same"],
        [4, "a", null],
        [5, "a", "nul\u0000tail"],
        [6, "a", new Uint8Array([0, 1, 255])],
        [7, "a", " same "],
        [8, "a", "SAME"],
      ] as const)
        insert.run(id, site, member);
      const actual = rows(db, optimized);
      expect(actual).toEqual(rows(db, fallback));
      expect(actual).toHaveLength(12);
      expect(
        actual.some((row) => row.site === "b" || row.member === null),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("preserves historical INTEGER storage and distinct numeric/text representatives", () => {
    const base = source("computed_membership", "BINARY", "integer");
    const result = membership(
      union(base, base, true) as TestRelation,
      compound(base),
    );
    const physical = lowerLogicalPlan(result);
    expect(physical.joinOrderStrategies).toHaveLength(1);
    // This historical-storage fixture deliberately rewrites sqlite_schema.
    const db = new DatabaseSync(":memory:", { defensive: false });
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member BLOB)",
      );
      const insert = db.prepare(
        "INSERT INTO computed_membership VALUES(?, 'a', ?)",
      );
      const values = [
        1.0,
        1.5,
        "01",
        "1",
        "1x",
        new Uint8Array([49]),
        null,
        9223372036854775807n,
        "9223372036854775807",
        "9007199254740993",
        9007199254740992,
      ];
      values.forEach((value, index) => insert.run(index + 1, value));
      db.exec(
        "PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql=replace(sql, 'member BLOB', 'member INTEGER') WHERE name='computed_membership'; PRAGMA schema_version=99; PRAGMA writable_schema=OFF",
      );
      const baseline = rows(db, unconstrained(physical));
      const optimized = rows(db, compileD1Query(physical));
      expect(optimized).toEqual(baseline);
      // The GROUP wrapper keeps the exact representatives already selected by
      // DISTINCT, including historical REAL/TEXT/BLOB values in INTEGER columns.
      expect(optimized).toHaveLength(18);
      expect(optimized.some((row) => row.member === "01")).toBe(true);
      expect(optimized.some((row) => row.member instanceof Uint8Array)).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });

  it("preserves NOCASE representatives and existing left ordering/selection", () => {
    const base = source("computed_membership", "unknown");
    const result = membership(base, compound(base));
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT COLLATE NOCASE); INSERT INTO computed_membership VALUES(1,'a','same'),(2,'a','SAME'),(3,'a',NULL),(4,'b','same')",
      );
      expect(rows(db, compileD1Query(result))).toEqual(
        rows(db, unconstrained(result)),
      );
      const selected = limit(
        sort(result, [{ expression: col(result, "id"), direction: "DESC" }]),
        1,
      );
      expect(lowerLogicalPlan(selected).joinOrderStrategies).toHaveLength(0);
      expect(
        lowerLogicalPlan(limit(distinct(result), 1)).joinOrderStrategies,
      ).toHaveLength(0);
      expect(rows(db, compileD1Query(selected))).toEqual(
        rows(db, unconstrained(selected)),
      );
    } finally {
      db.close();
    }
  });

  it("fences a closed computed semi membership without UNION and keeps ordinary DISTINCT unchanged", () => {
    const base = source("computed_membership", "unknown");
    const other = source("computed_other", "unknown");
    const qualified = semiJoin(
      base,
      other,
      eq(col(base, "member"), col(other, "member")),
    ) as TestRelation;
    const result = membership(base, distinct(keys(qualified)) as TestRelation);
    expect(lowerLogicalPlan(result).joinOrderStrategies).toHaveLength(1);
    const sql = compileD1Query(result);
    expect(sql.sql).toContain(" GROUP BY ");
    expect(sql.sql).not.toContain("UNION");
    const ordinary = membership(base, distinct(keys(base)) as TestRelation);
    expect(lowerLogicalPlan(ordinary).joinOrderStrategies).toHaveLength(0);
    const partial = filter(
      qualified,
      gt(callFunction("abs", col(qualified, "id")), param(0)),
    ) as TestRelation;
    expect(
      lowerLogicalPlan(
        membership(base, distinct(keys(partial)) as TestRelation),
      ).joinOrderStrategies,
    ).toHaveLength(0);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT); CREATE TABLE computed_other(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT); INSERT INTO computed_membership VALUES(1,'a','same'),(2,'b','same'),(3,'a',NULL),(4,'a','other'); INSERT INTO computed_other VALUES(1,'a','same'),(2,'a',NULL)",
      );
      expect(rows(db, sql)).toEqual(rows(db, unconstrained(result)));
      expect(rows(db, sql)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("keeps empty compound membership empty", () => {
    const base = source();
    const empty = filter(base, lt(col(base, "id"), param(0))) as TestRelation;
    const result = membership(base, compound(empty));
    expect(lowerLogicalPlan(result).joinOrderStrategies).toHaveLength(1);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT); INSERT INTO computed_membership VALUES(1,'a','same')",
      );
      expect(rows(db, compileD1Query(result))).toEqual([]);
      expect(rows(db, unconstrained(result))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("retains multiplication for a raw duplicate right bag", () => {
    const base = source();
    const right = union(keys(base), keys(base), true) as TestRelation;
    const result = membership(base, right);
    expect(lowerLogicalPlan(result).joinOrderStrategies).toHaveLength(0);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT); INSERT INTO computed_membership VALUES(1,'a','same'),(2,'a','same')",
      );
      expect(rows(db, compileD1Query(result))).toHaveLength(8);
    } finally {
      db.close();
    }
  });

  it("rejects partial equality keys and projections that retain right outputs", () => {
    const base = source();
    const right = compound(base);
    const partial = join(
      base,
      right,
      eq(col(base, "member"), col(right, "member")),
    );
    const partialResult = project(
      partial,
      Object.fromEntries(
        base.fields.map(({ name }) => [name, partial.columns[`left_${name}`]!]),
      ),
    );
    expect(lowerLogicalPlan(partialResult).joinOrderStrategies).toHaveLength(0);
    const joined = join(
      base,
      right,
      and(
        eq(col(base, "site"), col(right, "site")),
        eq(col(base, "member"), col(right, "member")),
      ),
    );
    expect(
      lowerLogicalPlan(
        project(joined, {
          id: joined.columns.left_id,
          rightMember: joined.columns.right_member,
        }),
      ).joinOrderStrategies,
    ).toHaveLength(0);
  });

  it("preserves catalog composite point lookups through pure projection/filter and unique INNER lookups", () => {
    const base = source("computed_membership", "BINARY", "text", true);
    const lookup = source("computed_lookup");
    const right = compound(base);
    const filtered = filter(
      base,
      gt(col(base, "id"), param(0)),
    ) as TestRelation;
    expect(
      lowerLogicalPlan(membership(filtered, right)).joinOrderStrategies,
    ).toHaveLength(0);
    const extend = (type: "inner" | "left") => {
      const joined = join(
        filtered,
        lookup,
        eq(col(filtered, "id"), col(lookup, "id")),
        type,
      );
      return project(
        joined,
        Object.fromEntries(
          base.fields.map(({ name }) => [
            name,
            joined.columns[`left_${name}`]!,
          ]),
        ),
      ) as TestRelation;
    };
    expect(
      lowerLogicalPlan(membership(extend("inner"), right)).joinOrderStrategies,
    ).toHaveLength(0);
    const preserved = membership(extend("left"), right);
    // Access belongs to the preserved catalog side; a DISTINCT consumer can
    // still make SQLite abandon that seek and needs the computed barrier.
    expect(lowerLogicalPlan(preserved).joinOrderStrategies).toHaveLength(0);
    expect(
      lowerLogicalPlan(distinct(preserved)).joinOrderStrategies,
    ).toHaveLength(1);
    // A shared node must retain the barrier if any consumer regroups it.
    expect(
      lowerLogicalPlan(union(preserved, distinct(preserved), true))
        .joinOrderStrategies,
    ).toHaveLength(1);
    expect(
      lowerLogicalPlan(
        distinct(
          aggregate(preserved, { groupBy: {}, aggregates: { rows: count() } }),
        ),
      ).joinOrderStrategies,
    ).toHaveLength(0);
    const missingCompositePart = project(base, {
      site: col(base, "site"),
      member: col(base, "id"),
    }) as TestRelation;
    const mapped = membership(
      missingCompositePart,
      compound(missingCompositePart),
    );
    expect(lowerLogicalPlan(mapped).joinOrderStrategies).toHaveLength(0); // id remains a complete catalog PK.
  });

  it("maps only direct catalog key lineage through LEFT joins without claiming joined uniqueness", () => {
    const base = source();
    const lookup = source("computed_lookup");
    const joined = join(
      base,
      lookup,
      eq(col(base, "site"), col(lookup, "site")),
      "left",
    );
    const preserved = project(joined, {
      site: joined.columns.left_site,
      member: joined.columns.left_id,
      computed: callFunction(
        "lower",
        col(joined as TestRelation, "right_member"),
      ),
    }) as TestRelation;
    const result = membership(preserved, compound(preserved));
    expect(lowerLogicalPlan(result).joinOrderStrategies).toHaveLength(0);
    expect(lowerLogicalPlan(distinct(result)).joinOrderStrategies).toHaveLength(
      0,
    ); // The computed payload has no DISTINCT representative certificate.
    if (result.node.kind !== "project") throw Error("expected_project");
    expect(
      computedMembershipLookupStrategy(result.node, new Map()),
    ).toBeDefined();
    expect(
      hasExposedCatalogIndexedLookup(preserved, [0, 1], new Set(), true),
    ).toBe(true);
    expect(
      hasExposedCatalogIndexedLookup(preserved, [0, 1], new Set(), false),
    ).toBe(false);
    expect(
      hasExposedCatalogIndexedLookup(
        preserved,
        [0, 1],
        new Set([preserved.node]),
        true,
      ),
    ).toBe(false);
    const rightKey = project(joined, {
      site: joined.columns.left_site,
      member: joined.columns.right_id,
    }) as TestRelation;
    expect(
      lowerLogicalPlan(membership(rightKey, compound(rightKey)))
        .joinOrderStrategies,
    ).toHaveLength(1);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT); CREATE TABLE computed_lookup(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT); INSERT INTO computed_membership VALUES(1,'a','one'),(2,'b',NULL); INSERT INTO computed_lookup VALUES(1,'a','x'),(2,'a','y')",
      );
      expect(rows(db, compileD1Query(result))).toEqual(
        rows(db, unconstrained(result)),
      );
      expect(rows(db, compileD1Query(result))).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("retains indexed membership for scalar COUNT and BINARY text grouping", () => {
    const base = source();
    const selected = membership(base, compound(base));
    expect(
      lowerLogicalPlan(
        aggregate(selected, { groupBy: {}, aggregates: { n: count() } }),
      ).joinOrderStrategies,
    ).toHaveLength(1);
    expect(
      lowerLogicalPlan(
        aggregate(selected, {
          groupBy: { site: col(selected, "site") },
          aggregates: { n: count() },
        }),
      ).joinOrderStrategies,
    ).toHaveLength(1);
  });

  it("allows mixed numeric representatives only when aligned DISTINCT unions end in COUNTstar", () => {
    const base = source(
      "computed_values",
      "BINARY",
      "text",
      false,
      undefined,
      "integer",
    );
    const left = union(
      base,
      filter(base, lt(col(base, "id"), param(0))),
      true,
    ) as TestRelation;
    const selected = membership(left, compound(base));
    const values = distinct(
      project(selected, { value: col(selected, "value") }),
    ) as TestRelation;
    const combined = union(
      values,
      project(base, { value: col(base, "value") }),
    ) as TestRelation;
    const counted = aggregate(combined, {
      groupBy: {},
      aggregates: { n: count() },
    });
    const observed = project(combined, {
      storage: callFunction("storage-class", col(combined, "value")),
    });
    expect(lowerLogicalPlan(counted).joinOrderStrategies).toHaveLength(1);
    expect(lowerLogicalPlan(observed).joinOrderStrategies).toHaveLength(0);
    // This historical-storage fixture deliberately rewrites sqlite_schema.
    const db = new DatabaseSync(":memory:", { defensive: false });
    try {
      db.exec(
        "CREATE TABLE computed_values(id INTEGER PRIMARY KEY,site TEXT NOT NULL,member TEXT,value BLOB NOT NULL); INSERT INTO computed_values VALUES(1,'s','c',1.0),(2,'s','a',1),(3,'s','b',2); PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql=replace(sql,'value BLOB','value INTEGER') WHERE name='computed_values'; PRAGMA schema_version=99; PRAGMA writable_schema=OFF",
      );
      expect(rows(db, compileD1Query(counted))).toEqual(
        rows(db, unconstrained(counted)),
      );
      expect(rows(db, compileD1Query(counted))).toEqual([{ n: 2n }]);
      expect(rows(db, compileD1Query(observed))).toEqual(
        rows(db, unconstrained(observed)),
      );
    } finally {
      db.close();
    }
  });

  it("retains the lookup when a numeric MIN representative is observed only as a fixed bucket", () => {
    const base = source(
      "computed_values",
      "BINARY",
      "text",
      false,
      undefined,
      "integer",
    );
    const left = union(
      base,
      filter(base, lt(col(base, "id"), param(0))),
      true,
    ) as TestRelation;
    const selected = membership(left, compound(base));
    const minimum = aggregate(selected, {
      groupBy: {},
      aggregates: { value: min(col(selected, "value")) },
    }) as TestRelation;
    const bucket = project(minimum, {
      bucket: caseWhen(
        [{ when: lt(col(minimum, "value"), constant(2)), then: constant(0) }],
        constant(1),
      ),
    });
    expect(lowerLogicalPlan(bucket).joinOrderStrategies).toHaveLength(1);
    // This historical-storage fixture deliberately rewrites sqlite_schema.
    const db = new DatabaseSync(":memory:", { defensive: false });
    try {
      db.exec(
        "CREATE TABLE computed_values(id INTEGER PRIMARY KEY,site TEXT NOT NULL,member TEXT,value BLOB NOT NULL); INSERT INTO computed_values VALUES(1,'s','c',1.0),(2,'s','a',1),(3,'s','b',2); PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql=replace(sql,'value BLOB','value INTEGER') WHERE name='computed_values'; PRAGMA schema_version=99; PRAGMA writable_schema=OFF",
      );
      expect(rows(db, compileD1Query(bucket))).toEqual(
        rows(db, unconstrained(bucket)),
      );
      expect(rows(db, compileD1Query(bucket))).toEqual([{ bucket: 0n }]);
    } finally {
      db.close();
    }
  });

  it("keeps observable aggregate errors and DISTINCT representatives on the original join", () => {
    for (const mode of [
      "overflow",
      "real-sum",
      "avg",
      "min-text",
      "max-text",
      "group-text",
      "distinct-text",
      "min-storage",
      "max-storage",
      "distinct-storage",
    ] as const) {
      const text = mode.endsWith("text");
      const real = mode === "real-sum" || mode === "avg";
      const base = source(
        "computed_values",
        "unknown",
        "text",
        false,
        undefined,
        text ? "text" : real ? "real" : "integer",
      );
      const lookup = source("computed_lookup");
      const left = union(
        base,
        filter(base, lt(col(base, "id"), param(0))),
        true,
      ) as TestRelation;
      const qualified = semiJoin(
        base,
        lookup,
        eq(col(base, "member"), col(lookup, "member")),
      ) as TestRelation;
      const selected = membership(
        left,
        distinct(keys(qualified)) as TestRelation,
      );
      let result: TestRelation;
      if (mode.startsWith("distinct"))
        result = distinct(
          project(selected, { value: col(selected, "value") }),
        ) as TestRelation;
      else if (mode === "group-text")
        result = aggregate(selected, {
          groupBy: { value: col(selected, "value") },
          aggregates: { total: count() },
        }) as TestRelation;
      else
        result = aggregate(selected, {
          groupBy: {},
          aggregates: {
            value: mode.startsWith("min")
              ? min(col(selected, "value"))
              : mode.startsWith("max")
                ? max(col(selected, "value"))
                : mode === "avg"
                  ? avg(col(selected, "value"))
                  : sum(col(selected, "value")),
          },
        }) as TestRelation;
      if (mode.endsWith("storage"))
        result = project(result, {
          storage: callFunction("storage-class", col(result, "value")),
        }) as TestRelation;
      expect(lowerLogicalPlan(result).joinOrderStrategies, mode).toHaveLength(
        0,
      );
      // Only these historical-storage controls rewrite sqlite_schema.
      const db = new DatabaseSync(
        ":memory:",
        mode.endsWith("storage") ? { defensive: false } : {},
      );
      try {
        const type = text
          ? "TEXT COLLATE NOCASE"
          : real
            ? "REAL"
            : mode.endsWith("storage")
              ? "BLOB"
              : "INTEGER";
        db.exec(
          `CREATE TABLE computed_values(id INTEGER PRIMARY KEY,site TEXT NOT NULL,member TEXT,value ${type} NOT NULL); CREATE TABLE computed_lookup(id INTEGER PRIMARY KEY,site TEXT NOT NULL,member TEXT)`,
        );
        const values =
          mode === "overflow"
            ? [-9223372036854775807n, 9223372036854775807n, 1n]
            : mode === "max-text"
              ? ["z", "Z", "a"]
              : text
                ? ["a", "A", "z"]
                : real
                  ? [-1e308, 1e308, 1e308]
                  : [1, 1n, mode.startsWith("min") ? 2n : 0n];
        const insert = db.prepare(
          "INSERT INTO computed_values VALUES(?,?,?,?)",
        );
        for (const [index, member] of ["c", "a", "b"].entries())
          insert.run(index + 1, "s", member, values[index]!);
        db.exec(
          "INSERT INTO computed_lookup SELECT id,site,member FROM computed_values",
        );
        if (mode.endsWith("storage"))
          db.exec(
            "PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql=replace(sql,'value BLOB','value INTEGER') WHERE name='computed_values'; PRAGMA schema_version=99; PRAGMA writable_schema=OFF",
          );
        expect(rows(db, compileD1Query(result)), mode).toEqual(
          rows(db, unconstrained(result)),
        );
        if (mode === "overflow")
          expect(rows(db, compileD1Query(result))).toEqual([{ value: 1n }]);
        if (mode === "real-sum")
          expect(rows(db, compileD1Query(result))).toEqual([{ value: 1e308 }]);
      } finally {
        db.close();
      }
    }
  });

  it("keeps complete nonunique leading-prefix seeks, including same-site duplicates, without accepting partial or expression indexes", () => {
    const baseIndex = {
      name: "computed_prefix",
      unique: false,
      partial: false,
      columns: ["site", "member", "id"],
    };
    const ordinary = source(
      "computed_membership",
      "BINARY",
      "text",
      false,
      baseIndex,
    );
    const right = compound(ordinary);
    expect(
      lowerLogicalPlan(membership(ordinary, right)).joinOrderStrategies,
    ).toHaveLength(0);
    const reversed = source("computed_reverse", "BINARY", "text", false, {
      ...baseIndex,
      columns: ["member", "site", "id"],
    });
    expect(
      lowerLogicalPlan(membership(reversed, compound(reversed)))
        .joinOrderStrategies,
    ).toHaveLength(0);
    for (const [name, index] of [
      ["computed_gap", { ...baseIndex, columns: ["site", "id", "member"] }],
      ["computed_partial", { ...baseIndex, partial: true }],
      [
        "computed_expression",
        { ...baseIndex, rawExpressionSql: "lower(member)" },
      ],
    ] as const) {
      const input = source(name, "BINARY", "text", false, index);
      expect(
        lowerLogicalPlan(membership(input, compound(input)))
          .joinOrderStrategies,
      ).toHaveLength(1);
    }
    expect(hasExposedCatalogIndexedLookup(ordinary, [2], new Set())).toBe(
      false,
    );
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT); CREATE INDEX computed_prefix ON computed_membership(site,member,id); INSERT INTO computed_membership VALUES(1,'a','same'),(2,'a','same'),(3,'b','same'),(4,'a',NULL)",
      );
      const result = membership(ordinary, right);
      expect(rows(db, compileD1Query(result))).toEqual(
        rows(db, unconstrained(result)),
      );
      expect(rows(db, compileD1Query(result))).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("rejects LEFT JOIN and non-strict or disjunctive conditions", () => {
    const base = source();
    const right = compound(base);
    for (const joined of [
      join(
        base,
        right,
        or(
          eq(col(base, "member"), col(right, "member")),
          eq(col(base, "site"), col(right, "site")),
        ),
      ),
      join(
        base,
        right,
        and(
          eq(col(base, "member"), col(right, "member")),
          eq(col(base, "site"), col(right, "site")),
        ),
        "left",
      ),
      join(
        base,
        right,
        and(
          gt(col(base, "member"), col(right, "member")),
          eq(col(base, "site"), col(right, "site")),
        ),
      ),
    ]) {
      const result = project(
        joined,
        Object.fromEntries(
          base.fields.map(({ name }) => [
            name,
            joined.columns[`left_${name}`]!,
          ]),
        ),
      );
      expect(lowerLogicalPlan(result).joinOrderStrategies).toHaveLength(0);
    }
  });

  it("preserves unknown collation and rejects invalid comparison affinities", () => {
    const binary = source();
    const unknown = source("computed_unknown", "unknown");
    const integers = source("computed_integer", "BINARY", "integer");
    expect(
      lowerLogicalPlan(membership(binary, compound(unknown)))
        .joinOrderStrategies,
    ).toHaveLength(1);
    const incompatible = membership(binary, compound(integers));
    if (incompatible.node.kind !== "project") throw Error("expected_project");
    expect(() => lowerLogicalPlan(incompatible)).toThrow(
      /incompatible SQL affinities/u,
    );
  });

  it("preserves mixed compound collation while keeping strict IN domain guards", () => {
    const base = source();
    const unknown = source("computed_unknown", "unknown");
    const nonbinary = compound(base, unknown);
    expect(
      lowerLogicalPlan(membership(base, nonbinary)).joinOrderStrategies,
    ).toHaveLength(1);
    const textKeys = keys(base);
    const integerKeys = project(base, {
      site: col(base, "site"),
      member: col(base, "id"),
    });
    // Exercise the domain analyzer with deliberately mismatched compound metadata.
    const malformed = {
      ...textKeys,
      node: {
        kind: "union" as const,
        all: false,
        left: {
          node: textKeys.node,
          scope: textKeys.scope,
          fields: textKeys.fields,
        },
        right: {
          node: integerKeys.node,
          scope: integerKeys.scope,
          fields: integerKeys.fields,
        },
        scope: textKeys.scope,
        fields: textKeys.fields,
      },
    };
    expect(semiMembershipComparisonDomain(malformed, 1).kind).toBe("rejected");
    const malformedMembership = membership(
      base,
      distinct(malformed) as TestRelation,
    );
    if (malformedMembership.node.kind !== "project")
      throw Error("expected_project");
    expect(
      computedMembershipLookupStrategy(malformedMembership.node, new Map()),
    ).toBeUndefined();
  });

  it("keeps selection barriers and partial-expression errors behind the original inner join", () => {
    const base = source();
    const limited = limit(base, 1) as TestRelation;
    const ordered = sort(base, [
      { expression: col(base, "id"), direction: "ASC" },
    ]) as TestRelation;
    const ranked = window(base, {
      rank: rowNumber({
        partitionBy: [col(base, "site")],
        orderBy: [{ expression: col(base, "id"), direction: "ASC" }],
      }),
    }) as TestRelation;
    const partial = filter(
      base,
      gt(callFunction("abs", col(base, "id")), param(0)),
    ) as TestRelation;
    for (const right of [
      compound(limited),
      compound(ordered),
      compound(ranked),
      compound(partial),
    ]) {
      const result = membership(base, right);
      expect(lowerLogicalPlan(result).joinOrderStrategies).toHaveLength(0);
      expect(compileD1Query(result).sql).not.toContain(" IN (SELECT ");
    }
    expect(
      lowerLogicalPlan(membership(limited, compound(base))).joinOrderStrategies,
    ).toHaveLength(0);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE computed_membership(id INTEGER PRIMARY KEY, site TEXT NOT NULL, member TEXT); INSERT INTO computed_membership VALUES(-9223372036854775808,'a','same')",
      );
      const result = membership(base, compound(partial));
      for (const query of [compileD1Query(result), unconstrained(result)])
        expect(() => rows(db, query)).toThrow(/integer overflow/u);
    } finally {
      db.close();
    }
  });

  it("refuses input predicates that reference an external scope", () => {
    const base = source();
    const external = source("computed_external");
    const correlated = filter(
      base,
      eq(col(base, "member"), col(external, "member")),
    ) as TestRelation;
    const result = membership(base, compound(correlated));
    if (result.node.kind !== "project") throw Error("expected_project");
    expect(
      computedMembershipLookupStrategy(result.node, new Map()),
    ).toBeUndefined();
    expect(() => lowerLogicalPlan(result)).toThrowError(
      expect.objectContaining({ code: "invalid_plan" }),
    );
  });

  it("recomputes candidate metadata and refuses forged key selection", () => {
    const base = source();
    const result = membership(base, compound(base));
    const physical = lowerLogicalPlan(result);
    expect(physical.joinOrderStrategies).toHaveLength(1);
    expect(() =>
      compileD1Query({
        ...physical,
        joinOrderStrategies: [
          {
            ...physical.joinOrderStrategies[0]!,
            kind: "right-anchor",
            driver: "right",
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_plan" }));
    if (result.node.kind !== "project") throw Error("expected_project");
    expect(
      computedMembershipLookupStrategy(result.node, new Map()),
    ).toBeDefined();
  });
});
