import type {
  QueryInput,
  QueryOperation,
  QuerySource,
} from "@/lib/edge/analytics/contract";

/**
 * Result returned by every canonical analytics provider.
 *
 * The application service owns the public AnalyticsResult envelope. Providers
 * only report their value and data provenance.
 */
export interface TypedQueryProviderResult<T> {
  readonly value: T;
  readonly source?: QuerySource;
  readonly approximateVisitors?: boolean;
}

/** The only provider shape accepted by the application layer. */
export interface TypedQueryProvider<T> {
  execute(
    input: QueryInput,
    execution?: { readonly signal?: AbortSignal },
  ): Promise<TypedQueryProviderResult<T>>;
}

/**
 * Request-scoped registry for canonical query operations.
 *
 * External/API operation ids are translated by their protocol adapters before
 * registration. This class deliberately knows only QueryOperation names and
 * maintains one provider map.
 */
export class AnalyticsProviderRegistry {
  private readonly providers = new Map<
    QueryOperation,
    TypedQueryProvider<unknown>
  >();

  register<T>(
    operation: QueryOperation,
    provider: TypedQueryProvider<T>,
  ): this {
    this.providers.set(operation, provider as TypedQueryProvider<unknown>);
    return this;
  }

  resolve<T>(operation: QueryOperation): TypedQueryProvider<T> | undefined {
    return this.providers.get(operation) as TypedQueryProvider<T> | undefined;
  }
}

export function typedQueryProvider<T>(
  reader: (
    input?: QueryInput,
    execution?: { readonly signal?: AbortSignal },
  ) => Promise<TypedQueryProviderResult<T>>,
): TypedQueryProvider<T> {
  return { execute: reader };
}

export function createTypedQueryProviderRegistry<T>(
  operation: QueryOperation,
  reader: (
    input?: QueryInput,
    execution?: { readonly signal?: AbortSignal },
  ) => Promise<TypedQueryProviderResult<T>>,
): AnalyticsProviderRegistry {
  return new AnalyticsProviderRegistry().register(
    operation,
    typedQueryProvider(reader),
  );
}
