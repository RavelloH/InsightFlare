import type {
  AnalyticsResult,
  BaseQuery,
  QueryContext,
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
  execute(input: BaseQuery): Promise<TypedQueryProviderResult<T>>;
}

export interface TypedQueryResultProvider<T> {
  execute(input: BaseQuery): Promise<AnalyticsResult<T>>;
}

/** Registry shared by private/public/SSR typed-query adapters. */
export class TypedQueryProviderRegistry {
  private readonly providers = new Map<
    QueryOperation,
    TypedQueryProvider<unknown>
  >();
  private readonly resultProviders = new Map<
    QueryOperation,
    TypedQueryResultProvider<unknown>
  >();

  register<T>(
    operation: QueryOperation,
    provider: TypedQueryProvider<T>,
  ): this {
    this.providers.set(operation, provider as TypedQueryProvider<unknown>);
    return this;
  }

  registerResult<T>(
    operation: QueryOperation,
    provider: TypedQueryResultProvider<T>,
  ): this {
    this.resultProviders.set(
      operation,
      provider as TypedQueryResultProvider<unknown>,
    );
    return this;
  }

  resolve<T>(operation: QueryOperation): TypedQueryProvider<T> | undefined {
    return this.providers.get(operation) as TypedQueryProvider<T> | undefined;
  }

  resolveResult<T>(
    operation: QueryOperation,
  ): TypedQueryResultProvider<T> | undefined {
    return this.resultProviders.get(operation) as
      | TypedQueryResultProvider<T>
      | undefined;
  }
}

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
): TypedQueryProviderRegistry {
  return new TypedQueryProviderRegistry().register(
    operation,
    typedQueryProvider(reader),
  );
}

export function createTypedQueryResultProviderRegistry<T>(
  operation: QueryOperation,
  reader: () => Promise<AnalyticsResult<T>>,
): TypedQueryProviderRegistry {
  return new TypedQueryProviderRegistry().registerResult(
    operation,
    typedQueryResultProvider(reader),
  );
}
