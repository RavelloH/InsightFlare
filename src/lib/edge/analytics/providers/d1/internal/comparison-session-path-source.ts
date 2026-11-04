import {
  queryWindowToTime,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { buildSessionPathComparisonRollupPlan } from "@/lib/edge/analytics/engine/session-path-report-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import type { QueryWindow } from "./core-types";

export function buildComparisonSessionPathPlan(input: {
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly kind: "entry" | "exit";
}): ValidatedLogicalPlan {
  const metadata = scopedFilterMetadata(input.filters);
  return buildSessionPathComparisonRollupPlan({
    siteId: input.siteId,
    queryTime: queryWindowToTime(input.window),
    filters: input.filters,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "reader-window-v1" as const,
        }
      : {}),
    kind: input.kind,
  });
}
