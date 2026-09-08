import { filterFingerprint } from "@/lib/edge/analytics/contract";
import type {
  GoalDefinition,
  GoalListData,
  GoalMutationData,
  GoalSummaryData,
  GoalTimeseriesData,
} from "@/lib/edge-client";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { demoBadRequest, demoNotFound } from "@/lib/realtime/mock/envelope";
import { demoPage } from "@/lib/realtime/mock/pagination";
import {
  buildDemoTimeBuckets,
  parseDemoTimeZone,
} from "@/lib/realtime/mock/shared";
import type { ErrorEnvelope } from "@/lib/response-envelope";

const CREATED_AT = 1_767_225_600;
let customGoalCounter = 0;

const demoGoals: GoalDefinition[] = [
  {
    id: "demo-goal-signup",
    siteId: "demo-site-001",
    name: "Signup completed",
    filterDslVersion: 1,
    filterDsl: 'event.name eq "signup_completed"',
    semanticFingerprint: "demo-goal-signup-v1",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT + 86_400,
  },
  {
    id: "demo-goal-purchase",
    siteId: "demo-site-001",
    name: "Purchase completed",
    filterDslVersion: 1,
    filterDsl: 'event.name eq "purchase"',
    semanticFingerprint: "demo-goal-purchase-v1",
    createdAt: CREATED_AT - 172_800,
    updatedAt: CREATED_AT + 43_200,
  },
  {
    id: "demo-goal-payload",
    siteId: "demo-site-001",
    name: "High-value purchase",
    filterDslVersion: 1,
    filterDsl: 'event.payload("/amount") gt 100',
    semanticFingerprint: "demo-goal-payload-v1",
    createdAt: CREATED_AT - 345_600,
    updatedAt: CREATED_AT,
  },
  {
    id: "demo-goal-trial",
    siteId: "demo-site-001",
    name: "Trial started",
    filterDslVersion: 1,
    filterDsl: 'event.name eq "trial_started"',
    semanticFingerprint: "demo-goal-trial-v1",
    createdAt: CREATED_AT - 518_400,
    updatedAt: CREATED_AT - 86_400,
  },
  {
    id: "demo-goal-subscription",
    siteId: "demo-site-001",
    name: "Subscription activated",
    filterDslVersion: 1,
    filterDsl: 'event.name eq "subscription_activated"',
    semanticFingerprint: "demo-goal-subscription-v1",
    createdAt: CREATED_AT - 691_200,
    updatedAt: CREATED_AT - 172_800,
  },
  {
    id: "demo-goal-contact",
    siteId: "demo-site-001",
    name: "Contact submitted",
    filterDslVersion: 1,
    filterDsl: 'event.name eq "contact_submitted"',
    semanticFingerprint: "demo-goal-contact-v1",
    createdAt: CREATED_AT - 864_000,
    updatedAt: CREATED_AT - 259_200,
  },
];

function siteGoals(siteId: string): GoalDefinition[] {
  return demoGoals
    .filter((goal) => goal.siteId === "demo-site-001")
    .map((goal) => ({ ...goal, siteId }));
}

function metric(total: number, converted: number) {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeConverted = Math.min(safeTotal, Math.max(0, Math.floor(converted)));
  return {
    total: safeTotal,
    converted: safeConverted,
    conversionRate: safeTotal > 0 ? safeConverted / safeTotal : 0,
  };
}

function summaryFor(goal: GoalDefinition): GoalSummaryData {
  const totalSessions = goal.id.includes("purchase") ? 2_450 : 3_180;
  const totalVisitors = goal.id.includes("purchase") ? 1_960 : 2_720;
  const converted = goal.id.includes("payload")
    ? 280
    : goal.id.includes("purchase")
      ? 640
      : 920;
  return {
    ok: true,
    data: {
      goal,
      summary: {
        sessions: metric(totalSessions, converted),
        visitors: metric(totalVisitors, Math.round(converted * 0.86)),
      },
    },
  };
}

function distribute(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from(
    { length: count },
    (_, index) => base + (index < remainder ? 1 : 0),
  );
}

function conversionBuckets(goal: GoalDefinition): {
  readonly sessions: readonly number[];
  readonly visitors: readonly number[];
} {
  if (goal.id.includes("purchase")) {
    return {
      sessions: [90, 85, 95, 90, 100, 90, 90],
      visitors: [100, 100, 100, 100, 100, 100, 100],
    };
  }
  if (goal.id.includes("payload")) {
    return {
      sessions: [40, 38, 42, 40, 40, 40, 40],
      visitors: [35, 34, 35, 35, 35, 35, 35],
    };
  }
  return {
    sessions: [130, 130, 132, 132, 132, 132, 132],
    visitors: [115, 115, 115, 115, 115, 115, 115],
  };
}

function timeseriesFor(
  goal: GoalDefinition,
  params: Record<string, string | number>,
): GoalTimeseriesData {
  const parseTimestamp = (
    value: string | number | undefined,
    fallback: number,
  ) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  };
  const to = parseTimestamp(params.to, Date.now());
  const from = parseTimestamp(params.from, to - 7 * 86_400_000);
  const intervalValue = String(params.interval ?? "day");
  const interval = (
    ["minute", "hour", "day", "week", "month"].includes(intervalValue)
      ? intervalValue
      : "day"
  ) as GoalTimeseriesData["data"]["interval"];
  const buckets = buildDemoTimeBuckets(
    from,
    to,
    interval,
    parseDemoTimeZone(params),
  );
  const count = Math.max(1, buckets.length);
  const base = summaryFor(goal).data.summary;
  const conversions = conversionBuckets(goal);
  const totalSessions = distribute(base.sessions.total, count);
  const totalVisitors = distribute(base.visitors.total, count);
  const sessionConversions = distributeByPattern(
    base.sessions.converted,
    totalSessions,
    conversions.sessions,
  );
  const visitorConversions = distributeByPattern(
    base.visitors.converted,
    totalVisitors,
    conversions.visitors,
  );
  const timeseries = buckets.map((bucket, index) => {
    return {
      timestampMs: bucket.timestampMs,
      sessions: metric(totalSessions[index]!, sessionConversions[index] ?? 0),
      visitors: metric(totalVisitors[index]!, visitorConversions[index] ?? 0),
    };
  });
  return {
    ok: true,
    data: {
      goal,
      interval: String(interval) as GoalTimeseriesData["data"]["interval"],
      timeseries,
    },
  };
}

