import type {
  AnyInListExpression,
  RelationScope,
} from "@/lib/db/query/expression";
import type {
  FilterNode,
  JoinNode,
  LogicalQueryNode,
  OutputField,
  ProjectNode,
  QuerySource,
  ScanNode,
  ValuesRelationNode,
  WindowNode,
  WindowOrderKey,
} from "@/lib/db/query/plan";
import type { DatabaseBinding } from "@/lib/db/types";

import type { PhysicalConditionalLookupChoice } from "./conditional-lookup";
import type { PhysicalLexicographicComparisonChoice } from "./lexicographic-comparison";
import type { PhysicalRowPipelineChoice } from "./row-pipeline";
import type { PhysicalSelfMembershipChoice } from "./self-membership";
import type { PhysicalSemiMembershipChoice } from "./semi-membership";
import type { PhysicalSemiMembershipCostSelection } from "./semi-membership-cost";

export type { PhysicalLexicographicComparisonChoice } from "./lexicographic-comparison";
export type { PhysicalRowPipelineChoice } from "./row-pipeline";
export type { PhysicalSemiMembershipChoice } from "./semi-membership";
export type { PhysicalSemiMembershipCostSelection } from "./semi-membership-cost";

export interface PhysicalMembershipUsage {
  readonly expression: AnyInListExpression;
  readonly occurrences: number;
}

export interface PhysicalMembershipStrategy {
  readonly expression: AnyInListExpression;
  readonly occurrences: number;
  readonly strategy: "native" | "json-text";
  readonly jsonText?: string;
  readonly jsonUtf8Bytes?: number;
  readonly nativeBindingsSaved: number;
}

export interface PhysicalMembershipOptimization {
  readonly nativeBindingCount: number;
  readonly selectedBindingCount: number;
  readonly strategies: readonly PhysicalMembershipStrategy[];
  readonly rowStrategies?: readonly PhysicalTextRowStrategy[];
  readonly tupleMemberships?: readonly PositiveTupleMembershipCandidate[];
}

export interface PhysicalMembershipOptimizationFacts {
  readonly nativeBindingCount: number;
  readonly usage: readonly PhysicalMembershipUsage[];
  readonly rowUsage?: readonly PhysicalTextRowUsage[];
}

/** Numbered parameter layout selected from final emitted SQL bindings. */
export interface PhysicalParameterSlotLayout {
  readonly strategy: "numbered-reuse";
  readonly occurrenceCount: number;
  readonly slotCount: number;
  /** One-based SQLite parameter indexes in original occurrence order. */
  readonly occurrenceSlots: readonly number[];
  readonly bindings: readonly DatabaseBinding[];
}

export interface PhysicalTextRowUsage {
  readonly node: ValuesRelationNode;
  readonly occurrences: number;
}

export interface PhysicalTextRowJsonSegment {
  readonly jsonText: string;
  readonly jsonUtf8Bytes: number;
}

export interface PhysicalTextRowStrategy {
  readonly node: ValuesRelationNode;
  readonly occurrences: number;
  readonly strategy: "native" | "json-rows";
  readonly jsonSegments?: readonly PhysicalTextRowJsonSegment[];
  readonly nativeBindingsSaved: number;
}

/** A left-only Project over an exactly-keyed, distinct positive Join. */
export interface PositiveTupleMembershipCandidate {
  readonly project: ProjectNode;
  readonly join: JoinNode;
  readonly membershipSource: "finite-values" | "dynamic-distinct";
  readonly valuesRelation?: ValuesRelationNode;
  /** Left Join input indexes, in the corresponding RHS output-key order. */
  readonly leftKeyIndexes: readonly number[];
  /** Complete RHS output-key indexes, in tuple comparison order. */
  readonly rightKeyIndexes: readonly number[];
}

export interface SharedRelationDefinition {
  readonly name: string;
  readonly node: LogicalQueryNode;
  readonly scope: RelationScope;
  readonly fields: readonly OutputField[];
  /** Names of shared CTEs referenced by this CTE, in definition order. */
  readonly dependencies: readonly string[];
  /** CTE evaluation policy selected from the canonical logical query shape. */
  readonly materialization: "auto" | "materialized";
  /** Fresh current-query physical boundary selection, when newly promoted. */
  readonly materializationSelection?: PhysicalMaterializationSelection;
}

