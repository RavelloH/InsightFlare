// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";

import { databaseFingerprint } from "./fingerprint";
import { buildJourneyEventFieldsCostFixture } from "./journey-event-fields-cost-fixture";

async function fingerprintAt(clock: number, legacyAuditDefaults: boolean) {
  const database = createMigratedDatabase();
  try {
    database.function("unixepoch", () => clock);
    const fixture = buildJourneyEventFieldsCostFixture(160);
    for (const statement of fixture.seed) {
      // Reconstruct the old four INSERT defaults as a negative control only.
      const actual = legacyAuditDefaults
        ? statement
            .replace(
              ",hostname,created_at,updated_at) VALUES",
              ",hostname) VALUES",
            )
            .replace(
              /,'c01.example.invalid',\d+,\d+\)$/u,
              ",'c01.example.invalid')",
            )
            .replace(",value_count,created_at) VALUES", ",value_count) VALUES")
            .replace(/(,0,0,0),\d+\)$/u, "$1)")
        : statement;
      database.exec(actual);
    }
    database.exec("PRAGMA query_only=ON");
    return await databaseFingerprint(
      createSqliteD1Database(database),
      160,
      fixture.seed,
    );
  } finally {
    database.close();
  }
}

describe("journey/fields fixture audit clock determinism", () => {
  it("fingerprints detect the old wall-clock defaults", async () => {
    expect(await fingerprintAt(1700000000, true)).not.toBe(
      await fingerprintAt(1800000000, true),
    );
  });
  it("seeds the same complete rows under different wall clocks", async () => {
    expect(await fingerprintAt(1700000000, false)).toBe(
      await fingerprintAt(1800000000, false),
    );
  });
});
