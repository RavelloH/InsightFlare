import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edge/query/funnels", () => ({
  queryFunnelDefinition: vi.fn(),
  queryFunnelAnalysis: vi.fn(),
}));

import {
  queryFunnelAnalysis,
  queryFunnelDefinition,
} from "@/lib/edge/query/funnels";
import { readSiteFunnelAnalysis } from "@/lib/edge/query-runtime/site-funnel-analysis";

const input = {
  env: {} as never,
  siteId: "site-1",
  funnelId: "funnel-1",
  window: { startMs: 0, endExclusiveMs: 100, nowMs: 100, timeZone: "UTC" },
  filters: { version: 1 as const, root: null },
};

const funnel = {
  id: "funnel-1",
  siteId: "site-1",
  name: "Signup",
  steps: [
    { type: "pageview" as const, value: "/landing" },
    { type: "event" as const, value: "signup" },
  ],
  createdAt: 1,
  updatedAt: 2,
};

describe("site funnel analysis runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the definition before delegating analysis", async () => {
    const analysis = {
      steps: [],
      summary: {
        totalSessions: 1,
        convertedSessions: 1,
        totalVisitors: 1,
        convertedVisitors: 1,
        overallConversionRate: 1,
        largestDropOffStepIndex: null,
      },
    };
    vi.mocked(queryFunnelDefinition).mockResolvedValue(funnel);
    vi.mocked(queryFunnelAnalysis).mockResolvedValue(analysis);

    await expect(readSiteFunnelAnalysis(input)).resolves.toEqual({
      funnel,
      analysis,
    });
    expect(queryFunnelDefinition).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.funnelId,
    );
    expect(queryFunnelAnalysis).toHaveBeenCalledWith(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      funnel.steps,
    );
  });

  it("returns null for missing or incomplete definitions", async () => {
    vi.mocked(queryFunnelDefinition).mockResolvedValueOnce(null);
    await expect(readSiteFunnelAnalysis(input)).resolves.toBeNull();

    vi.mocked(queryFunnelDefinition).mockResolvedValueOnce({
      ...funnel,
      steps: [funnel.steps[0]],
    });
    await expect(readSiteFunnelAnalysis(input)).resolves.toBeNull();
    expect(queryFunnelAnalysis).not.toHaveBeenCalled();
  });
});
