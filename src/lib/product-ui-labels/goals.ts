import type {
  GoalTimeseriesLabels,
  GoalVisualizationLabels,
} from "@insightflare/product-ui/goals";

import type { AppMessages } from "@/lib/i18n/messages";

export function buildGoalTimeseriesLabels(
  goals: Pick<AppMessages["goals"], "visitors" | "sessions">,
): GoalTimeseriesLabels {
  return { visitors: goals.visitors, sessions: goals.sessions };
}

export function buildGoalVisualizationLabels(
  goals: Pick<AppMessages["goals"], "visitors" | "sessions" | "conversion">,
): GoalVisualizationLabels {
  const visitorConversion = `${goals.visitors} ${goals.conversion}`;
  return {
    visitors: goals.visitors,
    sessions: goals.sessions,
    visitorConversion,
    visitorConversionComparison: `${visitorConversion} comparison`,
  };
}
