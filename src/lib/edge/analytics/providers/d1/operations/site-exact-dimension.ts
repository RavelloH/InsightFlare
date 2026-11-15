import "@tanstack/react-start/server-only";

import {
  isSiteExactDimensionRequest,
  siteExactDimensionQualificationForRequest,
  type SiteExactDimensionRequest,
} from "@/lib/edge/analytics/application/site-exact-dimension";
import type { BreakdownResult } from "@/lib/edge/analytics/contract";
import { crossBreakdownPageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { siteExactDimensionQualificationConsumerKey } from "@/lib/edge/analytics/providers/d1/internal/dimension-top-qualification";
import { queryDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { assertPageVisitQualificationPreparationContext } from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import type { Env } from "@/lib/edge/types";

/** Complete per-site input for a team merge; never a public dimension page. */
export async function readSiteExactDimension(
  env: Env,
  request: SiteExactDimensionRequest,
): Promise<BreakdownResult> {
  if (!isSiteExactDimensionRequest(request))
    throw new Error("site_exact_dimension_request_context_mismatch");
  const selection = crossBreakdownPageDimensionSelection(request.dimension);
  if (!selection || request.context.subject.kind !== "site")
    throw new Error("site_exact_dimension_unsupported_report");
  const qualification = siteExactDimensionQualificationForRequest(request);
  if (qualification)
    assertPageVisitQualificationPreparationContext({
      preparation: qualification.preparation,
      siteId: request.context.subject.siteId,
      filters: request.filters,
      queryTime: request.time,
      scopePlan: request.scopePlan!,
      consumerKey: siteExactDimensionQualificationConsumerKey(
        request.dimension,
      ),
    });
  const time = request.time;
  const rows = await queryDimensionFromD1(
    env,
    request.context.subject.siteId,
    {
      startMs: time.range.startMs,
      endExclusiveMs: time.range.endExclusiveMs,
      nowMs: time.capturedAtMs,
      timeZone: time.reportingTimeZone,
    },
    request.filters,
    0,
    selection,
    { excludeEmpty: true },
    undefined,
    qualification
      ? {
          preparation: qualification.preparation,
          queryTime: request.time,
          scopePlan: request.scopePlan!,
          consumer: "site-exact-dimension",
        }
      : undefined,
  );
  return {
    items: rows.map((row) => ({
      key: row.value,
      label: row.value,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
  };
}
