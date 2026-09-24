import {
  encodeFunnelConfig,
  type FunnelConfigV2,
  FunnelConfigValidationError,
  parseFunnelStepFilter,
  validateFunnelConfigForWrite,
} from "@/lib/edge/analytics/contract/funnel-config";
import { planObservationFilter } from "@/lib/edge/analytics/contract/observation-planner";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import { compileFilterDocument } from "./filter-compiler";
import {
  FUNNEL_SQL_BASE_DATASET_BINDINGS,
  FUNNEL_SQL_MAX_BINDINGS,
} from "./funnel-budget";

function predicateBindingCount(
  predicate: ReturnType<typeof planObservationFilter>["visit"],
  alias: string,
): number {
  if (predicate.kind !== "expression") return 0;
  const document: FilterDocument = { version: 1, root: predicate.expression };
  return compileFilterDocument(document, {
    alias,
    eventAlias: alias,
    sessionSource: "scope_raw_visits",
  }).bindings.length;
}

/**
 * Count D1 bindings owned by a persisted funnel. Dataset bindings are
 * request-scoped, so this counts projected filters, visitor window, and step
 * IDs; the fixed dataset cost is checked separately when validating a write.
 */
export function estimateFunnelSqlBindingCount(config: FunnelConfigV2): number {
  let count =
    config.steps.length + (config.progressionScope === "visitor" ? 1 : 0);
  for (const step of config.steps) {
    const plan = planObservationFilter(parseFunnelStepFilter(step).root);
    count += predicateBindingCount(plan.visit, "funnel_visit_filter");
    count += predicateBindingCount(plan.event, "funnel_event_filter");
  }
  return count;
}

/** Validate the provider-specific parameter budget for a new funnel write. */
export function validateD1FunnelConfigForWrite(
  config: FunnelConfigV2,
): FunnelConfigV2 {
  const validated = validateFunnelConfigForWrite(config);
  if (
    estimateFunnelSqlBindingCount(validated) +
      FUNNEL_SQL_BASE_DATASET_BINDINGS >
    FUNNEL_SQL_MAX_BINDINGS
  ) {
    throw new FunnelConfigValidationError("funnel_sql_binding_limit_exceeded");
  }
  return validated;
}

/** Encode only after both domain validation and the D1-specific budget pass. */
export function encodeD1FunnelConfig(config: FunnelConfigV2) {
  return encodeFunnelConfig(validateD1FunnelConfigForWrite(config));
}
