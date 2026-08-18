export interface FunnelStep {
  type: "pageview" | "event";
  value: string;
}

export interface FunnelDefinition {
  id: string;
  siteId: string;
  name: string;
  steps: FunnelStep[];
  createdAt: number;
  updatedAt: number;
}

export interface FunnelAnalysisStep {
  index: number;
  label: string;
  type: FunnelStep["type"];
  sessions: number;
  visitors: number;
  conversionRate: number;
  stepConversionRate: number;
  dropOffSessions: number;
  dropOffRate: number;
}

export interface FunnelAnalysis {
  steps: FunnelAnalysisStep[];
  summary: {
    totalSessions: number;
    convertedSessions: number;
    totalVisitors: number;
    convertedVisitors: number;
    overallConversionRate: number;
    largestDropOffStepIndex: number | null;
  };
}

export interface FunnelListData {
  ok: boolean;
  data: {
    funnels: FunnelDefinition[];
  };
}

export interface FunnelDetailData {
  ok: boolean;
  data: {
    funnel: FunnelDefinition;
    analysis: FunnelAnalysis;
  };
}

export type FunnelAnalysisData = FunnelDetailData;

export interface FunnelMutationData {
  ok: boolean;
  data: {
    funnel: FunnelDefinition;
  };
}

export interface FunnelDeleteData {
  ok: boolean;
}
