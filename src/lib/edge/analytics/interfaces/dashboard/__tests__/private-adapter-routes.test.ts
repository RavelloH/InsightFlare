import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as CompositionModule from "@/lib/edge/analytics/composition";
import type { Env } from "@/lib/edge/types";

const hoisted = vi.hoisted(() => ({
  goalsGet: vi.fn(),
  execute: vi.fn(),
  runtimeInputs: [] as unknown[],
  teamExecute: vi.fn(),
  teamInputs: [] as unknown[],
  referrerSummary: vi.fn(),
  journeys: vi.fn(),
  mockQuery: vi.fn(),
}));

vi.mock("@/lib/edge/analytics/composition", async (importOriginal) => {
  const actual = await importOriginal<typeof CompositionModule>();
  return {
    ...actual,
    createEdgeSiteAnalyticsRuntime: (input: unknown) => {
      hoisted.runtimeInputs.push(input);
      return {
        resources: { goals: { get: hoisted.goalsGet } },
        execute: hoisted.execute,
      };
    },
  };
});
vi.mock("@/lib/edge/analytics/composition/ssr-query-runtime", () => ({
  createTeamDashboardQueryRuntime: (input: unknown) => {
    hoisted.teamInputs.push(input);
    return { execute: hoisted.teamExecute };
  },
}));
vi.mock("@/lib/edge/analytics/interfaces/dashboard/protocol/pages", () => ({
  handleReferrerSummaryContract: hoisted.referrerSummary,
}));
vi.mock("@/lib/edge/analytics/interfaces/dashboard/protocol/journeys", () => ({
  handleJourneyCollectionContract: hoisted.journeys,
}));
vi.mock("@/lib/edge/analytics/interfaces/mock", () => ({
  executeMockQuery: hoisted.mockQuery,
}));

import {
  executePrivateQuery,
  executePrivateTeamDashboard,
} from "@/lib/edge/analytics/interfaces/dashboard/private";

const env = { DB: {} } as unknown as Env;
const FROM = 1_700_000_000_000;
const TO = FROM + 3_600_000;
const goal = {
  filterDslVersion: 1,
  filterDsl: 'event.name eq "signup"',
};

function url(path: string, query = ""): URL {
  return new URL(`https://app.test/api/private/${path}?${query}`);
}

async function goalCall(
  pathname: "goal-summary" | "goal-timeseries",
  query: string,
  request?: Request,
) {
  return executePrivateQuery({
    env,
    siteId: "site-1",
    pathname,
    url: url(pathname, query),
    request,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.runtimeInputs.length = 0;
  hoisted.teamInputs.length = 0;
});

describe("executePrivateQuery delegated routes", () => {
  it("routes referrer-summary to its protocol handler with the request context", async () => {
    hoisted.referrerSummary.mockResolvedValue(new Response("summary"));
    const target = url("referrer-summary", "from=1&to=2");
    const request = new Request(target, {
      headers: { "x-request-id": "req-1" },
    });
    const response = await executePrivateQuery({
      env,
      siteId: "site-1",
      pathname: "referrer-summary",
      url: target,
      request,
      deferJsonSerialization: true,
    });
    expect(await response.text()).toBe("summary");
    const args = hoisted.referrerSummary.mock.calls[0]!;
    expect(args[0]).toBe(env);
    expect(args[1]).toBe("site-1");
    expect(args[2]).toBe(target);
    expect(args[3]).toMatchObject({ deferJsonSerialization: true });
    expect(args[4]).toBeDefined();
  });

  it.each(["visitor-events", "visitor-sessions", "session-events"] as const)(
    "routes %s to the journey collection handler",
    async (pathname) => {
      hoisted.journeys.mockResolvedValue(new Response(pathname));
      const target = url(pathname);
      const response = await executePrivateQuery({
        env,
        siteId: "site-1",
        pathname,
        url: target,
      });
      expect(await response.text()).toBe(pathname);
      const args = hoisted.journeys.mock.calls[0]!;
      expect(args[1]).toBe("site-1");
      expect(args[3]).toBe(pathname);
      expect(args[4]).toBeUndefined();
    },
  );

  it("returns 404 for unknown routes", async () => {
    const response = await executePrivateQuery({
      env,
      siteId: "site-1",
      pathname: "nope",
      url: url("nope"),
    });
    expect(response.status).toBe(404);
  });
});

describe("executePrivateQuery goal routes", () => {
  it("rejects an invalid time window", async () => {
    const response = await goalCall("goal-summary", "from=abc&id=g1");
    expect(response.status).toBe(400);
    expect(hoisted.goalsGet).not.toHaveBeenCalled();
  });

  it("maps a goal repository failure to an internal error", async () => {
    hoisted.goalsGet.mockRejectedValue(new Error("db down"));
    const response = await goalCall(
      "goal-summary",
      `from=${FROM}&to=${TO}&id=g1`,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(hoisted.execute).not.toHaveBeenCalled();
  });

  it("returns 404 when the goal does not exist", async () => {
    hoisted.goalsGet.mockResolvedValue(null);
    const response = await goalCall(
      "goal-summary",
      `from=${FROM}&to=${TO}&id=%20missing%20`,
    );
    expect(response.status).toBe(404);
    expect(hoisted.goalsGet).toHaveBeenCalledWith("site-1", "missing");
  });

  it("rejects a timeseries that would exceed the bucket limit", async () => {
    hoisted.goalsGet.mockResolvedValue(goal);
    const response = await goalCall(
      "goal-timeseries",
      `from=${FROM}&to=${FROM + 3 * 86_400_000}&interval=minute&id=g1`,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "too_many_buckets" },
    });
    expect(hoisted.execute).not.toHaveBeenCalled();
  });

  it("executes goal-summary and returns the data with diagnostic headers", async () => {
    hoisted.goalsGet.mockResolvedValue(goal);
    hoisted.execute.mockResolvedValue({
      ok: true,
      data: { conversions: 3 },
      meta: { source: "raw" },
    });
    const request = new Request(url("goal-summary"), {
      headers: { "x-request-id": "req-9" },
    });
    const response = await goalCall(
      "goal-summary",
      `from=${FROM}&to=${TO}&id=g1`,
      request,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { conversions: 3 },
    });
    expect(response.headers.get("content-type")).toContain("json");
    const [operation, query, options] = hoisted.execute.mock.calls[0]!;
    expect(operation).toBe("goal-summary");
    expect(query).toMatchObject({ goalId: "g1" });
    expect(query).not.toHaveProperty("interval");
    expect(options.cost).toMatchObject({ bucketCount: 1, provider: "d1" });
  });

  it("executes goal-timeseries with the parsed interval", async () => {
    hoisted.goalsGet.mockResolvedValue(goal);
    hoisted.execute.mockResolvedValue({
      ok: true,
      data: { points: [] },
      meta: { source: "raw" },
    });
    const response = await goalCall(
      "goal-timeseries",
      `from=${FROM}&to=${TO}&interval=hour&id=g1`,
      new Request(url("goal-timeseries")),
    );
    expect(response.status).toBe(200);
    expect(hoisted.execute.mock.calls[0]![1]).toMatchObject({
      goalId: "g1",
      interval: "hour",
    });
    expect(hoisted.execute.mock.calls[0]![2].cost.bucketCount).toBe(2);
  });

  it("maps provider errors and empty data", async () => {
    hoisted.goalsGet.mockResolvedValue(goal);
    hoisted.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "internal", operation: "goal-summary" },
    });
    const failed = await goalCall(
      "goal-summary",
      `from=${FROM}&to=${TO}&id=g1`,
    );
    expect(failed.status).toBe(500);

    hoisted.execute.mockResolvedValueOnce({
      ok: true,
      data: null,
      meta: { source: "raw" },
    });
    const empty = await goalCall("goal-summary", `from=${FROM}&to=${TO}&id=g1`);
    expect(empty.status).toBe(404);
  });
});

