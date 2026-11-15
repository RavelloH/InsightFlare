import type { AnalyticsDbRelation } from "./analytics-relational-storage";

/** Already lowered explicit Source predecessors. Each value is ordinary DBIR,
 * projected from that SourceMembershipInput's declared site/member slots. */
export interface SourceMembershipRelations {
  readonly entity?: AnalyticsDbRelation;
  readonly visit?: AnalyticsDbRelation;
  readonly event?: AnalyticsDbRelation;
}

export interface ExplicitSourceMembershipRelations {
  readonly sourceInputs: SourceMembershipRelations;
}
export type ScopedQualificationRelations =
  ReadonlyMap<string, AnalyticsDbRelation> | ExplicitSourceMembershipRelations;
