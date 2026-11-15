// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";

import { databaseFingerprint } from "./fingerprint";
import { buildJourneyEventFieldsCostFixture } from "./journey-event-fields-cost-fixture";
import { C01_ACCOUNT_ID, resetRemoteCostFixture } from "./remote-cost-fixture";
import { C01_DATABASE_ID, C01_DATABASE_NAME } from "./remote-d1-database";

const options = {
  accountId: C01_ACCOUNT_ID,
  databaseId: C01_DATABASE_ID,
  token: "fake-test-token",
};
const result = (
  results: unknown[] = [],
  metrics: object = { rows_read: 0, rows_written: 0, duration: 0 },
) =>
  new Response(
    JSON.stringify({
      success: true,
      result: [{ success: true, results, meta: metrics }],
    }),
  );
const identity = () =>
  new Response(
    JSON.stringify({ success: true, result: { name: C01_DATABASE_NAME } }),
  );
afterEach(() => vi.unstubAllGlobals());

describe("shared explicit C01 reset and independent fingerprint", () => {
  it("refuses another account or UUID before a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      resetRemoteCostFixture({ ...options, accountId: "other" }, [], []),
    ).rejects.toThrow("unapproved_account_id");
    await expect(
      resetRemoteCostFixture({ ...options, databaseId: "other" }, [], []),
    ).rejects.toThrow("unapproved_database_id");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["transport", "metadata"])(
    "stops a reset on %s failure without retrying drops or seeding",
    async (failure) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(identity())
        .mockResolvedValueOnce(result([{ name: "visits" }]));
      if (failure === "transport")
        fetch.mockRejectedValueOnce(new Error("transport disconnected"));
      else fetch.mockResolvedValueOnce(result([], {}));
      vi.stubGlobal("fetch", fetch);
      await expect(
        resetRemoteCostFixture(
          options,
          ["CREATE TABLE sentinel(id)"],
          ["INSERT INTO sentinel VALUES(1)"],
        ),
      ).rejects.toThrow(
        failure === "transport" ? "disconnected" : "metric_unavailable",
      );
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );
  it("retries only an explicit foreign-key dependency and then applies the exact schema and seed", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(result([{ name: "visits" }]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1, message: "FOREIGN KEY constraint failed" }],
          }),
        ),
      )
      .mockImplementation(async () => result());
    vi.stubGlobal("fetch", fetch);
    await resetRemoteCostFixture(
      options,
      ["CREATE TABLE sentinel(id)"],
      ["INSERT INTO sentinel VALUES(1)"],
    );
    const statements = fetch.mock.calls
      .slice(1)
      .map((call) => JSON.parse(call[1].body).sql);
    expect(statements.slice(1)).toEqual([
      'DROP TABLE IF EXISTS "visits"',
      'DROP TABLE IF EXISTS "visits"',
      "CREATE TABLE sentinel(id)",
      "INSERT INTO sentinel VALUES(1)",
    ]);
  });
  it("includes extra funnel and normalized payload rows in the independent seed fingerprint", async () => {
    const db = createMigratedDatabase();
    try {
      const fixture = buildJourneyEventFieldsCostFixture(16);
      for (const sql of fixture.seed) db.exec(sql);
      const database = createSqliteD1Database(db);
      const before = await databaseFingerprint(database, 16, fixture.seed);
      db.exec(
        "UPDATE custom_event_json_values SET string_value='corrupt' WHERE string_value='pro'",
      );
      expect(await databaseFingerprint(database, 16, fixture.seed)).not.toBe(
        before,
      );
    } finally {
      db.close();
    }
  });
});
