import type { OperationResultCache } from "@/lib/edge/analytics/application/cache";
import { type OperationCachePolicy } from "@/lib/edge/analytics/application/cache";
import {
  calculateQueryCost,
  defaultQueryCostPolicy,
  type QueryCostInput,
  type QueryCostPolicy,
} from "@/lib/edge/analytics/application/cost";
import type {
  AnalyticsResult,
  QueryInput,
  QueryOperation,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import {
  currentInvocationLogger,
  errorLogData,
} from "@/lib/edge/observability-logger";

import type { AnalyticsProviderRegistry } from "./provider-registry";
import type { TypedQueryProviderResult } from "./provider-registry";
import { validateTypedQueryInput } from "./query-validation";

export type { AnalyticsServiceError, AnalyticsServiceResult } from "./errors";
export { AnalyticsProviderRegistry } from "./provider-registry";

export interface QueryExecutionContext {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  /** One request-scoped clock captured before provider execution. */
  readonly capturedAtMs?: number;
  readonly now?: () => number;
  /** Optional normalized cost dimensions supplied by the DTO adapter. */
  readonly cost?: QueryCostInput;
  /** Optional low-cardinality hook; callers must not include query payloads. */
  readonly onEvent?: (event: AnalyticsQueryEvent) => void;
  /** Allows a protocol adapter to preserve its legacy provider-error mapping. */
  readonly onProviderError?: (error: unknown) => void;
  readonly operation?: string;
}

export interface AnalyticsQueryEvent {
  readonly operation: string;
  readonly phase:
    | "start"
    | "success"
    | "cancelled"
    | "deadline"
    | "cost"
    | "failure";
  readonly cost?: number;
}

/**
 * The only application invocation shape. Route, SSR, and protocol adapters
 * normalize their own inputs before creating this object.
 */
export interface TypedQueryOperationInvocation<Result> {
  readonly kind: "typed-query";
  readonly operation: QueryOperation;
  readonly query: QueryInput;
  readonly providerRegistry: AnalyticsProviderRegistry;
  readonly cache?: {
    readonly key: string;
    readonly policy: OperationCachePolicy;
    readonly isCacheable?: (value: Result) => boolean;
  };
}

type ExecutionFailure = {
  readonly ok: false;
  readonly error:
    | { readonly kind: "request-cancelled" }
    | { readonly kind: "deadline-exceeded" };
};

function executionDomainError(
  context: QueryExecutionContext,
): ExecutionFailure | null {
  if (context.signal?.aborted) {
    return { ok: false, error: { kind: "request-cancelled" } };
  }
  const now = context.now?.() ?? Date.now();
  if (typeof context.deadlineMs === "number" && now >= context.deadlineMs) {
    return { ok: false, error: { kind: "deadline-exceeded" } };
  }
  return null;
}

function emit(
  context: QueryExecutionContext,
  phase: AnalyticsQueryEvent["phase"],
  cost?: number,
): void {
  try {
    context.onEvent?.({
      operation: context.operation ?? "unknown",
      phase,
      ...(cost === undefined ? {} : { cost }),
    });
  } catch {
    // Observability must never change query behavior.
  }
}

class UncacheableResult extends Error {
  constructor(readonly value: unknown) {
    super("analytics result must not enter cache");
  }
}

export class TypedQueryApplicationService {
  constructor(
    private readonly cache?: OperationResultCache,
    private readonly costPolicy: QueryCostPolicy = defaultQueryCostPolicy,
  ) {}

  private costError(executionContext: QueryExecutionContext): {
    readonly ok: false;
    readonly error: {
      readonly kind: "query-cost-exceeded";
      readonly cost: number;
    };
  } | null {
    if (!executionContext.cost) return null;
    const cost = calculateQueryCost(executionContext.cost, this.costPolicy);
    return cost >= this.costPolicy.maxCost
      ? { ok: false, error: { kind: "query-cost-exceeded", cost } }
      : null;
  }

  private async executeTypedQuery<Result>(
    invocation: TypedQueryOperationInvocation<Result>,
    executionContext: QueryExecutionContext,
  ): Promise<AnalyticsResult<Result>> {
    emit(executionContext, "start");

    const before = executionDomainError(executionContext);
    if (before) {
      emit(
        executionContext,
        before.error.kind === "deadline-exceeded" ? "deadline" : "cancelled",
      );
      return before;
    }

    const validationError = validateTypedQueryInput(
      invocation.operation,
      invocation.query,
    );
    if (validationError) {
      emit(executionContext, "failure");
      return { ok: false, error: validationError };
    }

    const costError = this.costError(executionContext);
    if (costError) {
      emit(
        executionContext,
        "cost",
        costError.error.kind === "query-cost-exceeded"
          ? costError.error.cost
          : undefined,
      );
      return costError;
    }

    try {
      const provider = invocation.providerRegistry.resolve<Result>(
        invocation.operation,
      );
      if (!provider) {
        emit(executionContext, "failure");
        return {
          ok: false,
          error: { kind: "internal", operation: invocation.operation },
        };
      }
      const load = async (): Promise<TypedQueryProviderResult<Result>> =>
        provider.execute(invocation.query, executionContext);
      let result: TypedQueryProviderResult<Result>;
      if (!invocation.cache || !this.cache) {
        result = await load();
      } else {
        try {
          result = (
            await this.cache.getOrLoad({
              key: invocation.cache.key,
              policy: invocation.cache.policy,
              load: async () => {
                const loaded = await load();
                if (!(invocation.cache?.isCacheable?.(loaded.value) ?? true)) {
                  throw new UncacheableResult(loaded);
                }
                return loaded;
              },
            })
          ).value;
        } catch (error) {
          if (!(error instanceof UncacheableResult)) throw error;
          result = error.value as TypedQueryProviderResult<Result>;
        }
      }
      const time =
        "time" in invocation.query
          ? (invocation.query as QueryInput & { readonly time: QueryTime }).time
          : undefined;
      if (!time) {
        emit(executionContext, "failure");
        return {
          ok: false,
          error: { kind: "internal", operation: invocation.operation },
        };
      }
      const after = executionDomainError(executionContext);
      if (after) {
        emit(
          executionContext,
          after.error.kind === "deadline-exceeded" ? "deadline" : "cancelled",
        );
        return after;
      }
      emit(executionContext, "success");
      return {
        ok: true,
        data: result.value,
        meta: {
          time,
          source: result.source ?? "raw",
          approximateVisitors: Boolean(result.approximateVisitors),
        },
      };
    } catch (error) {
      try {
        executionContext.onProviderError?.(error);
      } catch {
        // Error reporting must never change query behavior.
      }
      currentInvocationLogger()?.error("query.application-operation.failed", {
        operation: invocation.operation,
        ...errorLogData(error),
      });
      emit(executionContext, "failure");
      return {
        ok: false,
        error: { kind: "internal", operation: invocation.operation },
      };
    }
  }

  /**
   * Executes a registered canonical query. Providers receive only the
   * normalized query object, never HTTP/auth objects or route DTOs.
   */
  async execute<Result>(
    invocation: TypedQueryOperationInvocation<Result>,
    executionContext: QueryExecutionContext = {},
  ): Promise<AnalyticsResult<Result>> {
    return this.executeTypedQuery(invocation, executionContext);
  }
}
