// @vitest-environment node
import { expect, it, vi } from "vitest";

import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  prepareScopedQuery,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import { prepareSiteExactDimensionInputs } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

import { createFixture } from "./team-sites-membership-fixture";
it.each([
  "requestedScope",
  "resolvedScope",
  "metadata-getter",
  "metadata-toJSON",
] as const)(
  "TeamExact rejects %s change across joint Core before child preparation",
  async (kind) => {
    const db = createFixture();
    db.exec("UPDATE visits SET duration_ms='invalid-duration'");
    const sites = ["b04-site-a", "b04-site-b"];
    const query = prepareScopedQuery("dimension", {
      context: teamQueryContext("b04-team", "private-dashboard", sites),
      teamId: "b04-team",
      allowedSiteIds: sites,
      time: createQueryTime(100, 200, "UTC", 300),
      filters: parseFilterDsl(
        "count(page { page.durationMs gt 5 }) gte 1",
        analyticsFilterRegistry,
      ),
      scopePreference: "session" as const,
      mode: "breakdown" as const,
      dimension: "page.path",
      limit: 0,
    });
    const metadata = scopedFilterMetadata(query.filters)!;
    const real = evaluator.evaluateFilterDocument;
    let calls = 0,
      accesses = 0;
    const spy = vi
      .spyOn(evaluator, "evaluateFilterDocument")
      .mockImplementation((...args) => {
        const value = real(...args);
        if (++calls === 2) {
          if (kind === "requestedScope" || kind === "resolvedScope")
            Object.assign(metadata, { [kind]: "visitor" });
          if (kind === "metadata-getter")
            Object.defineProperty(metadata, "requestedScope", {
              enumerable: true,
              get() {
                accesses++;
                throw new Error("getter_must_not_run");
              },
            });
          if (kind === "metadata-toJSON")
            Object.assign(metadata, {
              toJSON() {
                accesses++;
                throw new Error("toJSON_must_not_run");
              },
            });
        }
        return value;
      });
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    try {
      await expect(
        prepareSiteExactDimensionInputs({
          env: { DB: createSqliteD1Database(db, trace) } as Env,
          query,
          siteIds: sites,
        }),
      ).rejects.toMatchObject({
        domainError: {
          issues: [
            { code: "team_exact_membership_admission_context_mismatch" },
          ],
        },
      });
      expect(calls).toBe(2);
      expect(accesses).toBe(0);
      expect(
        trace.preparedSql.some((s) => s.includes('AS "publicEnabled"')),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  },
);
