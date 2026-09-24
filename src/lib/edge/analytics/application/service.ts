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
  CanonicalQuery,
  CanonicalResult,
  EntitySetExpression,
  FilterScope,
  QueryInput,
  QueryOperation,
  QueryTime,
  ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import { prepareScopedQuery } from "@/lib/edge/analytics/contract/scoped-filter";
import { InvalidCursorError } from "@/lib/pagination";

import type { AnalyticsProviderRegistry } from "./provider-registry";
import type { TypedQueryProviderResult } from "./provider-registry";
import { validateTypedQueryInput } from "./query-validation";
export type { AnalyticsServiceError, AnalyticsServiceResult } from "./errors";
export interface QueryExecutionContext {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  /** One request-scoped clock captured before provider execution. */
  readonly capturedAtMs?: number;
  readonly now?: () => number;
  /** Optional normalized cost dimensions supplied by the DTO adapter. */
  readonly cost?: QueryCostInput;
  /** Optional protocol-owned cache policy carried through the runtime boundary. */
  readonly cache?: {
    readonly key: string;
    readonly policy: OperationCachePolicy;
    readonly isCacheable?: (value: unknown) => boolean;
  };
  /** Optional cache instance supplied by a protocol adapter. */
  readonly cacheStore?: OperationResultCache;
  /** Optional low-cardinality hook; callers must not include query payloads. */
  readonly onEvent?: (event: AnalyticsQueryEvent) => void;
  /** Allows a protocol adapter to preserve its legacy provider-error mapping. */
  readonly onProviderError?: (error: unknown) => void;
  readonly operation?: string;
}
export interface AnalyticsQueryEvent {
  readonly operation: string;
  readonly phase:
    "start" | "success" | "cancelled" | "deadline" | "cost" | "failure";
  readonly cost?: number;
  readonly requestedScope?: string;
  readonly resolvedScope?: FilterScope;
  readonly requiredSources?: readonly string[];
  readonly requiresRawSource?: boolean;
}
export type AnalyticsApplicationErrorHandler = (
  error: unknown,
  operation: string,
) => void;
/**
 * The only application invocation shape. Route, SSR, and protocol adapters
 * normalize their own inputs before creating this object.
 */
export interface TypedQueryOperationInvocation<
  Operation extends QueryOperation,
