import {
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type FunnelAnalysis,
  type FunnelConfigV2,
  type FunnelDefinition,
  parsePrivateFilterUrl,
} from "@/lib/edge/analytics/contract";
import {
  decodeFunnelConfig,
  encodeFunnelConfig,
  FunnelConfigValidationError,
  funnelSemanticFingerprint,
} from "@/lib/edge/analytics/contract/funnel-config";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  jsonResponseWith,
  notAllowed,
  notFound,
  parseWindow,
  queryD1All,
  type QueryWindow,
  type ResponseContext,
} from "./core";
import { buildFunnelSqlPlan } from "./funnel-planner";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  pageResult,
  paginationBinding,
} from "./pagination";
import { compileScopedDatasetSql, scopedDatasetFor } from "./scoped-dataset";

const FUNNEL_ANALYSIS_KIND = "funnel";

export type {
  FunnelAnalysis,
  FunnelAnalysisStep,
  FunnelDefinition,
  FunnelStepV2 as FunnelStepConfig,
} from "@/lib/edge/analytics/contract";

function rowConfig(row: Record<string, unknown>): FunnelConfigV2 {
  return decodeFunnelConfig(
    Number(row.config_version ?? 1),
    String(row.config_json ?? ""),
  );
}

async function mapFunnelDefinition(
  row: Record<string, unknown>,
): Promise<FunnelDefinition> {
  const config = rowConfig(row);
  return {
    id: String(row.id ?? ""),
    siteId: String(row.site_id ?? ""),
    name: String(row.name ?? ""),
    filterDslVersion: config.filterDslVersion,
    progressionScope: config.progressionScope,
    conversionWindowMs: config.conversionWindowMs,
    steps: [...config.steps],
    semanticFingerprint: await funnelSemanticFingerprint(config),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

interface FunnelDefinitionCursor {
  readonly createdAt: number;
  readonly id: string;
}

function funnelDefinitionCursor(value: unknown): FunnelDefinitionCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["createdAt", "id"]) &&
    typeof candidate.id === "string" &&
    Number.isSafeInteger(candidate.createdAt)
    ? { id: candidate.id, createdAt: candidate.createdAt as number }
    : null;
}

async function funnelCursorBinding(siteId: string): Promise<string> {
  return paginationBinding(["funnels-v2", siteId, "createdAt:desc,id:desc"]);
}

