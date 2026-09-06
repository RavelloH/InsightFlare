#!/usr/bin/env tsx

import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import type {
  FunnelConfigV2,
  ScopedDatasetSql,
} from "@/lib/edge/analytics/contract";
import {
  assertFunnelSqlShapeWithinBudget,
  buildFunnelSqlPlan,
} from "@/lib/edge/analytics/providers/d1/internal/funnel-planner";

const SESSION_COUNT = 250;
const STEP_COUNT = 10;
const ITERATIONS = 5;

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildDataset(): ScopedDatasetSql {
  const visits: string[] = [];
  const events: string[] = [];
  let eventPk = 1;
  for (let sessionIndex = 0; sessionIndex < SESSION_COUNT; sessionIndex += 1) {
    const sessionId = `session-${sessionIndex}`;
    const visitorId = `visitor-${sessionIndex % 50}`;
    for (let stepIndex = 0; stepIndex < STEP_COUNT; stepIndex += 1) {
      const timestamp = sessionIndex * 10_000 + stepIndex * 10;
      if (stepIndex % 2 === 0) {
        visits.push(
          `(1, ${sqlText(sessionId)}, ${sqlText(visitorId)}, ${timestamp}, ${sqlText(`visit-${sessionIndex}-${stepIndex}`)}, ${sqlText(`/step-${stepIndex}`)})`,
        );
      } else {
        events.push(
          `(${eventPk++}, ${sqlText(`event-${sessionIndex}-${stepIndex}`)}, 1, ${sqlText(sessionId)}, ${sqlText(visitorId)}, ${timestamp}, 0, ${sqlText(`step-${stepIndex}`)}, '')`,
        );
      }
    }
    visits.push(
      `(1, ${sqlText(sessionId)}, ${sqlText(visitorId)}, ${sessionIndex * 10_000 + 99}, ${sqlText(`noise-${sessionIndex}`)}, '/noise')`,
    );
  }
  return {
    ctes: `
scope_final_visits(site_pk, session_id, visitor_id, started_at, visit_id, pathname) AS (
  VALUES ${visits.join(",\n")}
),
scope_final_events(event_pk, event_id, site_pk, session_id, visitor_id, occurred_at, sequence, event_name, pathname) AS (
  VALUES ${events.join(",\n")}
)`,
    bindings: [],
    visitRelation: "scope_final_visits",
    eventRelation: "scope_final_events",
    sessionRelation: "scope_final_sessions",
    visitorRelation: "scope_final_visitors",
    scope: "event",
  };
}

const config: FunnelConfigV2 = {
  filterDslVersion: 1,
  progressionScope: "visitor",
  conversionWindowMs: 1_000_000,
  steps: Array.from({ length: STEP_COUNT }, (_, index) => ({
    id: `step-${index}`,
    filterDsl:
      index % 2 === 0
        ? `(page.path eq "/step-${index}" OR page.path eq "/missing") AND NOT page.path eq "/noise"`
        : `(event.name eq "step-${index}" OR event.name eq "missing") AND NOT event.name eq "noise"`,
  })),
};

const dataset = buildDataset();
const plan = buildFunnelSqlPlan(config, dataset);
const zeroTailPlan = buildFunnelSqlPlan(
  {
    ...config,
    steps: config.steps.map((step, index) =>
      index === STEP_COUNT - 1
        ? { ...step, filterDsl: 'event.name eq "never-occurs"' }
        : step,
    ),
  },
  dataset,
);
assertFunnelSqlShapeWithinBudget(plan.shape);
assertFunnelSqlShapeWithinBudget(zeroTailPlan.shape);
const database = new DatabaseSync(":memory:");
try {
  const execute = database.prepare(plan.sql);
  const zeroTailExecute = database.prepare(zeroTailPlan.sql);
  const values = plan.bindings.map((binding) => binding.value);
  const zeroTailValues = zeroTailPlan.bindings.map((binding) => binding.value);
  for (let index = 0; index < 2; index += 1) execute.all(...values);
  const samples: number[] = [];
  let rows = 0;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const startedAt = performance.now();
    const result = execute.all(...values) as Array<{ visitors: number }>;
    samples.push(performance.now() - startedAt);
    rows = result.length;
    if (result.some((row) => Number(row.visitors) !== 50)) {
      throw new Error(
        `Funnel benchmark produced unexpected visitor counts: ${JSON.stringify(result)}`,
      );
    }
  }
  const zeroTailRows = zeroTailExecute.all(...zeroTailValues) as Array<{
    visitors: number;
  }>;
  const zeroTailVisitors = Number(zeroTailRows.at(-1)?.visitors ?? 0);
  if (zeroTailVisitors !== 0) {
    throw new Error(
      `Funnel benchmark did not preserve a zero tail: ${zeroTailVisitors}`,
    );
  }
  const median =
    [...samples].sort((left, right) => left - right)[
      Math.floor(samples.length / 2)
    ] ?? 0;
  process.stdout.write(
    `${JSON.stringify({
      benchmark: "funnel-v2-production-shaped-sqlite",
      sessions: SESSION_COUNT,
      steps: STEP_COUNT,
      resultRows: rows,
      sqlLength: plan.shape.sqlLength,
      funnelCteCount: plan.shape.funnelCteCount,
      bindingCount: plan.shape.bindingCount,
      zeroTailVisitors,
      medianMs: Math.round(median * 1000) / 1000,
    })}\n`,
  );
} finally {
  database.close();
}
