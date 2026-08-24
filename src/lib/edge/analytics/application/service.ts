import type { OperationResultCache } from "@/lib/edge/analytics/application/cache";
import { type OperationCachePolicy } from "@/lib/edge/analytics/application/cache";
import {
  calculateQueryCost,
  defaultQueryCostPolicy,
  type QueryCostInput,
  type QueryCostPolicy,
} from "@/lib/edge/analytics/application/cost";
import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import type {
  AnalyticsResult,
  BaseQuery,
  QueryContext,
  QueryOperation,
} from "@/lib/edge/analytics/contract";
import {
  currentInvocationLogger,
  errorLogData,
} from "@/lib/edge/observability-logger";

import type { AnalyticsServiceError, AnalyticsServiceResult } from "./errors";
import { planAnalyticsOperation } from "./planner";
import type {
  TypedApplicationProviderRegistry,
  TypedQueryProviderRegistry,
} from "./provider-registry";
import { validateTypedQueryInput } from "./query-validation";

export type { AnalyticsServiceError, AnalyticsServiceResult } from "./errors";
export type { AnalyticsOperationProvider } from "./provider-registry";
export {
  analyticsOperationProvider,
  TypedApplicationProviderRegistry,
} from "./provider-registry";

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

export interface AnalyticsOperationInvocation<Query, Result> {
  readonly operation: AnalyticsOperationId;
  readonly context: QueryContext;
  readonly query: Query;
  readonly providerRegistry: TypedApplicationProviderRegistry;
  readonly cache?: {
    readonly key: string;
    readonly policy: OperationCachePolicy;
    readonly isCacheable?: (value: Result) => boolean;
  };
}

/**
 * Compatibility invocation for the canonical typed-query contract. It is
 * intentionally handled by this service as well, so low-level providers do
 * not have a second application execution path.
 */
export interface TypedQueryOperationInvocation<_Result> {
  readonly kind: "typed-query";
  readonly operation: QueryOperation;
  readonly query: BaseQuery;
  readonly providerRegistry: TypedQueryProviderRegistry;
  readonly resultMode: "value" | "result";
}

