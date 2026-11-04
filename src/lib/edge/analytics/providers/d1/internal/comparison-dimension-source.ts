import type { FilterDocument } from "@/lib/edge/analytics/contract";
import {
  queryWindowToTime,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import { appendComparisonDimensionRollup } from "@/lib/edge/analytics/engine/comparison-report-plan";
import type { PageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  pageDimensionReportSource,
  validatePageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";

import type { QueryWindow } from "./core-types";

export const COMPARISON_DIMENSION_ROLLUP_OUTPUT = "comparison-dimension-rollup";

/** Builds the unchanged reader-window-v1 source used by native page comparisons. */
export function buildComparisonDimensionRollupPlan(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly selection: PageDimensionSelection;
}): ValidatedLogicalPlan {
  const metadata = scopedFilterMetadata(input.filters);
  const selection = validatePageDimensionSelection(input.selection);
  const { builder, pages } = pageDimensionReportSource({
    siteId: input.siteId,
    queryTime: queryWindowToTime(input.window),
    filters: input.filters,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    selections: [selection],
  });
  const rows = appendComparisonDimensionRollup(builder, pages, selection);
  builder.output(COMPARISON_DIMENSION_ROLLUP_OUTPUT, rows, [
    { name: "value", slot: "value" },
    { name: "views", slot: "views" },
    { name: "sessions", slot: "sessions" },
    { name: "visitors", slot: "visitors" },
  ]);
  return builder.finish();
}