export interface PhysicalMaterializationSelection {
  readonly kind:
    | "strict-serial-rank-stage"
    | "stage-derived-auto"
    | "current-boundary-derived-auto";
  /** Stable postorder ordinal in this current logical root. */
  readonly choiceIndex: number;
}

/** Fresh, value-free permission to schedule currently licensed MAT leaves. */
export interface PhysicalCompileOrderPolicy {
  readonly kind: "strict-rank-materialization-order";
  readonly rootSort: Extract<LogicalQueryNode, { readonly kind: "sort" }>;
  readonly strictStageDefinitionIndexes: readonly number[];
  readonly candidateDefinitionIndexes: readonly number[];
}

export interface PhysicalCatalogColumnOrigin {
  readonly scan: ScanNode;
  readonly tableName: string;
  readonly columnName: string;
  readonly affinity: "integer" | "text";
  readonly collation: "BINARY";
}

export interface PhysicalDistinctUnionFieldCertificate {
  readonly index: number;
  readonly name: string;
  readonly affinity: "integer" | "text";
  readonly leftOrigin: PhysicalCatalogColumnOrigin;
  readonly rightOrigin: PhysicalCatalogColumnOrigin;
}

export interface PhysicalDistinctUnionConsumerEdge {
  readonly parent: LogicalQueryNode;
  readonly child: LogicalQueryNode;
  readonly via: "input" | "left" | "right";
  readonly phase: "union" | "distinct" | "join";
}

export interface PhysicalDistinctUnionJoinEquality {
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly affinity: "integer" | "text";
  readonly leftOrigin: PhysicalCatalogColumnOrigin;
}

export interface PhysicalDistinctUnionConsumerCertificate {
  readonly union: Extract<LogicalQueryNode, { readonly kind: "union" }>;
  readonly fields: readonly PhysicalDistinctUnionFieldCertificate[];
  readonly consumerEdges: readonly PhysicalDistinctUnionConsumerEdge[];
  readonly joinEqualities: readonly {
    readonly join: JoinNode;
    readonly equalities: readonly PhysicalDistinctUnionJoinEquality[];
  }[];
  readonly droppedBy: readonly ProjectNode[];
  readonly representationLaw: "sqlite-union-distinct-affinity-neutral";
}

export interface PhysicalSingletonRankBoundaryDependency {
  readonly node: LogicalQueryNode;
  readonly definitionName: string;
  readonly producerIndex: number;
  readonly consumerProducer: LogicalQueryNode | null;
  readonly consumerProducerIndex: number;
}

export interface PhysicalSingletonRankRenderContext {
  /** Null is the main query renderer; otherwise this is the active CTE producer. */
  readonly producer: LogicalQueryNode | null;
  readonly producerIndex: number;
}

/** Fresh proof binding one exact rank filter to one actual row-pipeline render. */
export interface PhysicalSingletonRankChoice {
  readonly pipeline: PhysicalRowPipelineChoice;
  readonly filter: FilterNode;
  readonly window: WindowNode;
  readonly rankOutputIndex: number;
  readonly partitionColumnIndexes: readonly number[];
  readonly keyFields: readonly number[];
  readonly keyCollations: readonly "BINARY"[];
  readonly requiredNonNullFields: readonly number[];
  readonly consumerCertificates: readonly PhysicalDistinctUnionConsumerCertificate[];
  readonly boundaryDependencies: readonly PhysicalSingletonRankBoundaryDependency[];
  readonly renderContexts: readonly PhysicalSingletonRankRenderContext[];
}

/** Exact adjacent ROW_NUMBER null-guard/value pair proved for native ordering. */
export interface PhysicalNativeNullOrderingChoice {
  readonly window: WindowNode;
  readonly windowIndex: number;
  readonly pairIndex: number;
  readonly input: QuerySource;
  readonly guardKey: WindowOrderKey;
  readonly valueKey: WindowOrderKey;
  readonly columnIndex: number;
  readonly columnName: string;
  readonly guardDirection: "ASC" | "DESC";
  readonly valueDirection: "ASC" | "DESC";
  readonly nullPlacement: "FIRST" | "LAST";
}

