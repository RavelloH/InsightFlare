import type { FunnelVisualizationLabels } from "@insightflare/product-ui/funnel";

import type { AppMessages } from "@/lib/i18n/messages";

export interface FunnelVisualizationLabelsByScope {
  readonly sessions: FunnelVisualizationLabels;
  readonly visitors: FunnelVisualizationLabels;
}

export function buildFunnelVisualizationLabels(
  funnels: Pick<
    AppMessages["funnels"],
    "overallConversion" | "convertedSessions" | "convertedVisitors"
  >,
): FunnelVisualizationLabelsByScope {
  return {
    sessions: {
      overallConversion: funnels.overallConversion,
      converted: funnels.convertedSessions,
    },
    visitors: {
      overallConversion: funnels.overallConversion,
      converted: funnels.convertedVisitors,
    },
  };
}
