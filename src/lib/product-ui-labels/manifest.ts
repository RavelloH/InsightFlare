import type { AppMessages } from "@/lib/i18n/messages";
import {
  buildEventMetricLabels,
  buildEventTrendCardLabels,
} from "@/lib/product-ui-labels/events";
import { buildFunnelVisualizationLabels } from "@/lib/product-ui-labels/funnel";
import {
  buildGoalTimeseriesLabels,
  buildGoalVisualizationLabels,
} from "@/lib/product-ui-labels/goals";
import { buildOverviewMetricsLabels } from "@/lib/product-ui-labels/overview";
import {
  buildRealtimeLogStreamLabels,
  buildRealtimeStatusLabels,
  buildRealtimeTrafficTrendLabels,
} from "@/lib/product-ui-labels/realtime";
import { buildRetentionLabels } from "@/lib/product-ui-labels/retention";
import {
  buildBrowserCrossBreakdownLabels,
  buildBrowserRadarLabels,
  buildBrowserShareOverviewLabels,
  buildBrowserVersionBreakdownLabels,
  buildDeviceCrossBreakdownLabels,
  buildDeviceShareOverviewLabels,
} from "@/lib/product-ui-labels/technology";

export const productUiLabelBuilders = {
  overviewMetrics: buildOverviewMetricsLabels,
  realtimeTrafficTrend: buildRealtimeTrafficTrendLabels,
  realtimeStatus: buildRealtimeStatusLabels,
  realtimeLogStream: buildRealtimeLogStreamLabels,
  eventMetrics: buildEventMetricLabels,
  eventTrendCard: buildEventTrendCardLabels,
  goalTimeseries: (messages: AppMessages) =>
    buildGoalTimeseriesLabels(messages.goals),
  goalVisualization: (messages: AppMessages) =>
    buildGoalVisualizationLabels(messages.goals),
  funnelVisualization: (messages: AppMessages) =>
    buildFunnelVisualizationLabels(messages.funnels),
  retention: buildRetentionLabels,
  browserShareOverview: buildBrowserShareOverviewLabels,
  deviceShareOverview: buildDeviceShareOverviewLabels,
  browserRadar: buildBrowserRadarLabels,
  browserCrossBreakdown: buildBrowserCrossBreakdownLabels,
  deviceCrossBreakdown: buildDeviceCrossBreakdownLabels,
  browserVersionBreakdown: buildBrowserVersionBreakdownLabels,
} as const;
