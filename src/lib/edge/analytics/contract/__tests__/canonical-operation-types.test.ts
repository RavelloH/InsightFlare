import { describe, expect, it } from "vitest";

import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/analytics/query-application";
import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import type {
  AnalyticsProviderRegistry,
  TypedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import type {
  ApiV1CanonicalOperation,
  ApiV1CanonicalOperationMap,
  ApiV1CanonicalQuery,
  ApiV1CanonicalResult,
} from "@/lib/edge/analytics/application/query-operation-map";
import type { AnalyticsQueryExecutor } from "@/lib/edge/analytics/composition/query-runtime";
import type {
  AnalyticsResult,
  BreakdownResult,
  CanonicalQuery,
  CanonicalResult,
} from "@/lib/edge/analytics/contract";

declare const executor: AnalyticsQueryExecutor;
declare const registry: AnalyticsProviderRegistry;
declare const overviewQuery: CanonicalQuery<"overview">;
declare const breakdownProvider: TypedQueryProvider<
  "dimension",
  BreakdownResult
>;
declare const nestedComparisonProvider: TypedQueryProvider<
  "comparison",
  AnalyticsResult<CanonicalResult<"comparison">>
>;
declare const comparisonValue: ApiV1CanonicalResult<"site.analytics.comparison">;
declare const apiOverviewQuery: CanonicalQuery<"overview">;
declare const apiExecutor: AnalyticsQueryExecutor;
declare const apiContext: CanonicalQuery<"overview">["context"];

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;
type _AllApiV1OperationsHaveMappings = Assert<
  Equal<keyof ApiV1CanonicalOperationMap, AnalyticsOperationId>
>;
type _ChannelsMapsToCanonicalChannels = Assert<
  Equal<ApiV1CanonicalOperation<"site.analytics.channels">, "channels">
>;
type _ChannelsUsesCanonicalQuery = Assert<
  Equal<
    ApiV1CanonicalQuery<"site.analytics.channels">,
    CanonicalQuery<"channels">
  >
>;
type _ComparisonResultIsNotAnEnvelope = Assert<
  Equal<
    ApiV1CanonicalResult<"site.analytics.comparison"> extends AnalyticsResult<unknown>
      ? true
      : false,
    false
  >
>;

function assertCanonicalOperationTypes() {
  // @ts-expect-error An overview query cannot execute the dimension operation.
  void executor.execute("dimension", overviewQuery);
  // @ts-expect-error A Dimension provider cannot be registered as Channels.
  registry.register("channels", breakdownProvider);
  // @ts-expect-error Canonical providers return values, not AnalyticsResult envelopes.
  registry.register("comparison", nestedComparisonProvider);

  const adapter = createApiV1QueryApplicationAdapter();
  void adapter.execute(
    {
      operation: "site.analytics.channels",
      context: apiContext,
      query: { limit: 12 },
      executor: apiExecutor,
    },
    {},
  );
  void adapter.execute(
    {
      operation: "site.analytics.channels",
      context: apiContext,
      // @ts-expect-error An overview query cannot be used for the channels API operation.
      query: apiOverviewQuery,
      executor: apiExecutor,
    },
    {},
  );
  void comparisonValue;
}
void assertCanonicalOperationTypes;

describe("canonical operation type mapping", () => {
  it("keeps operation query and provider result types coupled", () => {
    expect(true).toBe(true);
  });
});
