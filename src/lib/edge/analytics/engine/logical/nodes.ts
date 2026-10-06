import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import type { LogicalGrain } from "@/lib/edge/analytics/engine/logical/grain";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { SemanticAttributeId } from "@/lib/edge/analytics/engine/semantic/attributes";
import type { AnalyticsEntityKind } from "@/lib/edge/analytics/engine/semantic/entities";
import type { EventPayloadOccurrenceField } from "@/lib/edge/analytics/engine/semantic/event-payload-occurrences";
import type { SemanticRelationshipId } from "@/lib/edge/analytics/engine/semantic/relationships";
import type { SemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import type { TemporalDomainRef } from "@/lib/edge/analytics/engine/semantic/time";

export interface LogicalNodeBase {
  readonly id: RelationId;
  readonly output: readonly SlotId[];
  readonly grain: LogicalGrain;
}

export type SourceValueBinding =
  | { readonly kind: "self"; readonly slot: SlotId }
  | {
      readonly kind: "related-entity";
      readonly slot: SlotId;
      readonly relationship: SemanticRelationshipId;
    }
  | {
      readonly kind: "attribute";
      readonly slot: SlotId;
      readonly attribute: SemanticAttributeId;
    }
  | { readonly kind: "occurrence-time"; readonly slot: SlotId };

export interface SourceNode extends LogicalNodeBase {
  readonly kind: "source";
  readonly entity: AnalyticsEntityKind;
  readonly temporalDomain: TemporalDomainRef;
  readonly selection?: SemanticScopedSourceSelection;
  readonly values: readonly SourceValueBinding[];
}

export interface RelationshipLookupNode extends LogicalNodeBase {
  readonly kind: "relationship-lookup";
  readonly input: RelationId;
  readonly relationship: SemanticRelationshipId;
  readonly inputKey: SlotId;
  readonly relatedSlot: SlotId;
  /** Identity reads use the entity key and do not filter relationship evidence by activity time. */
  readonly timeSemantics: "identity-no-activity-filter";
}

export interface FilterNode extends LogicalNodeBase {
  readonly kind: "filter";
  readonly input: RelationId;
  readonly predicate: LogicalExpr;
}

/** Expands the stored occurrence bag for an already selected Event relation. */
export interface EventPayloadOccurrencesNode extends LogicalNodeBase {
  readonly kind: "event-payload-occurrences";
  readonly input: RelationId;
  readonly eventKey: SlotId;
  readonly eventPk: SlotId;
  readonly fields: readonly {
    readonly field: EventPayloadOccurrenceField;
    readonly slot: SlotId;
  }[];
}

export interface ProjectBinding {
  readonly slot: SlotId;
  readonly expression: LogicalExpr;
}

export interface ProjectNode extends LogicalNodeBase {
  readonly kind: "project";
  readonly input: RelationId;
  readonly projections: readonly ProjectBinding[];
}

export type LogicalAggregateMeasure =
  | { readonly kind: "count-rows"; readonly output: SlotId }
  | {
      readonly kind: "count-distinct";
      readonly input: LogicalExpr;
      readonly output: SlotId;
    }
  | {
      readonly kind: "sum" | "avg" | "min" | "max";
      readonly input: LogicalExpr;
      readonly output: SlotId;
    };

export interface AggregateNode extends LogicalNodeBase {
  readonly kind: "aggregate";
  readonly input: RelationId;
  readonly groups: readonly ProjectBinding[];
  readonly measures: readonly LogicalAggregateMeasure[];
}

export interface SampleStatisticsGroupBinding extends ProjectBinding {
  readonly name: string;
}

export interface SampleStatisticsPercentile {
  readonly name: string;
  readonly percentile: number;
  readonly output: SlotId;
}

/** Exact nearest-rank statistics over a bag of non-NULL numeric samples. */
export interface SampleStatisticsNode extends LogicalNodeBase {
  readonly kind: "sample-statistics";
  readonly input: RelationId;
  readonly groups: readonly SampleStatisticsGroupBinding[];
  readonly value: LogicalExpr;
  readonly samplesOutput: SlotId;
  readonly averageOutput: SlotId;
  readonly percentiles: readonly SampleStatisticsPercentile[];
}

export interface DistinctKeyBinding {
  readonly input: SlotId;
  readonly output: SlotId;
}

export interface DistinctNode extends LogicalNodeBase {
  readonly kind: "distinct";
  readonly input: RelationId;
  readonly keys: readonly DistinctKeyBinding[];
  readonly excludeNull: boolean;
}

export interface SetOperationNode extends LogicalNodeBase {
  readonly kind: "set-operation";
  readonly operation: "union" | "intersect" | "difference";
  readonly inputs: readonly RelationId[];
}

export interface RowConcatenationColumn {
  readonly name: string;
  readonly output: SlotId;
  /** One visible scalar/bucket slot for each input, in input order. */
  readonly inputs: readonly SlotId[];
}

/** Bag-preserving positional row concatenation (SQL UNION ALL semantics). */
export interface RowConcatenationNode extends LogicalNodeBase {
  readonly kind: "row-concatenation";
  readonly inputs: readonly RelationId[];
  readonly columns: readonly RowConcatenationColumn[];
}

export function setOperationResultNullable(
  operation: SetOperationNode["operation"],
  inputNullability: readonly boolean[],
): boolean {
  switch (operation) {
    case "union":
      return inputNullability.some(Boolean);
    case "intersect":
      return inputNullability.every(Boolean);
    case "difference":
      return inputNullability[0]!;
  }
}

export interface JoinKey {
  readonly left: SlotId;
  readonly right: SlotId;
}

export interface SemiJoinNode extends LogicalNodeBase {
  readonly kind: "semi-join";
  readonly left: RelationId;
  readonly right: RelationId;
  readonly keys: readonly JoinKey[];
}

export interface AntiJoinNode extends LogicalNodeBase {
  readonly kind: "anti-join";
  readonly left: RelationId;
  readonly right: RelationId;
  readonly keys: readonly JoinKey[];
}

export interface RightSlotAlias {
  readonly source: SlotId;
  readonly alias: SlotId;
}

export interface JoinNode extends LogicalNodeBase {
  readonly kind: "join";
  readonly joinType: "inner" | "left";
  readonly left: RelationId;
  readonly right: RelationId;
  readonly keys: readonly JoinKey[];
  /** Left joins alias right-side values with nullable slot metadata. */
  readonly rightAliases: readonly RightSlotAlias[];
}

export interface SortKey {
  readonly slot: SlotId;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
}

export interface SortNode extends LogicalNodeBase {
  readonly kind: "sort";
  readonly input: RelationId;
  readonly keys: readonly SortKey[];
}

/** Selects the first input row in each SQL NULL-equal group. */
export interface OrderedMemberNode extends LogicalNodeBase {
  readonly kind: "ordered-member";
  readonly input: RelationId;
  readonly groups: readonly SlotId[];
  readonly order: readonly SortKey[];
}

/** Adds a deterministic one-based ordinal without changing the input bag. */
export interface RankedMembersNode extends LogicalNodeBase {
  readonly kind: "ranked-members";
  readonly input: RelationId;
  readonly groups: readonly SlotId[];
  readonly order: readonly SortKey[];
  readonly rankSlot: SlotId;
}

export interface LimitNode extends LogicalNodeBase {
  readonly kind: "limit";
  readonly input: RelationId;
  readonly count: number;
}

export interface AnalysisResultFieldMapping {
  readonly field: string;
  readonly slot: SlotId;
}

/** Imports an independently validated scalar/keyed analysis result. */
export interface AnalysisResultNode extends LogicalNodeBase {
  readonly kind: "analysis-result";
  readonly childPlan: LogicalPlan;
  readonly outputId: string;
  readonly mappings: readonly AnalysisResultFieldMapping[];
}

export type LogicalNode =
  | SourceNode
  | RelationshipLookupNode
  | FilterNode
  | EventPayloadOccurrencesNode
  | ProjectNode
  | AggregateNode
  | SampleStatisticsNode
  | DistinctNode
  | SetOperationNode
  | RowConcatenationNode
  | SemiJoinNode
  | AntiJoinNode
  | JoinNode
  | OrderedMemberNode
  | RankedMembersNode
  | SortNode
  | LimitNode
  | AnalysisResultNode;
