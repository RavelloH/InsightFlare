import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import type {
  FilterDocument,
  FilterExpression,
} from "@/lib/filter-contract/filters";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";
import {
  attachFilterScopePreference,
  attachSavedFilterScopePreference,
  filterScopePreferenceFromDocument,
  savedFilterScopePreferenceFromDocument,
} from "@/lib/filter-contract/scope-preference";
function removeFields(
  expression: FilterExpression | null,
  fields: ReadonlySet<string>,
): FilterExpression | null {
  if (!expression) return null;
  if (expression.kind === "condition") {
    return expression.target.kind === "field" &&
      fields.has(expression.target.field)
      ? null
      : expression;
  }
  if (expression.kind === "not") {
    const child = removeFields(expression.child, fields);
    return child ? { kind: "not", child } : null;
  }
  const children = expression.children
    .map((child) => removeFields(child, fields))
    .filter((child): child is FilterExpression => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: expression.kind, children };
}
export function withoutFilterKey(
  filters: FilterDocument,
  field: string,
): FilterDocument {
  const normalized = normalizeFilterDocument(
    { version: 1, root: removeFields(filters.root, new Set([field])) },
    analyticsFilterRegistry,
  );
  const callerPreference = filterScopePreferenceFromDocument(filters);
  const savedPreference = savedFilterScopePreferenceFromDocument(filters);
  const withCallerPreference = callerPreference
    ? attachFilterScopePreference(normalized, callerPreference)
    : normalized;
  return savedPreference
    ? attachSavedFilterScopePreference(withCallerPreference, savedPreference)
    : withCallerPreference;
}
export function withoutGeoFilter(filters: FilterDocument): FilterDocument {
  return withoutFilterKey(
    withoutFilterKey(withoutFilterKey(filters, "geo.country"), "geo.region"),
    "geo.city",
  );
}
