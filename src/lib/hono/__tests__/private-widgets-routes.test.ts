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

describe("widget management permission and invalid-input matrix", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolvePrivateTeamForSession.mockResolvedValue({ id: "team-a" });
    mocks.widgetSiteBelongsToTeam.mockResolvedValue(true);
    mocks.createWidget.mockResolvedValue(publishedRecord);
    mocks.readWidget.mockResolvedValue(publishedRecord);
    mocks.publishWidget.mockResolvedValue(publishedRecord);
    mocks.deleteWidget.mockResolvedValue(true);
  });
  const endpoint = `/teams/team-a/${uuid}`;
  const write = (
    suffix: string,
    method: "POST" | "PUT" | "DELETE",
    body?: unknown,
  ) =>
    sameOriginRequest(suffix, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
    });

  it("lists only the authorized team with an opaque cursor", async () => {
    mocks.listTeamWidgets.mockResolvedValueOnce({
      data: [publishedRecord],
      nextCursor: "next-page",
    });
    const response = await send(
      appFor(),
      sameOriginRequest("/teams/team-a?cursor=first-page"),
    );
    expect(response.status).toBe(200);
    expect(mocks.listTeamWidgets).toHaveBeenCalledWith(
      expect.anything(),
      "team-a",
      "first-page",
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      nextCursor: "next-page",
    });
  });

  it("does not expose list data when team resolution denies access", async () => {
    mocks.resolvePrivateTeamForSession.mockResolvedValueOnce(
      new Response("Denied", { status: 404 }),
    );
    const result = await send(appFor(), sameOriginRequest("/teams/team-a"));
    expect(result.status).toBe(404);
    expect(mocks.listTeamWidgets).not.toHaveBeenCalled();
  });

  it.each([" ", ...Array(1).fill("x".repeat(130))])(
    "rejects invalid team identifiers for management without accessing storage",
    async (team) => {
      const result = await send(
        appFor(),
        sameOriginRequest(`/teams/${encodeURIComponent(team)}`),
      );
      expect(result.status).toBe(400);
      expect(mocks.listTeamWidgets).not.toHaveBeenCalled();
    },
  );

  it("converts unavailable storage and id conflicts into stable public errors", async () => {
    const { WidgetStorageUnavailableError, WidgetConflictError } =
      await import("@/lib/widgets/store");
    mocks.listTeamWidgets.mockRejectedValueOnce(
      new WidgetStorageUnavailableError(),
    );
    const unavailable = await send(
      appFor(),
      sameOriginRequest("/teams/team-a"),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "widget_storage_unavailable" },
    });
    mocks.createWidget.mockRejectedValueOnce(new WidgetConflictError());
    const conflict = await send(
      appFor(),
      write("/teams/team-a", "POST", {
        uuid,
        siteId: "site-a",
        config,
      }),
    );
    expect(conflict.status).toBe(400);
    expect(await conflict.json()).toMatchObject({
      error: { code: "widget_conflict" },
    });
  });

  it("previews unpublished valid configuration for a team-owned site", async () => {
    mocks.queryWidgetData.mockResolvedValueOnce({
      type: "metric",
      value: 42,
      change: null,
    });
    const response = await send(
      appFor(),
      write("/teams/team-a/preview", "POST", {
        siteId: "site-a",
        config,
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.queryWidgetData).toHaveBeenCalledWith(
      expect.anything(),
      "site-a",
      expect.objectContaining({ type: "metric" }),
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { value: 42 },
    });
  });

  it("never leaks storage or runtime failures from previews", async () => {
    mocks.queryWidgetData.mockRejectedValueOnce(
      new Error("internal analytics error"),
    );
    const response = await send(
      appFor(),
      write("/teams/team-a/preview", "POST", {
        siteId: "site-a",
        config,
      }),
    );
    expect(response.status).toBe(503);
    const serialized = await response.text();
    expect(serialized).toContain("widget_preview_failed");
    expect(serialized).not.toContain("internal analytics error");
  });

  it.each([
    { description: "non-object JSON", body: "[]", status: 400 },
    { description: "malformed JSON", body: "{not-json", status: 400 },
    {
      description: "invalid config",
      body: { siteId: "site-a", config: { bad: true } },
      status: 400,
    },
    { description: "missing site", body: { config }, status: 404 },
    {
      description: "invalid site",
      body: { siteId: "x".repeat(121), config },
      status: 404,
    },
  ])("validates preview payload: $description", async ({ body, status }) => {
    const response = await send(
      appFor(),
      write("/teams/team-a/preview", "POST", body),
    );
    expect(response.status).toBe(status);
    expect(mocks.queryWidgetData).not.toHaveBeenCalled();
  });

  it("refuses previewing a site owned by a different team", async () => {
    mocks.widgetSiteBelongsToTeam.mockResolvedValueOnce(false);
    const response = await send(
      appFor(),
      write("/teams/team-a/preview", "POST", { siteId: "site-b", config }),
    );
    expect(response.status).toBe(404);
    expect(mocks.queryWidgetData).not.toHaveBeenCalled();
  });

  it.each([
    {
      description: "missing UUID",
      body: { siteId: "site-a", config },
      status: 400,
    },
    {
      description: "invalid UUID",
      body: { uuid: "not-a-uuid", siteId: "site-a", config },
      status: 400,
    },
    {
      description: "invalid config",
      body: { uuid, siteId: "site-a", config: { type: "nonsense" } },
      status: 400,
    },
    {
      description: "publish is not a boolean",
      body: { uuid, siteId: "site-a", config, publish: "yes" },
      status: 400,
    },
    { description: "missing site", body: { uuid, config }, status: 404 },
    { description: "malformed JSON", body: "{invalid", status: 400 },
  ])("rejects malformed creation: $description", async ({ body, status }) => {
    const response = await send(appFor(), write("/teams/team-a", "POST", body));
    expect(response.status).toBe(status);
    expect(mocks.createWidget).not.toHaveBeenCalled();
  });

  it("cannot create a widget for another team's site", async () => {
    mocks.widgetSiteBelongsToTeam.mockResolvedValueOnce(false);
    const response = await send(
      appFor(),
      write("/teams/team-a", "POST", { uuid, siteId: "site-b", config }),
    );
    expect(response.status).toBe(404);
    expect(mocks.createWidget).not.toHaveBeenCalled();
  });

  it("creates an unpublished draft without implicitly publishing", async () => {
    const response = await send(
      appFor(),
      write("/teams/team-a", "POST", {
        uuid,
        siteId: "site-a",
        config,
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.createWidget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publish: false }),
    );
  });

  it("updates only the selected team's widget draft", async () => {
    mocks.updateWidgetDraft.mockResolvedValueOnce(publishedRecord);
    const response = await send(
      appFor(),
      write(endpoint, "PUT", { config: { ...config, title: "" } }),
    );
    expect(response.status).toBe(200);
    expect(mocks.updateWidgetDraft).toHaveBeenCalledWith(
      expect.anything(),
      "team-a",
      uuid,
      expect.objectContaining({ title: "" }),
    );
  });

  it.each([
    { description: "missing current record", current: null, siteOwns: true },
    {
      description: "different team",
      current: { ...publishedRecord, teamId: "team-b" },
      siteOwns: true,
    },
    { description: "site transfer", current: publishedRecord, siteOwns: false },
  ])(
    "rejects draft updates after $description",
    async ({ current, siteOwns }) => {
      mocks.readWidget.mockResolvedValueOnce(current);
      if (!siteOwns) mocks.widgetSiteBelongsToTeam.mockResolvedValueOnce(false);
      const response = await send(appFor(), write(endpoint, "PUT", { config }));
      expect(response.status).toBe(404);
      expect(mocks.updateWidgetDraft).not.toHaveBeenCalled();
    },
  );

  it.each([
    { description: "malformed object", data: "[]", status: 400 },
    {
      description: "invalid config",
      data: { config: { title: "x" } },
      status: 400,
    },
  ])("rejects updating a draft with $description", async ({ data, status }) => {
    const response = await send(appFor(), write(endpoint, "PUT", data));
    expect(response.status).toBe(status);
    expect(mocks.updateWidgetDraft).not.toHaveBeenCalled();
  });

  it("does not pretend a missing update result succeeded", async () => {
    mocks.updateWidgetDraft.mockResolvedValueOnce(null);
    const response = await send(appFor(), write(endpoint, "PUT", { config }));
    expect(response.status).toBe(404);
  });

  it.each([
    { description: "invalid JSON", data: "{", code: "invalid_json_body" },
    { description: "array body", data: "[]", code: "invalid_json_body" },
    {
      description: "invalid configuration",
      data: { config: { title: "bad" } },
      code: "invalid_widget_config",
    },
  ])("refuses publishing with $description", async ({ data, code }) => {
    const response = await send(
      appFor(),
      write(endpoint + "/publish", "POST", data),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(mocks.publishWidget).not.toHaveBeenCalled();
  });

  it("publishes the existing saved draft when no override is supplied", async () => {
    const response = await send(appFor(), write(endpoint + "/publish", "POST"));
    expect(response.status).toBe(200);
    expect(mocks.publishWidget).toHaveBeenCalledWith(
      expect.anything(),
      "team-a",
      uuid,
      undefined,
    );
  });

  it("cannot publish a record after its site has been transferred", async () => {
    mocks.widgetSiteBelongsToTeam.mockResolvedValueOnce(false);
    const response = await send(appFor(), write(endpoint + "/publish", "POST"));
    expect(response.status).toBe(404);
    expect(mocks.publishWidget).not.toHaveBeenCalled();
  });

  it("unpublishes a record and denies cross-team access", async () => {
    mocks.unpublishWidget.mockResolvedValueOnce({
      ...publishedRecord,
      status: "unpublished",
    });
    const ok = await send(appFor(), write(endpoint + "/unpublish", "POST"));
    expect(ok.status).toBe(200);
    expect(mocks.unpublishWidget).toHaveBeenCalledWith(
      expect.anything(),
      "team-a",
      uuid,
    );

    mocks.readWidget.mockResolvedValueOnce({
      ...publishedRecord,
      teamId: "team-b",
    });
    const denied = await send(appFor(), write(endpoint + "/unpublish", "POST"));
    expect(denied.status).toBe(404);
    expect(mocks.unpublishWidget).toHaveBeenCalledTimes(1);
  });

  it("does not leak an unpublish success if storage returns no record", async () => {
    mocks.unpublishWidget.mockResolvedValueOnce(null);
    const response = await send(
      appFor(),
      write(endpoint + "/unpublish", "POST"),
    );
    expect(response.status).toBe(404);
  });

  it("denies deleting a foreign-team widget without touching storage", async () => {
    mocks.readWidget.mockResolvedValueOnce({
      ...publishedRecord,
      teamId: "team-b",
    });
    const response = await send(appFor(), write(endpoint, "DELETE"));
    expect(response.status).toBe(404);
    expect(mocks.deleteWidget).not.toHaveBeenCalled();
  });

  it("preserves deletion retries when a widget record is already absent", async () => {
    mocks.readWidget.mockResolvedValueOnce(null);
    const response = await send(appFor(), write(endpoint, "DELETE"));
    expect(response.status).toBe(204);
    expect(mocks.deleteWidget).toHaveBeenCalledTimes(1);
  });

  it("refuses writes to unauthorized domains for every mutation", async () => {
    for (const [suffix, method] of [
      ["/teams/team-a/preview", "POST"],
      [endpoint, "PUT"],
      [endpoint + "/publish", "POST"],
      [endpoint + "/unpublish", "POST"],
      [endpoint, "DELETE"],
    ] as const) {
      const request = new Request(
        "https://insightflare.test/widgets" + suffix,
        {
          method,
          headers: { origin: "https://evil.test" },
        },
      );
      const response = await send(appFor(), request);
      expect(response.status).toBe(403);
    }
    expect(mocks.readWidget).not.toHaveBeenCalled();
  });
});
