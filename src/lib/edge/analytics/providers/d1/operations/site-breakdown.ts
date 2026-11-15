import "@tanstack/react-start/server-only";

import {
  type BreakdownResult,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import { crossBreakdownPageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryDimensionFromD1,
  querySessionBoundaryDimensionFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import { queryEventTypeAggregate } from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import type { Env } from "@/lib/edge/types";

export interface ReadSiteBreakdownInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly dimension: string;
  readonly limit: number;
  readonly filters: FilterDocument;
  readonly wholeOriginalOwner?: object;
}

function unsupportedDimension(dimension: string): never {
  throw new Error(`unsupported-dimension:${dimension}`);
}

/** Typed site dimension provider. HTTP and legacy API adapters do not own SQL. */
export async function readSiteBreakdown(
  input: ReadSiteBreakdownInput,
): Promise<BreakdownResult> {
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
              const selection = crossBreakdownPageDimensionSelection(
                input.dimension,
              );
              if (!selection) unsupportedDimension(input.dimension);
              const args: Parameters<typeof queryDimensionFromD1> =
                input.wholeOriginalOwner
                  ? [
                      input.env,
                      input.siteId,
                      input.window,
                      input.filters,
                      input.limit,
                      selection,
                      { excludeEmpty: true },
                      undefined,
                      undefined,
                      {
                        owner: input.wholeOriginalOwner,
                        dimension: input.dimension,
                      },
                    ]
                  : [
                      input.env,
                      input.siteId,
                      input.window,
                      input.filters,
                      input.limit,
                      selection,
                      { excludeEmpty: true },
                    ];
              return queryDimensionFromD1(...args);
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
