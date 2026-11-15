import type { TypedQueryProviderMiddleware } from "@/lib/edge/analytics/application/provider-registry";

import type { D1LogicalProgramExecution } from "./logical-program-execution";

/** Optional only for the existing direct reader / middleware call contract. */
export interface D1ExecutionOptions {
  readonly signal?: AbortSignal;
  readonly program?: D1LogicalProgramExecution;
}

/** Every configured D1 registry dispatch constructs this itself. */
export interface D1ProgramExecutionOptions extends D1ExecutionOptions {
  readonly program: D1LogicalProgramExecution;
}

/** Same middleware contract, with the D1-owned execution value in its closure. */
export type D1QueryProviderMiddleware = (
  operation: Parameters<TypedQueryProviderMiddleware>[0],
  input: Parameters<TypedQueryProviderMiddleware>[1],
  next: Parameters<TypedQueryProviderMiddleware>[2],
  execution?: D1ExecutionOptions,
) => ReturnType<TypedQueryProviderMiddleware>;
