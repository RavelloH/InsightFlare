import type { OverviewMetricsLabels } from "@insightflare/product-ui/overview";

import type { AppMessages } from "@/lib/i18n/messages";

export function buildOverviewMetricsLabels(
  messages: AppMessages,
): OverviewMetricsLabels {
  return {
    views: messages.common.views,
    visitors: messages.common.visitors,
    sessions: messages.common.sessions,
    bounceRate: messages.common.bounceRate,
    pagesPerSession: messages.teamManagement.sites.pagesPerSession,
    avgDuration: messages.common.avgDuration,
  };
}
