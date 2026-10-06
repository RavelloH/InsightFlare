import { sha256Hex } from "@/lib/sha256";

import {
  assertD1StatementBudget,
  D1_MAX_SQL_UTF8_BYTES,
  D1StatementBudgetError,
} from "./d1-budget";
import type {
  DatabaseObservationReason,
  DatabaseObservationSession,
  DatabaseObservationStatus,
  DatabaseOperation,
  DatabasePhysicalPlanShape,
  DatabaseQueryObservation,
  DatabaseQueryObserver,
  DatabaseRuntime,
  DatabaseRuntimeOptions,
  DatabaseStatement,
} from "./types";

const DATABASE_QUERY_OBSERVERS = new WeakMap<
  D1Database,
  DatabaseQueryObserver
>();
const MAX_OBSERVED_BATCH_MEMBERS = 32;
let nextBatchId = 0n;

interface ObservationOutcome {
  readonly status: DatabaseObservationStatus;
  readonly elapsedMs: number | null;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly resultHasD1Meta?: boolean;
  readonly reason?: DatabaseObservationReason;
  readonly budget?: {
    readonly item: "sql_bytes" | "bindings";
    readonly actual: number;
    readonly limit: number;
  };
}

interface SelectedObservationSession {
  readonly session: DatabaseObservationSession;
  readonly statementIndexes: readonly number[];
  readonly includeBatchSummary: boolean;
  readonly batchId?: string;
}

interface D1MetaLike {
  readonly rows_read?: unknown;
  readonly rows_written?: unknown;
  readonly duration?: unknown;
  readonly timings?: { readonly sql_duration_ms?: unknown };
}

function safeNow(): number {
  try {
    const value = globalThis.performance?.now() ?? Date.now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function elapsedSince(startedAt: number): number | null {
  const elapsed = safeNow() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function safeBegin(
  observer: DatabaseQueryObserver | undefined,
  operation: DatabaseOperation,
  statementCount: number,
): SelectedObservationSession | undefined {
  if (!observer) return undefined;
  const batchId =
    operation === "batch" ? (++nextBatchId).toString(36) : undefined;
  let session: DatabaseObservationSession | undefined;
  try {
    session = observer.begin({
      operation,
      statementCount,
      ...(batchId === undefined ? {} : { batchId }),
    });
  } catch {
    return undefined;
  }
  if (!session) return undefined;

  try {
    const maxSelected = operation === "batch" ? MAX_OBSERVED_BATCH_MEMBERS : 1;
    const statementIndexes: number[] = [];
    for (const index of session.statementIndexes) {
      if (statementIndexes.length >= maxSelected) break;
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < statementCount &&
        statementIndexes.length < maxSelected &&
        !statementIndexes.includes(index)
      )
        statementIndexes.push(index);
    }
    const includeBatchSummary =
      operation === "batch" && session.includeBatchSummary;
    if (statementIndexes.length === 0 && !includeBatchSummary) {
      releaseSession(session);
      return undefined;
    }
    return {
      session,
      statementIndexes,
      includeBatchSummary,
      ...(batchId === undefined ? {} : { batchId }),
    };
  } catch {
    releaseSession(session);
    return undefined;
  }
}

function releaseSession(session: DatabaseObservationSession): void {
  try {
    session.release();
  } catch {
    // Observation cleanup must never replace a database result or error.
  }
}

function validNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function validNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function d1Meta(result: unknown): D1MetaLike | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const meta = (result as { readonly meta?: unknown }).meta;
  return typeof meta === "object" && meta !== null
    ? (meta as D1MetaLike)
    : undefined;
}

function resultFailed(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { readonly success?: unknown }).success === false
  );
}

function shapeIsValid(
  shape: DatabasePhysicalPlanShape | undefined,
): shape is DatabasePhysicalPlanShape {
  return (
    (shape?.version === 1 ||
      (shape?.version === 2 &&
        Number.isInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0) ||
      (shape?.version === 3 &&
        Number.isInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0 &&
        shape.parameterStrategy === "numbered-reuse" &&
        Number.isSafeInteger(shape.parameterOccurrenceCount) &&
        shape.parameterOccurrenceCount > 100 &&
        Number.isSafeInteger(shape.parameterSlotCount) &&
        shape.parameterSlotCount > 0 &&
        shape.parameterSlotCount < shape.parameterOccurrenceCount)) &&
    Number.isInteger(shape.cteCount) &&
    shape.cteCount >= 0 &&
    Number.isInteger(shape.directScanProjectionCount) &&
    shape.directScanProjectionCount >= 0 &&
    Number.isInteger(shape.nativeMembershipCount) &&
    shape.nativeMembershipCount >= 0 &&
    Number.isInteger(shape.jsonMembershipCount) &&
    shape.jsonMembershipCount >= 0
  );
}

