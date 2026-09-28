#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import type { DatabaseSync } from "node:sqlite";

import { format } from "prettier";

import { createMigratedDatabase } from "./schema/database";
import { generateSchemaSql } from "./schema/generate-sql";
import { generateSchemaTypes } from "./schema/generate-types";
import type { SchemaObject } from "./schema/introspect";
import { introspectSchema } from "./schema/introspect";
import { createScriptLogger } from "./shared/logger";

const ROOT = resolve(import.meta.dirname, "..");
const rlog = createScriptLogger();
const OUTPUTS: readonly {
  path: string;
  build: (db: DatabaseSync, schema: readonly SchemaObject[]) => string;
}[] = [
  {
    path: resolve(ROOT, "docs", "schema.sql"),
    build: (db, schema) => generateSchemaSql(db, schema),
  },
  {
    path: resolve(ROOT, "src", "lib", "db", "schema", "generated.ts"),
    build: (_db, schema) => generateSchemaTypes(schema),
  },
] as const;

async function main() {
  const db = createMigratedDatabase(ROOT);
  try {
    const schema = introspectSchema(db);
    for (const output of OUTPUTS) {
      const generated = `${output.build(db, schema)}\n`;
      const content = output.path.endsWith(".ts")
        ? await format(generated, { filepath: output.path })
        : generated;
      let existing: string | null = null;
      try {
        existing = readFileSync(output.path, "utf8");
      } catch {
        // Missing outputs are generated below.
      }
      if (existing === content) {
        rlog.success(`Schema unchanged: ${output.path}`);
        continue;
      }
      writeFileSync(output.path, content, "utf8");
      rlog.success(`Generated ${output.path}`);
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  rlog.error("Schema generation failed");
  rlog.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
