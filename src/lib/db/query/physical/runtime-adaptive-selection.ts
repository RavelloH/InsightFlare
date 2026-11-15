import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type { PhysicalQueryPlan } from "@/lib/db/query/physical/contracts";
import type {
  LogicalQueryNode,
  SemiJoinNode,
  SortNode,
  WindowNode,
} from "@/lib/db/query/plan";

import { deriveRuntimeBooleanMembership } from "./runtime-boolean-membership";
import { deriveRuntimeWindowCertificate } from "./runtime-window-certificate";

/** Current graph identities select an optional execution attempt. They certify
 * neither current data nor an unconditional window/materialization license. */
export interface PhysicalRuntimeAdaptiveCandidate {
  readonly kind: "unique-ranked-owner";
  readonly root: LogicalQueryNode;
  readonly owner: LogicalQueryNode;
  readonly terminalSort: SortNode;
  readonly windows: readonly WindowNode[];
  readonly positiveMembership: readonly SemiJoinNode[];
  readonly negativeMembership: readonly SemiJoinNode[];
}
export type AdaptivePhysicalQueryPlan<
  Row extends object = Record<string, unknown>,
> = PhysicalQueryPlan<Row> & {
  readonly runtimeAdaptiveCandidate?: PhysicalRuntimeAdaptiveCandidate;
};

/** Called after all ordinary physical choices exist. A repeated ranked owner
 * alone does not justify a probe: a separately proven positive Boolean IN cut
 * must also exist. No table/report names or diagnostic node ids participate. */
export function derivePhysicalRuntimeAdaptiveCandidate(
  plan: PhysicalQueryPlan<object>,
): PhysicalRuntimeAdaptiveCandidate | undefined {
  const proof = deriveRuntimeWindowCertificate(plan);
  if (!proof.eligible) return undefined;
  const membership = deriveRuntimeBooleanMembership(plan);
  if (!membership.some((m) => m.observation === "positive-boolean-membership"))
    return undefined;
  return {
    kind: "unique-ranked-owner",
    root: plan.root,
    owner: proof.certificate.owner.node,
    terminalSort: proof.certificate.terminalSort,
    windows: proof.certificate.windows.map((w) => w.window),
    positiveMembership: membership
      .filter((m) => m.observation === "positive-boolean-membership")
      .map((m) => m.choice.node),
    negativeMembership: membership
      .filter((m) => m.observation === "negative-boolean-membership")
      .map((m) => m.choice.node),
  };
}

function sameReferences(a: readonly object[], b: readonly object[]): boolean {
  return (
    Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])
  );
}
/** Ordinary hand-built physical fixtures may omit optional metadata and remain
 * ordinary. Present metadata must match fresh derivation completely. No cache,
 * serialized identity, or previously accepted runtime guard is trusted. */
export function assertCurrentRuntimeAdaptiveCandidate(
  plan: AdaptivePhysicalQueryPlan<object>,
): void {
  const actual = plan.runtimeAdaptiveCandidate;
  if (actual === undefined) return;
  const expected = derivePhysicalRuntimeAdaptiveCandidate(plan);
  if (
    !actual ||
    !expected ||
    actual.kind !== expected.kind ||
    actual.root !== expected.root ||
    actual.owner !== expected.owner ||
    actual.terminalSort !== expected.terminalSort ||
    !sameReferences(actual.windows, expected.windows) ||
    !sameReferences(actual.positiveMembership, expected.positiveMembership) ||
    !sameReferences(actual.negativeMembership, expected.negativeMembership)
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical runtime adaptive candidate is inconsistent with the current logical query",
    );
}
