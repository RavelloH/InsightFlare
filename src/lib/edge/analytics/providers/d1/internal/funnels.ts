import {
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
} from "@/lib/db";
import type { QueryWindow } from "@/lib/edge/analytics/contract";
import {
  type FilterDocument,
  type FunnelAnalysis,
  type FunnelConfigV2,
  type FunnelDefinition,
} from "@/lib/edge/analytics/contract";
import {
  decodeFunnelConfig,
  funnelSemanticFingerprint,
} from "@/lib/edge/analytics/contract/funnel-config";
import {
  buildFunnelProgressionReportPlan,
  FUNNEL_PROGRESSION_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/funnel-progression-report-plan";
import type { Env } from "@/lib/edge/types";

import {
  analysisDefinitionByIdQuery,
  analysisDefinitionsPageQuery,
  archiveAnalysisDefinition,
  insertAnalysisDefinition,
  updateAnalysisDefinition,
} from "./analysis-definition-queries";
import { queryAnalyticsReportOutputRowsFromD1 } from "./analytics-report-query";
import { encodeD1FunnelConfig } from "./funnel-config-validation";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  pageResult,
  paginationBinding,
} from "./pagination";
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
  const result = await createD1DatabaseClient(env.DB).all(
    compileD1Query(
      analysisDefinitionsPageQuery({
        kind: FUNNEL_ANALYSIS_KIND,
        siteId,
        limit: limit + 1,
        cursor,
      }),
      { tag: "analytics.funnels.page" },
    ),
  );
  const mapped = await Promise.all(result.results.map(mapFunnelDefinition));
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
  const result = await createD1DatabaseClient(env.DB).all(
    compileD1Query(
      analysisDefinitionByIdQuery({
        kind: FUNNEL_ANALYSIS_KIND,
        siteId,
        id: funnelId,
      }),
      { tag: "analytics.funnels.detail" },
    ),
  );
  const row = result.results[0];
  return row ? mapFunnelDefinition(row) : null;
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
  const logical = buildFunnelProgressionReportPlan({
    siteId,
    window,
    filters,
    config,
  });
  const rows = await queryAnalyticsReportOutputRowsFromD1(
    env,
    logical.plan,
    FUNNEL_PROGRESSION_REPORT_OUTPUT,
  );
  return analysisFromRows(config, rows);
}
export async function createFunnelDefinition(
  env: Env,
  siteId: string,
  name: string,
  config: FunnelConfigV2,
): Promise<FunnelDefinition> {
  const encoded = encodeD1FunnelConfig(config);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      insertAnalysisDefinition({
        id,
        siteId,
        kind: FUNNEL_ANALYSIS_KIND,
        name,
        configJson: encoded.configJson,
        configVersion: encoded.configVersion,
        timestamp: now,
      }),
      { tag: "analytics.funnels.insert" },
    ),
  );
  const funnel = await queryFunnelDefinition(env, siteId, id);
  if (!funnel) throw new Error("funnel_create_readback_failed");
  return funnel;
}
export async function updateFunnelDefinition(
  env: Env,
  siteId: string,
  funnelId: string,
  name: string,
  config: FunnelConfigV2,
): Promise<FunnelDefinition> {
  const encoded = encodeD1FunnelConfig(config);
  const now = Math.floor(Date.now() / 1_000);
  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      updateAnalysisDefinition({
        kind: FUNNEL_ANALYSIS_KIND,
        siteId,
        id: funnelId,
        name,
        configJson: encoded.configJson,
        configVersion: encoded.configVersion,
        timestamp: now,
      }),
      { tag: "analytics.funnels.update" },
    ),
  );
  const funnel = await queryFunnelDefinition(env, siteId, funnelId);
  if (!funnel) throw new Error("funnel_update_readback_failed");
  return funnel;
}
export async function archiveFunnelDefinition(
  env: Env,
  siteId: string,
  funnelId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      archiveAnalysisDefinition({
        kind: FUNNEL_ANALYSIS_KIND,
        siteId,
        id: funnelId,
        timestamp: now,
      }),
      { tag: "analytics.funnels.archive" },
    ),
  );
}
