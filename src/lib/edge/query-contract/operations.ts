import { normalizeQueryFilterSet } from "./helpers";
import { assertOperationAllowed } from "./policy";
import type {
  AnalyticsResult,
  BaseQuery,
  QueryOperation,
  QuerySource,
} from "./types";

export interface OperationReaderResult<T> {
  readonly value: T;
  readonly source?: QuerySource;
  readonly approximateVisitors?: boolean;
}

/**
 * Shared pure-service gate for the families whose detailed typed payloads are
 * still intentionally opaque until the follow-up filter redesign.
 */
export async function executeQueryOperation<T>(
  operation: QueryOperation,
  input: BaseQuery,
  reader: () => Promise<OperationReaderResult<T>>,
): Promise<AnalyticsResult<T>> {
  const operationError = assertOperationAllowed(input.context, operation);
  if (operationError) return { ok: false, error: operationError };

  const filters = normalizeQueryFilterSet(input.filters);
  const maxClauses = input.context.policy.limits.maxFilterClauses;
  if (maxClauses !== undefined && filters.clauses.length > maxClauses) {
    return {
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [
          {
            path: "filters.clauses",
            code: "too_many_clauses",
          },
        ],
      },
    };
  }

  try {
    const result = await reader();
    return {
      ok: true,
      data: result.value,
      meta: {
        time: input.time,
        source: result.source ?? "raw",
        approximateVisitors: Boolean(result.approximateVisitors),
      },
    };
  } catch {
    return { ok: false, error: { kind: "internal", operation } };
  }
}
