import "@tanstack/react-start/server-only";

import { type FilterDocument } from "@/lib/edge/analytics/contract";
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
  const result = await queryRetentionFromD1(
    input.env,
    input.siteId,
    input.window,
    input.filters,
    parseRetentionGranularity(input.granularity),
  );
  return {
    granularity: result.granularity,
    cohorts: result.cohorts.map((cohort) => ({
      start: new Date(cohort.bucket).toISOString(),
      size: cohort.size,
      periods: cohort.periods,
    })),
  };
}
