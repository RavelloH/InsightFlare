import {
  type AdvancedCountNumberSelectorField,
  type AdvancedCountSelectorField,
  advancedCountSelectorField,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import type { FilterTargetExpression } from "@/lib/filter-contract/filters";

export type AdvancedCountFiniteCollection =
  | { readonly kind: "page" }
  | { readonly kind: "event" }
  | {
      readonly kind: "selector";
      readonly selector: Extract<
        FilterTargetExpression,
        { readonly kind: "selector" }
      >;
    };

export type AdvancedCountScalarCollection =
  | Extract<AdvancedCountFiniteCollection, { readonly kind: "page" }>
  | Extract<AdvancedCountFiniteCollection, { readonly kind: "selector" }>;

export interface AdvancedCountCollectionMemberField {
  readonly field: AdvancedCountSelectorField;
  readonly collection: AdvancedCountFiniteCollection;
}

export interface AdvancedCountScalarField {
  readonly field: AdvancedCountNumberSelectorField;
  readonly collection: AdvancedCountScalarCollection;
}

function resolveBaseCollection(
  base: FilterTargetExpression,
): AdvancedCountFiniteCollection | undefined {
  if (base.kind === "entity-root" && base.entity === "page")
    return { kind: "page" };
  if (base.kind === "entity-root" && base.entity === "event")
    return { kind: "event" };
  if (
    base.kind === "selector" &&
    base.collection.kind === "entity-root" &&
    (base.collection.entity === "page" || base.collection.entity === "event")
  )
    return { kind: "selector", selector: base };
  return undefined;
}

/** Resolve the finite Page/Event members whose collection cardinality is safe. */
export function resolveAdvancedCountCollectionMemberField(
  target: FilterTargetExpression,
): AdvancedCountCollectionMemberField | undefined {
  const members: string[] = [];
  let base = target;
  while (base.kind === "member") {
    members.unshift(base.member);
    base = base.object;
  }

  const fieldId =
    members.length === 1 && members[0] === "durationMs"
      ? "page.durationMs"
      : members.length === 2 && members[0] === "performance"
        ? `performance.${members[1]}`
        : members.length === 1 &&
            ["path", "title", "query", "hash"].includes(members[0]!)
          ? `page.${members[0]}`
          : members.length === 1 && members[0] === "name"
            ? "event.name"
            : undefined;
  if (!fieldId) return undefined;
  const field = advancedCountSelectorField(fieldId);
  const collection = resolveBaseCollection(base);
  if (!field || !collection) return undefined;
  const collectionEntity =
    collection.kind === "event"
      ? "event"
      : collection.kind === "page"
        ? "page"
        : collection.selector.collection.kind === "entity-root"
          ? collection.selector.collection.entity
          : undefined;
  if (field.collection !== collectionEntity) return undefined;
  return { field, collection };
}

/** Resolve only finite entity roots, selectors, or registered members. */
export function resolveAdvancedCountFiniteCollection(
  target: FilterTargetExpression,
): AdvancedCountFiniteCollection | undefined {
  if (target.kind !== "member") return resolveBaseCollection(target);
  return resolveAdvancedCountCollectionMemberField(target)?.collection;
}

/** Numeric reducers and numeric proofs intentionally stay number-only. */
export function resolveAdvancedCountScalarField(
  target: FilterTargetExpression,
): AdvancedCountScalarField | undefined {
  const resolved = resolveAdvancedCountCollectionMemberField(target);
  if (!resolved || resolved.field.kind !== "number") return undefined;
  if (resolved.collection.kind === "event") return undefined;
  return {
    field: resolved.field,
    collection: resolved.collection as AdvancedCountScalarCollection,
  };
}

export function advancedCountScalarFieldKey(
  target: FilterTargetExpression,
  resolved: AdvancedCountScalarField,
): string {
  return JSON.stringify({
    target,
    fieldId: resolved.field.fieldId,
    collection:
      resolved.collection.kind === "page"
        ? { kind: "page" }
        : resolved.collection.selector,
  });
}
