import type { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Mutation,
  eq,
  excluded,
  filter,
  insert,
  insertOrIgnoreFromQuery,
  isDistinctFrom,
  onConflictDoUpdate,
  param,
  project,
  scan,
} from "@/lib/db";
import { compileD1Expression } from "@/lib/db/query/compiler";
import { schema } from "@/lib/db/schema";

function executeRun(
  db: DatabaseSync,
  statement: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(statement.sql)
    .run(...((statement.bindings ?? []) as SQLInputValue[]));
}

describe("typed insert mutation capabilities", () => {
  it("compiles null-safe distinct comparisons to SQLite IS NOT", () => {
    const db = createMigratedDatabase();
    try {
      const evaluate = (
        left: string | number | null,
        right: string | number | null,
      ) => {
        const expression = compileD1Expression(
          isDistinctFrom(param(left), param(right)),
          new Map(),
        );
        return db
          .prepare(`SELECT ${expression.text} AS result`)
          .get(...(expression.bindings as SQLInputValue[])) as {
          result: number;
        };
      };

      expect(evaluate(null, null)).toEqual({ result: 0 });
      expect(evaluate(null, "value")).toEqual({ result: 1 });
      expect(evaluate("value", null)).toEqual({ result: 1 });
      expect(evaluate("same", "same")).toEqual({ result: 0 });
      expect(evaluate(1, 2)).toEqual({ result: 1 });
    } finally {
      db.close();
    }
  });

  it("binds conflict guards to the target row and preserves unguarded upserts", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.configs, {
            config_key: "guarded",
            value_json: "initial",
            updated_at: 1,
            created_at: 1,
          }),
        ),
      );

      const guardedUpsert = (
        value: string,
        updatedAt: number,
        expected: number | null,
      ) =>
        compileD1Mutation(
          onConflictDoUpdate(
            insert(schema.configs, {
              config_key: "guarded",
              value_json: value,
              updated_at: updatedAt,
              created_at: updatedAt,
            }),
            ["config_key"],
            (columns) => ({
              set: {
                value_json: excluded(schema.configs.columns.value_json),
                updated_at: excluded(schema.configs.columns.updated_at),
              },
              where: eq(columns.updated_at, param(expected)),
            }),
          ),
        );

      const update = guardedUpsert("updated", 2, 1);
      expect(update.sql).toContain('WHERE ("configs"."updated_at" = ?)');
      executeRun(db, update);
      expect(
        db
          .prepare(
            "SELECT value_json, updated_at FROM configs WHERE config_key = ?",
          )
          .get("guarded"),
      ).toEqual({ value_json: "updated", updated_at: 2 });

      executeRun(db, guardedUpsert("blocked", 3, 1));
      expect(
        db
          .prepare(
            "SELECT value_json, updated_at FROM configs WHERE config_key = ?",
          )
          .get("guarded"),
      ).toEqual({ value_json: "updated", updated_at: 2 });

      executeRun(db, guardedUpsert("null-guard", 4, null));
      expect(
        db
          .prepare(
            "SELECT value_json, updated_at FROM configs WHERE config_key = ?",
          )
          .get("guarded"),
      ).toEqual({ value_json: "updated", updated_at: 2 });

      const targetScopedAssignment = compileD1Mutation(
        onConflictDoUpdate(
          insert(schema.configs, {
            config_key: "guarded",
            value_json: "ignored",
            updated_at: 3,
            created_at: 3,
          }),
          ["config_key"],
          (columns) => ({
            set: {
              value_json: columns.value_json,
              updated_at: excluded(schema.configs.columns.updated_at),
            },
            where: eq(columns.updated_at, param(2)),
          }),
        ),
      );
      expect(targetScopedAssignment.sql).toContain(
        '"value_json" = "configs"."value_json"',
      );
      executeRun(db, targetScopedAssignment);
      expect(
        db
          .prepare(
            "SELECT value_json, updated_at FROM configs WHERE config_key = ?",
          )
          .get("guarded"),
      ).toEqual({ value_json: "updated", updated_at: 3 });

      const legacyShape = compileD1Mutation(
        onConflictDoUpdate(
          insert(schema.configs, {
            config_key: "unguarded",
            value_json: "one",
          }),
          ["config_key"],
          { value_json: "two" },
        ),
      );
      expect(legacyShape.sql).toContain("DO UPDATE SET");
      expect(legacyShape.sql).not.toContain(" WHERE ");
    } finally {
      db.close();
    }
  });

  it("uses OR IGNORE for query-backed inserts with zero and duplicate source rows", () => {
    const db = createMigratedDatabase();
    try {
      executeRun(
        db,
        compileD1Mutation(
          insert(schema.site_identities, { site_id: "source" }),
        ),
      );
      const sites = scan(schema.site_identities);
      const matchingSource = filter(
        sites,
        eq(sites.columns.site_id, param("source")),
      );
      const source = project(matchingSource, {
        site_id: matchingSource.columns.site_id,
      });
      const copy = compileD1Mutation(
        insertOrIgnoreFromQuery(schema.site_identities, ["site_id"], source),
      );
      expect(copy.sql).toContain("INSERT OR IGNORE INTO");
      expect(copy.sql).not.toContain("ON CONFLICT");
      executeRun(db, copy);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM site_identities").get(),
      ).toEqual({ count: 1 });

      const noMatchingRows = filter(
        sites,
        eq(sites.columns.site_id, param("missing")),
      );
      const noSourceRows = project(noMatchingRows, {
        site_id: noMatchingRows.columns.site_id,
      });
      executeRun(
        db,
        compileD1Mutation(
          insertOrIgnoreFromQuery(
            schema.site_identities,
            ["site_id"],
            noSourceRows,
          ),
        ),
      );
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM site_identities").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