export async function queryFunnelDefinitionsPage(
  env: Env,
  siteId: string,
  limit: number,
  cursor?: FunnelDefinitionCursor | null,
) {
  const cursorClause = cursor
    ? "AND (created_at < ? OR (created_at = ? AND id < ?))"
    : "";
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    `SELECT id, site_id, name, config_json, config_version, created_at, updated_at
     FROM analysis_definitions
     WHERE site_id = ? AND kind = ? AND archived_at IS NULL
     ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [
      siteId,
      FUNNEL_ANALYSIS_KIND,
      ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
      limit + 1,
    ],
  );
  const mapped = await Promise.all(rows.map(mapFunnelDefinition));
  const page = pageResult(mapped, limit);
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, await funnelCursorBinding(siteId), {
          createdAt: page.last.createdAt,
          id: page.last.id,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function decodeFunnelDefinitionCursor(
  env: Env,
  siteId: string,
  cursor?: string | null,
): Promise<FunnelDefinitionCursor | null> {
  return decodePageCursor<FunnelDefinitionCursor>(
    env,
    await funnelCursorBinding(siteId),
    cursor,
    "funnels",
    funnelDefinitionCursor,
  );
}

export async function queryFunnelDefinition(
  env: Env,
  siteId: string,
  funnelId: string,
): Promise<FunnelDefinition | null> {
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    "SELECT id, site_id, name, config_json, config_version, created_at, updated_at FROM analysis_definitions WHERE id = ? AND site_id = ? AND kind = ? AND archived_at IS NULL LIMIT 1",
    [funnelId, siteId, FUNNEL_ANALYSIS_KIND],
  );
  return rows[0] ? mapFunnelDefinition(rows[0]) : null;
}

function baseFunnelDataset(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
) {
  const existing = scopedDatasetFor(siteId, window, filters);
  if (existing) return existing;

  // A no-filter private request has no prepared metadata. It still gets the
  // canonical relation bundle before Step filters are applied.
  const plan = createScopedFilterPlan(
    "funnel-analysis",
    EMPTY_FILTER_DOCUMENT,
    "event",
  );
  if (!plan) throw new Error("funnel_scope_unavailable");
  return compileScopedDatasetSql({
    filters: EMPTY_FILTER_DOCUMENT,
    plan,
    siteIds: [siteId],
    window,
  });
}

function numberRow(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) && result > 0 ? Math.floor(result) : 0;
}

interface FunnelCountRow {
  readonly stepIndex?: unknown;
  readonly sessions?: unknown;
  readonly visitors?: unknown;
}

function analysisFromRows(
  config: FunnelConfigV2,
  rows: readonly FunnelCountRow[],
): FunnelAnalysis {
  const counts = config.steps.map((step, index) => {
    const row = rows.find((candidate) => Number(candidate.stepIndex) === index);
    const sessions = numberRow(row?.sessions);
    const visitors = numberRow(row?.visitors);
    return {
      step,
      index,
      sessions,
      visitors,
      count: config.progressionScope === "session" ? sessions : visitors,
    };
  });
  const firstCount = counts[0]?.count ?? 0;
  const convertedCount = counts.at(-1)?.count ?? 0;
  let largestDropOffStepIndex: number | null = null;
  let largestDropOff = 0;
  const steps = counts.map((entry, index) => {
    const previous =
      index === 0 ? entry.count : (counts[index - 1]?.count ?? 0);
    const dropOffCount = index === 0 ? 0 : Math.max(0, previous - entry.count);
    if (index > 0 && dropOffCount > largestDropOff) {
      largestDropOff = dropOffCount;
      largestDropOffStepIndex = index;
    }
    return {
      stepId: entry.step.id,
      index,
      sessions: entry.sessions,
      visitors: entry.visitors,
      progression: {
        count: entry.count,
        conversionRate: firstCount > 0 ? entry.count / firstCount : 0,
        stepConversionRate: previous > 0 ? entry.count / previous : 0,
        dropOffCount,
        dropOffRate: previous > 0 ? dropOffCount / previous : 0,
      },
    };
  });
  return {
    progressionScope: config.progressionScope,
    steps,
    summary: {
      totalProgressions: firstCount,
      convertedProgressions: convertedCount,
      overallConversionRate: firstCount > 0 ? convertedCount / firstCount : 0,
      largestDropOffStepIndex,
    },
  };
}

export async function queryFunnelAnalysis(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  config: FunnelConfigV2,
): Promise<FunnelAnalysis> {
  const plan = buildFunnelSqlPlan(
    config,
    baseFunnelDataset(siteId, window, filters),
    { allowHistoricalOverLimit: true },
  );
  const rows = await queryD1All<FunnelCountRow>(
    env,
    plan.sql,
    plan.bindings.map((binding) => binding.value),
  );
  return analysisFromRows(config, rows);
}

async function handleFunnelList(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(200, Math.max(1, limitParam))
    : 50;
  const cursorText = url.searchParams.get("cursor");
  const cursor = await decodeFunnelDefinitionCursor(env, siteId, cursorText);
  if (cursorText && !cursor) return badRequest("Invalid cursor");
  const page = await queryFunnelDefinitionsPage(env, siteId, limit, cursor);
  return jsonResponseWith(ctx!, { ok: true, data: page });
}

async function handleFunnelDetail(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const funnelId = url.searchParams.get("id")?.trim();
  if (!funnelId) return handleFunnelList(env, siteId, url, ctx);
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const funnel = await queryFunnelDefinition(env, siteId, funnelId);
  if (!funnel) return notFound();
  if (funnel.steps.length < 2)
    return badRequest("Funnel has fewer than 2 steps");
  const config: FunnelConfigV2 = {
    filterDslVersion: funnel.filterDslVersion,
    progressionScope: funnel.progressionScope,
    conversionWindowMs: funnel.conversionWindowMs,
    steps: funnel.steps,
  };
  const analysis = await queryFunnelAnalysis(
    env,
    siteId,
    window,
    parsePrivateFilterUrl(url),
    config,
  );
  return jsonResponseWith(ctx!, { ok: true, data: { funnel, analysis } });
}

interface FunnelWriteBody {
  readonly name?: unknown;
  readonly filterDslVersion?: unknown;
  readonly progressionScope?: unknown;
  readonly conversionWindowMs?: unknown;
  readonly steps?: unknown;
}

function readWriteConfig(
  body: FunnelWriteBody,
): { name: string; config: FunnelConfigV2 } | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const filterDslVersion = body.filterDslVersion ?? 1;
  const progressionScope = body.progressionScope ?? "session";
  const conversionWindowMs =
    body.conversionWindowMs === undefined ? null : body.conversionWindowMs;
  if (
    !name ||
    !Array.isArray(body.steps) ||
    filterDslVersion !== 1 ||
    (progressionScope !== "session" && progressionScope !== "visitor") ||
    (conversionWindowMs !== null &&
      (typeof conversionWindowMs !== "number" ||
        !Number.isFinite(conversionWindowMs)))
  ) {
    return null;
  }
  return {
    name,
    config: {
      filterDslVersion,
      progressionScope,
      conversionWindowMs,
      steps: body.steps as FunnelConfigV2["steps"],
    },
  };
}

async function handleFunnelCreate(
  env: Env,
  siteId: string,
  request: Request,
  ctx?: ResponseContext,
): Promise<Response> {
  let body: FunnelWriteBody;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return badRequest("Invalid JSON body");
    }
    body = parsed as FunnelWriteBody;
  } catch {
    return badRequest("Invalid JSON body");
  }
  const input = readWriteConfig(body);
  if (!input) return badRequest("Invalid funnel configuration");
  let encoded;
  try {
    encoded = encodeFunnelConfig(input.config);
  } catch (error) {
    if (error instanceof FunnelConfigValidationError) {
      return badRequest("Invalid funnel configuration");
    }
    throw error;
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    "INSERT INTO analysis_definitions (id, site_id, kind, name, config_json, config_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      siteId,
      FUNNEL_ANALYSIS_KIND,
      input.name,
      encoded.configJson,
      encoded.configVersion,
      now,
      now,
    )
    .run();
  const funnel = await queryFunnelDefinition(env, siteId, id);
  if (!funnel) throw new Error("funnel_create_readback_failed");
  return jsonResponseWith(ctx!, { ok: true, data: { funnel } }, 201);
}

async function handleFunnelUpdate(
  env: Env,
  siteId: string,
  url: URL,
  request: Request,
  ctx?: ResponseContext,
): Promise<Response> {
  const funnelId = url.searchParams.get("id")?.trim();
  if (!funnelId) return badRequest("Funnel id is required");
  const current = await queryFunnelDefinition(env, siteId, funnelId);
  if (!current) return notFound();
  let body: FunnelWriteBody;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return badRequest("Invalid JSON body");
    }
    body = parsed as FunnelWriteBody;
  } catch {
    return badRequest("Invalid JSON body");
  }
  const filterDslVersion =
    body.filterDslVersion === undefined
      ? current.filterDslVersion
      : body.filterDslVersion;
  const progressionScope =
    body.progressionScope === undefined
      ? current.progressionScope
      : body.progressionScope;
  const conversionWindowMs =
    body.conversionWindowMs === undefined
      ? current.conversionWindowMs
      : body.conversionWindowMs;
  if (
    filterDslVersion !== 1 ||
    (progressionScope !== "session" && progressionScope !== "visitor") ||
    (conversionWindowMs !== null &&
      (typeof conversionWindowMs !== "number" ||
        !Number.isFinite(conversionWindowMs)))
  ) {
    return badRequest("Invalid funnel configuration");
  }
  const config: FunnelConfigV2 = {
    filterDslVersion,
    progressionScope,
    conversionWindowMs,
    steps: (body.steps ?? current.steps) as FunnelConfigV2["steps"],
  };
  if (body.name !== undefined && typeof body.name !== "string") {
    return badRequest("Name is required");
  }
  const name = body.name === undefined ? current.name : body.name.trim();
  if (!name) return badRequest("Name is required");
  let encoded;
  try {
    encoded = encodeFunnelConfig(config);
  } catch (error) {
    if (error instanceof FunnelConfigValidationError) {
      return badRequest("Invalid funnel configuration");
    }
    throw error;
  }
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    "UPDATE analysis_definitions SET name=?, config_json=?, config_version=?, updated_at=? WHERE id=? AND site_id=? AND kind=? AND archived_at IS NULL",
  )
    .bind(
      name,
      encoded.configJson,
      encoded.configVersion,
      now,
      funnelId,
      siteId,
      FUNNEL_ANALYSIS_KIND,
    )
    .run();
  const funnel = await queryFunnelDefinition(env, siteId, funnelId);
  if (!funnel) throw new Error("funnel_update_readback_failed");
  return jsonResponseWith(ctx!, { ok: true, data: { funnel } });
}

async function handleFunnelDelete(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const funnelId = url.searchParams.get("id")?.trim();
  if (!funnelId) return badRequest("Funnel id is required");
  const now = Math.floor(Date.now() / 1_000);
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
  if (method === "POST" && request)
    return handleFunnelCreate(env, siteId, request, ctx);
  if (method === "PATCH" && request)
    return handleFunnelUpdate(env, siteId, url, request, ctx);
  if (method === "DELETE") return handleFunnelDelete(env, siteId, url, ctx);
  return notAllowed();
}
