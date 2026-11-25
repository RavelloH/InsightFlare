import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase, loadMigrations } from "./database";
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
      const names = loadMigrations().map(({ file }) => file);
      const sql = generateSchemaSql(db, schema, names);
      const fresh = createMigratedDatabase();
      const initialized = new DatabaseSync(":memory:");
      try {
        expect(sql).toBe(
          generateSchemaSql(fresh, introspectSchema(fresh), names),
        );
        expect(sql + "\n").toBe(
          readFileSync("docs/schema.sql", "utf8").replaceAll("\r\n", "\n"),
        );
        initialized.exec(sql);
        db.exec(
          "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
        );
        for (const name of names)
          db.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
        expect(introspectSchema(initialized)).toEqual(introspectSchema(db));
        const objects = (database: DatabaseSync) =>
          database
            .prepare(
              "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
            )
            .all()
            .map((row) => ({
              ...row,
              sql: String(row.sql)
                .replace(/\s+/g, " ")
                .replace(/\s*([(),])\s*/g, "$1")
                .trim(),
            }));
        expect(objects(initialized)).toEqual(objects(db));
        for (const table of introspectSchema(db).filter(
          (item) => item.kind === "table",
        )) {
          const name = '"' + table.name.replaceAll('"', '""') + '"';
          const rows = (database: DatabaseSync) =>
            database
              .prepare(`SELECT * FROM ${name}`)
              .all()
              .map((row) => {
                if (
                  table.name === "scheduled_task_schedule_state" ||
                  table.name === "d1_migrations"
                ) {
                  const field =
                    table.name === "d1_migrations"
                      ? "applied_at"
                      : "updated_at";
                  const value = row[field];
                  const seconds =
                    typeof value === "number"
                      ? value
                      : Date.parse(String(value) + "Z") / 1000;
                  expect(Math.abs(Date.now() / 1000 - seconds)).toBeLessThan(
                    60,
                  );
                  return { ...row, [field]: "initialization time" };
                }
                return row;
              })
              .map((row) => JSON.stringify(row))
              .sort();
          expect(rows(initialized)).toEqual(rows(db));
        }
        expect(
          initialized
            .prepare("SELECT * FROM sqlite_sequence ORDER BY name")
            .all(),
        ).toEqual(
          db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
        );
        expect(initialized.prepare("PRAGMA foreign_key_check").all()).toEqual(
          [],
        );
        expect(initialized.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        for (const database of [db, initialized]) {
          database.exec(
            "ALTER TABLE scheduled_task_schedule_state ADD COLUMN test_revision INTEGER NOT NULL DEFAULT 0",
          );
          database.exec(
            "UPDATE scheduled_task_schedule_state SET test_revision=1 WHERE task_key='notification_tick'",
          );
          database
            .prepare("INSERT INTO d1_migrations(name) VALUES (?)")
            .run("9999_test.sql");
        }
        expect(objects(initialized)).toEqual(objects(db));
        expect(
          initialized
            .prepare("SELECT id,name FROM d1_migrations ORDER BY id")
            .all(),
        ).toEqual(
          db.prepare("SELECT id,name FROM d1_migrations ORDER BY id").all(),
        );
        expect(
          initialized
            .prepare(
              "SELECT task_key,test_revision FROM scheduled_task_schedule_state ORDER BY task_key",
            )
            .all(),
        ).toEqual(
          db
            .prepare(
              "SELECT task_key,test_revision FROM scheduled_task_schedule_state ORDER BY task_key",
            )
            .all(),
        );
      } finally {
        fresh.close();
        initialized.close();
      }
    } finally {
      db.close();
    }
  });
});