export interface DirectScanProjectionChoice {
  readonly project: ProjectNode;
  readonly scan: ScanNode;
  /** Actual schema SQL column names in the Project output order. */
  readonly sqlColumnNames: readonly string[];
}

/** A parent Project may skip a pure column-only Project whose scope it does not read. */
export interface PassthroughProjectFusion {
  readonly project: ProjectNode;
  readonly input: QuerySource;
}

/** Join outputs needed by a filter whose only visible projection is constant. */
export interface ConstantFilterJoinProjection {
  readonly project: ProjectNode;
  readonly filter: FilterNode;
  readonly join: JoinNode;
  readonly referencedOutputColumns: readonly number[];
}

/** A canonical inner-Join input order selected from typed relational evidence. */
export type PhysicalJoinOrderStrategy =
  | {
      readonly kind: "right-anchor" | "unique-lookup";
      readonly join: JoinNode;
      readonly driver: "right";
      /** Generated schema proof used only by unique-lookup strategies. */
      readonly uniqueKey?: string;
    }
  | {
      readonly kind: "fact-local-indexed";
      readonly join: JoinNode;
      readonly driver: "left";
      readonly owner: Extract<LogicalQueryNode, { readonly kind: "aggregate" }>;
      readonly tableName: string;
      readonly indexName: string;
      readonly keyColumns: readonly {
        readonly name: string;
        readonly leftIndex: number;
        readonly rightIndex: number;
      }[];
    };

export interface PhysicalQueryPlan<
  Row extends object = Record<string, unknown>,
> {
  readonly kind: "physical-query";
  readonly root: LogicalQueryNode;
  readonly scope: QuerySource["scope"];
  readonly fields: QuerySource["fields"];
  readonly sharedRelations: readonly SharedRelationDefinition[];
  /** Optional current-root eligibility; actual references are resolved at render time. */
  readonly compileOrderPolicy?: PhysicalCompileOrderPolicy;
  /** Safe Project(Scan) column selections chosen by the physical planner. */
  readonly directScanProjections: readonly DirectScanProjectionChoice[];
  /** Safe parent Projects that can bypass an unused pure passthrough Project. */
  readonly passthroughProjectFusions: readonly PassthroughProjectFusion[];
  /** Maximal, single-path runs of pure column Projects and total Filters. */
  readonly rowPipelineChoices: readonly PhysicalRowPipelineChoice[];
  /** Exact, freshly revalidated singleton ROW_NUMBER rank-one fusions. */
  readonly singletonRankChoices: readonly PhysicalSingletonRankChoice[];
  /** Exact adjacent ROW_NUMBER null-guard/value pairs for native ordering. */
  readonly nativeNullOrderingChoices: readonly PhysicalNativeNullOrderingChoice[];
  /** Exact same-direction strict lexicographic predicates from the logical root. */
  readonly lexicographicComparisonChoices: readonly PhysicalLexicographicComparisonChoice[];
  /** Safe sparse Join outputs for constant Project(Filter(Join)) shapes. */
  readonly constantFilterJoinProjections: readonly ConstantFilterJoinProjection[];
  /** Canonical structural candidates; finite candidates need packed rows. */
  readonly positiveTupleMembershipCandidates: readonly PositiveTupleMembershipCandidate[];
  /** Exact-source left-only self-membership rewrites, freshly derived from root. */
  readonly selfMembershipChoices: readonly PhysicalSelfMembershipChoice[];
  /** Strictly typed positive SemiJoin membership choices. */
  readonly semiMembershipChoices: readonly PhysicalSemiMembershipChoice[];
  /** Recomputed physical-cost decisions for every semantic-safe SemiJoin. */
  readonly semiMembershipCostSelections: readonly PhysicalSemiMembershipCostSelection[];
  /** Explicit, recomputable inner Join order choices. */
  readonly joinOrderStrategies: readonly PhysicalJoinOrderStrategy[];
  /** Independently recomputed guarded LEFT JOIN indexed lookup choices. */
  readonly conditionalLookupChoices: readonly PhysicalConditionalLookupChoice[];
  /** Backend physical choice, populated after final-shape cost analysis. */
  readonly membershipOptimization?: PhysicalMembershipOptimization;
  readonly __rowType?: Row;
}
