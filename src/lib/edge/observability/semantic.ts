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
 * Only a reviewed, explicit field list can authorize a semantic candidate.
 * This is a capability for a trusted query producer, not a schema discovery
 * mechanism or an API accepting user-provided field names.
 */
const SQL_FIELD_POLICY_BRAND: unique symbol = Symbol(
  "sql-semantic-field-policy",
);
export interface SqlSemanticFieldPolicy {
  readonly [SQL_FIELD_POLICY_BRAND]: true;
}
const POLICY_PATHS = new WeakMap<SqlSemanticFieldPolicy, ReadonlySet<string>>();

/** Defense in depth; a syntactically valid pointer can still identify a user. */
const SENSITIVE_FIELD_COMPONENT =
  /(?:^|[_-])(email|e_mail|mail|phone|mobile|password|passwd|token|secret|credential|auth|authorization|session|visitor|identity|identification|user|users|customer|account|ip|address|name|ssn|dob|birth|cookie|api_key|private|personal)(?:$|[_-])/i;

function hasSensitiveComponent(pointer: string): boolean {
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    .some((part) => SENSITIVE_FIELD_COMPONENT.test(part));
}

/**
 * Supply a literal allowlist reviewed against the actual Event Schema.
 * Never derive it from filters, request payloads or user-defined field names.
 * Unknown or sensitive paths are rejected, even if they parse as JSON Pointers.
 */
export function createSqlSemanticFieldPolicy(
  approvedStaticPointers: readonly string[],
): SqlSemanticFieldPolicy {
  const allowed = new Set<string>();
  if (Array.isArray(approvedStaticPointers)) {
    for (const pointer of approvedStaticPointers) {
      if (
        isCanonicalSqlPointerSyntax(pointer) &&
        !hasSensitiveComponent(pointer)
      ) {
        allowed.add(pointer);
      }
    }
  }
  const policy = Object.freeze({
    [SQL_FIELD_POLICY_BRAND]: true as const,
  });
  POLICY_PATHS.set(policy, allowed);
  return policy;
}

export function isApprovedSqlSemanticField(
  pointer: string,
  policy: SqlSemanticFieldPolicy | undefined,
): boolean {
  return (
    typeof policy === "object" &&
    policy !== null &&
    POLICY_PATHS.get(policy)?.has(pointer) === true &&
    !hasSensitiveComponent(pointer)
  );
}

/**
 * Checks ONLY JSON Pointer syntax/shape, not privacy or schema authorization.
 * The producer must also pass a reviewed SqlSemanticFieldPolicy.
 */
export function isCanonicalSqlPointerSyntax(
  pointer: unknown,
): pointer is string {
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
  policy: SqlSemanticFieldPolicy | undefined,
): SqlSemanticObservation | undefined {
  if (!input || typeof input !== "object") return;
  if (!Number.isSafeInteger(input.sitePk) || input.sitePk < 1) return;
  if (!Number.isSafeInteger(input.eventNameId) || input.eventNameId < 1) return;
  if (!isCanonicalSqlPointerSyntax(input.jsonPointer)) return;
  if (!isApprovedSqlSemanticField(input.jsonPointer, policy)) return;
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
