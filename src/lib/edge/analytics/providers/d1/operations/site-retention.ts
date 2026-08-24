import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  assertFilterAudience,
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
  type FilterDocument,
  siteQueryContext,
  validateTypedQueryFilters,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  parseRetentionGranularity,
  queryRetentionFromD1,
  type RetentionResult,
} from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import type { Env } from "@/lib/edge/types";

export interface SiteRetentionResult {
  readonly granularity: RetentionResult["granularity"];
  readonly cohorts: readonly {
    readonly start: string;
    readonly size: number;
    readonly periods: readonly {
      readonly index: number;
      readonly visitors: number;
      readonly rate: number;
    }[];
  }[];
}

export interface ReadSiteRetentionInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly granularity: string;
}

export async function readSiteRetention(
  input: ReadSiteRetentionInput,
): Promise<SiteRetentionResult> {
  const context = siteQueryContext(input.siteId, "api-v1");
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
  const result = await executeTypedApplicationOperation<RetentionResult>(
    "retention",
    {
      context,
      time: createQueryTime(
        input.window.startMs,
        input.window.endExclusiveMs,
        input.window.timeZone,
        input.window.nowMs,
      ),
      filters: input.filters,
    },
    createTypedQueryProviderRegistry("retention", async () => ({
      value: await queryRetentionFromD1(
        input.env,
        input.siteId,
        input.window,
        input.filters,
        parseRetentionGranularity(input.granularity),
      ),
    })),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return {
    granularity: result.data.granularity,
    cohorts: result.data.cohorts.map((cohort) => ({
      start: new Date(cohort.bucket).toISOString(),
      size: cohort.size,
      periods: cohort.periods,
    })),
  };
}
