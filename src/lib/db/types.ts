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

export type DatabasePhysicalPlanShape =
  | (DatabasePhysicalPlanShapeFields & { readonly version: 1 })
  | (DatabasePhysicalPlanShapeFields & {
      readonly version: 2;
      readonly nativeRowRelationCount: number;
      readonly jsonRowRelationCount: number;
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
