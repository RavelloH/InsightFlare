import type { PaginatedCollection } from "./pagination";

export interface GoalDefinition {
  id: string;
  siteId: string;
  name: string;
  filterDslVersion: 1;
  filterDsl: string;
  semanticFingerprint: string;
  createdAt: number;
  updatedAt: number;
}

export interface GoalMetric {
  total: number;
  converted: number;
  conversionRate: number;
}

export interface GoalSummary {
  sessions: GoalMetric;
  visitors: GoalMetric;
}

export interface GoalTimeseriesPoint {
  timestampMs: number;
  sessions: GoalMetric;
  visitors: GoalMetric;
}

export interface GoalListData {
  ok: boolean;
  data: PaginatedCollection<GoalDefinition>;
}

export interface GoalSummaryData {
  ok: boolean;
  data: { goal: GoalDefinition; summary: GoalSummary };
}

export interface GoalTimeseriesData {
  ok: boolean;
  data: {
    goal: GoalDefinition;
    interval: "minute" | "hour" | "day" | "week" | "month";
    timeseries: GoalTimeseriesPoint[];
  };
}

export interface GoalMutationData {
  ok: boolean;
  data: { goal: GoalDefinition };
}

export interface GoalDeleteData {
  ok: boolean;
}
