import type { FilterScope } from "@/lib/edge/analytics/contract";

export interface QueryCostInput {
  readonly rangeMs: number;
  readonly sideCount?: number;
  readonly siteCount?: number;
  readonly metricCount?: number;
  readonly bucketCount?: number;
  readonly dimensionCardinality?: number;
  readonly filterComplexity?: number;
  readonly breakdownLimit?: number;
  readonly projectionFields?: number;
  readonly pageLimit?: number;
  readonly provider?: "d1" | "rollup" | "realtime" | "mixed";
  readonly batchFanout?: number;
  /** Resolved by the canonical scope planner before execution. */
  readonly scope?: FilterScope;
  readonly requiredSourceCount?: number;
  readonly entityAlgebraComplexity?: number;
  readonly eventPayloadComplexity?: number;
  readonly requiresRawSource?: boolean;
}

export interface QueryCostPolicy {
  readonly rangeUnitMs: number;
  readonly maxCost: number;
  readonly providerWeights: Readonly<
    Record<NonNullable<QueryCostInput["provider"]>, number>
  >;
}

export const defaultQueryCostPolicy: QueryCostPolicy = {
  rangeUnitMs: 24 * 60 * 60 * 1000,
  maxCost: 10_000,
  providerWeights: { d1: 1, rollup: 0.6, realtime: 2, mixed: 1.5 },
};

/**
 * Deterministic weighted budget shared by direct batch and query policy. All
 * inputs are normalized numbers; invalid/negative values fail closed to the
 * policy ceiling instead of becoming a cheap request.
 */
export function calculateQueryCost(
  input: QueryCostInput,
  policy: QueryCostPolicy = defaultQueryCostPolicy,
): number {
  const values = [
    input.rangeMs,
    input.sideCount ?? 1,
    input.siteCount ?? 1,
    input.metricCount ?? 1,
    input.bucketCount ?? 1,
    input.dimensionCardinality ?? 1,
    input.filterComplexity ?? 1,
    input.breakdownLimit ?? 1,
    input.projectionFields ?? 1,
    input.pageLimit ?? 1,
    input.batchFanout ?? 1,
    input.requiredSourceCount ?? 1,
    input.entityAlgebraComplexity ?? 1,
    input.eventPayloadComplexity ?? 1,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return policy.maxCost;
  }
  const rangeFactor = Math.max(1, input.rangeMs / policy.rangeUnitMs);
  const providerFactor = input.provider
    ? policy.providerWeights[input.provider]
    : 1;
  const scopeFactor =
    input.scope === "visitor" ? 1.5 : input.scope === "session" ? 1.25 : 1;
  const rawSourceFactor = input.requiresRawSource ? 1.15 : 1;
  const cost =
    rangeFactor *
    Math.max(1, input.sideCount ?? 1) *
    Math.max(1, input.siteCount ?? 1) *
    Math.max(1, input.metricCount ?? 1) *
    Math.max(1, input.bucketCount ?? 1) ** 0.5 *
    Math.max(1, input.dimensionCardinality ?? 1) ** 0.5 *
    Math.max(1, input.filterComplexity ?? 1) ** 0.25 *
    Math.max(1, input.projectionFields ?? 1) ** 0.25 *
    Math.max(1, input.breakdownLimit ?? input.pageLimit ?? 1) ** 0.25 *
    Math.max(1, input.requiredSourceCount ?? 1) ** 0.15 *
    Math.max(1, input.entityAlgebraComplexity ?? 1) ** 0.2 *
    Math.max(1, input.eventPayloadComplexity ?? 1) ** 0.2 *
    scopeFactor *
    rawSourceFactor *
    providerFactor *
    Math.max(1, input.batchFanout ?? 1);
  return Math.min(policy.maxCost, Math.max(1, Math.ceil(cost)));
}

/** Shared fail-closed gate for adapters that execute a provider directly. */
export function exceedsQueryCost(
  input: QueryCostInput,
  policy: QueryCostPolicy = defaultQueryCostPolicy,
): boolean {
  return calculateQueryCost(input, policy) >= policy.maxCost;
}
