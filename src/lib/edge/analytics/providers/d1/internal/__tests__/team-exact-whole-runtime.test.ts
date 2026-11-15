// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1TeamQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { createFixture } from "@/lib/edge/analytics/composition/d1/__tests__/team-sites-membership-fixture";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import * as exactPlan from "@/lib/edge/analytics/engine/team-exact-dimension-plan";
import * as stage from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as team from "@/lib/edge/analytics/providers/d1/internal/team";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const AUTHORIZED = ["b04-site-a", "b04-site-b"];
const SCENARIOS = [
  {
    name: "bare-sequence/full-history",
    dsl: 'sequence([page { page.path eq "/q" },event { event.name eq "qualifier" }]) exists',
    nonempty: true,
  },
  {
    name: "captured-dimension-after-listing",
    dsl: 'sequence([page { page.path eq "/q" },event { event.name eq "qualifier" }]) exists',
    nonempty: true,
  },
  {
    name: "independent-filter-range",
    dsl: 'time gte @now-195ms and time lt @now-175ms and count(event { event.name eq "qualifier" }) gte 1',
    nonempty: true,
  },
  {
    name: "payload-count-existing-error",
    dsl: 'count(event { event.payload("/plan") eq "pro" }) gt 0',
    nonempty: false,
  },
  {
    name: "payload-empty-matches",
    dsl: 'sequence([page { page.path eq "/q" },event { event.name eq "qualifier" }]) exists and count(event { event.payload("/plan") eq "pro" }) gt 0',
    nonempty: false,
  },
] as const;

afterEach(() => vi.restoreAllMocks());
describe.sequential("Team exact Page whole-original joint dependency", () => {
  for (const scope of ["session", "visitor"] as const) {
    for (const scenario of SCENARIOS) {
      it(`${scope}/${scenario.name}`, async () => {
        const db = createFixture();
        // The existing fixture shares session/visitor spelling across authorized
        // A/B and unauthorized C. Give Page鈫扙vent sequence strict order.
        db.exec(
          "UPDATE custom_events SET occurred_at=occurred_at+1; PRAGMA query_only=ON",
        );
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const registered = vi.spyOn(bridge, "registerPreparedMembership");
        const resolved = vi.spyOn(bridge, "resolvePreparedMembership");
        const staged = vi.spyOn(stage, "executeAnalyticsLogicalStage");
        const evaluated = vi.spyOn(core, "evaluateFilterDocument");
        const providerErrors: unknown[] = [];
        let observedOwner:
          | Parameters<typeof exactPlan.planTeamExactDimensionExecution>[0]
          | undefined;
        let dimensionMutations = 0;
        if (scenario.name === "captured-dimension-after-listing") {
          const originalDecision = exactPlan.planTeamExactDimensionExecution;
          vi.spyOn(
            exactPlan,
            "planTeamExactDimensionExecution",
          ).mockImplementation((value) => {
            observedOwner = value;
            return originalDecision(value);
          });
          const originalList = team.listTeamSites;
          vi.spyOn(team, "listTeamSites").mockImplementation(
            async (...args) => {
              const rows = await originalList(...args);
              if (!observedOwner)
                throw new Error("actual Team reader owner was not observed");
              Object.assign(observedOwner, { dimension: "client.browser" });
              dimensionMutations++;
              return rows;
            },
          );
        }
        try {
          const result = await createD1TeamQueryRuntime({
            env: {
              DB: createSqliteD1Database(db, trace),
              MAIN_SECRET: "w140-local-only",
            } as Env,
          }).execute(
            "dimension",
            {
              context: teamQueryContext(
                "b04-team",
                "private-dashboard",
                AUTHORIZED,
              ),
              teamId: "b04-team",
              allowedSiteIds: AUTHORIZED,
              time: createQueryTime(100, 200, "UTC", 300),
              scopePreference: scope,
              mode: "breakdown",
              dimension: "page.path",
              limit: 20,
              filters: parseFilterDsl(scenario.dsl, analyticsFilterRegistry),
            },
            {
              onProviderError(error) {
                providerErrors.push(error);
              },
            },
          );
          if (scenario.name === "payload-count-existing-error") {
            expect(providerErrors).toHaveLength(1);
            expect(providerErrors[0]).toBeInstanceOf(Error);
            expect((providerErrors[0] as Error).message).toBe(
              "advanced_count_plan_missing_payload_property",
            );
            expect(result).toEqual({
              ok: false,
              error: { kind: "internal", operation: "dimension" },
            });
            expect(evaluated).not.toHaveBeenCalled();
            expect(registered).not.toHaveBeenCalled();
            expect(resolved).not.toHaveBeenCalled();
            expect(staged).toHaveBeenCalledTimes(1);
            expect(trace.preparedSql).toHaveLength(1);
            expect(trace.bindings).toHaveLength(trace.preparedSql.length);
            return;
          }
          expect(providerErrors).toEqual([]);
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("expected actual Team Page success");
          if (!("items" in result.data))
            throw new Error("expected Team breakdown items");
          if (scenario.name === "captured-dimension-after-listing")
            expect(dimensionMutations).toBe(1);
          if (scenario.nonempty) {
            expect(result.data.items).toEqual([
              { key: "/p", label: "/p", views: 3, sessions: 2, visitors: 2 },
              { key: "/q", label: "/q", views: 2, sessions: 2, visitors: 2 },
            ]);
          } else expect(result.data.items).toEqual([]);
          expect(staged.mock.calls.map(([command]) => command.kind)).toEqual([
            "whole-original-completion-at-original-checkpoint",
          ]);
          if (scenario.name === "bare-sequence/full-history")
            expect(evaluated).toHaveBeenCalledTimes(2);
          expect(registered).not.toHaveBeenCalled();
          expect(resolved).not.toHaveBeenCalled();
          expect(trace.preparedSql.length).toBeGreaterThan(0);
          expect(trace.bindings).toHaveLength(trace.preparedSql.length);
        } finally {
          vi.restoreAllMocks();
        }
      });
    }
  }
});
