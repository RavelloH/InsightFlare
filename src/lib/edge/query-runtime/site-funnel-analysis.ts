import type { QueryWindow } from "@/lib/edge/query/core-types";
import {
  type FunnelAnalysis,
  type FunnelDefinition,
  queryFunnelAnalysis,
  queryFunnelDefinition,
} from "@/lib/edge/query/funnels";
import type { FilterDocument } from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

export interface SiteFunnelAnalysisInput {
  readonly env: Env;
  readonly siteId: string;
  readonly funnelId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
}

export interface SiteFunnelAnalysisResult {
  readonly funnel: FunnelDefinition;
  readonly analysis: FunnelAnalysis;
}

/** Runtime provider boundary for the typed API v1 funnel-analysis operation. */
export async function readSiteFunnelAnalysis(
  input: SiteFunnelAnalysisInput,
): Promise<SiteFunnelAnalysisResult | null> {
  const funnel = await queryFunnelDefinition(
    input.env,
    input.siteId,
    input.funnelId,
  );
  if (!funnel || funnel.steps.length < 2) return null;
  const analysis = await queryFunnelAnalysis(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    funnel.steps,
  );
  return { funnel, analysis };
}
