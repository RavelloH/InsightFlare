import {
  AnalyticsProviderRegistry,
  type TypedQueryProvider,
  typedQueryProviderFor,
  type TypedQueryProviderResult,
} from "@/lib/edge/analytics/application/provider-registry";
import type {
  CanonicalQuery,
  CanonicalResult,
  QueryOperation,
} from "@/lib/edge/analytics/contract";
import type {
  D1ExecutionOptions,
  D1ProgramExecutionOptions,
} from "@/lib/edge/analytics/providers/d1/internal/execution-options";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";

/** Keeps the application registry's one provider map and middleware ordering. */
export class D1ProgramProviderRegistry extends AnalyticsProviderRegistry {
  override resolve<Operation extends QueryOperation>(
    operation: Operation,
  ): TypedQueryProvider<Operation> | undefined {
    const provider = this.providers.get(operation) as
      TypedQueryProvider<Operation> | undefined;
    if (!provider || this.middlewares.length === 0) return provider;
    return {
      execute: (input, execution) => {
        const program = new D1LogicalProgramExecution();
        // Read only the caller's signal, lazily at the original read sites.
        // Unknown caller fields, including any program, are never copied.
        const d1Execution: D1ProgramExecutionOptions = Object.freeze({
          get signal() {
            return execution?.signal;
          },
          program,
        });
        const dispatch = async (
          index: number,
          current: unknown,
        ): Promise<unknown> => {
          if (index >= this.middlewares.length) {
            return provider.execute(
              current as CanonicalQuery<Operation>,
              d1Execution,
            );
          }
          return this.middlewares[index]!(
            operation,
            current,
            (nextInput) => dispatch(index + 1, nextInput),
            d1Execution,
          );
        };
        return dispatch(0, input) as ReturnType<typeof provider.execute>;
      },
    };
  }
}

/** A synchronous factory; the original reader remains the provider function. */
export function typedD1QueryProviderFor<Operation extends QueryOperation>(
  operation: Operation,
  reader: (
    input: CanonicalQuery<Operation>,
    execution?: D1ExecutionOptions,
  ) => Promise<TypedQueryProviderResult<CanonicalResult<Operation>>>,
): TypedQueryProvider<Operation> {
  return typedQueryProviderFor(operation, reader);
}
