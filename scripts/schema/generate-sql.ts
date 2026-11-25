import type { DatabaseSync } from "node:sqlite";

import type { SchemaObject } from "./introspect";

interface MasterRow {
  type: string;
  name: string;
  sql: string | null;
}

function splitDefinitions(body: string): string[] {
  const definitions: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) {
        if (body[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
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
  if (open < 0) return `${tableSql};`;
  const head = tableSql.slice(0, open).trim();
  const body = tableSql.slice(open + 1, tableSql.lastIndexOf(")"));
  const header = head.replace(
    /^CREATE TABLE(\s+(?:IF NOT EXISTS\s+)?)[\w_]+/i,
    `CREATE TABLE$1${tableName}`,
  );
  const definitions = splitDefinitions(body);
  const lines = [
    `${header} (`,
    ...definitions.map((definition) => `  ${definition}`),
    ");",
  ];
  for (let i = 0; i < definitions.length - 1; i++) lines[i + 1] += ",";
  if (indexSql.length > 0) lines.push("", ...indexSql.map((sql) => `${sql};`));
  return lines.join("\n");
}

export function generateSchemaSql(
  db: DatabaseSync,
  schema: readonly SchemaObject[],
  migrationNames: readonly string[],
): string {
  const sections: string[] = [];
  for (const object of schema) {
    const row = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')",
      )
      .get(object.name) as unknown as MasterRow | undefined;
    if (!row?.sql) continue;
    if (object.kind === "view") {
      sections.push(`${row.sql};`);
      continue;
    }
    const indexes = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
      )
      .all(object.name) as unknown as Array<{ sql: string }>;
    sections.push(
      pushTable(
        object.name,
        row.sql,
        indexes.map((index) => index.sql),
      ),
    );
  }

  // Seed data comes from a replay of the canonical migrations. Fail closed
  // on new seed tables until their initialization semantics are reviewed.
  for (const object of schema) {
    if (object.kind !== "table") continue;
    const identifier = '"' + object.name.replaceAll('"', '""') + '"';
    const count = db
      .prepare(`SELECT count(*) AS n FROM ${identifier}`)
      .get()?.n;
    if (count === 0) continue;
    if (object.name !== "scheduled_task_schedule_state") {
      throw new Error(`Unreviewed seed data in ${object.name}`);
    }
    const columns = object.columns.filter(
      (column) =>
        !column.generated &&
        column.hidden === 0 &&
        column.sqlName !== "updated_at",
    );
    const names = columns.map(
      (column) => '"' + column.sqlName.replaceAll('"', '""') + '"',
    );
    const rows = db
      .prepare(
        `SELECT ${names.map((name, index) => `quote(${name}) AS v${index}`).join(", ")} FROM ${identifier} ORDER BY task_key`,
      )
      .all();
    for (const row of rows) {
      sections.push(
        `INSERT INTO ${identifier} (${names.join(", ")}) VALUES (${names.map((_, index) => row[`v${index}`]).join(", ")});`,
      );
    }
  }

  const triggers = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as unknown as Array<{ sql: string | null }>;
  sections.push(
    ...triggers
      .map((trigger) => trigger.sql)
      .filter((sql): sql is string => Boolean(sql))
      .map((sql) => `${sql};`),
  );

  sections.push(
    "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
    "INSERT INTO d1_migrations (name) VALUES\n" +
      migrationNames
        .map((name) => "  ('" + name.replaceAll("'", "''") + "')")
        .join(",\n") +
      ";",
  );

  return [
    "-- D1 schema (generated). Do not edit by hand; run `pnpm run generate:schema`",
    "-- Complete initialization for a new empty D1 database, including seed data and migration history.",
    ...sections,
  ].join("\n\n");
}
