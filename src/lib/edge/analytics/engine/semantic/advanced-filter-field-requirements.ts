import {
  resolveAdvancedCountFiniteCollection,
  resolveAdvancedCountScalarField,
} from "@/lib/edge/analytics/engine/semantic/count-scalar-fields";
import {
  advancedCountSelectorField,
  advancedCountSelectorRequiresSafeRange,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import type {
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

export type AdvancedFilterNumericCompatibilityDomain =
  "page-only" | "page-and-event";

export type AdvancedFilterNumericCompatibilityProof =
  "safe-number" | "exact-aggregate";

export interface AdvancedFilterNumericCompatibilityRequirement {
  readonly fieldId: string;
  readonly domain: AdvancedFilterNumericCompatibilityDomain;
  /** Omitted for the backwards-compatible safe-number proof profile. */
  readonly proof?: AdvancedFilterNumericCompatibilityProof;
}

/**
 * Derive the raw-storage proof needed by the SQL count matcher from its
 * validated Filter tree. Bare Page metrics also occur on Event owner rows;
 * selector predicates remain scoped to their selected Page rows.
 */
export function deriveAdvancedFilterNumericCompatibilityRequirements(
  root: FilterExpression,
): readonly AdvancedFilterNumericCompatibilityRequirement[] {
  const requirements = new Map<
    string,
    {
      domain: AdvancedFilterNumericCompatibilityDomain;
      proof: AdvancedFilterNumericCompatibilityProof;
    }
  >();

  const add = (
    fieldId: string,
    domain: AdvancedFilterNumericCompatibilityDomain,
    proof: AdvancedFilterNumericCompatibilityProof = "safe-number",
  ) => {
    const current = requirements.get(fieldId);
    requirements.set(fieldId, {
      domain:
        current?.domain === "page-and-event" || domain === "page-and-event"
          ? "page-and-event"
          : "page-only",
      proof:
        current?.proof === "exact-aggregate" || proof === "exact-aggregate"
          ? "exact-aggregate"
          : "safe-number",
    });
  };

  const visitSelectorPredicate = (
    expression: FilterExpression,
    collection: "page" | "event",
  ): void => {
    if (expression.kind === "not") {
      visitSelectorPredicate(expression.child, collection);
      return;
    }
    if (expression.kind === "and" || expression.kind === "or") {
      expression.children.forEach((child) =>
        visitSelectorPredicate(child, collection),
      );
      return;
    }
    if (expression.kind !== "condition" || expression.target.kind !== "field")
      return;
    const field = advancedCountSelectorField(expression.target.field);
    if (
      field?.kind === "number" &&
      field.collection === collection &&
      advancedCountSelectorRequiresSafeRange(field, expression.operator)
    )
      add(field.fieldId, "page-only");
  };

  const visitTarget = (target: FilterTargetExpression): void => {
    if (target.kind === "arithmetic") {
      visitTarget(target.left);
      visitTarget(target.right);
      return;
    }
    if (target.kind !== "reducer") return;
    if (target.reducer === "count") {
      const collection = resolveAdvancedCountFiniteCollection(target.input);
      if (collection?.kind === "selector")
        visitSelectorPredicate(
          collection.selector.predicate,
          collection.selector.collection.kind === "entity-root" &&
            collection.selector.collection.entity === "event"
            ? "event"
            : "page",
        );
      return;
    }
    if (
      target.reducer !== "countDistinct" &&
      target.reducer !== "min" &&
      target.reducer !== "max" &&
      target.reducer !== "sum" &&
      target.reducer !== "avg"
    )
      return;
    const scalarField = resolveAdvancedCountScalarField(target.input);
    if (!scalarField) return;
    if (
      target.reducer === "countDistinct" ||
      target.reducer === "min" ||
      target.reducer === "max" ||
      target.reducer === "sum" ||
      target.reducer === "avg"
    )
      add(
        scalarField.field.fieldId,
        "page-only",
        target.reducer === "sum" || target.reducer === "avg"
          ? "exact-aggregate"
          : "safe-number",
      );
    if (scalarField.collection.kind === "selector")
      visitSelectorPredicate(scalarField.collection.selector.predicate, "page");
  };

  const visitExpression = (expression: FilterExpression): void => {
    if (expression.kind === "not") {
      visitExpression(expression.child);
      return;
    }
    if (expression.kind === "and" || expression.kind === "or") {
      expression.children.forEach(visitExpression);
      return;
    }
    if (expression.kind !== "condition") return;

    if (expression.target.kind === "field") {
      const field = advancedCountSelectorField(expression.target.field);
      if (
        field?.kind === "number" &&
        advancedCountSelectorRequiresSafeRange(field, expression.operator)
      )
        add(field.fieldId, "page-and-event");
    } else if (
      expression.operator === "exists" ||
      expression.operator === "notExists"
    ) {
      const collection = resolveAdvancedCountFiniteCollection(
        expression.target,
      );
      if (collection?.kind === "selector")
        visitSelectorPredicate(
          collection.selector.predicate,
          collection.selector.collection.kind === "entity-root" &&
            collection.selector.collection.entity === "event"
            ? "event"
            : "page",
        );
    } else visitTarget(expression.target);
  };

  visitExpression(root);
  return [...requirements]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldId, requirement]) => ({
      fieldId,
      domain: requirement.domain,
      ...(requirement.proof === "exact-aggregate"
        ? { proof: requirement.proof }
        : {}),
    }));
}
