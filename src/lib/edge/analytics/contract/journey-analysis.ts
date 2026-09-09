/**
 * Optional analysis context used by journey list queries.  This is an
 * internal dashboard capability; it is intentionally not part of the public
 * API v1 filter contract.
 */
export type JourneyAnalysisContext =
  | {
      readonly type: "goal";
      readonly goalId: string;
    }
  | {
      readonly type: "funnel";
      readonly funnelId: string;
      readonly stepId: string;
    };
