export type DatabaseBinding = Parameters<D1PreparedStatement["bind"]>[number];

/** Values that the typed SQL expression API accepts as SQLite parameters. */
export type SqlBinding =
  string | number | boolean | ArrayBuffer | ArrayBufferView | null;

export type DatabaseOperation = "all" | "first" | "run" | "batch" | "exec";
export type DatabaseObservationStatus = "success" | "failed" | "rejected";
export type DatabaseObservationReason =
  "budget" | "database_failure" | "result_failure" | "missing_batch_result";

/** Small, value-free description of the compiler's final physical emission. */
interface DatabasePhysicalPlanShapeFields {
  readonly cteCount: number;
  readonly directScanProjectionCount: number;
  readonly nativeMembershipCount: number;
  readonly jsonMembershipCount: number;
}

export interface DatabaseFactLocalIndexedJoinShape {
  readonly tableName: string;
  readonly indexName: string;
  readonly keyColumns: readonly {
    readonly name: string;
    readonly leftIndex: number;
    readonly rightIndex: number;
  }[];
}

export interface DatabaseConditionalLookupShape {
  readonly tableName: string;
  readonly indexName: string;
  readonly keyColumns: readonly {
    readonly name: string;
    readonly leftIndex: number;
    readonly rightIndex: number;
  }[];
  readonly selectedKey: {
    readonly name: string;
    readonly leftIndex: number;
    readonly rightIndex: number;
  };
  readonly guardConjunctCount: number;
}

export interface DatabaseRowPipelineShape {
  readonly nodeKinds: readonly ("filter" | "project")[];
  readonly outputColumnIndexes: readonly number[];
  readonly filterColumnIndexes: readonly (readonly number[])[];
}

export interface DatabaseLexicographicComparisonShape {
  readonly direction: ">" | "<";
  readonly componentCount: number;
  readonly emissionCount: number;
}

export interface DatabaseSemiMembershipShape {
  /** Number of ordered key columns used by the scalar/tuple IN predicate. */
  readonly keyCount: number;
  readonly emissionCount: number;
}

export interface DatabaseSingletonRankFusionShape {
  readonly partitionFieldCount: number;
  readonly keyFieldCount: number;
  readonly consumerCertificateCount: number;
  readonly emissionCount: number;
  readonly distinct: true;
}

export interface DatabaseNativeNullOrderingShape {
  /** Deterministic plan-wide ordinal of a window specification with native choices. */
  readonly windowIndex: number;
  readonly pairIndex: number;
  readonly columnIndex: number;
  readonly valueDirection: "ASC" | "DESC";
  readonly nullPlacement: "FIRST" | "LAST";
  readonly emissionCount: number;
}

export interface DatabaseDirectMaterializedReferenceShape {
  readonly definitionIndex: number;
  readonly fieldCount: number;
  readonly emissionCount: number;
}

export interface DatabaseMaterializationSelectionShape {
  readonly definitionIndex: number;
  readonly kind:
    | "strict-serial-rank-stage"
    | "stage-derived-auto"
    | "current-boundary-derived-auto";
  readonly choiceIndex: number;
  readonly emissionCount: number;
}

export interface DatabaseDerivedSelfMembershipShape {
  readonly definitionIndex: number;
  readonly producerIndex: number;
  readonly tupleWidth: number;
  readonly nullableGuardCount: number;
  readonly emissionCount: number;
}

export interface DatabaseCompileOrderHelperShape {
  readonly helperCount: 1;
  readonly leafCount: number;
  readonly definitionIndexes: readonly number[];
  readonly strategy: "dead-branch-materialization-order";
}

