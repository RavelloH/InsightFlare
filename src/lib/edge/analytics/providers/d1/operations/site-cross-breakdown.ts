import "@tanstack/react-start/server-only";

import {
  type CrossBreakdownResult,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { resolveCrossBreakdownDimension } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import { queryCrossDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
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
