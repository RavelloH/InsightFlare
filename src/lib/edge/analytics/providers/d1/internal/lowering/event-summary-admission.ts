import { and, constant, eq, filter, lte, semiJoin } from "@/lib/db";
import type {
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

export interface AnalyticsQualificationAdmissionPolicy {
  readonly primaryReportSourceRelationId: RelationId;
  readonly reportSourceRelations: readonly {
    readonly relationId: RelationId;
    readonly entity: "event" | "page";
  }[];
  readonly reportRelationIds: readonly RelationId[];
  readonly controlsRelationId: RelationId;
  readonly controlSlots: readonly {
    readonly name: string;
    readonly slot: SlotId;
  }[];
  readonly scope: "session" | "visitor" | "event";
  readonly candidateGrain?: "event-candidate";
  readonly eventCandidateReportProjection?: "page-visits";
  readonly maximumActivities: number;
  readonly numericCompatibilityControlNames: readonly string[];
}

export type AnalyticsQualificationAdmissionControlPolicy = Pick<
  AnalyticsQualificationAdmissionPolicy,
  "scope" | "maximumActivities" | "numericCompatibilityControlNames"
>;

/** Compatibility shape for the existing Event qualification call sites. */
export interface EventQualificationAdmissionPolicy extends Omit<
  AnalyticsQualificationAdmissionPolicy,
  "primaryReportSourceRelationId" | "eventCandidateReportProjection"
> {
  readonly eventSourceRelationId: RelationId;
}

export interface EventAdmissionControlReaders {
  readonly numeric: (
    name: string,
  ) => SqlExpression<
    number | null,
    ExpressionResultType<"integer" | "real" | "numeric", boolean>
  >;
  readonly text: (
    name: string,
  ) => SqlExpression<string | null, ExpressionResultType<"text", boolean>>;
}

/** Build the single admitted-control relation shared by source and report gates. */
export function createAnalyticsQualificationAdmittedControls(input: {
  readonly controls: AnalyticsDbRelation;
  readonly readers: EventAdmissionControlReaders;
  readonly policy: AnalyticsQualificationAdmissionControlPolicy;
}): AnalyticsDbRelation {
  const predicates: Predicate[] = [
    lte(
      input.readers.numeric("rawCount"),
      constant(input.policy.maximumActivities),
    ),
    eq(input.readers.numeric("nullActivityIdCount"), constant(0)),
    eq(input.readers.numeric("siteIdentityMismatchCount"), constant(0)),
    eq(input.readers.text("entityKind"), constant(input.policy.scope)),
    eq(input.readers.numeric("invalidIdentityCount"), constant(0)),
    eq(input.readers.numeric("duplicateIdentityCount"), constant(0)),
    ...input.policy.numericCompatibilityControlNames.map((name) =>
      eq(input.readers.numeric(name), constant(0)),
    ),
  ];
  const [firstPredicate, ...otherPredicates] = predicates;
  if (!firstPredicate)
    throw new Error("analytics_event_summary_admission_controls_missing");
  return filter(input.controls, and(firstPredicate, ...otherPredicates));
}

export function createEventQualificationAdmittedControls(input: {
  readonly controls: AnalyticsDbRelation;
  readonly readers: EventAdmissionControlReaders;
  readonly policy: EventQualificationAdmissionPolicy;
}): AnalyticsDbRelation {
  return createAnalyticsQualificationAdmittedControls({
    ...input,
    policy: {
      scope: input.policy.scope,
      maximumActivities: input.policy.maximumActivities,
      numericCompatibilityControlNames:
        input.policy.numericCompatibilityControlNames,
    },
  });
}

/** Gate a report relation with the same materialized controls as its source. */
export function applyAnalyticsQualificationAdmissionGate(
  relation: AnalyticsDbRelation,
  admittedControls: AnalyticsDbRelation,
): AnalyticsDbRelation {
  return semiJoin(relation, admittedControls, eq(constant(1), constant(1)));
}

export const applyEventQualificationAdmissionGate =
  applyAnalyticsQualificationAdmissionGate;
