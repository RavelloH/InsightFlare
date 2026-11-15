// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import { COST_TIME } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import { SEED_SITE_ID } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

for (const audience of ["public-share", "api-v1"] as const) {
  it(`preserves the real application Event Summary policy for ${audience}`, async () => {
    const native = createMigratedDatabase();
    for (const statement of buildJourneyEventFieldsCostFixture(24).seed)
      native.exec(statement);
    const DB = createSqliteD1Database(native);
    const prepare = vi.spyOn(DB, "prepare");
    const providers = createD1SiteProviderRegistry({
      env: { DB, MAIN_SECRET: "event-summary-policy-contract" } as Env,
      siteId: SEED_SITE_ID,
    });
    const resolve = vi.spyOn(providers, "resolve");
    try {
      // The original public policy denies the operation before it considers
      // the also-private payload predicate. No caller policy is fabricated.
      const result = await createAnalyticsQueryRuntime(providers).execute(
        "event-summary",
        {
          context: siteQueryContext(SEED_SITE_ID, audience),
          time: COST_TIME,
          scopePreference: "session",
          filters: parseFilterDsl(
            'first(event.payload("/amount")) gt 0',
            analyticsFilterRegistry,
          ),
        },
        {
          onProviderError(error) {
            throw error;
          },
        },
      );
      if (audience === "public-share") {
        expect(result).toEqual({
          ok: false,
          error: { kind: "capability-denied", capability: "event-summary" },
        });
        expect(resolve).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
      } else {
        expect(resolve).toHaveBeenCalledWith("event-summary");
        expect(prepare).toHaveBeenCalled();
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        expect(result.data.summary.events).toBeGreaterThan(0);
      }
    } finally {
      resolve.mockRestore();
      prepare.mockRestore();
      native.close();
    }
  });
}
