import type { QueryTime } from "@/lib/edge/analytics/contract";
import {
  freezeMembershipRecipeValue,
  type MembershipPreparationInput,
  type MembershipPreparationStep,
  normalizeMembershipPreparations,
  validMembershipChildReferences,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";
import type { OverviewTrendQualificationConfiguration } from "@/lib/edge/analytics/engine/overview-trend-qualification-plan";

export type OverviewMembershipChildKey =
  "current-overview" | "previous-overview" | "current-detail" | "current-trend";

export interface OverviewMembershipChild {
  readonly kind: "read-report";
  readonly strategy: "consume-dependency";
  readonly key: OverviewMembershipChildKey;
  readonly preparationKey: string;
  readonly outputId: string;
  readonly localOutputId: "overview-aggregate" | "overview-trend";
  readonly readerProfile:
    "overview-entity-aggregate-v1" | "overview-entity-trend-v1";
  readonly queryTime: QueryTime;
  readonly interval?: "minute" | "hour" | "day" | "week" | "month";
  readonly sourceRoles: readonly ["page", "event"];
  readonly maxPlans: 1;
  readonly maxSources: 2;
}

export interface OverviewMembershipDependencyPlan<Consumer> {
  readonly kind: "overview-membership-dependencies";
  readonly preparation: MembershipPreparationStep;
  readonly configuration: OverviewTrendQualificationConfiguration;
  readonly children: readonly OverviewMembershipChild[];
  readonly steps: readonly (
    MembershipPreparationStep | OverviewMembershipChild
  )[];
  readonly consumer: Consumer;
}

/**
 * Closed Overview reader recipe. The original qualification is evaluated once;
 * current/previous/detail Sources consume that same request-private relation.
 * This declaration does not grant audience, subject, role or binding authority.
 */
export function planOverviewMembershipDependencies<Consumer>(input: {
  readonly preparation: MembershipPreparationInput;
  readonly readerQueryTime: QueryTime;
  readonly operation: "overview" | "trend";
  readonly configuration: OverviewTrendQualificationConfiguration;
  readonly importedOutputs: readonly {
    readonly childKey: OverviewMembershipChildKey;
    readonly outputId: string;
  }[];
  readonly consumer: Consumer;
}): OverviewMembershipDependencyPlan<Consumer> | undefined {
  const configuration = input.configuration;
  if (input.operation !== "overview" && input.operation !== "trend")
    return undefined;
  if (
    !configuration ||
    Object.getPrototypeOf(configuration) !== Object.prototype
  )
    return undefined;
  const kind = configuration.kind;
  if (
    ![
      "aggregate",
      "trend",
      "overview-with-detail",
      "overview-with-previous",
      "overview-with-previous-and-detail",
    ].includes(kind)
  )
    return undefined;
  if ((kind === "trend") !== (input.operation === "trend")) return undefined;
  const needsTrend =
    kind === "trend" ||
    kind === "overview-with-detail" ||
    kind === "overview-with-previous-and-detail";
  const needsPrevious =
    kind === "overview-with-previous" ||
    kind === "overview-with-previous-and-detail";
  if (
    needsTrend &&
    (!("interval" in configuration) ||
      !["minute", "hour", "day", "week", "month"].includes(
        configuration.interval,
      ))
  )
    return undefined;
  if (
    needsPrevious &&
    (!("previousTime" in configuration) || !configuration.previousTime?.range)
  )
    return undefined;
  const preparations = normalizeMembershipPreparations([input.preparation]);
  if (!preparations) return undefined;
  const preparation = preparations[0]!;
  const keys: OverviewMembershipChildKey[] =
    kind === "trend"
      ? ["current-trend"]
      : [
          "current-overview",
          ...(needsPrevious ? ["previous-overview" as const] : []),
          ...(needsTrend ? ["current-detail" as const] : []),
        ];
  if (
    input.importedOutputs.length !== keys.length ||
    keys.some((key, index) => input.importedOutputs[index]?.childKey !== key)
  )
    return undefined;
  const children = keys.map((key, index): OverviewMembershipChild => {
    const aggregate = key === "current-overview" || key === "previous-overview";
    return {
      kind: "read-report",
      strategy: "consume-dependency",
      key,
      preparationKey: preparation.key,
      outputId: input.importedOutputs[index]!.outputId,
      localOutputId: aggregate ? "overview-aggregate" : "overview-trend",
      readerProfile: aggregate
        ? "overview-entity-aggregate-v1"
        : "overview-entity-trend-v1",
      queryTime:
        key === "previous-overview" && "previousTime" in configuration
          ? configuration.previousTime
          : input.readerQueryTime,
      ...(!aggregate && "interval" in configuration
        ? { interval: configuration.interval }
        : {}),
      sourceRoles: ["page", "event"],
      maxPlans: 1,
      maxSources: 2,
    };
  });
  if (!validMembershipChildReferences(preparations, children)) return undefined;
  const value: OverviewMembershipDependencyPlan<Consumer> = {
    kind: "overview-membership-dependencies",
    preparation,
    configuration,
    children,
    steps: [preparation, ...children],
    consumer: input.consumer,
  };
  return freezeMembershipRecipeValue(
    JSON.parse(JSON.stringify(value)) as typeof value,
  );
}
