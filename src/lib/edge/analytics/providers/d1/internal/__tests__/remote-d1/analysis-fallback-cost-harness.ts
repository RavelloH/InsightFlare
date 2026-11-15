import { createHash } from "node:crypto";

import { expect, vi } from "vitest";

import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  type CanonicalQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as membership from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import * as preparedMembership from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

import { errorEvidence, observeStatementAttempts } from "./cost-guards";
import {
  buildJourneyEventFieldsCostFixture,
  NEXT_FUNNEL_ID,
} from "./journey-event-fields-cost-fixture";
import {
  COST_TIME,
  observeCostDatabase,
  summarizeCost,
} from "./referrers-cost-harness";
import { SEED_SITE_ID } from "./seed";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const ANALYSIS_FALLBACK_EXTRA_SETUP = [
  `INSERT INTO analysis_definitions (id,site_id,kind,name,config_json,config_version,created_at,updated_at) VALUES ('w12-cost-goal',${literal(SEED_SITE_ID)},'goal','W12 cost goal',${literal(JSON.stringify({ filterDslVersion: 1, filterDsl: 'page.path eq "/qualifier"' }))},1,0,0)`,
  `INSERT INTO analysis_definitions (id,site_id,kind,name,config_json,config_version,created_at,updated_at) VALUES ('w12-cost-visitor-funnel',${literal(SEED_SITE_ID)},'funnel','W12 visitor funnel',${literal(
    JSON.stringify({
      filterDslVersion: 1,
      progressionScope: "visitor",
      conversionWindowMs: 7 * 86400000,
      steps: [
        { id: "landing", filterDsl: 'page.path eq "/qualifier"' },
        { id: "qualified", filterDsl: 'event.name eq "qualifier"' },
      ],
    }),
  )},2,0,0)`,
  "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='v1'",
] as const;

export function buildAnalysisFallbackCostFixture(visits: number) {
  const base = buildJourneyEventFieldsCostFixture(visits);
  const seed = [...base.seed, ...ANALYSIS_FALLBACK_EXTRA_SETUP];
  return {
    schemaSql: base.schemaSql,
    seed,
    baseFixtureFingerprint: base.fingerprint,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([base.schemaSql, seed]))
      .digest("hex"),
  };
}

export const ANALYSIS_FALLBACK_SCENARIOS = (
  ["visitors", "sessions"] as const
).flatMap((operation) =>
  (["session", "visitor"] as const).flatMap((scope) =>
    (["goal", "funnel"] as const).map((analysis) => ({
      operation,
      scope,
      analysis,
      name: `${operation}/${scope}/${analysis}`,
    })),
  ),
);
export type AnalysisFallbackScenario =
  (typeof ANALYSIS_FALLBACK_SCENARIOS)[number];
export type AnalysisFallbackRoute = "old-bridge" | "request-relation";

export function analysisFallbackRequest(
  scenario: AnalysisFallbackScenario,
  cursor: string | null = null,
): CanonicalQuery<"visitors"> {
  return {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: COST_TIME,
    scopePreference: scenario.scope,
    filters: parseFilterDsl(
      "count(page { page.durationMs gt 5 }) gte 1",
      analyticsFilterRegistry,
    ),
    analysisContext:
      scenario.analysis === "goal"
        ? { type: "goal", goalId: "w12-cost-goal" }
        : {
            type: "funnel",
            funnelId:
              scenario.operation === "visitors"
                ? "w12-cost-visitor-funnel"
                : NEXT_FUNNEL_ID,
            stepId: "qualified",
          },
    page: { limit: 3, cursor },
    sort: {
      key: scenario.operation === "visitors" ? "lastSeenAt" : "startedAt",
      direction: "desc",
    },
  };
}

/** The only forced seam disables the new fallback preparer for the old route. */
export async function executeAnalysisFallbackCost(
  database: D1Database,
  scenario: AnalysisFallbackScenario,
  route: AnalysisFallbackRoute,
  cursor: string | null = null,
  record: Record<string, unknown> = {},
) {
  const attempted = observeStatementAttempts(database);
  const measured = observeCostDatabase(attempted.database);
  const bridge = vi.spyOn(preparedMembership, "registerPreparedMembership");
  const core = vi.spyOn(evaluator, "evaluateFilterDocument");
  const old =
    route === "old-bridge"
      ? vi
          .spyOn(membership, "prepareEventMembershipFallback")
          .mockResolvedValue(undefined)
      : undefined;
  const diagnostics = createD1ReadDiagnostics();
  const request = analysisFallbackRequest(scenario, cursor);
  const started = performance.now();
  Object.assign(record, {
    route,
    scenario: scenario.name,
    cursor,
    request,
    requestFingerprint: createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex"),
    status: "running",
    statementAttempts: attempted.attempts,
    statementDetail: measured.observations,
  });
  try {
    const runtime = createD1SiteQueryRuntime({
      env: {
        DB: measured.database,
        MAIN_SECRET: "w12-analysis-membership-secret",
      } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    });
    const result = await runtime.execute(scenario.operation, request, {
      onProviderError(error) {
        record.providerError = errorEvidence(error);
        throw error;
      },
    });
    record.result = result;
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(core.mock.calls.length).toBeGreaterThan(0);
    expect(bridge.mock.calls.length).toBe(route === "old-bridge" ? 1 : 0);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    record.status = "passed";
    return result;
  } catch (error) {
    record.status = "failed";
    record.error = errorEvidence(error);
    throw error;
  } finally {
    Object.assign(record, {
      diagnostics,
      bridgeCalls: bridge.mock.calls.length,
      coreCalls: core.mock.calls.length,
      elapsedMs: performance.now() - started,
      ...summarizeCost(measured.observations),
    });
    old?.mockRestore();
    bridge.mockRestore();
    core.mockRestore();
  }
}
