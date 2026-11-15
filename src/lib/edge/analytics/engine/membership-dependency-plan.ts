import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { AdvancedFilterExecutionPlan } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

/** Reader shape only: this declaration grants no audience, role or site authority. */
export type MembershipReaderProfile =
  "referrers-summary-page-v1" | "comparison-page-dimension-v1";
export interface MembershipPreparationInput {
  readonly key: string;
  readonly execution: AdvancedFilterExecutionPlan;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
}
export interface MembershipChildDescriptor {
  readonly key: string;
  readonly preparationKey: string;
  readonly outputId?: string;
  readonly readerProfile: MembershipReaderProfile;
  readonly queryTime: QueryTime;
  readonly sourceRole: "page";
  readonly maxPlans: 1;
  readonly maxSources: 1;
}

export interface MembershipDependencyPlan<Consumer> {
  readonly kind: "ordered-membership-dependencies";
  readonly preparations: readonly {
    readonly kind: "prepare-membership";
    readonly key: string;
    readonly strategy: "sql-membership";
    readonly filterSemantics: "whole-original-tree";
    readonly fallback: "bounded-core";
    readonly dependencyRef: typeof EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY;
    readonly membership: AdvancedFilterExecutionPlan["decision"]["membership"];
    readonly filters: FilterDocument;
    readonly queryTime: QueryTime;
    readonly bounds: AdvancedFilterExecutionPlan["decision"]["coreBounds"];
  }[];
  readonly children: readonly MembershipChildDescriptor[];
  readonly consumer: Consumer;
}

export type MembershipPreparationStep =
  MembershipDependencyPlan<unknown>["preparations"][number];

/** Universal value validation only. Each reader owns its closed shape/caps. */
export function normalizeMembershipPreparations(
  inputs: readonly MembershipPreparationInput[],
): readonly MembershipPreparationStep[] | undefined {
  const keys = new Set<string>();
  for (const input of inputs) {
    if (
      typeof input.key !== "string" ||
      !input.key ||
      keys.has(input.key) ||
      input.execution.decision.strategy !== "sql-membership" ||
      input.execution.support.kind !== "supported" ||
      input.execution.decision.membership.identity.grain === "activity"
    )
      return undefined;
    keys.add(input.key);
  }
  return inputs.map((input) => ({
    kind: "prepare-membership",
    key: input.key,
    strategy: "sql-membership",
    filterSemantics: "whole-original-tree",
    fallback: "bounded-core",
    dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
    membership: input.execution.decision.membership,
    filters: input.filters,
    queryTime: input.queryTime,
    bounds: input.execution.decision.coreBounds,
  }));
}

/** References/identities only: this does not authorize a reader or fanout. */
export function validMembershipChildReferences(
  preparations: readonly Pick<MembershipPreparationStep, "key">[],
  children: readonly {
    readonly key: string;
    readonly preparationKey: string;
    readonly outputId?: string;
  }[],
): boolean {
  const preparationKeys = new Set(preparations.map((p) => p.key));
  const childKeys = new Set<string>();
  const outputIds = new Set<string>();
  for (const child of children) {
    if (
      typeof child.key !== "string" ||
      !child.key ||
      childKeys.has(child.key) ||
      !preparationKeys.has(child.preparationKey) ||
      (child.outputId !== undefined &&
        (typeof child.outputId !== "string" ||
          !child.outputId ||
          outputIds.has(child.outputId)))
    )
      return false;
    childKeys.add(child.key);
    if (child.outputId !== undefined) outputIds.add(child.outputId);
  }
  return true;
}

/** Shared value snapshot; neither this value nor a reader profile is a capability. */
export function freezeMembershipRecipeValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value))
      freezeMembershipRecipeValue(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Preserve ordered preparations and independent child inputs. This first bounded
 * contract permits one child per preparation, never an arbitrary fan-out count.
 * The evaluator must still freshly prove eligibility/bounds and bind its own
 * request-private relation; the recipe cannot authorize execution.
 */
export function planMembershipDependencies<Consumer>(input: {
  readonly preparations: readonly MembershipPreparationInput[];
  readonly children: readonly MembershipChildDescriptor[];
  readonly consumer: Consumer;
}): MembershipDependencyPlan<Consumer> | undefined {
  if (
    input.preparations.length < 1 ||
    input.preparations.length > 2 ||
    input.children.length !== input.preparations.length
  )
    return undefined;
  const preparations = normalizeMembershipPreparations(input.preparations);
  if (
    !preparations ||
    !validMembershipChildReferences(preparations, input.children)
  )
    return undefined;
  const preparationKeys = new Set(preparations.map((p) => p.key));
  const childKeys = new Set<string>();
  const consumedPreparations = new Set<string>();
  const outputIds = new Set<string>();
  for (const child of input.children) {
    if (
      typeof child.key !== "string" ||
      !child.key ||
      childKeys.has(child.key) ||
      !preparationKeys.has(child.preparationKey) ||
      consumedPreparations.has(child.preparationKey) ||
      child.sourceRole !== "page" ||
      child.maxPlans !== 1 ||
      child.maxSources !== 1 ||
      (child.readerProfile !== "referrers-summary-page-v1" &&
        child.readerProfile !== "comparison-page-dimension-v1") ||
      (child.outputId !== undefined &&
        (typeof child.outputId !== "string" ||
          !child.outputId ||
          outputIds.has(child.outputId)))
    )
      return undefined;
    childKeys.add(child.key);
    consumedPreparations.add(child.preparationKey);
    if (child.outputId !== undefined) outputIds.add(child.outputId);
  }
  const value = {
    kind: "ordered-membership-dependencies" as const,
    preparations,
    children: input.children,
    consumer: input.consumer,
  };
  // Match the existing wrappers' JSON value contract (including optional fields),
  // with one shared copy rather than retaining request-owned mutable objects.
  return freezeMembershipRecipeValue(
    JSON.parse(JSON.stringify(value)) as typeof value,
  );
}
