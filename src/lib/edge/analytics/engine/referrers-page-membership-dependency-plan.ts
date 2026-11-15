import type { QueryTime } from "@/lib/edge/analytics/contract";
import {
  freezeMembershipRecipeValue,
  type MembershipPreparationInput,
  normalizeMembershipPreparations,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";

export interface ReferrersPageReaderConfiguration {
  readonly limit: number;
  readonly includeFullUrl: boolean;
  readonly search?: string;
  readonly cursorText: string | null;
  readonly audience: "private-dashboard";
  readonly sortBy: "views" | "visitors";
  readonly sortDirection: "asc" | "desc";
}

/** Closed reader recipe only. The provider separately proves request authority. */
export function planReferrersPageMembershipDependencies(input: {
  readonly preparation: MembershipPreparationInput;
  readonly readerQueryTime: QueryTime;
  readonly configuration: ReferrersPageReaderConfiguration;
}) {
  const c = input.configuration;
  if (
    !Number.isSafeInteger(c.limit) ||
    c.limit < 0 ||
    typeof c.includeFullUrl !== "boolean" ||
    (c.search !== undefined && typeof c.search !== "string") ||
    (c.cursorText !== null && typeof c.cursorText !== "string") ||
    c.audience !== "private-dashboard" ||
    (c.sortBy !== "views" && c.sortBy !== "visitors") ||
    (c.sortDirection !== "asc" && c.sortDirection !== "desc")
  )
    return undefined;
  const preparations = normalizeMembershipPreparations([input.preparation]);
  if (!preparations || preparations.length !== 1) return undefined;
  return freezeMembershipRecipeValue(
    JSON.parse(
      JSON.stringify({
        kind: "referrers-page-membership-dependencies" as const,
        steps: [
          preparations[0]!,
          {
            kind: "decode-page-cursor" as const,
            operation: "referrers" as const,
            cursorText: c.cursorText,
            queryTime: input.readerQueryTime,
          },
          {
            kind: "read-report" as const,
            strategy: "consume-dependency" as const,
            readerProfile: "referrers-page-v1" as const,
            outputId: "referrers-page" as const,
            preparationKey: input.preparation.key,
            sourceRole: "page" as const,
            queryTime: input.readerQueryTime,
            maxPlans: 1 as const,
            maxSources: 1 as const,
          },
        ] as const,
        consumer: { operation: "referrers" as const, configuration: c },
      }),
    ) as {
      readonly kind: "referrers-page-membership-dependencies";
      readonly steps: readonly [
        (typeof preparations)[0],
        {
          readonly kind: "decode-page-cursor";
          readonly operation: "referrers";
          readonly cursorText: string | null;
          readonly queryTime: QueryTime;
        },
        {
          readonly kind: "read-report";
          readonly strategy: "consume-dependency";
          readonly readerProfile: "referrers-page-v1";
          readonly outputId: "referrers-page";
          readonly preparationKey: string;
          readonly sourceRole: "page";
          readonly queryTime: QueryTime;
          readonly maxPlans: 1;
          readonly maxSources: 1;
        },
      ];
      readonly consumer: {
        readonly operation: "referrers";
        readonly configuration: ReferrersPageReaderConfiguration;
      };
    },
  );
}
export type ReferrersPageMembershipDependencyPlan = NonNullable<
  ReturnType<typeof planReferrersPageMembershipDependencies>
>;