function distributeByPattern(
  total: number,
  bucketTotals: readonly number[],
  pattern: readonly number[],
): number[] {
  if (bucketTotals.length === 0) return [];
  const safeTotal = Math.max(0, Math.floor(total));
  if (safeTotal === 0) return bucketTotals.map(() => 0);

  const capacities = bucketTotals.map((value) =>
    Math.max(0, Math.floor(value)),
  );
  const weights = bucketTotals.map((_, index) =>
    Math.max(0, pattern[index % Math.max(1, pattern.length)] ?? 0),
  );
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  if (weightTotal <= 0) return distribute(safeTotal, bucketTotals.length);

  const ideal = weights.map((weight) => (safeTotal * weight) / weightTotal);
  const allocations = ideal.map((value, index) =>
    Math.min(capacities[index] ?? 0, Math.floor(value)),
  );
  let remaining =
    safeTotal - allocations.reduce((sum, value) => sum + value, 0);

  while (remaining > 0) {
    let bestIndex = -1;
    let bestDeficit = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < allocations.length; index += 1) {
      if (allocations[index]! >= (capacities[index] ?? 0)) continue;
      const deficit = (ideal[index] ?? 0) - allocations[index]!;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    allocations[bestIndex] = (allocations[bestIndex] ?? 0) + 1;
    remaining -= 1;
  }

  return allocations;
}

export function generateDemoGoals(
  siteId: string,
  params: Record<string, string | number>,
): GoalListData | GoalSummaryData | GoalTimeseriesData | ErrorEnvelope {
  const id = String(params.id ?? "").trim();
  const goals = siteGoals(siteId);
  if (!id)
    return {
      ok: true,
      data: demoPage(
        goals,
        params,
        { operation: "goals", siteId, sort: "createdAt:desc,id:desc" },
        50,
        100,
      ),
    };
  const goal = goals.find((item) => item.id === id);
  if (!goal) return demoNotFound();
  return params.operation === "goal-timeseries" || String(params.interval ?? "")
    ? timeseriesFor(goal, params)
    : summaryFor(goal);
}

function input(body: unknown): { name: string; filterDsl: string } | null {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const filterDsl =
    typeof record.filterDsl === "string" ? record.filterDsl : "";
  if (!name || !filterDsl.trim()) return null;
  try {
    parseFilterDsl(filterDsl, analyticsFilterRegistry);
  } catch {
    return null;
  }
  return { name, filterDsl };
}

function demoGoalFingerprint(filterDsl: string): string {
  try {
    return `demo-goal-v1-${filterFingerprint(
      parseFilterDsl(filterDsl, analyticsFilterRegistry),
      analyticsFilterRegistry,
    )}`;
  } catch {
    return "demo-goal-invalid";
  }
}

export function createDemoGoal(
  siteId: string,
  body: unknown,
): GoalMutationData | ErrorEnvelope {
  const value = input(body);
  if (!value) return demoBadRequest("Invalid goal configuration");
  customGoalCounter += 1;
  const id = `demo-goal-custom-${customGoalCounter}`;
  const now = Math.floor(Date.now() / 1000);
  const goal: GoalDefinition = {
    id,
    siteId,
    ...value,
    filterDslVersion: 1,
    semanticFingerprint: demoGoalFingerprint(value.filterDsl),
    createdAt: now,
    updatedAt: now,
  };
  demoGoals.unshift(goal);
  return { ok: true, data: { goal: { ...goal } } };
}

export function updateDemoGoal(
  siteId: string,
  params: Record<string, string | number>,
  body: unknown,
): GoalMutationData | ErrorEnvelope {
  const id = String(params.id ?? "").trim();
  const index = demoGoals.findIndex(
    (goal) => goal.siteId === siteId && goal.id === id,
  );
  if (index < 0) return demoNotFound();
  const current = demoGoals[index]!;
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name =
    typeof record.name === "string" ? record.name.trim() : current.name;
  const filterDsl =
    typeof record.filterDsl === "string" ? record.filterDsl : current.filterDsl;
  if (!name || !filterDsl.trim())
    return demoBadRequest("Invalid goal configuration");
  try {
    parseFilterDsl(filterDsl, analyticsFilterRegistry);
  } catch {
    return demoBadRequest("Invalid goal configuration");
  }
  const next = {
    ...current,
    name,
    filterDsl,
    semanticFingerprint: demoGoalFingerprint(filterDsl),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  demoGoals[index] = next;
  return { ok: true, data: { goal: { ...next } } };
}

export function deleteDemoGoal(
  siteId: string,
  params: Record<string, string | number>,
): { ok: boolean } | ErrorEnvelope {
  const id = String(params.id ?? "").trim();
  const index = demoGoals.findIndex(
    (goal) => goal.siteId === siteId && goal.id === id,
  );
  if (index >= 0) demoGoals.splice(index, 1);
  return { ok: true };
}