async function physicalPlanHash(
  statement: DatabaseStatement,
  sqlBytes: number,
): Promise<string | null> {
  const shape = statement.physicalPlanShape;
  if (!shapeIsValid(shape) || sqlBytes > D1_MAX_SQL_UTF8_BYTES) return null;
  try {
    if (shape.version === 1) {
      const payload = JSON.stringify([
        "d1-query-shape-v1",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
      ]);
      return `v1:${await sha256Hex(payload)}`;
    }
    if (shape.version === 2) {
      const payload = JSON.stringify([
        "d1-query-shape-v2",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
      ]);
      return `v2:${await sha256Hex(payload)}`;
    }
    const payload = JSON.stringify([
      "d1-query-shape-v3",
      statement.sql,
      shape.cteCount,
      shape.directScanProjectionCount,
      shape.nativeMembershipCount,
      shape.jsonMembershipCount,
      shape.nativeRowRelationCount,
      shape.jsonRowRelationCount,
      shape.parameterStrategy,
      shape.parameterOccurrenceCount,
      shape.parameterSlotCount,
    ]);
    return `v3:${await sha256Hex(payload)}`;
  } catch {
    return null;
  }
}

function observationStatusForError(
  error: unknown,
): Pick<ObservationOutcome, "status" | "reason" | "budget"> | undefined {
  if (error instanceof D1StatementBudgetError)
    return {
      status: "rejected",
      reason: "budget",
      budget: {
        item: error.item,
        actual: error.actual,
        limit: error.limit,
      },
    };
  return { status: "failed", reason: "database_failure" };
}

function statementEvent(
  statement: DatabaseStatement,
  operation: Exclude<DatabaseOperation, "batch">,
  outcome: ObservationOutcome,
): Promise<DatabaseQueryObservation>;
function statementEvent(
  statement: DatabaseStatement,
  operation: "batch",
  outcome: ObservationOutcome,
  batch: { readonly batchId: string; readonly batchIndex: number },
): Promise<DatabaseQueryObservation>;
async function statementEvent(
  statement: DatabaseStatement,
  operation: DatabaseOperation,
  outcome: ObservationOutcome,
  batch?: { readonly batchId: string; readonly batchIndex: number },
): Promise<DatabaseQueryObservation> {
  const sqlBytes =
    outcome.budget?.item === "sql_bytes"
      ? outcome.budget.actual
      : new TextEncoder().encode(statement.sql).byteLength;
  const meta =
    outcome.status === "success" && outcome.resultHasD1Meta
      ? d1Meta(outcome.result)
      : undefined;
  const timing = validNonNegativeNumber(meta?.timings?.sql_duration_ms);
  const dbDurationMs = timing ?? validNonNegativeNumber(meta?.duration) ?? null;
  const hash = await physicalPlanHash(statement, sqlBytes);
  const base = {
    version: 1,
    tag: statement.tag ?? null,
    status: outcome.status,
    rowsRead: validNonNegativeInteger(meta?.rows_read),
    rowsWritten: validNonNegativeInteger(meta?.rows_written),
    dbDurationMs,
    elapsedMs: outcome.elapsedMs,
    sqlBytes,
    bindings: statement.bindings?.length ?? 0,
    physicalPlanHash: hash,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.budget === undefined ? {} : { budget: outcome.budget }),
  } as const;
  if (operation === "batch")
    return {
      ...base,
      operation,
      batchId: batch!.batchId,
      batchIndex: batch!.batchIndex,
    };
  return { ...base, operation };
}

function batchSummaryEvent(
  batchId: string,
  statementCount: number,
  outcome: ObservationOutcome,
): DatabaseQueryObservation {
  return {
    version: 1,
    tag: null,
    operation: "batch",
    status: outcome.status,
    rowsRead: null,
    rowsWritten: null,
    dbDurationMs: null,
    elapsedMs: outcome.elapsedMs,
    sqlBytes: null,
    bindings: null,
    physicalPlanHash: null,
    batchId,
    batchIndex: null,
    statementCount,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.budget === undefined ? {} : { budget: outcome.budget }),
  };
}