> {
  readonly kind: "typed-query";
  readonly operation: Operation;
  readonly query: CanonicalQuery<Operation>;
  readonly providerRegistry: AnalyticsProviderRegistry;
  readonly cache?: {
    readonly key: string;
    readonly policy: OperationCachePolicy;
    readonly isCacheable?: (value: CanonicalResult<Operation>) => boolean;
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
  query?: QueryInput,
): void {
  try {
    const plan = query?.scopePlan;
    context.onEvent?.({
      operation: context.operation ?? "unknown",
      phase,
      ...(cost === undefined ? {} : { cost }),
      ...(plan
        ? {
            requestedScope: query?.scopePreference ?? "auto",
            resolvedScope: plan.scope,
            requiredSources: [...plan.requiredSources].sort(),
            requiresRawSource: plan.requiresRawSource,
          }
        : {}),
    });
  } catch {
    // Observability must never change query behavior.
  }
}
function entityExpressionComplexity(
  expression: EntitySetExpression | null,
): number {
  if (!expression || expression.kind === "condition") return 1;
  if (expression.kind === "not") {
    return 1 + entityExpressionComplexity(expression.child);
  }
  return Math.max(
    1,
    1 +
      expression.children.reduce(
        (total, child) => total + entityExpressionComplexity(child),
        0,
      ),
  );
}
function scopeAwareCostInput(
  input: QueryCostInput | undefined,
  query: QueryInput,
): QueryCostInput | undefined {
  const plan: ScopedFilterPlan | undefined = query.scopePlan;
  if (!input || !plan) return input;
  return {
    ...input,
    scope: plan.scope,
    requiredSourceCount: Math.max(1, plan.requiredSources.size),
    entityAlgebraComplexity:
      plan.membership.kind === "entity"
        ? entityExpressionComplexity(plan.membership.expression)
        : 1,
    eventPayloadComplexity: plan.requiredSources.has("payload") ? 2 : 1,
    requiresRawSource: plan.requiresRawSource,
  };
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
    private readonly onApplicationError?: AnalyticsApplicationErrorHandler,
  ) {}

  private costError(costInput: QueryCostInput | undefined): {
    readonly ok: false;
    readonly error: {
      readonly kind: "query-cost-exceeded";
      readonly cost: number;
    };
  } | null {
    if (!costInput) return null;
    const cost = calculateQueryCost(costInput, this.costPolicy);
    return cost >= this.costPolicy.maxCost
      ? { ok: false, error: { kind: "query-cost-exceeded", cost } }
      : null;
  }

  private async executeTypedQuery<Operation extends QueryOperation>(
    invocation: TypedQueryOperationInvocation<Operation>,
    executionContext: QueryExecutionContext,
  ): Promise<AnalyticsResult<CanonicalResult<Operation>>> {
    emit(executionContext, "start");

    const before = executionDomainError(executionContext);
    if (before) {
      emit(
        executionContext,
        before.error.kind === "deadline-exceeded" ? "deadline" : "cancelled",
      );
      return before;
    }

    // Validate the caller's document before scope planning. Scope planning
    // deliberately works with trusted FilterExpression nodes, while this
    // boundary is also responsible for returning the public invalid-filter
    // error for malformed documents.
    const initialValidationError = validateTypedQueryInput(
      invocation.operation,
      invocation.query,
    );
    if (initialValidationError) {
      emit(executionContext, "failure");
      return { ok: false, error: initialValidationError };
    }

    let preparedQuery: QueryInput;
    try {
      preparedQuery = prepareScopedQuery(
        invocation.operation,
        invocation.query,
      );
    } catch (error) {
      const code =
        error instanceof Error ? error.message : "invalid_filter_scope";
      emit(executionContext, "failure");
      if (error instanceof InvalidCursorError) {
        return {
          ok: false,
          error: { kind: "invalid-cursor", cursorKind: error.cursorKind },
        };
      }
      return {
        ok: false,
        error: {
          kind: "invalid-input",
          issues: [{ path: "scope", code }],
        },
      };
    }

    const validationError = validateTypedQueryInput(
      invocation.operation,
      preparedQuery,
    );
    if (validationError) {
      emit(executionContext, "failure");
      return { ok: false, error: validationError };
    }

    const costInput = scopeAwareCostInput(executionContext.cost, preparedQuery);
    const costError = this.costError(costInput);
    if (costError) {
      emit(
        executionContext,
        "cost",
        costError.error.kind === "query-cost-exceeded"
          ? costError.error.cost
          : undefined,
        preparedQuery,
      );
      return costError;
    }

    try {
      const provider = invocation.providerRegistry.resolve<Operation>(
        invocation.operation,
      );
      if (!provider) {
        emit(executionContext, "failure");
        return {
          ok: false,
          error: { kind: "internal", operation: invocation.operation },
        };
      }
      const load = async (): Promise<
        TypedQueryProviderResult<CanonicalResult<Operation>>
      > =>
        provider.execute(
          preparedQuery as CanonicalQuery<Operation>,
          executionContext,
        );
      let result: TypedQueryProviderResult<CanonicalResult<Operation>>;
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
          result = error.value as TypedQueryProviderResult<
            CanonicalResult<Operation>
          >;
        }
      }
      const time =
        "time" in preparedQuery
          ? (preparedQuery as QueryInput & { readonly time: QueryTime }).time
          : "current" in preparedQuery &&
              preparedQuery.current &&
              typeof preparedQuery.current === "object" &&
              "time" in preparedQuery.current
            ? (preparedQuery.current as { readonly time: QueryTime }).time
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
      emit(executionContext, "success", undefined, preparedQuery);
      return {
        ok: true,
        data: result.value,
        meta: {
          time,
          source: result.source ?? "raw",
          approximateVisitors: Boolean(result.approximateVisitors),
          ...(preparedQuery.scopePlan
            ? {
                filterScope: {
                  requested: preparedQuery.scopePreference ?? "auto",
                  resolved: preparedQuery.scopePlan.scope,
                },
              }
            : {}),
        },
      };
    } catch (error) {
      try {
        executionContext.onProviderError?.(error);
      } catch {
        // Error reporting must never change query behavior.
      }
      try {
        this.onApplicationError?.(error, invocation.operation);
      } catch {
        // Application error reporting must never change query behavior.
      }
      emit(executionContext, "failure");
      if (error instanceof InvalidCursorError) {
        return {
          ok: false,
          error: { kind: "invalid-cursor", cursorKind: error.cursorKind },
        };
      }
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
  async execute<Operation extends QueryOperation>(
    invocation: TypedQueryOperationInvocation<Operation>,
    executionContext: QueryExecutionContext = {},
  ): Promise<AnalyticsResult<CanonicalResult<Operation>>> {
    return this.executeTypedQuery(invocation, executionContext);
  }
}
