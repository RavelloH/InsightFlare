import type { Env } from "@/lib/edge/types";

import type { DashboardFilters, QueryWindow } from "./core";
import {
  badRequest,
  buildEventAnalyticsSourceCte,
  buildEventFilterSql,
  buildVisitFilterSql,
  buildVisitSourceCte,
  eventSourceBindings,
  jsonResponseWith,
  notAllowed,
  notFound,
  parseFilters,
  parseWindow,
  queryD1All,
  type ResponseContext,
  visitSourceBindings,
} from "./core";

const FUNNEL_ANALYSIS_KIND = "funnel";
const MAX_FUNNEL_STEPS = 12;

export interface FunnelStepConfig {
  type: "pageview" | "event";
  value: string;
}

export interface FunnelDefinition {
  id: string;
  siteId: string;
  name: string;
  steps: FunnelStepConfig[];
  createdAt: number;
  updatedAt: number;
}

export interface FunnelEvent {
  sessionId: string;
  visitorId: string;
  type: FunnelStepConfig["type"];
  value: string;
  timestampMs: number;
  sourceOrder: number;
  sourceId: string;
}

export interface FunnelAnalysisStep {
  index: number;
  label: string;
  type: FunnelStepConfig["type"];
  sessions: number;
  visitors: number;
  conversionRate: number;
  stepConversionRate: number;
  dropOffSessions: number;
  dropOffRate: number;
}

export interface FunnelAnalysis {
  steps: FunnelAnalysisStep[];
  summary: {
    totalSessions: number;
    convertedSessions: number;
    totalVisitors: number;
    convertedVisitors: number;
    overallConversionRate: number;
    largestDropOffStepIndex: number | null;
  };
}

function isFunnelStepType(value: unknown): value is FunnelStepConfig["type"] {
  return value === "pageview" || value === "event";
}

export function normalizeFunnelSteps(input: unknown): FunnelStepConfig[] {
  if (!Array.isArray(input)) return [];

  const steps: FunnelStepConfig[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!isFunnelStepType(record.type)) continue;
    const value = String(record.value ?? "").trim();
    if (!value) continue;
    steps.push({ type: record.type, value });
    if (steps.length >= MAX_FUNNEL_STEPS) break;
  }
  return steps;
}

function parseFunnelSteps(configJson: string): FunnelStepConfig[] {
  try {
    const parsed = JSON.parse(configJson) as
      | FunnelStepConfig[]
      | { steps?: FunnelStepConfig[] };
    return normalizeFunnelSteps(Array.isArray(parsed) ? parsed : parsed.steps);
  } catch {
    return [];
  }
}

function serializeFunnelConfig(steps: FunnelStepConfig[]): string {
  return JSON.stringify({ steps });
}

function mapFunnelDefinition(row: Record<string, unknown>): FunnelDefinition {
  return {
    id: String(row.id ?? ""),
    siteId: String(row.site_id ?? ""),
    name: String(row.name ?? ""),
    steps: parseFunnelSteps(String(row.config_json ?? "{}")),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export async function queryFunnelDefinitions(
  env: Env,
  siteId: string,
): Promise<FunnelDefinition[]> {
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    "SELECT id, site_id, kind, name, config_json, created_at, updated_at FROM analysis_definitions WHERE site_id = ? AND kind = ? AND archived_at IS NULL ORDER BY created_at DESC",
    [siteId, FUNNEL_ANALYSIS_KIND],
  );
  return rows.map(mapFunnelDefinition);
}

export async function queryFunnelDefinition(
  env: Env,
  siteId: string,
  funnelId: string,
): Promise<FunnelDefinition | null> {
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    "SELECT id, site_id, kind, name, config_json, created_at, updated_at FROM analysis_definitions WHERE id = ? AND site_id = ? AND kind = ? AND archived_at IS NULL LIMIT 1",
    [funnelId, siteId, FUNNEL_ANALYSIS_KIND],
  );
  return rows[0] ? mapFunnelDefinition(rows[0]) : null;
}

function uniqueStepValues(
  steps: FunnelStepConfig[],
  type: FunnelStepConfig["type"],
): string[] {
  return Array.from(
    new Set(
      steps
        .filter((step) => step.type === type)
        .map((step) => step.value)
        .filter(Boolean),
    ),
  );
}