export type DatabasePhysicalPlanShape =
  | (DatabasePhysicalPlanShapeFields & { readonly version: 1 })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 2;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 3;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly parameterStrategy: "numbered-reuse";
      readonly parameterOccurrenceCount: number;
      readonly parameterSlotCount: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 4;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 5;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 6;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 7;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly selfMembershipCount: number;
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 8;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly selfMembershipCount: number;
      readonly rowPipelineChoices: readonly DatabaseRowPipelineShape[];
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 9;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly selfMembershipCount: number;
      readonly rowPipelineChoices: readonly DatabaseRowPipelineShape[];
      readonly lexicographicComparisonCount: number;
      readonly lexicographicComparisons: readonly DatabaseLexicographicComparisonShape[];
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 10;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly selfMembershipCount: number;
      readonly rowPipelineChoices: readonly DatabaseRowPipelineShape[];
      readonly lexicographicComparisonCount: number;
      readonly lexicographicComparisons: readonly DatabaseLexicographicComparisonShape[];
      readonly semiMembershipCount: number;
      readonly semiMemberships: readonly DatabaseSemiMembershipShape[];
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 11;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly selfMembershipCount: number;
      readonly rowPipelineChoices: readonly DatabaseRowPipelineShape[];
      readonly lexicographicComparisonCount: number;
      readonly lexicographicComparisons: readonly DatabaseLexicographicComparisonShape[];
      readonly semiMembershipCount: number;
      readonly semiMemberships: readonly DatabaseSemiMembershipShape[];
      readonly singletonRankFusionCount: number;
      readonly singletonRankFusions: readonly DatabaseSingletonRankFusionShape[];
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 12;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly selfMembershipCount: number;
      readonly rowPipelineChoices: readonly DatabaseRowPipelineShape[];
      readonly lexicographicComparisonCount: number;
      readonly lexicographicComparisons: readonly DatabaseLexicographicComparisonShape[];
      readonly semiMembershipCount: number;
      readonly semiMemberships: readonly DatabaseSemiMembershipShape[];
      readonly singletonRankFusionCount: number;
      readonly singletonRankFusions: readonly DatabaseSingletonRankFusionShape[];
      readonly nativeNullOrderingCount: number;
      readonly nativeNullOrderings: readonly DatabaseNativeNullOrderingShape[];
      readonly directMaterializedReferenceCount: number;
      readonly directMaterializedReferences: readonly DatabaseDirectMaterializedReferenceShape[];
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 13;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly selfMembershipCount: number;
      readonly rowPipelineChoices: readonly DatabaseRowPipelineShape[];
      readonly lexicographicComparisonCount: number;
      readonly lexicographicComparisons: readonly DatabaseLexicographicComparisonShape[];
      readonly semiMembershipCount: number;
      readonly semiMemberships: readonly DatabaseSemiMembershipShape[];
      readonly singletonRankFusionCount: number;
      readonly singletonRankFusions: readonly DatabaseSingletonRankFusionShape[];
      readonly nativeNullOrderingCount: number;
      readonly nativeNullOrderings: readonly DatabaseNativeNullOrderingShape[];
      readonly directMaterializedReferenceCount: number;
      readonly directMaterializedReferences: readonly DatabaseDirectMaterializedReferenceShape[];
      readonly materializationSelectionCount: number;
      readonly materializationSelections: readonly DatabaseMaterializationSelectionShape[];
      readonly derivedSelfMembershipCount: number;
      readonly derivedSelfMemberships: readonly DatabaseDerivedSelfMembershipShape[];
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 14;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
      readonly rightAnchorJoinOrderCount: number;
      readonly uniqueLookupJoinOrderCount: number;
      readonly factLocalIndexedJoinStrategies: readonly DatabaseFactLocalIndexedJoinShape[];
      readonly conditionalLookupCount: number;
      readonly conditionalLookupStrategies: readonly DatabaseConditionalLookupShape[];
      readonly selfMembershipCount: number;
      readonly rowPipelineChoices: readonly DatabaseRowPipelineShape[];
      readonly lexicographicComparisonCount: number;
      readonly lexicographicComparisons: readonly DatabaseLexicographicComparisonShape[];
      readonly semiMembershipCount: number;
      readonly semiMemberships: readonly DatabaseSemiMembershipShape[];
      readonly singletonRankFusionCount: number;
      readonly singletonRankFusions: readonly DatabaseSingletonRankFusionShape[];
      readonly nativeNullOrderingCount: number;
      readonly nativeNullOrderings: readonly DatabaseNativeNullOrderingShape[];
      readonly directMaterializedReferenceCount: number;
      readonly directMaterializedReferences: readonly DatabaseDirectMaterializedReferenceShape[];
      readonly materializationSelectionCount: number;
      readonly materializationSelections: readonly DatabaseMaterializationSelectionShape[];
      readonly derivedSelfMembershipCount: number;
      readonly derivedSelfMemberships: readonly DatabaseDerivedSelfMembershipShape[];
      readonly compileOrder: DatabaseCompileOrderHelperShape;
      readonly parameterStrategy?: "numbered-reuse";
      readonly parameterOccurrenceCount?: number;
      readonly parameterSlotCount?: number;
    });

interface DatabaseObservationFields {
  readonly version: 1;
  readonly tag: string | null;
  readonly status: DatabaseObservationStatus;
  readonly rowsRead: number | null;
  readonly rowsWritten: number | null;
  readonly dbDurationMs: number | null;
  readonly elapsedMs: number | null;
  readonly sqlBytes: number | null;
  readonly bindings: number | null;
  readonly physicalPlanHash: string | null;
  readonly reason?: DatabaseObservationReason;
  readonly budget?: {
    readonly item: "sql_bytes" | "bindings";
    readonly actual: number;
    readonly limit: number;
  };
}

export type DatabaseQueryObservation =
  | (DatabaseObservationFields & {
      readonly operation: Exclude<DatabaseOperation, "batch">;
      readonly batchId?: never;
      readonly batchIndex?: never;
      readonly statementCount?: never;
    })
  | (DatabaseObservationFields & {
      readonly operation: "batch";
      readonly batchId: string;
      readonly batchIndex: number;
      readonly statementCount?: never;
    })
  | (DatabaseObservationFields & {
      readonly operation: "batch";
      readonly batchId: string;
      readonly batchIndex: null;
      readonly statementCount: number;
    });

/** A bounded set of log slots selected before any optional hashing work. */
export interface DatabaseObservationSession {
  readonly statementIndexes: readonly number[];
  readonly includeBatchSummary: boolean;
  record(event: DatabaseQueryObservation): void | Promise<void>;
  release(): void;
}

export interface DatabaseQueryObserver {
  begin(input: {
    readonly operation: DatabaseOperation;
    readonly statementCount: number;
    readonly batchId?: string;
  }): DatabaseObservationSession | undefined;
}

export interface DatabaseRuntimeOptions {
  readonly observer?: DatabaseQueryObserver;
}

export interface DatabaseStatement {
  readonly sql: string;
  readonly bindings?: readonly DatabaseBinding[];
  readonly tag?: string;
  /** Set only by the typed query compiler; raw SQL and mutations omit it. */
  readonly physicalPlanShape?: DatabasePhysicalPlanShape;
}

export interface DatabaseRuntime {
  all<T extends object = Record<string, unknown>>(
    statement: DatabaseStatement,
  ): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(
    statement: DatabaseStatement,
    columnName?: string,
  ): Promise<T | null>;
  run(statement: DatabaseStatement): Promise<D1Result>;
  batch(statements: readonly DatabaseStatement[]): Promise<readonly D1Result[]>;
  exec(sql: string): Promise<D1ExecResult>;
}
