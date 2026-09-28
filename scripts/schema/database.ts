import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function loadMigrations(root = resolve(import.meta.dirname, "../..")) {
  const directory = join(root, "migrations");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      sql: readFileSync(join(directory, file), "utf8"),
    }));
}

/** Replay the canonical migration history exactly once for all schema outputs. */
export function createMigratedDatabase(root?: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of loadMigrations(root)) db.exec(migration.sql);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
