/**
 * Optional, internal-only query hints. The caller MUST submit these only
 * after an actually executed D1 query with an indexable predicate. Binding
 * instrumentation never guesses event semantics by parsing SQL or arguments.
 */
export type SqlObservationValueType = "string" | "number";
export type SqlObservationIndexKind = "equality" | "range";
export type SqlObservationExecution = "succeeded" | "failed";

export interface SqlSemanticObservationInput {
  readonly sitePk: number;
  readonly eventNameId: number;
  /** Canonical, escaped JSON Pointer. No wildcards, variables or user values. */
  readonly jsonPointer: string;
  readonly valueType: SqlObservationValueType;
  readonly indexKind: SqlObservationIndexKind;
  readonly execution: SqlObservationExecution;
}

export interface SqlSemanticObservation {
  readonly sitePk: number;
  readonly eventNameId: number;
  readonly jsonPointer: string;
  readonly valueType: SqlObservationValueType;
  readonly indexKind: SqlObservationIndexKind;
  /** Repeated reports for one candidate count as one request demand. */
  readonly requestDemand: 1;
  readonly executions: number;
  readonly failedExecutions: number;
}

export const MAX_SQL_SEMANTIC_CANDIDATES = 32;

/**
 * Conservative v1 pointer contract. Each canonical segment must be a static
 * field name, with RFC 6901 ~0/~1 escapes permitted. Dynamic identifiers,
 * emails, UUIDs, wildcards, selector indices and raw filter values are rejected.
 * Broader keys require an explicit future privacy review.
 */
export function isSafeCanonicalPointer(pointer: unknown): pointer is string {
  if (
    typeof pointer !== "string" ||
    pointer.length < 2 ||
    pointer.length > 256
  ) {
    return false;
  }
  if (!pointer.startsWith("/")) return false;
  const segments = pointer.slice(1).split("/");
  if (segments.length > 8) return false;
  return segments.every((segment) => {
    if (/~(?![01])/.test(segment)) return false;
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    // Avoid accepting dynamic opaque identifiers that resemble a value or UUID.
    if (/^[a-z0-9]{4,}(?:-[a-z0-9]{3,}){2,}$/i.test(decoded)) return false;
    return decoded.length <= 64 && /^[A-Za-z_][A-Za-z0-9_./~-]*$/.test(decoded);
  });
}

export function normalizeSqlSemanticObservation(
  input: SqlSemanticObservationInput,
): SqlSemanticObservation | undefined {
  if (!input || typeof input !== "object") return;
  if (!Number.isSafeInteger(input.sitePk) || input.sitePk < 1) return;
  if (!Number.isSafeInteger(input.eventNameId) || input.eventNameId < 1) return;
  if (!isSafeCanonicalPointer(input.jsonPointer)) return;
  if (input.valueType !== "string" && input.valueType !== "number") return;
  if (input.indexKind !== "equality" && input.indexKind !== "range") return;
  if (input.execution !== "succeeded" && input.execution !== "failed") return;
  return Object.freeze({
    sitePk: input.sitePk,
    eventNameId: input.eventNameId,
    jsonPointer: input.jsonPointer,
    valueType: input.valueType,
    indexKind: input.indexKind,
    requestDemand: 1 as const,
    executions: 1,
    failedExecutions: input.execution === "failed" ? 1 : 0,
  });
}

export function sqlSemanticCandidateKey(
  observation: SqlSemanticObservation,
): string {
  return JSON.stringify([
    observation.sitePk,
    observation.eventNameId,
    observation.jsonPointer,
    observation.valueType,
    observation.indexKind,
  ]);
}

/** Aggregation is in-memory and request-scoped; it never performs D1 I/O. */
export function appendSqlSemanticObservation(
  accumulated: Map<string, SqlSemanticObservation>,
  normalized: SqlSemanticObservation,
): boolean {
  const key = sqlSemanticCandidateKey(normalized);
  const previous = accumulated.get(key);
  if (!previous && accumulated.size >= MAX_SQL_SEMANTIC_CANDIDATES)
    return false;
  accumulated.set(
    key,
    Object.freeze({
      ...normalized,
      executions: (previous?.executions ?? 0) + 1,
      failedExecutions:
        (previous?.failedExecutions ?? 0) + normalized.failedExecutions,
    }),
  );
  return true;
}
