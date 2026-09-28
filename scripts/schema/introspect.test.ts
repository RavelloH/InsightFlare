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
          }),
          expect.objectContaining({
            name: "records_partial",
            partial: true,
            columns: ["name", "b"],
          }),
          expect.objectContaining({
            name: "records_expression",
            columns: [null],
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