function publishObservations(
  selected: SelectedObservationSession,
  events: readonly (
    DatabaseQueryObservation | Promise<DatabaseQueryObservation>
  )[],
): void {
  const task = (async () => {
    try {
      for (const event of events) await selected.session.record(await event);
    } catch {
      // An observer failure cannot change the native database result.
    } finally {
      releaseSession(selected.session);
    }
  })();
  void task.catch(() => releaseSession(selected.session));
}

function runObserved<T>(
  selected: SelectedObservationSession | undefined,
  operation: DatabaseOperation,
  statements: readonly DatabaseStatement[],
  action: () => Promise<T>,
  eventsForSuccess: (
    result: T,
    elapsedMs: number | null,
  ) =>
    | readonly (DatabaseQueryObservation | Promise<DatabaseQueryObservation>)[]
    | undefined,
): Promise<T> {
  if (!selected) return action();
  const startedAt = safeNow();
  const onError = (error: unknown) => {
    const elapsedMs = elapsedSince(startedAt);
    const failure = observationStatusForError(error)!;
    const outcome: ObservationOutcome = {
      ...failure,
      elapsedMs,
    };
    const events: (
      DatabaseQueryObservation | Promise<DatabaseQueryObservation>
    )[] = [];
    try {
      if (operation === "batch") {
        const batchId = selected.batchId!;
        if (selected.includeBatchSummary)
          events.push(batchSummaryEvent(batchId, statements.length, outcome));
        if (failure.status !== "rejected")
          for (const index of selected.statementIndexes) {
            const statement = statements[index];
            if (!statement) continue;
            events.push(
              statementEvent(
                statement,
                "batch",
                { ...outcome, elapsedMs: null, resultHasD1Meta: false },
                { batchId, batchIndex: index },
              ),
            );
          }
      } else {
        const statement = statements[0];
        if (statement && selected.statementIndexes.includes(0))
          events.push(
            statementEvent(statement, operation, {
              ...outcome,
              resultHasD1Meta: false,
            }),
          );
      }
      publishObservations(selected, events);
    } catch {
      releaseSession(selected.session);
    }
  };

  let promise: Promise<T>;
  try {
    promise = action();
  } catch (error) {
    onError(error);
    throw error;
  }
  return promise.then(
    (result) => {
      const elapsedMs = elapsedSince(startedAt);
      try {
        const events = eventsForSuccess(result, elapsedMs);
        if (events) publishObservations(selected, events);
        else releaseSession(selected.session);
      } catch {
        releaseSession(selected.session);
      }
      return result;
    },
    (error: unknown) => {
      onError(error);
      throw error;
    },
  );
}

function databaseResultEvent(
  statement: DatabaseStatement,
  operation: Exclude<DatabaseOperation, "batch">,
  result: unknown,
  elapsedMs: number | null,
  includeMeta: boolean,
): Promise<DatabaseQueryObservation> {
  const failed = includeMeta && resultFailed(result);
  return statementEvent(statement, operation, {
    status: failed ? "failed" : "success",
    ...(failed ? { reason: "result_failure" as const } : {}),
    elapsedMs,
    result,
    resultHasD1Meta: includeMeta,
  });
}

