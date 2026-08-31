import { describe, expect, it } from "vitest";

import { buildHistorySeed } from "./e2e/seed-history";

describe("history E2E seed", () => {
  it("creates deterministic, schema-derived SQL and manifest truth", () => {
    const seed = buildHistorySeed({
      nowMs: 1_800_000_000_000,
      runId: "run-1",
      siteId: "site-1",
    });
    expect(seed.manifest).toMatchObject({
      pages: { "/": 30, "/checkout": 30, "/docs": 30, "/pricing": 30 },
      totalVisits: 120,
    });
    expect(seed.manifest.fromMs).toBeLessThan(seed.manifest.toMs);
    expect(seed.sql).toContain(
      "INSERT OR IGNORE INTO site_identities (site_id) VALUES ('site-1');",
    );
    expect(seed.sql).toContain(
      "(SELECT site_pk FROM site_identities WHERE site_id = 'site-1')",
    );
    expect(seed.sql).toContain("INSERT INTO visits");
    expect(seed.sql).toContain("run-1-history-visit-0");
    expect(seed.sql).toContain("summer-launch");
  });
});
