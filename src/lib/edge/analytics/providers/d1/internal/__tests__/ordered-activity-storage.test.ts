import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { compileD1Query, project, scan } from "@/lib/db";
import { schema } from "@/lib/db/schema";
import { canonicalOrderedActivityStorage } from "@/lib/edge/analytics/providers/d1/internal/ordered-activity-storage";
it.each([
  ["zero", "id", "scope", 0n, 1],
  ["negative", "id", "scope", -1n, 1],
  ["safe maximum", "id", "scope", BigInt(Number.MAX_SAFE_INTEGER), 1],
  ["safe minimum", "id", "scope", -BigInt(Number.MAX_SAFE_INTEGER), 1],
  ["REAL same numeric value", "id", "scope", 1, 0],
  ["fractional REAL", "id", "scope", 1.5, 0],
  ["unsafe INTEGER", "id", "scope", BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0],
  [
    "negative unsafe INTEGER",
    "id",
    "scope",
    -BigInt(Number.MAX_SAFE_INTEGER) - 1n,
    0,
  ],
  ["NULL time", "id", "scope", null, 0],
  ["numeric TEXT time", "id", "scope", "1", 0],
  ["BLOB time", "id", "scope", new Uint8Array([1]), 0],
  ["NULL id", null, "scope", 1n, 0],
  ["BLOB id", new Uint8Array([1]), "scope", 1n, 0],
  ["INTEGER id", 1n, "scope", 1n, 0],
  ["NULL scope", "id", null, 1n, 0],
  ["BLOB scope", "id", new Uint8Array([1]), 1n, 0],
  ["INTEGER scope", "id", 1n, 1n, 0],
] as const)(
  "proves actual historical storage independently of declared metadata: %s",
  (_name, id, scope, time, expected) => {
    const db = new DatabaseSync(":memory:");
    try {
      // Historic storage deliberately violates current generated affinity facts.
      // Only actual storage-class evidence may admit it.
      db.exec(
        `CREATE TABLE sites(${Object.keys(schema.sites.columns)
          .map((name) => `"${name}"`)
          .join(",")})`,
      );
      db.prepare("INSERT INTO sites(id,team_id,created_at) VALUES(?,?,?)").run(
        id,
        scope,
        time,
      );
      const rows = scan(schema.sites),
        query = compileD1Query(
          project(rows, {
            compatible: canonicalOrderedActivityStorage(
              rows.columns.id,
              rows.columns.team_id,
              rows.columns.created_at,
            ),
          }),
        );
      expect(db.prepare(query.sql).all(...(query.bindings as never[]))).toEqual(
        [{ compatible: expected }],
      );
    } finally {
      db.close();
    }
  },
);
