import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@/lib/edge/types";
import { privateWidgetRoutes } from "@/lib/hono/routes/private/widgets";
import type { AppEnv } from "@/lib/hono/types";
import type { WidgetConfig, WidgetRecord } from "@/lib/widgets/contract";

const mocks = vi.hoisted(() => ({
  resolvePrivateTeamForSession: vi.fn(),
  queryWidgetData: vi.fn(),
  createWidget: vi.fn(),
  deleteWidget: vi.fn(),
  listTeamWidgets: vi.fn(),
  publishWidget: vi.fn(),
  readWidget: vi.fn(),
  unpublishWidget: vi.fn(),
  updateWidgetDraft: vi.fn(),
  widgetSiteBelongsToTeam: vi.fn(),
}));

vi.mock("@/lib/edge/auth/site-access", () => ({
  resolvePrivateTeamForSession: mocks.resolvePrivateTeamForSession,
}));
vi.mock("@/lib/edge/analytics/interfaces/dashboard/widget-query", () => ({
  queryWidgetData: mocks.queryWidgetData,
}));
vi.mock("@/lib/widgets/store", () => ({
  createWidget: mocks.createWidget,
  deleteWidget: mocks.deleteWidget,
  listTeamWidgets: mocks.listTeamWidgets,
  publishWidget: mocks.publishWidget,
  readWidget: mocks.readWidget,
  unpublishWidget: mocks.unpublishWidget,
  updateWidgetDraft: mocks.updateWidgetDraft,
  widgetSiteBelongsToTeam: mocks.widgetSiteBelongsToTeam,
  WidgetConflictError: class WidgetConflictError extends Error {},
  WidgetStorageUnavailableError: class WidgetStorageUnavailableError extends Error {},
}));

const uuid = "aef8f0db-ccdd-468f-bd9c-344339264cae";
const config: WidgetConfig = {
  title: "Visitors",
  type: "metric" as const,
  metric: "visitors" as const,
  range: "30d" as const,
  timeZone: "UTC",
  locale: "en" as const,
  theme: "auto" as const,
  embedMode: "restricted" as const,
  allowedOrigins: ["https://example.com"],
  comparison: true,
  dimension: "page.path" as const,
  limit: 5 as const,
  rankingStyle: "list",
  pageLinksEnabled: false,
  distributionStyle: "bars",
  trendStyle: "line",
  distributionDimension: "client.deviceType",
  trendMetrics: [],
  conversionKind: "event",
  eventName: "",
  goalId: "",
  geoProjection: "flat",
  realtimeLayout: "badge",
};

const publishedRecord: WidgetRecord = {
  schemaVersion: 1,
  uuid,
  teamId: "team-a",
  siteId: "site-a",
  draft: config,
  published: config,
  status: "published",
  revision: 1,
  createdAt: 10,
  updatedAt: 10,
};

function appFor(
  session: { userId: string; systemRole: "user" | "admin" } = {
    userId: "user-a",
    systemRole: "user",
  },
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("session", {
      ...session,
      username: "user",
      displayName: "User",
      exp: 1_900_000_000,
    });
    await next();
  });
  app.route("/widgets", privateWidgetRoutes);
  return app;
}

function sameOriginRequest(path: string, init: RequestInit = {}) {
  return new Request(`https://insightflare.test/widgets${path}`, {
    ...init,
    headers: {
      origin: "https://insightflare.test",
      ...(init.headers ?? {}),
    },
  });
}

function send(app: Hono<AppEnv>, input: Request) {
  return app.request(input, undefined, { DB: {} } as Env);
}

describe("private widget routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePrivateTeamForSession.mockResolvedValue({ id: "team-a" });
    mocks.widgetSiteBelongsToTeam.mockResolvedValue(true);
    mocks.createWidget.mockResolvedValue(publishedRecord);
    mocks.readWidget.mockResolvedValue(publishedRecord);
    mocks.publishWidget.mockResolvedValue(publishedRecord);
    mocks.deleteWidget.mockResolvedValue(true);
  });

  it("requires a team manager for listing and management", async () => {
    mocks.resolvePrivateTeamForSession.mockResolvedValueOnce({
      id: "team-a",
      allowedSiteIds: ["site-a"],
    });
    const response = await send(appFor(), sameOriginRequest("/teams/team-a"));

    expect(response.status).toBe(403);
    expect(mocks.listTeamWidgets).not.toHaveBeenCalled();
  });

  it("creates a published component atomically after site ownership is checked", async () => {
    const response = await send(
      appFor(),
      sameOriginRequest("/teams/team-a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uuid, siteId: "site-a", config, publish: true }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.widgetSiteBelongsToTeam).toHaveBeenCalledWith(
      expect.anything(),
      "team-a",
      "site-a",
    );
    expect(mocks.createWidget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "team-a",
        siteId: "site-a",
        publish: true,
      }),
    );
  });

  it("rejects cross-origin writes before reading or changing widget state", async () => {
    const request = new Request(
      "https://insightflare.test/widgets/teams/team-a",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.test",
        },
        body: JSON.stringify({ uuid, siteId: "site-a", config }),
      },
    );
    const response = await send(appFor(), request);

    expect(response.status).toBe(403);
    expect(mocks.createWidget).not.toHaveBeenCalled();
  });

  it("publishes submitted unsaved configuration only after confirming site ownership", async () => {
    const nextConfig = { ...config, title: "New title" };
    const response = await send(
      appFor(),
      sameOriginRequest(`/teams/team-a/${uuid}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: nextConfig }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.publishWidget).toHaveBeenCalledWith(
      expect.anything(),
      "team-a",
      uuid,
      nextConfig,
    );
  });

  it("returns no body after deleting the record and orphanable index", async () => {
    mocks.readWidget.mockResolvedValueOnce(null);
    const response = await send(
      appFor(),
      sameOriginRequest(`/teams/team-a/${uuid}`, { method: "DELETE" }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(mocks.deleteWidget).toHaveBeenCalledWith(
      expect.anything(),
      "team-a",
      uuid,
    );
  });
});
