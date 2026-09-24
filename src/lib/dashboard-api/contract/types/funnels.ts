import type { PaginatedCollection } from "./pagination";

export interface FunnelStep {
  id: string;
  name?: string;
  filterDsl: string;
}

export interface FunnelDefinition {
  id: string;
  siteId: string;
  name: string;
  filterDslVersion: 1;
  progressionScope: "session" | "visitor";
  conversionWindowMs: number | null;
  steps: FunnelStep[];
  semanticFingerprint: string;
  createdAt: number;
  updatedAt: number;
}

export interface FunnelAnalysisStep {
  stepId: string;
  index: number;
  sessions: number;
  visitors: number;
  progression: {
    count: number;
    conversionRate: number;
    stepConversionRate: number;
    dropOffCount: number;
    dropOffRate: number;
  };
}

export interface FunnelAnalysis {
  progressionScope: "session" | "visitor";
  steps: FunnelAnalysisStep[];
  summary: {
    totalProgressions: number;
    convertedProgressions: number;
    overallConversionRate: number;
    largestDropOffStepIndex: number | null;
  };
}

export interface FunnelListData {
  ok: boolean;
  data: PaginatedCollection<FunnelDefinition>;
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
