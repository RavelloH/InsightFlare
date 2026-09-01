import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");

describe("saved-filter scope preference migration", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    while (databases.length > 0) databases.pop()?.close();
  });

  it("backfills legacy rows to auto and applies the allowed-value check", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE saved_filters (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        visibility TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        filter_dsl TEXT NOT NULL,
        filter_dsl_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO saved_filters (
        id, site_id, owner_user_id, visibility, name, filter_dsl
      ) VALUES ('legacy', 'site-1', 'user-1', 'private', 'Legacy', 'page.path eq "/docs"');
    `);

    database.exec(
      readFileSync(
        join(MIGRATIONS_DIR, "0043_add_saved_filter_scope_preference.sql"),
        "utf8",
      ),
    );

    expect(
      database
        .prepare("SELECT scope_preference FROM saved_filters WHERE id = ?")
        .get("legacy"),
    ).toEqual({ scope_preference: "auto" });
    database
      .prepare(
        `INSERT INTO saved_filters (
           id, site_id, owner_user_id, visibility, name, filter_dsl
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "new",
        "site-1",
        "user-1",
        "private",
        "New",
        'page.path eq "/pricing"',
      );
    expect(
      database
        .prepare("SELECT scope_preference FROM saved_filters WHERE id = ?")
        .get("new"),
    ).toEqual({ scope_preference: "auto" });
    expect(() =>
      database
        .prepare(
          `INSERT INTO saved_filters (
             id, site_id, owner_user_id, visibility, name, filter_dsl,
             scope_preference
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "invalid",
          "site-1",
          "user-1",
          "private",
          "Invalid",
          'page.path eq "/pricing"',
          "account",
        ),
    ).toThrow();
  });
});
