import type { QueryTime } from "@/lib/edge/analytics/contract";
import { COMPARISON_MEMBERSHIP_CHILD_OUTPUTS } from "@/lib/edge/analytics/engine/comparison-membership-dependency-plan";
import {
  comparisonPageReaderContract,
  type ComparisonPageReaderTab,
} from "@/lib/edge/analytics/engine/comparison-page-reader-contract";
import type { OverviewTrendQualificationConfiguration } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type {
  ExactMembershipSourceUse,
  ExactOutputDescriptor,
} from "@/lib/edge/analytics/engine/whole-filter-reader-contract";

/** Closed reader shape only. Eligibility, audience, original request snapshots,
 * independent preparation contexts and exact plan authority stay in provider. */
export type OverviewComparisonReaderConsumer =
  | {
      readonly kind: "overview";
      readonly configuration: OverviewTrendQualificationConfiguration;
    }
  | {
      readonly kind: "comparison-page";
      readonly tab: ComparisonPageReaderTab;
      readonly referenceQueryTime: QueryTime;
    };

export interface OverviewComparisonReaderDescription {
  readonly scheduling: "current-previous-detail" | "current-then-reference";
  readonly preparationKeys:
    readonly ["original"] | readonly ["current", "reference"];
  readonly outputs: readonly ExactOutputDescriptor[];
}

/** No caller-supplied reader list or numeric binding allowance. Each descriptor
 * corresponds to a real canonical child plan, never a separate output claim. */
export function describeOverviewComparisonReader(input: {
  readonly consumer: OverviewComparisonReaderConsumer;
  readonly queryTime: QueryTime;
  readonly mode: "entity" | "observation";
}): OverviewComparisonReaderDescription | undefined {
  if (input.mode !== "entity" && input.mode !== "observation") return undefined;
  const entity = EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY;
  const sources: readonly ExactMembershipSourceUse[] = Object.freeze([
    Object.freeze({
      entity: "page" as const,
      dependencyRef:
        input.mode === "entity" ? entity : EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
    }),
    Object.freeze({
      entity: "event" as const,
      dependencyRef:
        input.mode === "entity"
          ? entity
          : EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
    }),
  ]);
  const c = input.consumer;
  if (c.kind === "comparison-page") {
    // The existing native comparison child builder only exposes an entity
    // dependency. Observation must be wired and proved before admitting it.
    if (input.mode !== "entity" || !comparisonPageReaderContract(c.tab))
      return undefined;
    return Object.freeze({
      scheduling: "current-then-reference",
      preparationKeys: Object.freeze(["current", "reference"] as const),
      outputs: Object.freeze(
        (["current", "reference"] as const).map((side) =>
          Object.freeze({
            key: `comparison:${side}`,
            readerKey: `comparison:${side}`,
            preparationKey: side,
            outputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS[side],
            queryTime:
              side === "current" ? input.queryTime : c.referenceQueryTime,
            sources: Object.freeze([sources[0]!]),
          }),
        ),
      ),
    });
  }
  if (c.kind !== "overview") return undefined;
  const config = c.configuration;
  const outputs: ExactOutputDescriptor[] = [];
  const add = (
    readerKey: string,
    outputId: "overview-aggregate" | "overview-trend",
    queryTime: QueryTime,
  ) =>
    outputs.push(
      Object.freeze({
        key: readerKey,
        readerKey,
        preparationKey: "original",
        outputId,
        queryTime,
        sources,
      }),
    );
  if (config.kind === "trend") {
    add("current-trend", "overview-trend", input.queryTime);
  } else {
    if (
      config.kind !== "aggregate" &&
      config.kind !== "overview-with-detail" &&
      config.kind !== "overview-with-previous" &&
      config.kind !== "overview-with-previous-and-detail"
    )
      return undefined;
    add("current-overview", "overview-aggregate", input.queryTime);
    if (
      config.kind === "overview-with-previous" ||
      config.kind === "overview-with-previous-and-detail"
    )
      add("previous-overview", "overview-aggregate", config.previousTime);
    if (
      config.kind === "overview-with-detail" ||
      config.kind === "overview-with-previous-and-detail"
    )
      add("current-detail", "overview-trend", input.queryTime);
  }
  return Object.freeze({
    scheduling: "current-previous-detail",
    preparationKeys: Object.freeze(["original"] as const),
    outputs: Object.freeze(outputs),
  });
}
