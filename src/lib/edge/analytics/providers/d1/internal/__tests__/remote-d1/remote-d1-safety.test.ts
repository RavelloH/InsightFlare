// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";

import { databaseFingerprint } from "./fingerprint";
import {
  assertDisposableDatabase,
  C01_DATABASE_ID,
  C01_DATABASE_NAME,
} from "./remote-d1-database";
import { buildDataStatements, buildSiteStatements } from "./seed";

const options = {
  accountId: "test-account",
  token: "fake-test-token",
  databaseId: C01_DATABASE_ID,
};
afterEach(() => vi.unstubAllGlobals());
describe("C01 destructive reset preflight (mocked HTTP only)", () => {
  it("rejects another UUID before making any request", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(
      assertDisposableDatabase({ ...options, databaseId: "wrong-id" }),
    ).rejects.toThrow("unapproved_database_id");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    "insightflare",
    "if-c01-bench-20261114",
    `${C01_DATABASE_NAME}-copy`,
  ])("rejects non-exact name %s", async (name) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, result: { name } })),
        ),
    );
    await expect(assertDisposableDatabase(options)).rejects.toThrow(
      "refuses_non_benchmark_database",
    );
  });
  it("accepts only the exact approved UUID/name pair", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: { name: C01_DATABASE_NAME },
          }),
        ),
      ),
    );
    await expect(assertDisposableDatabase(options)).resolves.toBeUndefined();
  });
  it("matches migrated/schema-export seeds and detects same-count corruption", async () => {
    const migrated = createMigratedDatabase();
    const exported = new DatabaseSync(":memory:");
    try {
      exported.exec(readFileSync(resolve("docs/schema.sql"), "utf8"));
      for (const database of [migrated, exported])
        for (const sql of [
          ...buildSiteStatements(),
          ...buildDataStatements({ visits: 16 }),
        ])
          database.exec(sql);
      const fingerprint = await databaseFingerprint(
        createSqliteD1Database(migrated),
        16,
      );
      expect(
        await databaseFingerprint(createSqliteD1Database(exported), 16),
      ).toBe(fingerprint);
      exported.exec("UPDATE visits SET pathname = '/corrupted'");
      expect(
        await databaseFingerprint(createSqliteD1Database(exported), 16),
      ).not.toBe(fingerprint);
    } finally {
      migrated.close();
      exported.close();
    }
  });
});
