import type { QueryTime } from "@/lib/edge/analytics/contract";
import { freezeMembershipRecipeValue } from "@/lib/edge/analytics/engine/membership-dependency-plan";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { ExactOutputDescriptor } from "@/lib/edge/analytics/engine/whole-filter-reader-contract";

/** Initial closed consumer. Page/Event catalog unions are integrated separately. */
export interface ReferrersSummaryWholeConsumer {
  readonly kind: "referrers-summary";
  readonly configuration: { readonly topN: number };
}
export type WholeFilterReaderConsumer = ReferrersSummaryWholeConsumer;

/** Reader values only; no Count/Seq/Core admission or request authority. */
export function describeWholeFilterReader(input: {
  readonly consumer: WholeFilterReaderConsumer;
  readonly queryTime: QueryTime;
}) {
  const c = input.consumer;
  if (
    c.kind !== "referrers-summary" ||
    !Number.isSafeInteger(c.configuration.topN) ||
    c.configuration.topN < 0
  )
    return undefined;
  const queryTime = JSON.parse(JSON.stringify(input.queryTime)) as QueryTime;
  const outputs: readonly ExactOutputDescriptor[] = [
    "referrer-summary",
    "referrer-top-sources",
  ].map((outputId) => ({
    key: outputId,
    readerKey: "referrers-summary",
    preparationKey: "original",
    outputId,
    queryTime,
    sources: [
      {
        entity: "page",
        dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
      },
    ],
  }));
  return freezeMembershipRecipeValue({
    kind: "whole-filter-reader" as const,
    consumer: { kind: c.kind, configuration: { topN: c.configuration.topN } },
    preparationKeys: ["original"] as const,
    outputs,
  });
}
export type WholeFilterReaderDescription = NonNullable<
  ReturnType<typeof describeWholeFilterReader>
>;
