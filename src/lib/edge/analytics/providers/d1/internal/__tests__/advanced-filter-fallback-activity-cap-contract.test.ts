import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as filterEvaluator from "@/lib/filter-contract/filter-evaluator";

const SITE_ID = "wave96o-activity-cap";
const ACTIVITY_LIMIT = 20_000;
const READ_RANGE = { startMs: 0, endExclusiveMs: 30_000 } as const;

describe("Advanced filter fallback activity cap contract", () => {
  it("rejects an over-cap compiled activity read before evaluating or matching", async () => {
    const database = createMigratedDatabase();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const evaluator = vi.spyOn(filterEvaluator, "evaluateFilterDocument");

    try {
      database
        .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
        .run("wave96o-user", "wave96o@example.test");
      database
        .prepare(
          "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
        )
        .run("wave96o-team", "Wave96O", "wave96o", "wave96o-user");
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(SITE_ID);
      const identity = database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number };
      const sitePk = Number(identity.site_pk);
      database
        .prepare(
          "INSERT INTO sites (id, team_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(SITE_ID, "wave96o-team", "Wave96O", "example.test", 0);

      const insertVisit = database.prepare(`
        INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname
        ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?)
      `);
      database.exec("BEGIN");
      try {
        for (let index = 0; index <= ACTIVITY_LIMIT; index += 1) {
          const startedAt = index + 10;
          insertVisit.run(
            `wave96o-visit-${index}`,
            SITE_ID,
            sitePk,
            "wave96o-visitor",
            "wave96o-session",
            startedAt,
            startedAt,
            "/cap",
            "example.test",
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      const oracle = database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM visits
           WHERE site_id = ? AND started_at >= ? AND started_at < ?`,
        )
        .get(SITE_ID, READ_RANGE.startMs, READ_RANGE.endExclusiveMs) as {
        readonly count: number;
      };
      expect(Number(oracle.count)).toBe(ACTIVITY_LIMIT + 1);

      const time = createQueryTime(0, 30_000, "UTC", 30_000);
      const document = parseFilterDsl(
        "countDistinct(page) gte 0",
        analyticsFilterRegistry,
      );
      const plan = createScopedFilterPlan("overview", document, "session");
      if (!plan) throw new Error("expected_scoped_filter_plan");
      const filters = attachScopedFilterMetadata(document, {
        requestedScope: "session",
        resolvedScope: "session",
        plan,
        time,
        siteIds: [SITE_ID],
      });
      const input = {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        filters,
        scopePreference: "session" as const,
        scopePlan: plan,
        time,
      };
      const env = {
        DB: createSqliteD1Database(database, trace),
      } as unknown as Env;

      await expect(
        d1AdvancedFilterMiddleware(env)(
          "overview",
          input,
          async (prepared) => prepared,
        ),
      ).rejects.toMatchObject({
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(evaluator).not.toHaveBeenCalled();
      expect(trace.preparedSql).toHaveLength(2);
      expect(trace.preparedSql[0]).toContain('"sites"');
      expect(trace.preparedSql[1]).toContain('"visits"');
    } finally {
      evaluator.mockRestore();
      database.close();
    }
  });
});
