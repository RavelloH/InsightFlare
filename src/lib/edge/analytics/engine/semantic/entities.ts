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

/** Validates an upstream-resolved scope without discarding its concrete result. */
export function validateResolvedAnalyticsScope(
  scope: ResolvedAnalyticsScope,
): ResolvedAnalyticsScope {
  if (!scope || typeof scope !== "object") {
    throw new Error("invalid_resolved_analytics_scope");
  }

  if (scope.requested === "auto") {
    const validAutoResolution =
      (scope.contractScope === null && scope.logicalScope === null) ||
      (scope.contractScope === "event" &&
        scope.logicalScope === "observation") ||
      (scope.contractScope === "session" && scope.logicalScope === "session") ||
      (scope.contractScope === "visitor" && scope.logicalScope === "visitor");
    if (!validAutoResolution) {
      throw new Error("invalid_resolved_analytics_scope");
    }
    return Object.freeze({ ...scope });
  }

  if (!["event", "session", "visitor"].includes(scope.requested)) {
    throw new Error("invalid_resolved_analytics_scope");
  }
  const canonical = resolveAnalyticsScope(scope.requested);
  if (
    scope.contractScope !== canonical.contractScope ||
    scope.logicalScope !== canonical.logicalScope
  ) {
    throw new Error("invalid_resolved_analytics_scope");
  }
  return Object.freeze({ ...scope });
}

export function isAnalyticsEntityKind(
  value: unknown,
): value is AnalyticsEntityKind {
  return (
    typeof value === "string" &&
    ANALYTICS_ENTITY_KINDS.includes(value as AnalyticsEntityKind)
  );
}
