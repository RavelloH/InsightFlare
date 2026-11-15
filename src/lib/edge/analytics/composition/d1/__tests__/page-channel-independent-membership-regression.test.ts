// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as countSupport from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import * as recipe from "@/lib/edge/analytics/engine/page-channel-membership-dependency-plan";
import { PAGE_MEMBERSHIP_DIMENSIONS } from "@/lib/edge/analytics/engine/page-channel-membership-reader-contract";
import * as wholeFamily from "@/lib/edge/analytics/engine/page-whole-original-family";
import { observeCostDatabase } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as prepared from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
it("actual old/new/Core independent Page/channel requests preserve full DTO and SQL parameters", async () => {
  const native = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 200 }),
  ])
    native.exec(sql);
  const dimensions = PAGE_MEMBERSHIP_DIMENSIONS;
  try {
    for (const scope of ["session", "visitor"] as const)
      for (const dimension of [...dimensions, null]) {
        const operation = dimension === null ? "channels" : "dimension";
        const request = {
          context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
          time: createQueryTime(
            SEED_BASE_MS + 3 * SEED_DAY_MS,
            SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
            "UTC",
            SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
          ),
          scopePreference: scope,
          filters: parseFilterDsl(
            "count(page { page.durationMs gt 5 }) gte 1 and time gte @range.start+1d",
            analyticsFilterRegistry,
          ),
          ...(dimension === null
            ? { mode: "list", limit: 3 }
            : { dimension, page: { limit: 2 } }),
        };
        const run = async (mode: "old" | "candidate" | "core") => {
          const bridge = vi.spyOn(prepared, "registerPreparedMembership"),
            spy =
              mode === "old"
                ? vi
                    .spyOn(recipe, "planPageChannelMembershipDependencies")
                    .mockReturnValue(undefined)
                : undefined;
          // Disabling only the Count recipe now selects the newer whole-filter
          // route; the historical oracles must bypass that route as well.
          const legacyWhole =
            mode !== "candidate"
              ? vi
                  .spyOn(wholeFamily, "pageWholeOriginalFamilyFromQuery")
                  .mockReturnValue(undefined)
              : undefined;
          const core =
            mode === "core"
              ? vi
                  .spyOn(countSupport, "classifyAdvancedCountFilter")
                  .mockReturnValue({
                    kind: "unsupported",
                    code: "page_channel_core_oracle",
                    path: "root",
                    reason: "Complete original Core oracle",
                  })
              : undefined;
          const initialChanges = native
            .prepare("SELECT total_changes() AS n")
            .get()!.n;
          const observed = observeCostDatabase(createSqliteD1Database(native));
          try {
            const registry = createD1SiteProviderRegistry({
              env: {
                DB: observed.database,
                MAIN_SECRET: "page-channel-scratch",
              } as Env,
              siteId: SEED_SITE_ID,
              diagnostics: createD1ReadDiagnostics(),
            });
            // Isolate the existing Count/whole qualification adapter contracts with the
            // actual registered providers, middleware, application service and request.
            // The base dispatcher prevents the newer Program from replacing a declined
            // route. This is a compatibility control, not a historical-source oracle or
            // coverage of the current D1 Program; real registry Program tests cover it.
            Object.defineProperty(registry, "resolve", {
              value: AnalyticsProviderRegistry.prototype.resolve,
            });
            const runtime = createAnalyticsQueryRuntime(registry);
            const result = await runtime.execute(operation, request as never, {
              onProviderError(e) {
                throw e;
              },
            });
            expect(
              native.prepare("SELECT total_changes() AS n").get()!.n,
            ).toEqual(initialChanges);

            return {
              result,
              bridgeCalls: bridge.mock.calls.length,
              observations: observed.observations,
            };
          } finally {
            legacyWhole?.mockRestore();
            spy?.mockRestore();
            core?.mockRestore();
            bridge.mockRestore();
          }
        };
        const old = await run("old"),
          candidate = await run("candidate"),
          core = await run("core");
        expect(old.result.ok).toBe(true);
        expect(candidate.result).toEqual(old.result);
        expect(candidate.result).toEqual(core.result);
        expect(old.bridgeCalls).toBe(1);
        expect(candidate.bridgeCalls).toBe(0);
        expect(core.bridgeCalls).toBe(1);
        expect(
          candidate.observations.map(({ sql, params }) => ({ sql, params })),
        ).toEqual(old.observations.map(({ sql, params }) => ({ sql, params })));
      }
  } finally {
    native.close();
  }
}, 120000);
