import type { FilterScope } from "@/lib/filter-contract/scope-preference";

export const ANALYTICS_ENTITY_KINDS = [
  "observation",
  "page",
  "event",
  "session",
  "visitor",
] as const;

export type AnalyticsEntityKind = (typeof ANALYTICS_ENTITY_KINDS)[number];
export type ObservationKind = Extract<AnalyticsEntityKind, "page" | "event">;
export type LogicalFilterScope = "observation" | "session" | "visitor";

export interface ResolvedAnalyticsScope {
  readonly requested: FilterScope | "auto";
  readonly contractScope: FilterScope | null;
  readonly logicalScope: LogicalFilterScope | null;
}

export function resolveAnalyticsScope(
  requested: FilterScope | "auto",
): ResolvedAnalyticsScope {
  if (requested === "auto") {
    return {
      requested,
      contractScope: null,
      logicalScope: null,
    };
  }
  return {
    requested,
    contractScope: requested,
    logicalScope: requested === "event" ? "observation" : requested,
  };
}

export function isAnalyticsEntityKind(
  value: unknown,
): value is AnalyticsEntityKind {
  return (
    typeof value === "string" &&
    ANALYTICS_ENTITY_KINDS.includes(value as AnalyticsEntityKind)
  );
}
