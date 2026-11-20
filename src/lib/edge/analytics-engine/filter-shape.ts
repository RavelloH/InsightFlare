import type { QueryInput } from "@/lib/edge/analytics/contract";
import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

export const FILTER_FAMILIES = [
  "none",
  "basic",
  "boolean",
  "related-entity",
  "advanced-json",
  "mixed",
  "unknown",
] as const;
export type FilterFamily = (typeof FILTER_FAMILIES)[number];
type Bucket = "0" | "1" | "2" | "3-4" | "5-8" | "9+";
const FIELD_GROUPS = [
  "geo",
  "page",
  "session",
  "visitor",
  "source",
  "client",
  "event",
  "traffic",
  "other",
  "custom",
] as const;
type FieldGroup = (typeof FIELD_GROUPS)[number];
const SOURCE_GROUPS = [
  "visit",
  "event",
  "session",
  "visitor",
  "payload",
] as const;

export type SafeFilterShape = Readonly<{
  family: FilterFamily;
  code: string;
  conditionsBucket: Bucket;
  maxDepthBucket: Bucket;
  operatorGroups: readonly (
    "equality" | "range" | "set" | "stringMatch" | "presence"
  )[];
  fieldGroups: readonly FieldGroup[];
  setSizeBucket: Bucket;
  scope: "observation" | "session" | "visitor" | "unknown";
  requiredSources: readonly string[];
  execution: "raw.filtered" | "unknown";
}>;

function bucket(value: number): Bucket {
  return value <= 0
    ? "0"
    : value === 1
      ? "1"
      : value === 2
        ? "2"
        : value <= 4
          ? "3-4"
          : value <= 8
            ? "5-8"
            : "9+";
}
const OPERATORS = [
  "equality",
  "range",
  "set",
  "stringMatch",
  "presence",
] as const;

function operatorGroup(
  op: FilterCondition["operator"],
): (typeof OPERATORS)[number] {
  if (op === "eq" || op === "neq") return "equality";
  if (op === "in" || op === "notIn") return "set";
  if (
    op === "gt" ||
    op === "gte" ||
    op === "lt" ||
    op === "lte" ||
    op === "between"
  )
    return "range";
  if (op === "contains" || op === "startsWith" || op === "endsWith")
    return "stringMatch";
  return "presence";
}

/** No user-supplied field ID, payload path, event name or value ever escapes. */
function fieldGroup(target: FilterTargetExpression): FieldGroup {
  switch (target.kind) {
    case "field": {
      const group: string = target.field.split(".", 1)[0] ?? "";
      return FIELD_GROUPS.includes(group as FieldGroup) && group !== "custom"
        ? (group as FieldGroup)
        : "other";
    }
    case "event-payload":
    case "current-payload":
      return "custom";
    case "entity-root":
      return target.entity === "event"
        ? "event"
        : target.entity === "page"
          ? "page"
          : target.entity === "session"
            ? "session"
            : "visitor";
    case "member":
      return fieldGroup(target.object);
    default:
      return "other";
  }
}

/**
 * Only called with the normalized and validated Filter-SQL plan.
 * Traversal is bounded independently of user-provided filter limits.
 */
export function safeFilterShape(
  document: FilterDocument,
  plan?: QueryInput["scopePlan"],
): SafeFilterShape {
  let count = 0,
    maxDepth = 0,
    maxSet = 0;
  let boolean = false,
    related = false,
    custom = false,
    basic = false;
  const ops = new Set<(typeof OPERATORS)[number]>();
  const fields = new Set<FieldGroup>();
  const visit = (node: FilterExpression, depth: number): void => {
    if (depth > 20 || count > 128) return;
    maxDepth = Math.max(maxDepth, depth);
    if (node.kind === "condition") {
      count++;
      const group = fieldGroup(node.target);
      fields.add(group);
      if (group === "custom") custom = true;
      else basic = true;
      if (node.target.kind !== "field") related = true;
      ops.add(operatorGroup(node.operator));
      if (node.operator === "in" || node.operator === "notIn")
        maxSet = Math.max(
          maxSet,
          Array.isArray(node.value) ? node.value.length : 0,
        );
    } else if (node.kind === "not") {
      boolean = true;
      visit(node.child, depth + 1);
    } else {
      boolean = true;
      for (const child of node.children.slice(0, 128)) visit(child, depth + 1);
    }
  };
  if (document.root) visit(document.root, 1);
  const family: FilterFamily = !document.root
    ? "none"
    : custom && (basic || related)
      ? "mixed"
      : custom
        ? "advanced-json"
        : related
          ? "related-entity"
          : boolean
            ? "boolean"
            : "basic";
  const conditionsBucket = bucket(count);
  const maxDepthBucket = bucket(maxDepth);
  const rawSources = plan ? [...plan.requiredSources] : [];
  return Object.freeze({
    family,
    code: `${family}.${conditionsBucket}.${maxDepthBucket}`,
    conditionsBucket,
    maxDepthBucket,
    operatorGroups: Object.freeze(OPERATORS.filter((item) => ops.has(item))),
    fieldGroups: Object.freeze(FIELD_GROUPS.filter((item) => fields.has(item))),
    setSizeBucket: bucket(maxSet),
    scope:
      plan?.scope === "event"
        ? "observation"
        : plan?.scope === "session"
          ? "session"
          : plan?.scope === "visitor"
            ? "visitor"
            : "unknown",
    requiredSources: Object.freeze(
      SOURCE_GROUPS.filter((source) => rawSources.includes(source)),
    ),
    execution:
      document.root && plan?.requiresRawSource ? "raw.filtered" : "unknown",
  });
}
