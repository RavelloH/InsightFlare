import { analyticsFilterRegistry } from "./filter-registry";
import { assertFilterAudience } from "./filters";
import { EMPTY_FILTER_DOCUMENT } from "./helpers";
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

  const filters = input.filters ?? EMPTY_FILTER_DOCUMENT;
  try {
    assertFilterAudience(
      filters,
      analyticsFilterRegistry,
      input.context.policy.audience,
    );
  } catch {
    return {
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [
          {
            path: "filters",
            code: "invalid_or_unauthorized_filter",
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