function executionError(
  context: QueryExecutionContext,
): AnalyticsServiceError | null {
  if (context.signal?.aborted) return { kind: "request-cancelled" };
  const now = context.now?.() ?? Date.now();
  if (typeof context.deadlineMs === "number" && now >= context.deadlineMs) {
    return { kind: "deadline-exceeded" };
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

function isTypedQueryInvocation<Query, Result>(
  invocation:
    | AnalyticsOperationInvocation<Query, Result>
    | TypedQueryOperationInvocation<Result>,
): invocation is TypedQueryOperationInvocation<Result> {
  return "kind" in invocation && invocation.kind === "typed-query";
}

/**
 * HTTP-free boundary for typed analytics queries. Authentication and DTO
 * parsing happen before this class; providers only receive canonical query data.
 */
export class TypedQueryApplicationService {
  constructor(
    private readonly cache?: OperationResultCache,
    private readonly costPolicy: QueryCostPolicy = defaultQueryCostPolicy,
  ) {}

  private costError(
    executionContext: QueryExecutionContext,
  ): AnalyticsServiceError | null {
    if (!executionContext.cost) return null;
    const cost = calculateQueryCost(executionContext.cost, this.costPolicy);
    return cost >= this.costPolicy.maxCost
      ? { kind: "query-cost-exceeded", cost }
      : null;
  }

  private async cached<T extends { readonly ok: boolean }>(
    cache:
      | {
          readonly key: string;
          readonly policy: OperationCachePolicy;
        }
      | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!cache || !this.cache) return run();
    try {
      return (
        await this.cache.getOrLoad({
          key: cache.key,
          policy: cache.policy,
          load: async () => {
            const value = await run();
            if (!value.ok) throw new UncacheableResult(value);
            return value;
          },
        })
      ).value;
    } catch (error) {
      if (error instanceof UncacheableResult) return error.value as T;
      throw error;
    }
  }

  private async executeTypedQuery<Result>(
    invocation: TypedQueryOperationInvocation<Result>,
  ): Promise<AnalyticsResult<Result>> {
    const validationError = validateTypedQueryInput(
      invocation.operation,
      invocation.query,
    );
    if (validationError) return { ok: false, error: validationError };

    try {
      if (invocation.resultMode === "result") {
        const provider = invocation.providerRegistry.resolveResult<Result>(
          invocation.operation,
        );
        if (!provider) {
          return {
            ok: false,
            error: { kind: "internal", operation: invocation.operation },
          };
        }
        return await provider.execute(invocation.query);
      }

      const provider = invocation.providerRegistry.resolve<Result>(
        invocation.operation,
      );
      if (!provider) {
        return {
          ok: false,
          error: { kind: "internal", operation: invocation.operation },
        };
      }
      const result = await provider.execute(invocation.query);
      return {
        ok: true,
        data: result.value,
        meta: {
          time: invocation.query.time,
          source: result.source ?? "raw",
          approximateVisitors: Boolean(result.approximateVisitors),
        },
      };
    } catch (error) {
      currentInvocationLogger()?.error("query.application-operation.failed", {
        operation: invocation.operation,
        ...errorLogData(error),
      });
      return {
        ok: false,
        error: { kind: "internal", operation: invocation.operation },
      };
    }
  }

  /**
   * Executes a registered analytics operation after validating the trusted
   * policy context and request guards. A provider sees only canonical query
   * data and execution context, never HTTP/auth objects.
   */
  async execute<Query, Result>(
    invocation: AnalyticsOperationInvocation<Query, Result>,
    executionContext: QueryExecutionContext,
  ): Promise<AnalyticsServiceResult<Result>>;
  async execute<Result>(
    invocation: TypedQueryOperationInvocation<Result>,
    executionContext?: QueryExecutionContext,
  ): Promise<AnalyticsResult<Result>>;
  async execute<Query, Result>(
    invocation:
      | AnalyticsOperationInvocation<Query, Result>
      | TypedQueryOperationInvocation<Result>,
    executionContext: QueryExecutionContext = {},
  ): Promise<AnalyticsServiceResult<Result> | AnalyticsResult<Result>> {
    if (isTypedQueryInvocation(invocation)) {
      return this.executeTypedQuery(invocation);
    }
    emit(executionContext, "start");
    const before = executionError(executionContext);
    if (before) {
      emit(
        executionContext,
        before.kind === "deadline-exceeded" ? "deadline" : "cancelled",
      );
      return { ok: false, error: before };
    }
    const plan = planAnalyticsOperation(
      invocation.operation,
      invocation.context,
    );
    if (!plan.ok) {
      const error: AnalyticsServiceError = plan.error;
      emit(executionContext, "failure");
      return { ok: false, error };
    }
    const costError = this.costError(executionContext);
    if (costError) {
      emit(
        executionContext,
        "cost",
        costError.kind === "query-cost-exceeded" ? costError.cost : undefined,
      );
      return { ok: false, error: costError };
    }
    const provider = invocation.providerRegistry.resolve<Query, Result>(
      invocation.operation,
    );
    if (!provider) {
      emit(executionContext, "failure");
      return {
        ok: false,
        error: {
          kind: "operation-not-allowed",
          operation: invocation.operation,
        },
      };
    }
    let value: Result;
    try {
      const load = async () =>
        provider.execute({
          operation: invocation.operation,
          context: invocation.context,
          query: invocation.query,
          execution: executionContext,
        });
      if (invocation.cache && this.cache) {
        const cached = await this.cached(invocation.cache, async () => {
          const loaded = await load();
          return {
            ok: invocation.cache?.isCacheable?.(loaded) ?? true,
            value: loaded,
          };
        });
        value = cached.value;
      } else {
        value = await load();
      }
    } catch (error) {
      emit(executionContext, "failure");
      throw error;
    }
    const after = executionError(executionContext);
    if (after) {
      emit(
        executionContext,
        after.kind === "deadline-exceeded" ? "deadline" : "cancelled",
      );
      return { ok: false, error: after };
    }
    emit(executionContext, "success");
    return { ok: true, value };
  }
}
