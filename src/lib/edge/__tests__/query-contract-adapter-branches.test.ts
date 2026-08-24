import { describe, expect, it, vi } from "vitest";

const readers = vi.hoisted(() => ({
  queryBrowserRadarFromD1: vi.fn(),
  queryFunnelAnalysis: vi.fn(),
  queryFunnelDefinition: vi.fn(),
  queryFunnelDefinitions: vi.fn(),
}));

vi.mock("@/lib/edge/analytics/providers/d1/internal/funnels", () => ({
  queryFunnelAnalysis: readers.queryFunnelAnalysis,
  queryFunnelDefinition: readers.queryFunnelDefinition,
  queryFunnelDefinitions: readers.queryFunnelDefinitions,
}));

vi.mock("@/lib/edge/analytics/providers/d1/internal/technology/radar", () => ({
  queryBrowserRadarFromD1: readers.queryBrowserRadarFromD1,
  queryReferrerRadarFromD1: vi.fn(),
}));

import { handleFunnelAnalysisContract } from "@/lib/edge/analytics/providers/d1/internal/funnels-contract-adapter";
import {
  handleBrowserRadarContract,
  handleBrowserVersionBreakdownContract,
  handleClientDimensionTrendContract,
  handleCrossBreakdownContract,
  handleUtmDimensionTrendContract,
} from "@/lib/edge/analytics/providers/d1/internal/technology-contract-adapter";
import type { Env } from "@/lib/edge/types";

const env = { DB: {} } as unknown as Env;
const siteId = "site-contract-branches";
const base = "from=1767225600000&to=1767312000000";

describe("typed contract adapter data branches", () => {
  it("runs funnel analysis only for a complete definition", async () => {
    readers.queryFunnelDefinition.mockResolvedValue({
      id: "funnel-1",
      steps: [
        { type: "pageview", value: "/" },
        { type: "event", value: "signup" },
      ],
    });
    readers.queryFunnelAnalysis.mockResolvedValue({ completed: 1 });

    const response = await handleFunnelAnalysisContract(
      env,
      siteId,
      new URL(`https://edge.test/query?${base}&id=funnel-1`),
    );

    expect(response.status).toBe(200);
    expect(readers.queryFunnelAnalysis).toHaveBeenCalledOnce();
  });

  it("maps radar metrics for both zero and non-zero denominators", async () => {
    readers.queryBrowserRadarFromD1.mockResolvedValue([
      {
        browser: "Empty",
        visitors: 0,
        sessions: 0,
        avgDurationMs: 0,
        bounces: 0,
        avgDepth: 0,
        returningVisitors: 0,
        avgFrequency: 0,
        trafficShare: 0,
      },
      {
        browser: "Busy",
        visitors: 4,
        sessions: 2,
        avgDurationMs: 100,
        bounces: 1,
        avgDepth: 2,
        returningVisitors: 1,
        avgFrequency: 1.5,
        trafficShare: 0.5,
      },
    ]);

    const response = await handleBrowserRadarContract(
      env,
      siteId,
      new URL(`https://edge.test/query?${base}`),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: [
        { browser: "Empty", metrics: { engagement: 0, loyalty: 0 } },
        { browser: "Busy", metrics: { engagement: 0.5, loyalty: 0.25 } },
      ],
    });
  });

  it("validates technology dimensions and normalizes bounded limits", async () => {
    const valid = `https://edge.test/query?${base}`;
    const responses = await Promise.all([
      handleBrowserVersionBreakdownContract(
        env,
        siteId,
        new URL(`${valid}&browserLimit=4&versionLimit=12`),
      ),
      handleClientDimensionTrendContract(env, siteId, new URL(valid)),
      handleUtmDimensionTrendContract(env, siteId, new URL(valid)),
      handleCrossBreakdownContract(env, siteId, new URL(valid)),
      handleCrossBreakdownContract(
        env,
        siteId,
        new URL(`${valid}&primaryDimension=browser`),
      ),
      handleCrossBreakdownContract(
        env,
        siteId,
        new URL(`${valid}&primaryDimension=browser&secondaryDimension=browser`),
      ),
    ]);

    expect(responses.every((response) => response instanceof Response)).toBe(
      true,
    );
    expect(
      responses.filter((response) => response.status === 400),
    ).toHaveLength(5);
    expect(
      responses.filter((response) => response.status === 500),
    ).toHaveLength(1);
  });

  it("rejects definitions without enough funnel steps", async () => {
    readers.queryFunnelDefinition.mockResolvedValueOnce({
      id: "short-funnel",
      steps: [{ type: "pageview", value: "/" }],
    });

    const response = await handleFunnelAnalysisContract(
      env,
      siteId,
      new URL(`https://edge.test/query?${base}&id=short-funnel`),
    );

    expect(response.status).toBe(400);
  });
});
