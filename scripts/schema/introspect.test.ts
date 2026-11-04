import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "./database";
import { generateSchemaSql } from "./generate-sql";
import { generateSchemaTypes } from "./generate-types";
import { introspectSchema } from "./introspect";

describe("SQLite schema introspection", () => {
  it("reads final metadata after rebuilds, ALTERs, and indexes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        INSERT INTO parents (name) VALUES ('key');
        CREATE TABLE records_old (a TEXT, b INTEGER, name TEXT);
        INSERT INTO records_old VALUES ('key', 1, 'old');
        CREATE TABLE records_new (
          a TEXT NOT NULL,
          b INTEGER NOT NULL,
          name TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (a, b),
          FOREIGN KEY (a) REFERENCES parents(name) ON DELETE CASCADE
        );
        INSERT INTO records_new (a, b, name) SELECT a, b, name FROM records_old;
        DROP TABLE records_old;
        ALTER TABLE records_new RENAME TO records;
        ALTER TABLE records ADD COLUMN note TEXT DEFAULT 'added';
        CREATE UNIQUE INDEX records_unique_pair ON records(a, b);
        CREATE INDEX records_partial ON records(name, b) WHERE name IS NOT NULL;
        CREATE INDEX records_expression ON records(lower(name));
        CREATE VIEW record_names AS SELECT name, created_at FROM records;
      `);

      const schema = introspectSchema(db);
      const records = schema.find((item) => item.name === "records")!;
      const view = schema.find((item) => item.name === "record_names")!;

      expect(records.kind).toBe("table");
      expect(records.defaultCollation).toBe("BINARY");
      expect(records.primaryKey).toEqual(["a", "b"]);
      expect(
        records.columns.find((column) => column.sqlName === "a"),
      ).toMatchObject({
        declaredType: "TEXT",
        affinity: "text",
        nullable: false,
        primaryKeyPosition: 1,
      });
      expect(
        records.columns.find((column) => column.sqlName === "name")?.nullable,
      ).toBe(true);
      expect(
        records.columns.find((column) => column.sqlName === "created_at")
          ?.defaultSql,
      ).toBe("unixepoch()");
      expect(
        records.columns.find((column) => column.sqlName === "note")?.defaultSql,
      ).toBe("'added'");
      expect(records.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "records_unique_pair",
            unique: true,
            columns: ["a", "b"],
            collations: ["BINARY", "BINARY"],
          }),
          expect.objectContaining({
            name: "records_partial",
            partial: true,
            columns: ["name", "b"],
            collations: ["BINARY", "BINARY"],
          }),
          expect.objectContaining({
            name: "records_expression",
            columns: [null],
            collations: ["BINARY"],
            rawExpressionSql: expect.stringContaining("lower(name)"),
          }),
        ]),
      );
      expect(records.foreignKeys).toEqual([
        expect.objectContaining({
          from: "a",
          toTable: "parents",
          toColumn: "name",
          onDelete: "CASCADE",
        }),
      ]);
      expect(view).toMatchObject({
        kind: "view",
        defaultCollation: "unknown",
        columns: [{ sqlName: "name" }, { sqlName: "created_at" }],
        indexes: [],
        foreignKeys: [],
      });
      expect(db.prepare("SELECT name FROM records").get()).toEqual({
        name: "old",
      });
    } finally {
      db.close();
    }
  });

  it("preserves index key collations separately from auxiliary columns", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE collation_probe (
          id INTEGER PRIMARY KEY,
          binary_name TEXT,
          nocase_name TEXT COLLATE NOCASE,
          rtrim_name TEXT COLLATE RTRIM
        );
        CREATE INDEX collation_probe_binary ON collation_probe(id, binary_name);
        CREATE INDEX collation_probe_column_nocase ON collation_probe(nocase_name, id);
        CREATE INDEX collation_probe_column_rtrim ON collation_probe(rtrim_name, id);
        CREATE INDEX collation_probe_index_nocase ON collation_probe(binary_name COLLATE NOCASE, id);
        CREATE INDEX collation_probe_nocase_binary ON collation_probe(nocase_name COLLATE BINARY, id);
        CREATE INDEX collation_probe_expression ON collation_probe(lower(binary_name), id);
        CREATE INDEX collation_probe_partial ON collation_probe(id, binary_name) WHERE id > 0;
      `);

      const table = introspectSchema(db).find(
        (item) => item.name === "collation_probe",
      )!;
      const index = (name: string) =>
        table.indexes.find((candidate) => candidate.name === name)!;

      expect(table.defaultCollation).toBe("unknown");
      expect(index("collation_probe_binary")).toMatchObject({
        columns: ["id", "binary_name"],
        collations: ["BINARY", "BINARY"],
      });
      expect(index("collation_probe_column_nocase")).toMatchObject({
        columns: ["nocase_name", "id"],
        collations: ["NOCASE", "BINARY"],
      });
      expect(index("collation_probe_column_rtrim")).toMatchObject({
        columns: ["rtrim_name", "id"],
        collations: ["RTRIM", "BINARY"],
      });
      expect(index("collation_probe_index_nocase")).toMatchObject({
        columns: ["binary_name", "id"],
        collations: ["NOCASE", "BINARY"],
      });
      expect(index("collation_probe_nocase_binary")).toMatchObject({
        columns: ["nocase_name", "id"],
        collations: ["BINARY", "BINARY"],
      });
      expect(index("collation_probe_expression")).toMatchObject({
        columns: [null, "id"],
        collations: ["BINARY", "BINARY"],
        rawExpressionSql: expect.stringContaining("lower(binary_name)"),
      });
      expect(index("collation_probe_partial")).toMatchObject({
        columns: ["id", "binary_name"],
        collations: ["BINARY", "BINARY"],
        partial: true,
      });
      for (const candidate of table.indexes)
        expect(candidate.collations).toHaveLength(candidate.columns.length);
    } finally {
      db.close();
    }
  });

  it("marks only SQLite INTEGER PRIMARY KEY rowid aliases non-null", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE rowid_alias (id INTEGER PRIMARY KEY, value TEXT);
        CREATE TABLE rowid_alias_inline_unique (
          id INTEGER PRIMARY KEY UNIQUE,
          value TEXT
        );
        CREATE TABLE rowid_alias_extra_unique (
          id INTEGER PRIMARY KEY,
          value TEXT
        );
        CREATE UNIQUE INDEX rowid_alias_extra_unique_id
          ON rowid_alias_extra_unique(id);
        CREATE TABLE rowid_alias_table_desc (
          id INTEGER,
          value TEXT,
          PRIMARY KEY (id DESC)
        );
        CREATE TABLE integer_primary_key_column_desc (
          id INTEGER PRIMARY KEY DESC,
          value TEXT
        );
        CREATE TABLE integer_primary_key_column_desc_not_null (
          id INTEGER NOT NULL PRIMARY KEY DESC,
          value TEXT
        );
        CREATE TABLE text_primary_key (id TEXT PRIMARY KEY);
        CREATE TABLE int_primary_key (id INT PRIMARY KEY);
        CREATE TABLE bigint_primary_key (id BIGINT PRIMARY KEY);
        CREATE TABLE composite_primary_key (
          first_id INTEGER,
          second_id INTEGER,
          PRIMARY KEY (first_id, second_id)
        );
        CREATE TABLE without_rowid_primary_key (
          id TEXT PRIMARY KEY
        ) WITHOUT ROWID;
        CREATE TABLE strict_rowid_alias (id INTEGER PRIMARY KEY) STRICT;
        CREATE TABLE strict_text_primary_key (id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE explicit_not_null_primary_key (
          id TEXT NOT NULL PRIMARY KEY
        );
        CREATE VIEW rowid_alias_view AS SELECT id FROM rowid_alias;
      `);

      const schema = introspectSchema(db);
      const nullable = (table: string, column: string) =>
        schema
          .find((item) => item.name === table)!
          .columns.find((item) => item.sqlName === column)!.nullable;
      const columnMetadata = (table: string, column: string) =>
        schema
          .find((item) => item.name === table)!
          .columns.find((item) => item.sqlName === column)!;
      const rawNullable = (table: string, column: string) => {
        const row = db
          .prepare(`PRAGMA table_xinfo(${JSON.stringify(table)})`)
          .all()
          .find((item) => (item as { name: string }).name === column) as
          { notnull: number } | undefined;
        if (!row) throw new Error(`Missing SQLite column ${table}.${column}`);
        return row.notnull === 0;
      };

      expect(nullable("rowid_alias", "id")).toBe(false);
      expect(rawNullable("rowid_alias", "id")).toBe(true);
      expect(columnMetadata("rowid_alias", "id").rowidAlias).toBe(true);
      expect(columnMetadata("rowid_alias_inline_unique", "id").rowidAlias).toBe(
        true,
      );
      expect(columnMetadata("rowid_alias_extra_unique", "id").rowidAlias).toBe(
        true,
      );
      expect(nullable("rowid_alias_table_desc", "id")).toBe(false);
      expect(nullable("integer_primary_key_column_desc", "id")).toBe(
        rawNullable("integer_primary_key_column_desc", "id"),
      );
      expect(nullable("integer_primary_key_column_desc", "id")).toBe(true);
      expect(
        columnMetadata("integer_primary_key_column_desc", "id").rowidAlias,
      ).toBeUndefined();
      expect(nullable("integer_primary_key_column_desc_not_null", "id")).toBe(
        false,
      );
      expect(
        columnMetadata("integer_primary_key_column_desc_not_null", "id")
          .rowidAlias,
      ).toBeUndefined();
      for (const [table, column] of [
        ["text_primary_key", "id"],
        ["int_primary_key", "id"],
        ["bigint_primary_key", "id"],
        ["composite_primary_key", "first_id"],
        ["composite_primary_key", "second_id"],
        ["without_rowid_primary_key", "id"],
        ["strict_text_primary_key", "id"],
        ["explicit_not_null_primary_key", "id"],
      ])
        expect(nullable(table!, column!)).toBe(rawNullable(table!, column!));
      expect(nullable("strict_rowid_alias", "id")).toBe(false);
      for (const [table, column] of [
        ["text_primary_key", "id"],
        ["int_primary_key", "id"],
        ["bigint_primary_key", "id"],
        ["composite_primary_key", "first_id"],
        ["composite_primary_key", "second_id"],
        ["without_rowid_primary_key", "id"],
        ["strict_text_primary_key", "id"],
        ["explicit_not_null_primary_key", "id"],
      ])
        expect(columnMetadata(table!, column!).rowidAlias).toBeUndefined();
      expect(
        schema.find((item) => item.name === "rowid_alias_view")?.kind,
      ).toBe("view");
      expect(nullable("rowid_alias_view", "id")).toBe(
        rawNullable("rowid_alias_view", "id"),
      );

      db.exec(`
        INSERT INTO rowid_alias (id, value) VALUES (NULL, 'auto');
        INSERT INTO rowid_alias_table_desc (id, value) VALUES (NULL, 'auto');
        INSERT INTO integer_primary_key_column_desc (id, value)
          VALUES (NULL, 'ordinary-null');
        INSERT INTO text_primary_key (id) VALUES (NULL);
        INSERT INTO int_primary_key (id) VALUES (NULL);
        INSERT INTO composite_primary_key (first_id, second_id)
          VALUES (NULL, 1);
        INSERT INTO strict_rowid_alias (id) VALUES (NULL);
      `);
      for (const table of [
        "rowid_alias",
        "rowid_alias_table_desc",
        "strict_rowid_alias",
      ])
        expect(
          db.prepare(`SELECT typeof(id) AS type FROM ${table}`).get()?.type,
        ).toBe("integer");
      expect(
        db
          .prepare(
            "SELECT id IS NULL AS null_flag FROM integer_primary_key_column_desc",
          )
          .get()?.null_flag,
      ).toBe(1);
      expect(
        db.prepare("SELECT id IS NULL AS null_flag FROM text_primary_key").get()
          ?.null_flag,
      ).toBe(1);
      expect(() =>
        db.exec("INSERT INTO without_rowid_primary_key (id) VALUES (NULL)"),
      ).toThrow();
      expect(() =>
        db.exec("INSERT INTO strict_text_primary_key (id) VALUES (NULL)"),
      ).toThrow();
      expect(() =>
        db.exec("INSERT INTO explicit_not_null_primary_key (id) VALUES (NULL)"),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("replays the migration source once and emits deterministic outputs", () => {
    const db = createMigratedDatabase();
    try {
      const schema = introspectSchema(db);
      expect(schema.length).toBeGreaterThan(0);
      expect(generateSchemaTypes(schema)).toBe(
        generateSchemaTypes(introspectSchema(db)),
      );
      expect(generateSchemaSql(db, schema)).toBe(generateSchemaSql(db, schema));
    } finally {
      db.close();
    }
  });
});
