import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authenticateApiKey } from "@/lib/edge/api-key-auth";
import type * as ApiV1Module from "@/lib/edge/api-v1";
import {
  handleAnalytics,
  handleApiV1,
  handleBatch,
  handleCapabilities,
  handleEvents,
  handleFunnels,
  handleJourneys,
  handlePerformance,
  handlePrivacy,
  handleRealtime,
  handleRoot,
  handleSharing,
  handleSiteResource,
  handleSitesCollection,
  handleTeam,
  handleToken,
  handleTokenCheck,
  handleTracking,
  handleTrackingScript,
} from "@/lib/edge/api-v1";
import { v1Routes } from "@/lib/hono/routes/v1";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/api-key-auth", () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock("@/lib/edge/api-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiV1Module>();
  return {
    ...actual,
    handleAnalytics: vi.fn(),
    handleApiV1: vi.fn(),
    handleBatch: vi.fn(),
    handleCapabilities: vi.fn(),
    handleEvents: vi.fn(),
    handleFunnels: vi.fn(),
    handleJourneys: vi.fn(),
    handlePerformance: vi.fn(),
    handlePrivacy: vi.fn(),
    handleRealtime: vi.fn(),
    handleRoot: vi.fn(),
    handleSharing: vi.fn(),
    handleSiteResource: vi.fn(),
    handleSitesCollection: vi.fn(),
    handleTeam: vi.fn(),
    handleToken: vi.fn(),
    handleTokenCheck: vi.fn(),
    handleTracking: vi.fn(),
    handleTrackingScript: vi.fn(),
  };
});

const principal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "if_123",
  scopes: ["analytics:read" as const],
  siteIds: ["site-1"],
};
const env = { DB: {} };
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://app.test${path}`, init);
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1", v1Routes);
  return app;
}

