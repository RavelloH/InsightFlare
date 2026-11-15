import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  aggregate,
  and,
  callFunction,
  compileD1Query,
  constant,
  count,
  distinct,
  eq,
  join,
  limit,
  param,
  project,
  scan,
  sort,
  union,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import { hasOrderStableConsumers } from "@/lib/db/query/physical/consumer-order-stability";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type { SchemaTableReference } from "@/lib/db/schema/types";

type TestRelation = Relation<
  Record<string, unknown>,
  Readonly<Record<string, AnyExpression>>
>;
const tables = new Set<string>();
function input(
  name: string,
  affinity: "integer" | "text" = "integer",
  binary = true,
): TestRelation {
  const column = (sqlName: string, kind: "integer" | "text") => ({
    kind: "column" as const,
    table: name,
    sqlName,
    propertyName: sqlName,
    declaredType: kind.toUpperCase(),
    affinity: kind,
    nullable: true,
    primaryKeyPosition: 0,
    defaultSql: null,
    hidden: 0,
    generated: false,
  });
  const table: SchemaTableReference = {
    kind: "table",
    name,
    defaultCollation: binary ? "BINARY" : "unknown",
    columns: {
      site_pk: column("site_pk", affinity),
      site_id: column("site_id", "text"),
    },
    primaryKey: [],
    indexes: [],
    foreignKeys: [],
  };
  Reflect.set(schema, name, table);
  tables.add(name);
  return scan(
    table as unknown as typeof schema.site_identities,
  ) as TestRelation;
}
const col = (source: TestRelation, name: string) => source.columns[name]!;
function membership(mode = "numeric") {
  const base = input("taint_source", "integer", mode !== "nocase");
  const first = project(base, { key: col(base, "site_pk") }) as TestRelation;
  const second = project(base, { key: col(base, "site_pk") }) as TestRelation;
  const keys = distinct(union(first, second)) as TestRelation;
  const catalog = input("taint_catalog", mode === "text" ? "text" : "integer");
  const other =
    mode === "computed"
      ? (project(catalog, {
          site_pk: constant(1),
          site_id: col(catalog, "site_id"),
        }) as TestRelation)
      : catalog;
  const equality = eq(col(other, "site_pk"), col(keys, "key"));
  const condition =
    mode === "extra-observer"
      ? and(
          equality,
          eq(callFunction("storage-class", col(keys, "key")), param("integer")),
        )
      : equality;
  const selected = join(
    other,
    keys,
    condition,
    mode === "left" ? "left" : "inner",
  ) as TestRelation;
  let projected = project(selected, {
    label: col(selected, "left_site_id"),
    ...(mode === "raw" ? { copy: col(selected, "right_key") } : {}),
    ...(mode === "typeof"
      ? { storage: callFunction("storage-class", col(selected, "right_key")) }
      : {}),
  }) as TestRelation;
  if (mode === "limit") projected = limit(projected, 1) as TestRelation;
  if (mode === "sort")
    projected = sort(projected, [
      { expression: col(projected, "label"), direction: "ASC" },
    ]) as TestRelation;
  const result =
    mode === "raw"
      ? projected
      : (aggregate(projected, {
          groupBy: {},
          aggregates: { rows: count() },
        }) as TestRelation);
  return { first, result };
}

describe("numeric representative membership consumers", () => {
  afterEach(() => {
    for (const name of tables) Reflect.deleteProperty(schema, name);
    tables.clear();
  });
  it("permits a complete numeric catalog equality only after every representative copy is discarded", () => {
    const query = membership();
    expect(hasOrderStableConsumers(query.first.node, query.result.node)).toBe(
      true,
    );
    // This historical-storage fixture deliberately rewrites sqlite_schema.
    const db = new DatabaseSync(":memory:", { defensive: false });
    try {
      db.exec(
        "CREATE TABLE taint_source(site_pk BLOB,site_id TEXT);CREATE TABLE taint_catalog(site_pk BLOB,site_id TEXT);INSERT INTO taint_source VALUES(1,'integer'),(1.0,'real'),('1','text-one'),('1.0','text-real'),(x'31','blob'),(NULL,'null'),(9007199254740993,'large');INSERT INTO taint_catalog SELECT site_pk,site_id FROM taint_source;PRAGMA writable_schema=ON;UPDATE sqlite_schema SET sql=replace(sql,'site_pk BLOB','site_pk INTEGER') WHERE name IN ('taint_source','taint_catalog');PRAGMA schema_version=99;PRAGMA writable_schema=OFF",
      );
      const compiled = compileD1Query(query.result);
      const bindings = (compiled.bindings ?? []).map((value): SQLInputValue => {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "bigint" ||
          value instanceof Uint8Array
        )
          return value;
        throw new Error("invalid_numeric_membership_test_binding");
      });
      const actual = db.prepare(compiled.sql).all(...bindings);
      const expected = db
        .prepare(
          "SELECT COUNT(*) AS rows FROM taint_catalog AS c INNER JOIN (SELECT site_pk AS key FROM taint_source UNION SELECT site_pk FROM taint_source) AS k ON c.site_pk=k.key",
        )
        .all();
      expect(actual).toEqual(expected);
      expect(
        db
          .prepare("SELECT typeof(site_pk) AS storage FROM taint_source")
          .all()
          .map((row) => row.storage),
      ).toEqual(["integer", "real", "text", "text", "blob", "null", "integer"]);
    } finally {
      db.close();
    }
  });
  it.each([
    "text",
    "computed",
    "extra-observer",
    "typeof",
    "raw",
    "limit",
    "sort",
    "left",
    "nocase",
  ])("rejects %s affinity, observer, selection or collation paths", (mode) => {
    const query = membership(mode);
    expect(hasOrderStableConsumers(query.first.node, query.result.node)).toBe(
      false,
    );
  });
  it("retains the TEXT-affinity 1 versus 1.0 counterexample rather than treating both as TypeScript numbers", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE labels(label TEXT);INSERT INTO labels VALUES('1'),('1.0')",
      );
      const first = db
        .prepare(
          "SELECT label FROM labels JOIN (SELECT 1 AS k UNION SELECT 1.0) AS keys ON labels.label=keys.k",
        )
        .all();
      const second = db
        .prepare(
          "SELECT label FROM labels JOIN (SELECT 1.0 AS k UNION SELECT 1) AS keys ON labels.label=keys.k",
        )
        .all();
      expect(first).not.toEqual(second);
    } finally {
      db.close();
    }
  });
});
