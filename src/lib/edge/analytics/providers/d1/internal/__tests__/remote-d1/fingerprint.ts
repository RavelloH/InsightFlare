import { createHash } from "node:crypto";

import { buildDataStatements, buildSiteStatements } from "./seed";

/** Verify actual seeded rows and structural schema, not just visits count. */
export async function databaseFingerprint(
  database: D1Database,
  visits: number,
  seedStatements?: readonly string[],
): Promise<string> {
  const statements = seedStatements ?? [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits }),
  ];
  const tables = [
    ...new Set(
      statements
        .map((sql) => /^INSERT INTO (\w+)/u.exec(sql)?.[1])
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
  const schema = await database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name",
    )
    .all<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>();
  const structural: unknown[] = [];
  for (const row of schema.results) {
    if (!/^[A-Za-z0-9_]+$/u.test(row.name))
      throw new Error("c01_schema_name_invalid");
    if (row.type === "table") {
      const columns = await database
        .prepare(`PRAGMA table_info("${row.name}")`)
        .all();
      const indexes = await database
        .prepare(`PRAGMA index_list("${row.name}")`)
        .all<{
          name: string;
          unique: number;
          origin: string;
          partial: number;
        }>();
      const foreignKeys = await database
        .prepare(`PRAGMA foreign_key_list("${row.name}")`)
        .all();
      structural.push([
        row.type,
        row.name,
        columns.results,
        indexes.results
          .map((index) => ({
            name: index.name,
            unique: index.unique,
            origin: index.origin,
            partial: index.partial,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        foreignKeys.results,
      ]);
    } else if (row.type === "index") {
      const columns = await database
        .prepare(`PRAGMA index_info("${row.name}")`)
        .all();
      structural.push([
        row.type,
        row.name,
        row.tbl_name,
        columns.results,
        row.sql
          ?.replace(/\s+/gu, " ")
          .replace(/IF NOT EXISTS /giu, "")
          .replace(/["`]/gu, "")
          .trim(),
      ]);
    } else structural.push(row);
  }
  const data: unknown[] = [];
  for (const table of tables) {
    const result = await database
      .prepare(`SELECT * FROM "${table}"`)
      .all<Record<string, unknown>>();
    data.push([
      table,
      result.results
        .map((row) =>
          JSON.stringify(
            Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
          ),
        )
        .sort(),
    ]);
  }
  return createHash("sha256")
    .update(JSON.stringify([structural, data]))
    .digest("hex");
}
