import type {
  CanonicalQuery,
  CanonicalResult,
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
export interface TypedQueryProvider<
  Operation extends QueryOperation = QueryOperation,
  Result = CanonicalResult<Operation>,
> {
  execute(
    input: CanonicalQuery<Operation>,
    execution?: { readonly signal?: AbortSignal },
  ): Promise<TypedQueryProviderResult<Result>>;
}

type AnyTypedQueryProvider = {
  [Operation in QueryOperation]: TypedQueryProvider<Operation>;
}[QueryOperation];

/**
 * Request-scoped registry for canonical query operations.
 *
 * External/API operation ids are translated by their protocol adapters before
 * registration. This class deliberately knows only QueryOperation names and
 * maintains one provider map.
 */
export class AnalyticsProviderRegistry {
  private readonly providers = new Map<QueryOperation, AnyTypedQueryProvider>();

  register<Operation extends QueryOperation>(
    operation: Operation,
    provider: TypedQueryProvider<NoInfer<Operation>>,
  ): this {
    this.providers.set(operation, provider as AnyTypedQueryProvider);
    return this;
  }

  resolve<Operation extends QueryOperation>(
    operation: Operation,
  ): TypedQueryProvider<Operation> | undefined {
    return this.providers.get(operation) as
      TypedQueryProvider<Operation> | undefined;
  }
}

/** Builds a provider from the query/result contract for one canonical operation. */
export function typedQueryProviderFor<Operation extends QueryOperation>(
  operation: Operation,
  reader: (
    input: CanonicalQuery<Operation>,
    execution?: { readonly signal?: AbortSignal },
  ) => Promise<TypedQueryProviderResult<CanonicalResult<Operation>>>,
): TypedQueryProvider<Operation> {
  void operation;
  return { execute: reader };
}

export function createTypedQueryProviderRegistry<
  Operation extends QueryOperation,
>(
  operation: Operation,
  reader: (
    input: CanonicalQuery<Operation>,
    execution?: { readonly signal?: AbortSignal },
  ) => Promise<TypedQueryProviderResult<CanonicalResult<Operation>>>,
): AnalyticsProviderRegistry {
  return new AnalyticsProviderRegistry().register(operation, {
    execute: reader,
  });
}
