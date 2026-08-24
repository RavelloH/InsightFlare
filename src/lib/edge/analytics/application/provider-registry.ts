import type {
  AnalyticsResult,
  QueryContext,
  QueryInput,
  QueryOperation,
  QuerySource,
} from "@/lib/edge/analytics/contract";

import type { AnalyticsOperationId } from "./operation-registry";
import type { QueryExecutionContext } from "./service";

/**
 * A provider is the only application-layer boundary to a query data source.
 * Adapters may create providers, but the application service only resolves
 * them from a request-scoped registry.
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
 * The single provider registry used by the analytics application boundary.
 *
 * The two provider signatures are intentionally kept as separate maps while
 * callers migrate to canonical QueryOperation names.  They are one registry
 * object and one composition boundary; the old exported names below are only
 * compatibility aliases for existing adapters and tests.
 */
export class AnalyticsProviderRegistry {
  private readonly providers = new Map<
    AnalyticsOperationId,
    AnalyticsOperationProvider<unknown, unknown>
  >();
  private readonly queryProviders = new Map<
    QueryOperation,
    TypedQueryProvider<unknown>
  >();
  private readonly resultProviders = new Map<
    QueryOperation,
    TypedQueryResultProvider<unknown>
  >();

  /** Registers an external/API operation during the migration window. */
  register<T>(operation: QueryOperation, provider: TypedQueryProvider<T>): this;
  register<Query, Result>(
    operation: AnalyticsOperationId,
    provider: AnalyticsOperationProvider<Query, Result>,
  ): this;
  register(
    operation: AnalyticsOperationId | QueryOperation,
    provider: unknown,
  ): this {
    if (!operation.includes(".")) {
      return this.registerQuery(
        operation as QueryOperation,
        provider as TypedQueryProvider<unknown>,
      );
    }
    this.providers.set(
      operation as AnalyticsOperationId,
      provider as AnalyticsOperationProvider<unknown, unknown>,
    );
    return this;
  }

  /** Registers the canonical typed-query provider. */
  registerQuery<T>(
    operation: QueryOperation,
    provider: TypedQueryProvider<T>,
  ): this {
    this.queryProviders.set(operation, provider as TypedQueryProvider<unknown>);
    return this;
  }

  /** Registers a typed provider that already owns the AnalyticsResult envelope. */
  registerQueryResult<T>(
    operation: QueryOperation,
    provider: TypedQueryResultProvider<T>,
  ): this {
    this.resultProviders.set(
      operation,
      provider as TypedQueryResultProvider<unknown>,
    );
    return this;
  }

  /** Keeps callback adaptation inside the registry rather than in routes. */
  registerCallback<Query, Result>(
    operation: AnalyticsOperationId,
    execute: (
      query: Query,
      execution: QueryExecutionContext,
    ) => Promise<Result>,
  ): this {
    return this.register(operation, analyticsOperationProvider(execute));
  }

  resolve<T>(operation: QueryOperation): TypedQueryProvider<T> | undefined;
  resolve<Query, Result>(
    operation: AnalyticsOperationId,
  ): AnalyticsOperationProvider<Query, Result> | undefined;
  resolve<Query, Result>(
    operation: AnalyticsOperationId | QueryOperation,
  ):
    | AnalyticsOperationProvider<Query, Result>
    | TypedQueryProvider<Query>
    | undefined {
    if (!operation.includes(".")) {
      return this.resolveQuery<Query>(operation as QueryOperation);
    }
    return this.providers.get(operation as AnalyticsOperationId) as
      | AnalyticsOperationProvider<Query, Result>
      | undefined;
  }

  resolveResult<T>(
    operation: QueryOperation,
  ): TypedQueryResultProvider<T> | undefined {
    return this.resolveQueryResult(operation);
  }

  registerResult<T>(
    operation: QueryOperation,
    provider: TypedQueryResultProvider<T>,
  ): this {
    return this.registerQueryResult(operation, provider);
  }

  resolveQuery<T>(
    operation: QueryOperation,
  ): TypedQueryProvider<T> | undefined {
    return this.queryProviders.get(operation) as
      | TypedQueryProvider<T>
      | undefined;
  }

  resolveQueryResult<T>(
    operation: QueryOperation,
  ): TypedQueryResultProvider<T> | undefined {
    return this.resultProviders.get(operation) as
      | TypedQueryResultProvider<T>
      | undefined;
  }
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

export interface TypedQueryProviderResult<T> {
  readonly value: T;
  readonly source?: QuerySource;
  readonly approximateVisitors?: boolean;
}

export interface TypedQueryProvider<T> {
  execute(input: QueryInput): Promise<TypedQueryProviderResult<T>>;
}

export interface TypedQueryResultProvider<T> {
  execute(input: QueryInput): Promise<AnalyticsResult<T>>;
}

/** Registry shared by private/public/SSR typed-query adapters. */
/** Compatibility aliases. New code should use AnalyticsProviderRegistry. */
export {
  AnalyticsProviderRegistry as TypedApplicationProviderRegistry,
  AnalyticsProviderRegistry as TypedQueryProviderRegistry,
};

export function typedQueryProvider<T>(
  reader: () => Promise<TypedQueryProviderResult<T>>,
): TypedQueryProvider<T> {
  return { execute: reader };
}

export function typedQueryResultProvider<T>(
  reader: () => Promise<AnalyticsResult<T>>,
): TypedQueryResultProvider<T> {
  return { execute: reader };
}

export function createTypedQueryProviderRegistry<T>(
  operation: QueryOperation,
  reader: () => Promise<TypedQueryProviderResult<T>>,
): AnalyticsProviderRegistry {
  return new AnalyticsProviderRegistry().registerQuery(
    operation,
    typedQueryProvider(reader),
  );
}

export function createTypedQueryResultProviderRegistry<T>(
  operation: QueryOperation,
  reader: () => Promise<AnalyticsResult<T>>,
): AnalyticsProviderRegistry {
  return new AnalyticsProviderRegistry().registerQueryResult(
    operation,
    typedQueryResultProvider(reader),
  );
}
