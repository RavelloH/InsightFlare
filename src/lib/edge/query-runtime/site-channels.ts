import "@tanstack/react-start/server-only";

import { queryChannelsFromD1 } from "@/lib/edge/query/channels";
import type { QueryWindow } from "@/lib/edge/query/core";
import {
  assertFilterAudience,
  type ChannelsResult,
  executeChannels,
  type FilterDocument,
  siteQueryContext,
  validateQueryFilters,
} from "@/lib/edge/query-contract";
import { analyticsFilterRegistry } from "@/lib/edge/query-contract/filter-registry";
import { createQueryTime } from "@/lib/edge/query-contract/helpers";
import type { Env } from "@/lib/edge/types";

export interface ReadSiteChannelsInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
}

function assertApiV1Filters(siteId: string, filters: FilterDocument): void {
  const context = siteQueryContext(siteId, "api-v1");
  const error = validateQueryFilters(context, filters);
  if (error) throw new Error(error.kind);
  try {
    assertFilterAudience(
      filters,
      analyticsFilterRegistry,
      context.policy.audience,
    );
  } catch {
    throw new Error("invalid-input");
  }
}

export async function readSiteChannels(
  input: ReadSiteChannelsInput,
): Promise<ChannelsResult> {
  assertApiV1Filters(input.siteId, input.filters);
  const result = await executeChannels(
    {
      async readChannels(query) {
        return {
          value: await queryChannelsFromD1(
            input.env,
            input.siteId,
            input.window,
            query.filters,
            query.limit,
          ),
          source: "raw" as const,
        };
      },
    },
    {
      context: siteQueryContext(input.siteId, "api-v1"),
      time: createQueryTime(
        input.window.startMs,
        input.window.endExclusiveMs,
        input.window.timeZone,
        input.window.nowMs,
      ),
      filters: input.filters,
      limit: input.limit,
    },
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}
