import "@tanstack/react-start/server-only";

import type { QueryWindow } from "@/lib/edge/query/core";
import { resolveCrossBreakdownDimension } from "@/lib/edge/query/core-dimensions";
import { queryCrossDimensionFromD1 } from "@/lib/edge/query/technology/client-cross";
import {
  assertFilterAudience,
  assertOperationAllowed,
  type CrossBreakdownResult,
  type FilterDocument,
  siteQueryContext,
  validateTypedQueryFilters,
} from "@/lib/edge/query-contract";
import { analyticsFilterRegistry } from "@/lib/edge/query-contract/filter-registry";
import type { Env } from "@/lib/edge/types";

export interface ReadSiteCrossBreakdownInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly primaryDimension: string;
  readonly secondaryDimension: string;
  readonly primaryLimit: number;
  readonly secondaryLimit: number;
  readonly filters: FilterDocument;
}

/** Typed site cross-dimension provider. SQL remains below this domain boundary. */
export async function readSiteCrossBreakdown(
  input: ReadSiteCrossBreakdownInput,
): Promise<CrossBreakdownResult> {
  const context = siteQueryContext(input.siteId, "api-v1");
  const operationError = assertOperationAllowed(context, "cross-dimension");
  if (operationError) throw new Error(operationError.kind);
  const filterError = validateTypedQueryFilters(context, input.filters);
  if (filterError) throw new Error(filterError.kind);
  try {
    assertFilterAudience(
      input.filters,
      analyticsFilterRegistry,
      context.policy.audience,
    );
  } catch {
    throw new Error("invalid-input");
  }

  const primary = resolveCrossBreakdownDimension(input.primaryDimension);
  const secondary = resolveCrossBreakdownDimension(input.secondaryDimension);
  if (
    !primary ||
    !secondary ||
    input.primaryDimension === input.secondaryDimension
  ) {
    throw new Error("unsupported-dimension");
  }
  return queryCrossDimensionFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    input.primaryLimit,
    input.secondaryLimit,
    primary,
    secondary,
  );
}
