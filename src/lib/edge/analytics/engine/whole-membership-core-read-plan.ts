import { activityEvaluationReadRanges } from "@/lib/edge/analytics/engine/semantic/activity-read-ranges";
import type { WholeMembershipState } from "@/lib/edge/analytics/engine/whole-membership-stage-transition";
import type {
  FilterDocument,
  FilterTargetExpression,
} from "@/lib/filter-contract/filters";

export function wholeMembershipPayloadPaths(
  expression: FilterDocument["root"],
): {
  readonly paths: readonly string[];
  readonly wholePayload: boolean;
} {
  const paths = new Set<string>();
  let wholePayload = false;
  const target = (value: FilterTargetExpression): void => {
    if (value.kind === "event-payload") paths.add(value.path);
    else if (value.kind === "member") {
      target(value.object);
      if (value.member === "payload") wholePayload = true;
    } else if (value.kind === "context-intrinsic") {
      if (value.intrinsic === "same") target(value.input);
    } else if (value.kind === "occurrence-time") {
      target(value.input);
    } else if (value.kind === "selector") {
      target(value.collection);
      visit(value.predicate);
    } else if (value.kind === "projection") {
      target(value.collection);
      if (value.member === "payload") {
        if (value.path) paths.add(value.path);
        else wholePayload = true;
      }
    } else if (value.kind === "reducer") target(value.input);
    else if (value.kind === "arithmetic") {
      target(value.left);
      target(value.right);
    } else if (value.kind === "bucket") target(value.input);
    else if (value.kind === "window") {
      target(value.collection);
      target(value.anchor);
    } else if (value.kind === "periods") target(value.collection);
    else if (value.kind === "sequence") value.steps.forEach(target);
    else if (value.kind === "adjacent") target(value.sequence);
    else if (value.kind === "without") {
      target(value.sequence);
      target(value.excluded);
    }
  };
  const visit = (node: FilterDocument["root"]): void => {
    if (!node) return;
    if (node.kind === "condition") {
      target(node.target);
      if (
        node.value &&
        typeof node.value === "object" &&
        !Array.isArray(node.value) &&
        "kind" in node.value
      )
        target(node.value as FilterTargetExpression);
    } else if (node.kind === "not") visit(node.child);
    else node.children.forEach(visit);
  };
  visit(expression);
  return { paths: [...paths].sort(), wholePayload };
}

/** Two sibling read chains retain the original Promise.all launch structure.
 * Within each chain, preserve the old fixed 90-site chunk then range order.
 * No dataset can be accepted until both complete and their global caps pass. */
export function planWholeMembershipCoreReads(
  state: Extract<WholeMembershipState, { kind: "core-inputs" }>,
  lateInput: {
    readonly root: FilterDocument["root"];
    readonly candidateRange: typeof state.node.queryTime.range;
    readonly readRange: typeof state.readRange;
  },
) {
  const paths = wholeMembershipPayloadPaths(lateInput.root);
  const ranges = activityEvaluationReadRanges(
    lateInput.candidateRange,
    lateInput.readRange,
  );
  // This is the old statement-partition size, not a new admission/activity cap.
  const sites = state.stage.context.subject.siteIds;
  const chunks = [];
  for (let offset = 0; offset < sites.length; offset += 90)
    chunks.push(sites.slice(offset, offset + 90));
  return {
    kind: "parallel-core-input-chains" as const,
    // Leaf plans are still constructed at the original per-read checkpoint.
    activities: chunks.flatMap((siteIds) =>
      ranges.map((range) => ({
        kind: "activity-read" as const,
        siteIds,
        range,
      })),
    ),
    payloads:
      paths.paths.length || paths.wholePayload
        ? chunks.flatMap((siteIds) =>
            ranges.map((range) => ({
              kind: "payload-nodes" as const,
              siteIds,
              range,
              paths: paths.paths,
              wholePayload: paths.wholePayload,
            })),
          )
        : [],
    coreBounds: state.job.bounds,
  };
}
