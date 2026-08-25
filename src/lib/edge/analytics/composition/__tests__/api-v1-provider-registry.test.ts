import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AnalyticsProviderRegistry,
  type TypedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import { createApiV1ProviderRegistry } from "@/lib/edge/analytics/composition/api-v1-provider-registry";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { readSiteFunnelAnalysis } from "@/lib/edge/analytics/providers/d1/operations/site-funnel-analysis";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/analytics/composition/d1", () => ({
  createD1SiteQueryRuntime: vi.fn(),
  createD1TeamQueryRuntime: vi.fn(),
}));
vi.mock(
  "@/lib/edge/analytics/providers/d1/operations/site-funnel-analysis",
  () => ({ readSiteFunnelAnalysis: vi.fn() }),
);

const createD1SiteQueryRuntimeMock = vi.mocked(createD1SiteQueryRuntime);
const readSiteFunnelAnalysisMock = vi.mocked(readSiteFunnelAnalysis);

const env = {} as Env;
const time = createQueryTime(100, 200, "UTC", 200);

function setupProvider<Result>(
  operation: "overview" | "trend",
  value: Result,
): TypedQueryProvider<Result> {
  const provider: TypedQueryProvider<Result> = {
    execute: vi.fn().mockResolvedValue({
      value,
      source: "rollup",
      approximateVisitors: true,
    }),
  };
  createD1SiteQueryRuntimeMock.mockReturnValue({
    providerRegistry: new AnalyticsProviderRegistry().register(
      operation,
      provider,
    ),
    execute: vi.fn(),
  });
  return provider;
}

describe("API v1 provider composition", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["site.analytics.overview", "overview"],
    ["site.analytics.timeseries", "trend"],
  ] as const)(
    "wraps the %s canonical value with API analytics metadata",
    (operation, canonicalOperation) => {
      const value = { operation };
      const source = setupProvider(canonicalOperation, value);
      const registry = createApiV1ProviderRegistry({
        env,
        siteId: "site-1",
        operation,
      });
      const provider = registry.resolve(canonicalOperation);

      expect(provider).toBeDefined();
      return expect(
        provider!.execute({
          context: siteQueryContext("site-1", "api-v1"),
          time,
          filters: EMPTY_FILTER_DOCUMENT,
        } as never),
      )
        .resolves.toEqual({
          value: {
            ok: true,
            data: value,
            meta: {
              time,
              source: "rollup",
              approximateVisitors: true,
            },
          },
        })
        .then(() => {
          expect(source.execute).toHaveBeenCalledOnce();
        });
    },
  );

  it("preserves a missing funnel as a nullable provider result", async () => {
    readSiteFunnelAnalysisMock.mockResolvedValue(null);
    const registry = createApiV1ProviderRegistry({
      env,
      siteId: "site-1",
      operation: "site.analytics.funnelAnalysis",
    });
    const provider = registry.resolve("funnel-analysis");

    await expect(
      provider!.execute({
        context: siteQueryContext("site-1", "api-v1"),
        time,
        funnelId: "missing-funnel",
        filters: EMPTY_FILTER_DOCUMENT,
      } as never),
    ).resolves.toEqual({ value: null });
  });
});
