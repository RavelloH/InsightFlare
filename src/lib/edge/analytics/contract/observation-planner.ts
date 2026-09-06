import {
  analyticsFilterDefinition,
  type FilterObservationKind,
} from "./filter-registry";
import type { FilterExpression } from "./filters";

export type ObservationPredicatePlan =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "expression"; readonly expression: FilterExpression };

export interface ObservationFilterPlan {
  readonly visit: ObservationPredicatePlan;
  readonly event: ObservationPredicatePlan;
}

const ALL: ObservationPredicatePlan = Object.freeze({ kind: "all" });
const NONE: ObservationPredicatePlan = Object.freeze({ kind: "none" });

function conditionApplies(
  expression: FilterExpression,
  observationKind: FilterObservationKind,
): boolean {
  if (expression.kind !== "condition") return false;
  const fieldId =
    expression.target.kind === "field"
      ? expression.target.field
      : "event.payload";
  return Boolean(
    analyticsFilterDefinition(fieldId)?.observationKinds.has(observationKind),
  );
}

function project(
  expression: FilterExpression | null,
  observationKind: FilterObservationKind,
): ObservationPredicatePlan {
  if (!expression) return ALL;

  if (expression.kind === "condition") {
    return conditionApplies(expression, observationKind)
      ? { kind: "expression", expression }
      : NONE;
  }

  if (expression.kind === "not") {
    const child = project(expression.child, observationKind);
    if (child.kind === "none") return NONE;
    if (child.kind === "all") return NONE;
    return {
      kind: "expression",
      expression: { kind: "not", child: child.expression },
    };
  }

  const children = expression.children.map((child) =>
    project(child, observationKind),
  );
  if (expression.kind === "and") {
    if (children.some((child) => child.kind === "none")) return NONE;
    const applicable = children.flatMap((child) =>
      child.kind === "expression" ? [child.expression] : [],
    );
    if (applicable.length === 0) return ALL;
    if (applicable.length === 1) {
      return { kind: "expression", expression: applicable[0]! };
    }
    return {
      kind: "expression",
      expression: { kind: "and", children: applicable },
    };
  }

  if (children.some((child) => child.kind === "all")) return ALL;
  const applicable = children.flatMap((child) =>
    child.kind === "expression" ? [child.expression] : [],
  );
  if (applicable.length === 0) return NONE;
  if (applicable.length === 1) {
    return { kind: "expression", expression: applicable[0]! };
  }
  return {
    kind: "expression",
    expression: { kind: "or", children: applicable },
  };
}

/**
 * Projects one FilterExpression into the two observation domains. This is a
 * semantic operation; SQL compilers must consume its result instead of
 * deciding Boolean applicability from storage sources.
 */
export function planObservationFilter(
  expression: FilterExpression | null,
): ObservationFilterPlan {
  return {
    visit: project(expression, "visit"),
    event: project(expression, "event"),
  };
}
