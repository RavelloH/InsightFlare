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

  return [
    "-- D1 schema (generated). Do not edit by hand; run `pnpm run generate:schema`",
    "-- Regenerates the current table structure by replaying migrations/.",
    ...sections,
  ].join("\n\n");
}
