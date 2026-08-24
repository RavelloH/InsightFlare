import {
  calculateQueryCost,
  defaultQueryCostPolicy,
  type QueryCostInput,
  type QueryCostPolicy,
} from "@/lib/api-v1/query-cost";
import type { OperationResultCache } from "@/lib/edge/analytics/operation-cache";
import { type OperationCachePolicy } from "@/lib/edge/analytics/operation-cache";
import {
  analyticsOperationById,
  type AnalyticsOperationId,
} from "@/lib/edge/analytics/operation-registry";
import {
  executeOverview,
  executeTrend,
  type FilterDocument,
  type OverviewQuery,
  type OverviewReader,
  type QueryContext,
  type QueryTime,
} from "@/lib/edge/query-contract";

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

export type AnalyticsServiceError =
  | { readonly kind: "deadline-exceeded" }
  | { readonly kind: "request-cancelled" }
  | { readonly kind: "query-cost-exceeded"; readonly cost: number }
  | {
      readonly kind: "operation-not-allowed";
      readonly operation: AnalyticsOperationId;
    };

export type AnalyticsServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AnalyticsServiceError };

/**
 * Provider boundary for a registered analytics operation. HTTP adapters build
 * the canonical query and inject this provider at composition time; the query
 * service never accepts an arbitrary reader callback.
 */
export interface AnalyticsOperationProvider<Query, Result> {
  execute(input: {
    readonly operation: AnalyticsOperationId;
    readonly context: QueryContext;
    readonly query: Query;
    readonly execution: QueryExecutionContext;
  }): Promise<Result>;
}

/**
 * Request-scoped provider registry. The application operation service resolves
 * providers by operation id, so protocol adapters no longer need to select a
 * data source by reaching into query/runtime modules directly.
 */
export class TypedApplicationProviderRegistry {
  private readonly providers = new Map<
    AnalyticsOperationId,
    AnalyticsOperationProvider<unknown, unknown>
  >();

  register<Query, Result>(
    operation: AnalyticsOperationId,
    provider: AnalyticsOperationProvider<Query, Result>,
  ): this {
    this.providers.set(
      operation,
      provider as AnalyticsOperationProvider<unknown, unknown>,
    );
    return this;
  }

  resolve<Query, Result>(
    operation: AnalyticsOperationId,
  ): AnalyticsOperationProvider<Query, Result> | undefined {
    return this.providers.get(operation) as
      | AnalyticsOperationProvider<Query, Result>
      | undefined;
  }
}

export interface AnalyticsOperationInvocation<Query, Result> {
  readonly operation: AnalyticsOperationId;
  readonly context: QueryContext;
  readonly query: Query;
  readonly provider?: AnalyticsOperationProvider<Query, Result>;
  readonly providerRegistry?: TypedApplicationProviderRegistry;
  readonly cache?: {
    readonly key: string;
    readonly policy: OperationCachePolicy;
    readonly isCacheable?: (value: Result) => boolean;
  };
}

/** Creates a provider adapter at the composition boundary. */
export function analyticsOperationProvider<Query, Result>(
  execute: (query: Query, execution: QueryExecutionContext) => Promise<Result>,
): AnalyticsOperationProvider<Query, Result> {
  return {
    execute: ({ query, execution: executionContext }) =>
      execute(query, executionContext),
  };
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

export interface OverviewExecution {
  readonly context: QueryContext;
  readonly time: QueryTime;
  readonly filters: FilterDocument;
  readonly previousTime?: QueryTime;
  readonly cache?: {
    readonly key: string;
    readonly policy: OperationCachePolicy;
  };
}

export interface TrendExecution extends Omit<
  OverviewExecution,
  "previousTime"
> {
  readonly interval: Parameters<typeof executeTrend>[1]["interval"];
}

class UncacheableResult extends Error {
  constructor(readonly value: unknown) {
    super("analytics result must not enter cache");
  }
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
    cache: OverviewExecution["cache"] | undefined,
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

  /**
   * Executes a registered non-overview operation after validating the trusted
   * policy context and request guards. A provider sees only canonical query
   * data and execution context, never HTTP/auth objects.
   */
  async execute<Query, Result>(
    invocation: AnalyticsOperationInvocation<Query, Result>,
    executionContext: QueryExecutionContext,
  ): Promise<AnalyticsServiceResult<Result>>;
  async execute<Query, Result>(
    invocation: AnalyticsOperationInvocation<Query, Result>,
    executionContext: QueryExecutionContext,
  ): Promise<AnalyticsServiceResult<Result>> {
    emit(executionContext, "start");
    const before = executionError(executionContext);
    if (before) {
      emit(
        executionContext,
        before.kind === "deadline-exceeded" ? "deadline" : "cancelled",
      );
      return { ok: false, error: before };
    }
    const descriptor = analyticsOperationById(invocation.operation);
    if (
      !descriptor ||
      !descriptor.subjectKinds.includes(invocation.context.subject.kind) ||
      !descriptor.audiences.includes(invocation.context.policy.audience)
    ) {
      const error: AnalyticsServiceError = {
        kind: "operation-not-allowed",
        operation: invocation.operation,
      };
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
    const provider =
      invocation.provider ??
      invocation.providerRegistry?.resolve<Query, Result>(invocation.operation);
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

  async overview(
    reader: OverviewReader,
    execution: OverviewExecution,
    executionContext: QueryExecutionContext,
  ): Promise<
    AnalyticsServiceResult<Awaited<ReturnType<typeof executeOverview>>>
  > {
    emit(executionContext, "start");
    const before = executionError(executionContext);
    if (before) {
      emit(
        executionContext,
        before.kind === "deadline-exceeded" ? "deadline" : "cancelled",
      );
      return { ok: false, error: before };
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

    const input: OverviewQuery = {
      context: execution.context,
      time: execution.time,
      filters: execution.filters,
      ...(execution.previousTime
        ? { previousTime: execution.previousTime }
        : {}),
    };
    let result: Awaited<ReturnType<typeof executeOverview>>;
    try {
      result = await this.cached(execution.cache, () =>
        executeOverview(reader, input),
      );
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
    return { ok: true, value: result };
  }

  async trend(
    reader: OverviewReader,
    execution: TrendExecution,
    executionContext: QueryExecutionContext,
  ): Promise<AnalyticsServiceResult<Awaited<ReturnType<typeof executeTrend>>>> {
    emit(executionContext, "start");
    const before = executionError(executionContext);
    if (before) {
      emit(
        executionContext,
        before.kind === "deadline-exceeded" ? "deadline" : "cancelled",
      );
      return { ok: false, error: before };
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
    let result: Awaited<ReturnType<typeof executeTrend>>;
    try {
      result = await this.cached(execution.cache, () =>
        executeTrend(reader, {
          context: execution.context,
          time: execution.time,
          filters: execution.filters,
          interval: execution.interval,
        }),
      );
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
    return { ok: true, value: result };
  }
}
