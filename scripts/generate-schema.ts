#!/usr/bin/env tsx

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createScriptLogger } from "./shared/logger";

const ROOT = resolve(import.meta.dirname, "..");
const rlog = createScriptLogger();
const MIGRATIONS_DIR = join(ROOT, "migrations");
const OUTPUT_PATH = resolve(ROOT, "docs", "schema.sql");

interface MasterRow {
  type: string;
  name: string;
  sql: string | null;
}

function loadMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
}

/**
 * Replays every migration file in an in-memory SQLite database, then exports
 * the resulting current schema from sqlite_master. This reliably resolves the
 * rebuild/temp-table patterns (CREATE ..._new + RENAME, DROP TABLE/INDEX) that
 * a textual scan of the migration files cannot.
 */
function exportSchema(): string[] {
  const db = new DatabaseSync(":memory:");
  for (const sql of loadMigrations()) {
    db.exec(sql);
  }

  const order = `
    SELECT name FROM sqlite_master
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `;
  const names = db
    .prepare(order)
    .all()
    .map((row) => (row as unknown as MasterRow).name);

  const sections: string[] = [];
  for (const tableName of names) {
    const row = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name = ? AND type IN ('table', 'view')`,
      )
      .get(tableName) as unknown as MasterRow;

    if (!row.sql) {
      rlog.warn(`Skipping "${tableName}": no stored DDL`);
      continue;
    }

    if (row.type === "view") {
      sections.push(`${row.sql};`);
      continue;
    }

    const indexSql = db
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
         ORDER BY name`,
      )
      .all(tableName)
      .map((idx) => (idx as unknown as MasterRow).sql as string);

    sections.push(pushTable(tableName, row.sql, indexSql));
  }

  const triggers = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((trig) => (trig as unknown as MasterRow).sql as string)
    .filter(Boolean);

  for (const triggerSql of triggers) {
    sections.push(`${triggerSql};`);
  }

  return sections;
}

/**
 * Splits a CREATE TABLE body on top-level commas (ignoring commas inside
 * parentheses and string literals) and re-joins each definition on its own
 * line. SQLite concatenates ALTER TABLE ADD COLUMN additions onto the tail
 * of the table body without line breaks, which is illegible as-is.
 */
function splitDefinitions(body: string): string[] {
  const definitions: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      definitions.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }

  definitions.push(body.slice(start).trim());
  return definitions.filter(Boolean);
}

function pushTable(
  tableName: string,
  tableSql: string,
  indexSql: string[],
): string {
  const open = tableSql.indexOf("(");
  const head = tableSql.slice(0, open).trim();
  const body = tableSql.slice(open + 1, tableSql.lastIndexOf(")"));
  const header = head.replace(
    /^CREATE TABLE(\s+(?:IF NOT EXISTS\s+)?)[\w_]+/i,
    `CREATE TABLE$1${tableName}`,
  );

  const definitions = splitDefinitions(body);
  const lines = [`${header} (`, ...definitions.map((def) => `  ${def}`), ");"];
  // Add a trailing comma to every definition except the last.
  for (let i = 0; i < definitions.length - 1; i++) {
    lines[i + 1] += ",";
  }

  if (indexSql.length > 0) {
    lines.push("");
    lines.push(...indexSql.map((sql) => `${sql};`));
  }

  return lines.join("\n");
}

function buildContent(sections: string[]): string {
  return [
    "-- D1 schema (generated). Do not edit by hand; run `npm run generate:schema`",
    "-- Regenerates the current table structure by replaying migrations/.",
    ...sections,
  ].join("\n\n");
}

function main() {
  const sections = exportSchema();
  const existing = readFileSafe(OUTPUT_PATH);
  const content = buildContent(sections) + "\n";

  if (existing === content) {
    rlog.success(`Schema unchanged: ${OUTPUT_PATH}`);
    return;
  }

  writeFileSync(OUTPUT_PATH, content, "utf8");
  rlog.success(`Generated ${OUTPUT_PATH}`);
}

function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

main();
