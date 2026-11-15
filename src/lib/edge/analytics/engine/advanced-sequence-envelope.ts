import { FILTER_EVALUATOR_LIMITS } from "@/lib/filter-contract/filter-evaluator";

import { assertSequenceProof } from "./advanced-filter-sequence-support";
import type { SequencePlanInput } from "./advanced-sequence-filter-plan";
export interface SequenceLimits {
  readonly maxActivities: number;
  readonly maxMatches: number;
  readonly maxWork: number;
}
/** Existing request activity and per-site Seq limits; a smaller test limit may
 * exercise boundaries, but no caller may enlarge the original Core caps. */
export const SEQUENCE_LIMITS: SequenceLimits = Object.freeze({
  maxActivities: FILTER_EVALUATOR_LIMITS.maxActivities,
  maxMatches: FILTER_EVALUATOR_LIMITS.maxSequenceMatches,
  maxWork: FILTER_EVALUATOR_LIMITS.maxSequenceWork,
});
export type SequenceAcceptance =
  | {
      readonly kind: "evaluated";
      readonly matches: readonly {
        readonly siteId: string;
        readonly entityId: string;
      }[];
    }
  | { readonly kind: "fallback"; readonly reason: string };
/** Accept only controls and membership from the same bounded SQL statement.
 * Canonical flags are adapter-produced actual-storage facts. A failed proof
 * routes the whole original request to Core, preserving its public errors. */
export function acceptSequenceAggregate(
  input: SequencePlanInput,
  rows: readonly Record<string, unknown>[],
  limits: SequenceLimits = SEQUENCE_LIMITS,
): SequenceAcceptance {
  assertSequenceProof(input.support);
  const fallback = (reason: string) => ({ kind: "fallback", reason }) as const;
  const natural = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (
    Object.keys(SEQUENCE_LIMITS).some(
      (key) =>
        !natural(limits[key as keyof SequenceLimits]) ||
        limits[key as keyof SequenceLimits] >
          SEQUENCE_LIMITS[key as keyof SequenceLimits],
    )
  )
    return fallback("sequence_invalid_bounds");
  if (rows.some((row) => !natural(row.rawCount)))
    return fallback("sequence_envelope_invalid");
  const total = rows.reduce((n, row) => n + (row.rawCount as number), 0);
  if (total > limits.maxActivities) return fallback("sequence_activity_cap");
  const sites = new Set<string>(input.subject.siteIds),
    seen = new Set<string>();
  if (rows.some((row) => row.canonical !== 1))
    return fallback("sequence_storage_compatibility");
  const budgets = new Map<string, { work: number; matches: number }>(),
    matches: { siteId: string; entityId: string }[] = [];
  let tie = false;
  for (const row of rows) {
    if (
      typeof row.siteId !== "string" ||
      !sites.has(row.siteId) ||
      typeof row.entityId !== "string"
    )
      return fallback("sequence_storage_compatibility");
    const key = JSON.stringify([row.siteId, row.entityId]);
    if (seen.has(key)) return fallback("sequence_envelope_invalid");
    seen.add(key);
    const counts = [
      "firstCount",
      "secondCount",
      "firstTimes",
      "secondTimes",
      "participatingTimes",
    ];
    if (
      counts.some(
        (name) =>
          !natural(row[name]) ||
          (row[name] as number) > (row.rawCount as number),
      ) ||
      (row.matches !== 0 && row.matches !== 1)
    )
      return fallback("sequence_envelope_invalid");
    const first = row.firstCount as number,
      second = row.secondCount as number;
    if (
      input.support.steps[0].kind === input.support.steps[1].kind
        ? first + second > (row.participatingTimes as number)
        : first > (row.firstTimes as number) ||
          second > (row.secondTimes as number)
    )
      tie = true;
    if (first && second) {
      const pairs = first * second,
        budget = budgets.get(row.siteId) ?? { work: 0, matches: 0 };
      budget.work += first + pairs;
      budget.matches += pairs;
      budgets.set(row.siteId, budget);
    }
    if (row.matches === 1) {
      if (!row.entityId || !first || !second)
        return fallback("sequence_membership_invalid");
      matches.push({ siteId: row.siteId, entityId: row.entityId });
    }
  }
  if (
    [...budgets.values()].some(
      (value) =>
        value.work > limits.maxWork || value.matches > limits.maxMatches,
    )
  )
    return fallback("sequence_budget_unproven");
  if (tie) return fallback("sequence_locale_tie");
  return { kind: "evaluated", matches };
}