describe("executePrivateTeamDashboard guards", () => {
  const teamInput = (query: string) => ({
    env,
    teamId: "team-1",
    allowedSiteIds: ["site-1"],
    url: url("team", query),
  });

  it("rejects an invalid time window", async () => {
    const response = await executePrivateTeamDashboard(teamInput("from=zzz"));
    expect(response.status).toBe(400);
    expect(hoisted.teamExecute).not.toHaveBeenCalled();
  });

  it("rejects unsafe integer boundaries", async () => {
    const response = await executePrivateTeamDashboard(
      teamInput("from=1e20&to=2e20"),
    );
    expect(response.status).toBe(400);
    expect(hoisted.teamExecute).not.toHaveBeenCalled();
  });

  it("rejects trends with too many buckets", async () => {
    const response = await executePrivateTeamDashboard(
      teamInput(`from=${FROM}&to=${FROM + 40 * 86_400_000}&interval=minute`),
    );
    expect(response.status).toBe(422);
    expect(hoisted.teamExecute).not.toHaveBeenCalled();
  });

  it("maps a runtime error result", async () => {
    hoisted.teamExecute.mockResolvedValue({
      ok: false,
      error: { kind: "invalid-cursor", cursorKind: "x" },
    });
    const response = await executePrivateTeamDashboard(
      teamInput(`from=${FROM}&to=${TO}`),
    );
    expect(response.status).toBe(400);
    expect(hoisted.teamInputs[0]).toMatchObject({
      teamId: "team-1",
      allowedSiteIds: ["site-1"],
      interval: "day",
    });
  });

  it("returns team data with cache and diagnostic headers", async () => {
    hoisted.teamExecute.mockResolvedValue({
      ok: true,
      data: { sites: [] },
      meta: { source: "raw" },
    });
    const response = await executePrivateTeamDashboard({
      ...teamInput(`from=${FROM}&to=${TO}`),
      request: new Request(url("team")),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { sites: [] },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("executePrivateQuery demo build", () => {
  it("delegates to the mock executor when VITE_DEMO_MODE is enabled", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    vi.resetModules();
    try {
      const demo =
        await import("@/lib/edge/analytics/interfaces/dashboard/private");
      hoisted.mockQuery.mockResolvedValue(new Response("mock"));
      const target = url("overview", "from=1");
      const withRequest = await demo.executePrivateQuery({
        env,
        siteId: "site-1",
        pathname: "overview",
        url: target,
        request: new Request(target, { headers: { "x-request-id": "r-1" } }),
      });
      expect(await withRequest.text()).toBe("mock");
      const first = hoisted.mockQuery.mock.calls[0]![0];
      expect(first).toMatchObject({
        siteId: "site-1",
        url: target,
        context: expect.objectContaining({ requestId: expect.any(String) }),
      });

      await demo.executePrivateQuery({
        env,
        siteId: "site-1",
        pathname: "overview",
        url: target,
      });
      const second = hoisted.mockQuery.mock.calls[1]![0];
      expect(second.context).toBeUndefined();
      expect(second.request).toBeInstanceOf(Request);
      expect(second.request.method).toBe("GET");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
