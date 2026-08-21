import "@tanstack/react-start/server-only";

import type { QueryWindow } from "@/lib/edge/query/core";
import { resolveCrossBreakdownDimension } from "@/lib/edge/query/core-dimensions";
import {
  queryDimensionFromD1,
  querySessionBoundaryDimensionFromD1,
} from "@/lib/edge/query/dimensions";
import { queryEventTypeAggregate } from "@/lib/edge/query/events-summary";
import {
  assertFilterAudience,
  assertOperationAllowed,
  type BreakdownResult,
  type FilterDocument,
  siteQueryContext,
  validateQueryFilters,
} from "@/lib/edge/query-contract";
import { analyticsFilterRegistry } from "@/lib/edge/query-contract/filter-registry";
import type { Env } from "@/lib/edge/types";

export interface ReadSiteBreakdownInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly dimension: string;
  readonly limit: number;
  readonly filters: FilterDocument;
}

function unsupportedDimension(dimension: string): never {
  throw new Error(`unsupported-dimension:${dimension}`);
}

/** Typed site dimension provider. HTTP and legacy API adapters do not own SQL. */
export async function readSiteBreakdown(
  input: ReadSiteBreakdownInput,
): Promise<BreakdownResult> {
  const context = siteQueryContext(input.siteId, "api-v1");
  const operationError = assertOperationAllowed(context, "dimension");
  if (operationError) throw new Error(operationError.kind);
  const filterError = validateQueryFilters(context, input.filters);
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

  const rows =
    input.dimension === "session.entryPath"
      ? await querySessionBoundaryDimensionFromD1(
          input.env,
          input.siteId,
          input.window,
          input.filters,
          input.limit,
          "entry",
        )
      : input.dimension === "session.exitPath"
        ? await querySessionBoundaryDimensionFromD1(
            input.env,
            input.siteId,
            input.window,
            input.filters,
            input.limit,
            "exit",
          )
        : input.dimension === "event.name"
          ? await queryEventTypeAggregate(
              input.env,
              input.siteId,
              input.window,
              input.filters,
              input.limit,
            )
          : await (() => {
              const definition = resolveCrossBreakdownDimension(
                input.dimension,
              );
              if (!definition) unsupportedDimension(input.dimension);
              return queryDimensionFromD1(
                input.env,
                input.siteId,
                input.window,
                input.filters,
                input.limit,
                definition.labelExpr,
                { excludeEmpty: true },
              );
            })();
  return {
    items: rows.map((row) => ({
      key: row.value,
      label: row.value,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
  };
}