async function queryFunnelPageviewEvents(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  steps: FunnelStepConfig[],
): Promise<FunnelEvent[]> {
  const values = uniqueStepValues(steps, "pageview");
  if (values.length === 0) return [];

  const filter = buildVisitFilterSql(filters, "vs");
  const filterClause = filter.clause
    ? `AND ${filter.clause.replace(/^WHERE\s+/i, "")}`
    : "";
  const sql = `
WITH ${buildVisitSourceCte()}
SELECT
  vs.session_id AS sessionId,
  vs.visitor_id AS visitorId,
  vs.pathname AS value,
  vs.started_at AS timestampMs,
  vs.visit_id AS sourceId
FROM visit_source vs
WHERE TRIM(COALESCE(vs.session_id, '')) != ''
  ${filterClause}
  AND vs.pathname IN (${values.map(() => "?").join(", ")})
ORDER BY timestampMs ASC, sourceId ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...filter.bindings,
    ...values,
  ]);

  return rows.map((row) => ({
    sessionId: String(row.sessionId ?? ""),
    visitorId: String(row.visitorId ?? ""),
    type: "pageview" as const,
    value: String(row.value ?? ""),
    timestampMs: Number(row.timestampMs ?? 0),
    sourceOrder: 0,
    sourceId: String(row.sourceId ?? ""),
  }));
}

async function queryFunnelCustomEvents(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  steps: FunnelStepConfig[],
): Promise<FunnelEvent[]> {
  const values = uniqueStepValues(steps, "event");
  if (values.length === 0) return [];

  const filter = buildEventFilterSql(filters, "es");
  const filterClause = filter.clause
    ? `AND ${filter.clause.replace(/^WHERE\s+/i, "")}`
    : "";
  const sql = `
WITH
${buildVisitSourceCte()},
${buildEventAnalyticsSourceCte({ eventNames: values })}
SELECT
  es.session_id AS sessionId,
  es.visitor_id AS visitorId,
  es.event_name AS value,
  es.occurred_at AS timestampMs,
  COALESCE(es.sequence, 0) AS sequence,
  es.event_id AS sourceId
FROM event_source es
WHERE TRIM(COALESCE(es.session_id, '')) != ''
  ${filterClause}
ORDER BY timestampMs ASC, sequence ASC, sourceId ASC
`;
  const rows = await queryD1All<Record<string, unknown>>(env, sql, [
    ...visitSourceBindings(siteId, window),
    ...eventSourceBindings(siteId, window, values),
    ...filter.bindings,
  ]);

  return rows.map((row) => ({
    sessionId: String(row.sessionId ?? ""),
    visitorId: String(row.visitorId ?? ""),
    type: "event" as const,
    value: String(row.value ?? ""),
    timestampMs: Number(row.timestampMs ?? 0),
    sourceOrder: 1,
    sourceId: String(row.sourceId ?? ""),
  }));
}

function compareFunnelEvents(left: FunnelEvent, right: FunnelEvent): number {
  if (left.timestampMs !== right.timestampMs) {
    return left.timestampMs - right.timestampMs;
  }
  if (left.sourceOrder !== right.sourceOrder) {
    return left.sourceOrder - right.sourceOrder;
  }
  return left.sourceId.localeCompare(right.sourceId);
}

function groupEventsBySession(
  events: FunnelEvent[],
): Map<string, FunnelEvent[]> {
  const sessions = new Map<string, FunnelEvent[]>();
  for (const event of events) {
    if (!event.sessionId) continue;
    const group = sessions.get(event.sessionId) ?? [];
    group.push(event);
    sessions.set(event.sessionId, group);
  }
  for (const group of sessions.values()) {
    group.sort(compareFunnelEvents);
  }
  return sessions;
}

export function analyzeFunnelEvents(
  steps: FunnelStepConfig[],
  events: FunnelEvent[],
): FunnelAnalysis {
  const sessions = groupEventsBySession(events);
  const sessionCounts = steps.map(() => 0);
  const visitorSets = steps.map(() => new Set<string>());

  for (const group of sessions.values()) {
    let cursor = 0;
    let visitorId = "";

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const matchIndex = group.findIndex(
        (event, eventIndex) =>
          eventIndex >= cursor &&
          event.type === step.type &&
          event.value === step.value,
      );
      if (matchIndex === -1) break;

      const match = group[matchIndex];
      cursor = matchIndex + 1;
      visitorId = match.visitorId || visitorId;
      sessionCounts[index] += 1;
      if (visitorId) visitorSets[index].add(visitorId);
    }
  }

  const totalSessions = sessionCounts[0] ?? 0;
  const totalVisitors = visitorSets[0]?.size ?? 0;
  let largestDropOffStepIndex: number | null = null;
  let largestDropOffSessions = 0;

  const analyzedSteps = steps.map((step, index) => {
    const sessionsAtStep = sessionCounts[index] ?? 0;
    const previousSessions =
      index === 0 ? sessionsAtStep : (sessionCounts[index - 1] ?? 0);
    const dropOffSessions =
      index === 0 ? 0 : Math.max(0, previousSessions - sessionsAtStep);
    if (index > 0 && dropOffSessions > largestDropOffSessions) {
      largestDropOffSessions = dropOffSessions;
      largestDropOffStepIndex = index;
    }

    return {
      index,
      label: step.value,
      type: step.type,
      sessions: sessionsAtStep,
      visitors: visitorSets[index]?.size ?? 0,
      conversionRate: totalSessions > 0 ? sessionsAtStep / totalSessions : 0,
      stepConversionRate:
        index === 0
          ? sessionsAtStep > 0
            ? 1
            : 0
          : previousSessions > 0
            ? sessionsAtStep / previousSessions
            : 0,
      dropOffSessions,
      dropOffRate:
        index === 0 || previousSessions <= 0
          ? 0
          : dropOffSessions / previousSessions,
    };
  });

  const convertedStep = analyzedSteps[analyzedSteps.length - 1];

  return {
    steps: analyzedSteps,
    summary: {
      totalSessions,
      convertedSessions: convertedStep?.sessions ?? 0,
      totalVisitors,
      convertedVisitors: convertedStep?.visitors ?? 0,
      overallConversionRate:
        totalSessions > 0 ? (convertedStep?.sessions ?? 0) / totalSessions : 0,
      largestDropOffStepIndex,
    },
  };
}

export async function queryFunnelAnalysis(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  steps: FunnelStepConfig[],
): Promise<FunnelAnalysis> {
  const [pageviews, events] = await Promise.all([
    queryFunnelPageviewEvents(env, siteId, window, filters, steps),
    queryFunnelCustomEvents(env, siteId, window, filters, steps),
  ]);
  return analyzeFunnelEvents(steps, [...pageviews, ...events]);
}

async function handleFunnelList(
  env: Env,
  siteId: string,
  ctx?: ResponseContext,
): Promise<Response> {
  return jsonResponseWith(ctx!, {
    ok: true,
    funnels: await queryFunnelDefinitions(env, siteId),
  });
}

async function handleFunnelDetail(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const funnelId = url.searchParams.get("id")?.trim();
  if (!funnelId) return handleFunnelList(env, siteId, ctx);

  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const funnel = await queryFunnelDefinition(env, siteId, funnelId);
  if (!funnel) return notFound();
  if (funnel.steps.length < 2) {
    return badRequest("Funnel has fewer than 2 steps");
  }

  const filters = parseFilters(url);
  const analysis = await queryFunnelAnalysis(
    env,
    siteId,
    window,
    filters,
    funnel.steps,
  );

  return jsonResponseWith(ctx!, { ok: true, funnel, analysis });
}

async function handleFunnelCreate(
  env: Env,
  siteId: string,
  request: Request,
  ctx?: ResponseContext,
): Promise<Response> {
  let body: { name?: string; steps?: unknown };
  try {
    body = (await request.json()) as { name?: string; steps?: unknown };
  } catch {
    return badRequest("Invalid JSON body");
  }

  const name = String(body.name ?? "").trim();
  if (!name) return badRequest("Name is required");

  const steps = normalizeFunnelSteps(body.steps);
  if (steps.length < 2) return badRequest("At least 2 steps are required");

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO analysis_definitions (id, site_id, kind, name, config_json, config_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  )
    .bind(
      id,
      siteId,
      FUNNEL_ANALYSIS_KIND,
      name,
      serializeFunnelConfig(steps),
      now,
      now,
    )
    .run();

  return jsonResponseWith(
    ctx!,
    {
      ok: true,
      funnel: { id, siteId, name, steps, createdAt: now, updatedAt: now },
    },
    201,
  );
}

async function handleFunnelDelete(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const funnelId = url.searchParams.get("id")?.trim();
  if (!funnelId) return badRequest("Funnel id is required");

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE analysis_definitions SET archived_at = ?, updated_at = ? WHERE id = ? AND site_id = ? AND kind = ? AND archived_at IS NULL",
  )
    .bind(now, now, funnelId, siteId, FUNNEL_ANALYSIS_KIND)
    .run();

  return jsonResponseWith(ctx!, { ok: true });
}

export async function handleFunnel(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  request?: Request,
): Promise<Response> {
  const method = request?.method ?? "GET";
  if (method === "GET") return handleFunnelDetail(env, siteId, url, ctx);
  if (method === "POST" && request) {
    return handleFunnelCreate(env, siteId, request, ctx);
  }
  if (method === "DELETE") return handleFunnelDelete(env, siteId, url, ctx);
  return notAllowed();
}