describe("Hono API v1 routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateApiKey).mockResolvedValue(principal);
    vi.mocked(handleRoot).mockResolvedValue(new Response("root"));
    vi.mocked(handleCapabilities).mockResolvedValue(
      new Response("capabilities"),
    );
    vi.mocked(handleSitesCollection).mockResolvedValue(new Response("sites"));
    vi.mocked(handleAnalytics).mockResolvedValue(new Response("analytics"));
    vi.mocked(handleBatch).mockResolvedValue(new Response("batch"));
    vi.mocked(handleEvents).mockResolvedValue(new Response("events"));
    vi.mocked(handleFunnels).mockResolvedValue(new Response("funnels"));
    vi.mocked(handleJourneys).mockResolvedValue(new Response("journeys"));
    vi.mocked(handlePerformance).mockResolvedValue(new Response("performance"));
    vi.mocked(handlePrivacy).mockResolvedValue(new Response("privacy"));
    vi.mocked(handleRealtime).mockResolvedValue(new Response("realtime"));
    vi.mocked(handleSharing).mockResolvedValue(new Response("sharing"));
    vi.mocked(handleSiteResource).mockResolvedValue(
      new Response("site-resource"),
    );
    vi.mocked(handleSitesCollection).mockResolvedValue(new Response("sites"));
    vi.mocked(handleTeam).mockResolvedValue(new Response("team"));
    vi.mocked(handleToken).mockResolvedValue(new Response("token"));
    vi.mocked(handleTokenCheck).mockResolvedValue(new Response("token-check"));
    vi.mocked(handleTracking).mockResolvedValue(new Response("tracking"));
    vi.mocked(handleTrackingScript).mockResolvedValue(
      new Response("tracking-script"),
    );
  });

  it("serves the API v1 root without API key auth", async () => {
    const response = await createApp().fetch(
      request("/api/v1"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("root");
    expect(handleRoot).toHaveBeenCalledWith(expect.any(Request));
    expect(authenticateApiKey).not.toHaveBeenCalled();
    expect(handleApiV1).not.toHaveBeenCalled();
  });

  it("authenticates non-root routes and dispatches capabilities directly", async () => {
    const response = await createApp().fetch(
      request("/api/v1/capabilities"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("capabilities");
    expect(authenticateApiKey).toHaveBeenCalled();
    expect(handleCapabilities).toHaveBeenCalledWith(
      expect.any(Request),
      principal,
    );
    expect(handleApiV1).not.toHaveBeenCalled();
  });

  it("routes site analytics resources with the decoded API v1 path", async () => {
    const response = await createApp().fetch(
      request("/api/v1/sites/site-1/analytics/overview"),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("analytics");
    expect(handleAnalytics).toHaveBeenCalledWith(
      expect.any(Request),
      env,
      new URL("https://app.test/api/v1/sites/site-1/analytics/overview"),
      principal,
      "site-1",
      ["sites", "site-1", "analytics", "overview"],
    );
  });

  it.each([
    ["/api/v1/token", handleToken, "token"],
    ["/api/v1/token/check", handleTokenCheck, "token-check"],
    ["/api/v1/team", handleTeam, "team"],
    ["/api/v1/team/usage", handleTeam, "team"],
    ["/api/v1/sites", handleSitesCollection, "sites"],
    ["/api/v1/sites/site-1", handleSiteResource, "site-resource"],
    ["/api/v1/sites/site-1/tracking", handleTracking, "tracking"],
    [
      "/api/v1/sites/site-1/tracking/script",
      handleTrackingScript,
      "tracking-script",
    ],
    ["/api/v1/sites/site-1/privacy", handlePrivacy, "privacy"],
    ["/api/v1/sites/site-1/sharing", handleSharing, "sharing"],
    ["/api/v1/sites/site-1/analytics/schema", handleAnalytics, "analytics"],
    ["/api/v1/sites/site-1/event-types", handleEvents, "events"],
    ["/api/v1/sites/site-1/events", handleEvents, "events"],
    ["/api/v1/sites/site-1/events/event-1", handleEvents, "events"],
    ["/api/v1/sites/site-1/event-fields", handleEvents, "events"],
    ["/api/v1/sites/site-1/visitors", handleJourneys, "journeys"],
    ["/api/v1/sites/site-1/visitors/visitor-1", handleJourneys, "journeys"],
    ["/api/v1/sites/site-1/sessions", handleJourneys, "journeys"],
    ["/api/v1/sites/site-1/sessions/session-1", handleJourneys, "journeys"],
    ["/api/v1/sites/site-1/funnels", handleFunnels, "funnels"],
    ["/api/v1/sites/site-1/funnels/analysis", handleFunnels, "funnels"],
    ["/api/v1/sites/site-1/funnels/funnel-1", handleFunnels, "funnels"],
    ["/api/v1/sites/site-1/performance", handlePerformance, "performance"],
    [
      "/api/v1/sites/site-1/performance/summary",
      handlePerformance,
      "performance",
    ],
    ["/api/v1/sites/site-1/realtime", handleRealtime, "realtime"],
    ["/api/v1/sites/site-1/realtime/snapshot", handleRealtime, "realtime"],
  ])("routes %s directly through Hono", async (route, handler, body) => {
    const response = await createApp().fetch(request(route), env as never, ctx);

    await expect(response.text()).resolves.toBe(body);
    expect(handler).toHaveBeenCalled();
    expect(handleApiV1).not.toHaveBeenCalled();
  });

  it("returns the API v1 resource_not_found envelope for unknown resources", async () => {
    const response = await createApp().fetch(
      request("/api/v1/nope"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "resource_not_found" },
    });
  });

  it("dispatches batch subrequests through the Hono v1 route map", async () => {
    vi.mocked(handleBatch).mockImplementation(
      async (_request, batchEnv, _url, _principal, dispatch) =>
        dispatch!(
          request("/api/v1/capabilities"),
          batchEnv,
          new URL("https://app.test/api/v1/capabilities"),
        ),
    );
    const response = await createApp().fetch(
      request("/api/v1/batch", { method: "POST", body: "{}" }),
      env as never,
      ctx,
    );

    await expect(response.text()).resolves.toBe("capabilities");
    expect(handleCapabilities).toHaveBeenCalled();
    expect(handleApiV1).not.toHaveBeenCalled();
  });
});
