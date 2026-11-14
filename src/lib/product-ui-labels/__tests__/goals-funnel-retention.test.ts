import { describe, expect, it } from "vitest";

import { getMessages } from "@/lib/i18n/messages";
import { buildFunnelVisualizationLabels } from "@/lib/product-ui-labels/funnel";
import {
  buildGoalTimeseriesLabels,
  buildGoalVisualizationLabels,
} from "@/lib/product-ui-labels/goals";
import { buildRetentionLabels } from "@/lib/product-ui-labels/retention";

describe("goal, funnel, and retention label builders", () => {
  const messages = getMessages("en");

  it("keeps the goal conversion labels identical to the legacy composition", () => {
    const labels = buildGoalVisualizationLabels(messages.goals);
    expect(labels.visitors).toBe(messages.goals.visitors);
    expect(labels.sessions).toBe(messages.goals.sessions);
    expect(labels.visitorConversion).toBe(
      `${messages.goals.visitors} ${messages.goals.conversion}`,
    );
    expect(labels.visitorConversionComparison).toBe(
      `${messages.goals.visitors} ${messages.goals.conversion} comparison`,
    );
  });

  it("exposes only the series names for the goal timeseries", () => {
    expect(buildGoalTimeseriesLabels(messages.goals)).toEqual({
      visitors: messages.goals.visitors,
      sessions: messages.goals.sessions,
    });
  });

  it("picks the converted label for each funnel progression scope", () => {
    const labels = buildFunnelVisualizationLabels(messages.funnels);
    expect(labels.sessions).toEqual({
      overallConversion: messages.funnels.overallConversion,
      converted: messages.funnels.convertedSessions,
    });
    expect(labels.visitors).toEqual({
      overallConversion: messages.funnels.overallConversion,
      converted: messages.funnels.convertedVisitors,
    });
  });

  it("maps retention copy and the comparison heading", () => {
    const labels = buildRetentionLabels(messages);
    expect(labels.periodLabel).toBe(messages.retention.periodLabel);
    expect(labels.cohortDate).toBe(messages.retention.cohortDate);
    expect(labels.compareCurrentPeriod).toBe(
      messages.dashboardHeader.compareCurrentPeriod,
    );
    expect(Object.values(labels).every((value) => value.length > 0)).toBe(true);
  });
});
