import { isFilterTimeLeaf } from "@/lib/filter-contract/filter-history";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import type {
  FilterDocument,
  FilterExpression,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

export type AdvancedFilterExecutionStrategy =
  "sql-report-fusion" | "sql-membership" | "bounded-core";
export type AdvancedFilterLeafFamily =
  "field" | "count" | "time" | "seq" | "computed";
export interface AdvancedFilterLeafCapability {
  readonly family: AdvancedFilterLeafFamily;
  readonly permittedStrategies: readonly AdvancedFilterExecutionStrategy[];
  readonly constraints: readonly string[];
}

/** Upper bounds on leaf capability, never a substitute for a whole-tree proof. */
export const ADVANCED_FILTER_LEAF_CAPABILITIES: Readonly<
  Record<AdvancedFilterLeafFamily, AdvancedFilterLeafCapability>
> = {
  field: {
    family: "field",
    permittedStrategies: [
      "sql-report-fusion",
      "sql-membership",
      "bounded-core",
    ],
    constraints: [
      "registered-field-and-operator",
      "same-site-role-and-grain",
      "runtime-comparison-and-payload-compatibility",
    ],
  },
  count: {
    family: "count",
    permittedStrategies: [
      "sql-report-fusion",
      "sql-membership",
      "bounded-core",
    ],
    constraints: [
      "finite-page-event-collection",
      "whole-tree-relation-and-arithmetic-proof",
      "runtime-numeric-domain-and-resource-guards",
    ],
  },
  time: {
    family: "time",
    permittedStrategies: ["sql-membership", "bounded-core"],
    constraints: [
      "explicit-filter-window",
      "request-captured-time",
      "ordered-finite-endpoints",
      "independent-expression-domain",
    ],
  },
  seq: {
    family: "seq",
    permittedStrategies: ["sql-membership", "bounded-core"],
    constraints: [
      "whole-tree-two-step-exists-proof",
      "canonical-activity-storage-and-locale-tie-guards",
      "request-activity-and-per-site-sequence-bounds",
      "same-statement-control-and-membership-envelope",
    ],
  },
  computed: {
    family: "computed",
    permittedStrategies: [
      "sql-report-fusion",
      "sql-membership",
      "bounded-core",
    ],
    constraints: ["whole-tree-computed-target-proof-required"],
  },
};

export function advancedFilterLeafCapabilities(
  document: FilterDocument,
): readonly AdvancedFilterLeafCapability[] {
  // Invalid inputs remain the whole-tree classifier's responsibility. A
  // declaration audit must not introduce an earlier validation exception.
  let normalized: FilterDocument;
  try {
    normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
  } catch {
    return [];
  }
  const families = new Set<AdvancedFilterLeafFamily>();
  const target = (
    value: FilterTargetExpression,
    into: Set<AdvancedFilterLeafFamily>,
  ): void => {
    switch (value.kind) {
      case "field":
      case "event-payload":
        into.add("field");
        break;
      case "reducer":
        if (value.reducer === "count") into.add("count");
        target(value.input, into);
        break;
      case "sequence":
        into.add("seq");
        value.steps.forEach((step) => target(step, into));
        break;
      case "adjacent":
        into.add("seq");
        target(value.sequence, into);
        break;
      case "without":
        into.add("seq");
        target(value.sequence, into);
        target(value.excluded, into);
        break;
      case "context-root":
      case "context-intrinsic":
        if (value.context === "sequence") into.add("seq");
        if (value.kind === "context-intrinsic" && value.intrinsic === "same")
          target(value.input, into);
        break;
      case "member":
        target(value.object, into);
        break;
      case "occurrence-time":
      case "bucket":
        target(value.input, into);
        break;
      case "selector":
        target(value.collection, into);
        expression(value.predicate, into);
        break;
      case "projection":
      case "periods":
        target(value.collection, into);
        break;
      case "arithmetic":
        target(value.left, into);
        target(value.right, into);
        break;
      case "window":
        target(value.collection, into);
        target(value.anchor, into);
        break;
      case "entity-root":
      case "duration":
      case "time-anchor":
        break;
    }
  };
  const expression = (
    value: FilterExpression | null,
    into: Set<AdvancedFilterLeafFamily>,
  ): void => {
    if (!value) return;
    if (value.kind === "condition") {
      const local = new Set<AdvancedFilterLeafFamily>();
      if (isFilterTimeLeaf(value)) local.add("time");
      else target(value.target, local);
      if (local.size === 0) local.add("computed");
      for (const family of local) into.add(family);
    } else if (value.kind === "not") expression(value.child, into);
    else value.children.forEach((child) => expression(child, into));
  };
  expression(normalized.root, families);
  return [...families]
    .sort()
    .map((family) => ADVANCED_FILTER_LEAF_CAPABILITIES[family]);
}