function batchSuccessEvents(
  selected: SelectedObservationSession,
  statements: readonly DatabaseStatement[],
  results: readonly D1Result[],
  elapsedMs: number | null,
): readonly (DatabaseQueryObservation | Promise<DatabaseQueryObservation>)[] {
  const batchId = selected.batchId!;
  const countMismatch = results.length !== statements.length;
  const anyFailed = results.some(resultFailed);
  const summaryOutcome: ObservationOutcome = {
    status: countMismatch || anyFailed ? "failed" : "success",
    elapsedMs,
    ...(countMismatch
      ? { reason: "missing_batch_result" as const }
      : anyFailed
        ? { reason: "result_failure" as const }
        : {}),
  };
  const events: (
    DatabaseQueryObservation | Promise<DatabaseQueryObservation>
  )[] = [];
  if (selected.includeBatchSummary)
    events.push(batchSummaryEvent(batchId, statements.length, summaryOutcome));
  for (const index of selected.statementIndexes) {
    const statement = statements[index];
    if (!statement) continue;
    const result = results[index];
    if (!result) {
      events.push(
        statementEvent(
          statement,
          "batch",
          {
            status: "failed",
            reason: "missing_batch_result",
            elapsedMs: null,
            resultHasD1Meta: false,
          },
          { batchId, batchIndex: index },
        ),
      );
    } else {
      const failed = resultFailed(result);
      events.push(
        statementEvent(
          statement,
          "batch",
          {
            status: failed ? "failed" : "success",
            ...(failed ? { reason: "result_failure" as const } : {}),
            elapsedMs: null,
            result,
            resultHasD1Meta: true,
          },
          { batchId, batchIndex: index },
        ),
      );
    }
  }
  return events;
}

function prepare(database: D1Database, statement: DatabaseStatement) {
  assertD1StatementBudget(statement);
  const prepared = database.prepare(statement.sql);
  return statement.bindings === undefined
    ? prepared
    : prepared.bind(...statement.bindings);
}

export function registerDatabaseQueryObserver(
  database: D1Database,
  observer: DatabaseQueryObserver,
): void {
  DATABASE_QUERY_OBSERVERS.set(database, observer);
}

export function createDatabaseRuntime(
  database: D1Database,
  options: DatabaseRuntimeOptions = {},
): DatabaseRuntime {
  const observer = options.observer ?? DATABASE_QUERY_OBSERVERS.get(database);
  return {
    all<T extends object>(statement: DatabaseStatement): Promise<D1Result<T>> {
      const selected = safeBegin(observer, "all", 1);
      return runObserved(
        selected,
        "all",
        [statement],
        () => prepare(database, statement).all<T>(),
        (result, elapsedMs) => {
          if (!selected?.statementIndexes.includes(0)) return undefined;
          return [
            databaseResultEvent(statement, "all", result, elapsedMs, true),
          ];
        },
      );
    },
    first<T>(
      statement: DatabaseStatement,
      columnName?: string,
    ): Promise<T | null> {
      const selected = safeBegin(observer, "first", 1);
      return runObserved(
        selected,
        "first",
        [statement],
        () => {
          const prepared = prepare(database, statement);
          return columnName === undefined
            ? prepared.first<T>()
            : prepared.first<T>(columnName);
        },
        (_result, elapsedMs) => {
          if (!selected?.statementIndexes.includes(0)) return undefined;
          return [
            statementEvent(statement, "first", {
              status: "success",
              elapsedMs,
              resultHasD1Meta: false,
            }),
          ];
        },
      );
    },
    run(statement: DatabaseStatement): Promise<D1Result> {
      const selected = safeBegin(observer, "run", 1);
      return runObserved(
        selected,
        "run",
        [statement],
        () => prepare(database, statement).run(),
        (result, elapsedMs) => {
          if (!selected?.statementIndexes.includes(0)) return undefined;
          return [
            databaseResultEvent(statement, "run", result, elapsedMs, true),
          ];
        },
      );
    },
    batch(
      statements: readonly DatabaseStatement[],
    ): Promise<readonly D1Result[]> {
      const selected = safeBegin(observer, "batch", statements.length);
      return runObserved(
        selected,
        "batch",
        statements,
        () => {
          statements.forEach(assertD1StatementBudget);
          return database.batch(
            statements.map((statement) => prepare(database, statement)),
          );
        },
        (results, elapsedMs) =>
          selected
            ? batchSuccessEvents(selected, statements, results, elapsedMs)
            : undefined,
      );
    },
    exec(sql: string): Promise<D1ExecResult> {
      const selected = safeBegin(observer, "exec", 1);
      return runObserved(
        selected,
        "exec",
        [{ sql }],
        () => {
          // D1 exec accepts multi-statement scripts; statement limits are checked
          // on the prepared-statement path and SQL is intentionally not split here.
          return database.exec(sql);
        },
        (_result, elapsedMs) => {
          if (!selected?.statementIndexes.includes(0)) return undefined;
          return [
            statementEvent({ sql }, "exec", {
              status: "success",
              elapsedMs,
              resultHasD1Meta: false,
            }),
          ];
        },
      );
    },
  };
}
