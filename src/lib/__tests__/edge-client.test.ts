import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionToken } from "@/lib/auth";
import { dashboardFilterDocumentFromPresentation } from "@/lib/dashboard/filter-state";
import {
  addAdminMember,
  createAdminSite,
  createAdminTeam,
  createAdminUser,
  createNotificationRule,
  deleteNotificationRule,
  fetchAdminMe,
  fetchAdminMembers,
  fetchAdminScriptSnippet,
  fetchAdminSiteConfig,
  fetchAdminSites,
  fetchAdminTeams,
  fetchAdminUsers,
  fetchNotificationEmailConfig,
  fetchNotificationEmailPreview,
  fetchNotificationMessages,
  fetchNotificationPreferences,
  fetchNotificationRules,
  fetchPublicOverview,
  fetchPublicPages,
  fetchPublicReferrers,
  fetchPublicSite,
  fetchPublicTrend,
  loginAdminAccount,
  markAllNotificationMessagesRead,
  markNotificationMessageRead,
  previewNotificationRule,
  removeAdminMember,
  removeAdminSite,
  removeAdminTeam,
  removeAdminUser,
  runNotificationRuleNow,
  sendNotificationTest,
  transferAdminTeamOwner,
  updateAdminMemberRole,
  updateAdminSite,
  updateAdminTeam,
  updateAdminUser,
  updateMyProfile,
  updateNotificationPreferences,
  updateNotificationRule,
  upsertAdminSiteConfig,
} from "@/lib/edge-client";
import { demoRequest } from "@/lib/realtime/mock";
import { requestHeader } from "@/lib/request-headers";

vi.mock("@/lib/auth", () => ({
  getSessionToken: vi.fn(),
}));

vi.mock("@/lib/realtime/mock", () => ({
  demoRequest: vi.fn(),
}));

vi.mock("@/lib/request-headers", () => ({ requestHeader: vi.fn() }));

const getSessionTokenMock = vi.mocked(getSessionToken);
const demoRequestMock = vi.mocked(demoRequest);
const requestHeaderMock = vi.mocked(requestHeader);

function fetchMock() {
  return vi.mocked(fetch);
}

function lastFetchCall(): [string, RequestInit] {
  return fetchMock().mock.calls.at(-1) as [string, RequestInit];
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

describe("edge client request wrappers", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DEMO_MODE", "");
    getSessionTokenMock.mockReset();
    getSessionTokenMock.mockResolvedValue("session-token");
    demoRequestMock.mockReset();
    requestHeaderMock.mockReset();
    requestHeaderMock.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            ok: true,
            data: {
              id: "result-1",
              teamId: "team-1",
              userId: "user-1",
              siteId: "site-1",
              removed: true,
              role: "member",
              user: { id: "user-1", username: "admin" },
              teams: [{ id: "team-1" }],
            },
            interval: "day",
          }),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds public requests without session authorization", async () => {
    await fetchPublicOverview("public site", { from: 10, to: 20 });

    const [url, init] = lastFetchCall();
    const headers = init.headers as Headers;

    expect(url).toBe(
      "http://127.0.0.1:8787/api/public/share/public%20site/overview?from=10&to=20",
    );
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(headers.has("authorization")).toBe(false);
    expect(getSessionTokenMock).not.toHaveBeenCalled();
  });

  it("unwraps public site metadata and rejects missing public sites", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        data: {
          id: "site-1",
          slug: "public-site",
          name: "Public Site",
          domain: "example.test",
        },
      }),
    );

    await expect(fetchPublicSite("public site")).resolves.toEqual({
      id: "site-1",
      slug: "public-site",
      name: "Public Site",
      domain: "example.test",
    });
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/public/share/public%20site/site",
    );

    fetchMock().mockResolvedValueOnce(jsonResponse({ ok: false, data: null }));
    await expect(fetchPublicSite("missing")).rejects.toThrow(
      "Public site not found",
    );
  });

  it("encodes public slugs and query params", async () => {
    await fetchPublicOverview("public/site?draft=true", { from: 0, to: 1 });

    const [url] = lastFetchCall();

    expect(url).toBe(
      "http://127.0.0.1:8787/api/public/share/public%2Fsite%3Fdraft%3Dtrue/overview?from=0&to=1",
    );
  });

  it("adds session authorization for private GET requests and serializes filters", async () => {
    await fetchAdminTeams("user-1");

    const [firstUrl, init] = lastFetchCall();
    let url = firstUrl;
    const headers = init.headers as Headers;
    expect(url).toBe(
      "http://127.0.0.1:8787/api/private/admin/teams?userId=user-1",
    );
    expect(headers.get("authorization")).toBe("Bearer session-token");

    await fetchPublicTrend("slug", { from: 1, to: 2 });
    [url] = lastFetchCall();
    expect(url).toBe(
      "http://127.0.0.1:8787/api/public/share/slug/trend?from=1&to=2&interval=day",
    );

    await fetchPublicPages("slug", { from: 1, to: 2 });
    [url] = lastFetchCall();
    expect(url).toBe(
      "http://127.0.0.1:8787/api/public/share/slug/pages?from=1&to=2&limit=8",
    );

    await fetchPublicReferrers("slug", { from: 1, to: 2 });
    [url] = lastFetchCall();
    expect(url).toBe(
      "http://127.0.0.1:8787/api/public/share/slug/referrers?from=1&to=2&limit=8",
    );
  });

  it("serializes supported public dashboard filters", async () => {
    const filters = dashboardFilterDocumentFromPresentation({
      country: "US",
      device: "desktop",
      browser: "Chrome",
      path: "/docs",
      title: "Docs",
      hostname: "example.com",
      entry: "/entry",
      exit: "/exit",
      sourceDomain: "search.example",
      clientBrowser: "Chrome",
      clientOsVersion: "Windows 11",
      clientDeviceType: "desktop",
      clientLanguage: "en-US",
      clientScreenSize: "1920x1080",
      geoContinent: "NA",
      geoTimezone: "America/Los_Angeles",
    });
    await fetchPublicOverview("slug", {
      from: 1,
      to: 2,
      filters,
    });

    const [url] = lastFetchCall();
    const params = new URL(url).searchParams;

    expect(params.get("from")).toBe("1");
    expect(params.get("to")).toBe("2");
    expect(params.get("filter[geo.country]")).toBe("us");
    expect(params.get("filter[client.deviceType]")).toBe("desktop");
    expect(params.get("filter[client.browser]")).toBe("Chrome");
    expect(params.get("filter[page.path]")).toBe("/docs");
    expect(params.get("filter[page.title]")).toBe("Docs");
    expect(params.get("filter[page.hostname]")).toBe("example.com");
    expect(params.get("filter[session.entryPath]")).toBe("/entry");
    expect(params.get("filter[session.exitPath]")).toBe("/exit");
    expect(params.get("filter[referrer.domain]")).toBe("search.example");
    expect(params.get("filter[client.osVersion]")).toBe("Windows 11");
    expect(params.get("filter[client.language]")).toBe("en-US");
    expect(params.get("filter[client.screenSize]")).toBe("1920x1080");
    expect(params.get("filter[geo.continent]")).toBe("na");
    expect(params.get("filter[geo.timeZone]")).toBe("America/Los_Angeles");
  });

  it("omits blank public dashboard filters", async () => {
    await fetchPublicPages("slug", {
      from: 1,
      to: 2,
      filters: dashboardFilterDocumentFromPresentation({}),
    });

    const [url] = lastFetchCall();
    const params = new URL(url).searchParams;

    expect(url).toBe(
      "http://127.0.0.1:8787/api/public/share/slug/pages?from=1&to=2&limit=8",
    );
    expect(params.has("eventPayloadFilters")).toBe(false);
  });

  it("omits optional query params when they are not provided", async () => {
    await fetchAdminTeams();

    const [url] = lastFetchCall();

    expect(url).toBe("http://127.0.0.1:8787/api/private/admin/teams");
  });

  it("serializes POST and PATCH request bodies for admin wrappers", async () => {
    await createAdminTeam({ name: "Team", slug: "team" });

    let [url, init] = lastFetchCall();
    const headers = init.headers as Headers;
    expect(url).toBe("http://127.0.0.1:8787/api/private/admin/teams");
    expect(init.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "Team", slug: "team" }));

    await updateAdminTeam({ teamId: "team-1", name: "Renamed" });
    [url, init] = lastFetchCall();
    expect(url).toBe("http://127.0.0.1:8787/api/private/admin/teams");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(
      JSON.stringify({ teamId: "team-1", name: "Renamed" }),
    );

    await removeAdminTeam({ teamId: "team-1" });
    [, init] = lastFetchCall();
    expect(init.body).toBe(
      JSON.stringify({ teamId: "team-1", intent: "remove" }),
    );

    await updateAdminMemberRole({
      teamId: "team-1",
      userId: "user-1",
      role: "member",
    });
    [, init] = lastFetchCall();
    expect(init.body).toBe(
      JSON.stringify({
        teamId: "team-1",
        userId: "user-1",
        role: "member",
        intent: "update_role",
      }),
    );
  });

  it("serializes remaining admin mutation wrapper bodies", async () => {
    await loginAdminAccount({ username: "admin", password: "secret" });

    let [url, init] = lastFetchCall();
    expect(url).toBe("http://127.0.0.1:8787/api/public/session");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ username: "admin", password: "secret" }),
    );

    await updateMyProfile({
      username: "admin2",
      email: "admin2@example.test",
      currentPassword: "old-secret",
      password: "new-secret",
      timeZone: "Asia/Shanghai",
      preferredLocale: "zh",
    });
    [url, init] = lastFetchCall();
    expect(url).toBe("http://127.0.0.1:8787/api/private/admin/profile");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        username: "admin2",
        email: "admin2@example.test",
        currentPassword: "old-secret",
        password: "new-secret",
        timeZone: "Asia/Shanghai",
        preferredLocale: "zh",
      }),
    );

    await transferAdminTeamOwner({
      teamId: "team-1",
      newOwnerUserId: "user-2",
    });
    [, init] = lastFetchCall();
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(
      JSON.stringify({
        teamId: "team-1",
        newOwnerUserId: "user-2",
        intent: "transfer_owner",
      }),
    );

    await removeAdminSite({ siteId: "site-1" });
    [, init] = lastFetchCall();
    expect(init.body).toBe(
      JSON.stringify({ siteId: "site-1", intent: "remove" }),
    );

    await removeAdminUser({ userId: "user-1" });
    [, init] = lastFetchCall();
    expect(init.body).toBe(
      JSON.stringify({ userId: "user-1", intent: "remove" }),
    );

    await removeAdminMember({ teamId: "team-1", userId: "user-1" });
    [, init] = lastFetchCall();
    expect(init.body).toBe(
      JSON.stringify({ teamId: "team-1", userId: "user-1" }),
    );
  });

  it("unwraps data for the remaining admin wrappers", async () => {
    await fetchAdminSites("team-1");
    await createAdminSite({
      teamId: "team-1",
      name: "Docs",
      domain: "docs.example.test",
      publicEnabled: true,
    });
    await updateAdminSite({ siteId: "site-1", name: "Docs" });
    await removeAdminSite({ siteId: "site-1" });
    await fetchAdminMembers("team-1");
    await addAdminMember({
      teamId: "team-1",
      identifier: "user@example.test",
      role: "member",
    });
    await removeAdminMember({ teamId: "team-1", userId: "user-1" });
    await fetchAdminSiteConfig("site-1");
    await upsertAdminSiteConfig({
      siteId: "site-1",
      config: { trackingStrength: "smart" },
    });
    await fetchAdminScriptSnippet("site-1");
    await loginAdminAccount({ username: "admin", password: "secret" });
    await fetchAdminMe();
    await fetchAdminUsers();
    await createAdminUser({
      username: "new-user",
      email: "new@example.test",
      password: "supersecret",
      systemRole: "user",
    });
    await updateAdminUser({ userId: "user-1", email: "new@example.test" });
    await removeAdminUser({ userId: "user-1" });
    await updateMyProfile({ name: "Admin User", timeZone: "Asia/Shanghai" });
    await transferAdminTeamOwner({
      teamId: "team-1",
      newOwnerUserId: "user-2",
    });

    expect(fetchMock()).toHaveBeenCalledTimes(18);
    const urls = fetchMock().mock.calls.map(([url]) => String(url));
    expect(urls).toContain(
      "http://127.0.0.1:8787/api/private/admin/sites?teamId=team-1",
    );
    expect(urls).toContain(
      "http://127.0.0.1:8787/api/private/admin/script-snippet?siteId=site-1",
    );
    expect(urls).toContain("http://127.0.0.1:8787/api/private/session");
    expect(urls).toContain("http://127.0.0.1:8787/api/private/admin/users");
  });

  it("serializes notification rule and preference wrappers", async () => {
    await fetchNotificationRules({ teamId: "team-1" });
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/private/admin/notification-rules?teamId=team-1",
    );

    await fetchNotificationEmailConfig();
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/private/admin/notification-email",
    );

    await createNotificationRule({
      teamId: "team-1",
      siteId: null,
      name: "Daily report",
      enabled: true,
      schedule: { kind: "daily" },
      condition: { metric: "views" },
      recipient: { mode: "creator" },
    });
    let [, init] = lastFetchCall();
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        teamId: "team-1",
        siteId: null,
        name: "Daily report",
        enabled: true,
        schedule: { kind: "daily" },
        condition: { metric: "views" },
        recipient: { mode: "creator" },
      }),
    );

    await updateNotificationRule({ ruleId: "rule-1", enabled: false });
    [, init] = lastFetchCall();
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(
      JSON.stringify({ ruleId: "rule-1", enabled: false }),
    );

    await deleteNotificationRule({ ruleId: "rule 1" });
    let [url] = lastFetchCall();
    expect(url).toBe(
      "http://127.0.0.1:8787/api/private/admin/notification-rules?id=rule+1",
    );
    expect(lastFetchCall()[1].method).toBe("DELETE");

    await previewNotificationRule({ ruleId: "rule-1" });
    expect(lastFetchCall()[1].method).toBe("POST");

    await runNotificationRuleNow({ ruleId: "rule-1" });
    [url, init] = lastFetchCall();
    expect(url).toBe(
      "http://127.0.0.1:8787/api/private/admin/notification-rules/run",
    );
    expect(init.body).toBe(JSON.stringify({ ruleId: "rule-1" }));

    await fetchNotificationPreferences();
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/private/notifications/preferences",
    );

    const controller = new AbortController();
    await fetchNotificationPreferences({ signal: controller.signal });
    expect(lastFetchCall()[1].signal).toBe(controller.signal);

    await updateNotificationPreferences({
      email: true,
      attention: { alertsCreateUnread: false },
    });
    [, init] = lastFetchCall();
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(
      JSON.stringify({
        email: true,
        attention: { alertsCreateUnread: false },
      }),
    );
  });

  it("normalizes notification message wrapper responses", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        data: {
          messages: [{ id: "msg-1" }],
          unreadAttentionCount: 5,
        },
      }),
    );
    await expect(
      fetchNotificationMessages({
        teamId: "team-1",
        siteId: "site-1",
        type: "report",
        severity: "warning",
        unread: true,
        locale: "zh",
        limit: 25,
      }),
    ).resolves.toEqual({
      messages: [{ id: "msg-1" }],
      unreadAttentionCount: 5,
    });
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/private/notifications?teamId=team-1&siteId=site-1&type=report&severity=warning&unread=1&locale=zh&limit=25",
    );

    const controller = new AbortController();
    fetchMock().mockResolvedValueOnce(jsonResponse({ ok: true, data: null }));
    await fetchNotificationMessages({ signal: controller.signal });
    expect(lastFetchCall()[1].signal).toBe(controller.signal);

    fetchMock().mockResolvedValueOnce(jsonResponse({ ok: true, data: null }));
    await expect(fetchNotificationMessages({})).resolves.toEqual({
      messages: [],
      unreadAttentionCount: 0,
    });

    await markNotificationMessageRead({ messageId: "msg/1", locale: "zh" });
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/private/notifications/msg%2F1",
    );
    expect(lastFetchCall()[1].body).toBe(
      JSON.stringify({ read: true, locale: "zh" }),
    );

    await markAllNotificationMessagesRead({ teamId: "team-1" });
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/private/notifications",
    );
    expect(lastFetchCall()[1].body).toBe(
      JSON.stringify({ teamId: "team-1", read: true }),
    );

    await sendNotificationTest({ teamId: "team-1", siteId: "site-1" });
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/private/admin/notification-test",
    );
    expect(lastFetchCall()[1].body).toBe(
      JSON.stringify({ teamId: "team-1", siteId: "site-1" }),
    );
  });

  it("normalizes incomplete notification preference responses", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        data: {
          email: false,
        },
      }),
    );

    await expect(fetchNotificationPreferences()).resolves.toEqual({
      inApp: true,
      email: false,
      webPush: false,
      attention: {
        reportsCreateUnread: false,
        milestonesCreateUnread: false,
        alertsCreateUnread: true,
      },
    });
  });

  it("fetches notification email previews in every supported format", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        data: {
          subject: "Demo subject",
          html: "<p>Demo</p>",
          text: "Demo",
        },
      }),
    );

    await expect(
      fetchNotificationEmailPreview({
        type: "report",
        locale: "en",
        format: "json",
      }),
    ).resolves.toEqual({
      subject: "Demo subject",
      html: "<p>Demo</p>",
      text: "Demo",
    });
    expect(new URL(lastFetchCall()[0]).searchParams.get("format")).toBe("json");

    fetchMock().mockResolvedValueOnce(new Response("<p>HTML</p>"));
    await expect(
      fetchNotificationEmailPreview({
        type: "health",
        locale: "zh",
        format: "html",
      }),
    ).resolves.toBe("<p>HTML</p>");

    fetchMock().mockResolvedValueOnce(new Response("plain text"));
    await expect(
      fetchNotificationEmailPreview({
        type: "threshold",
        locale: "en",
        format: "text",
      }),
    ).resolves.toBe("plain text");
  });

  it("throws descriptive errors for failed notification email previews", async () => {
    fetchMock().mockResolvedValueOnce(
      new Response("preview denied", { status: 403 }),
    );

    await expect(
      fetchNotificationEmailPreview({
        type: "test",
        locale: "en",
        format: "html",
      }),
    ).rejects.toThrow("Email preview failed (403): preview denied");
  });

  it("throws descriptive errors for non-OK edge responses", async () => {
    fetchMock().mockResolvedValueOnce(new Response("denied", { status: 403 }));

    await expect(fetchAdminUsers()).rejects.toThrow(
      "Edge API failed (403 GET /api/private/admin/users): denied",
    );
  });

  it("includes JSON API error bodies in non-OK edge response errors", async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ error: "invalid_request", reason: "Missing team" }, 400),
    );

    await expect(fetchAdminSites("team-1")).rejects.toThrow(
      'Edge API failed (400 GET /api/private/admin/sites): {"error":"invalid_request","reason":"Missing team"}',
    );
  });

  it("propagates network failures from fetch", async () => {
    fetchMock().mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(fetchAdminUsers()).rejects.toThrow("fetch failed");
  });

  it("continues without authorization when the session token is unavailable", async () => {
    getSessionTokenMock.mockRejectedValueOnce(new Error("outside request"));

    await fetchAdminMe();

    const [, init] = lastFetchCall();
    const headers = init.headers as Headers;
    expect(headers.has("authorization")).toBe(false);
  });

  it("continues without authorization when no session token is returned", async () => {
    getSessionTokenMock.mockResolvedValueOnce("");

    await fetchAdminMe();

    const [, init] = lastFetchCall();
    const headers = init.headers as Headers;
    expect(headers.has("authorization")).toBe(false);
  });

  it("derives the edge base URL from forwarded server headers", async () => {
    requestHeaderMock.mockImplementation(async (name) => {
      if (name === "x-forwarded-host") return "dashboard.example.test";
      if (name === "x-forwarded-proto") return "https";
      return null;
    });

    await fetchAdminUsers();

    const [url] = lastFetchCall();
    expect(url).toBe("https://dashboard.example.test/api/private/admin/users");
  });

  it("uses https for non-local server hosts when forwarded proto is absent", async () => {
    requestHeaderMock.mockImplementation(async (name) =>
      name === "host" ? "app.test" : null,
    );

    await fetchAdminUsers();

    const [url] = lastFetchCall();
    expect(url).toBe("https://app.test/api/private/admin/users");
  });

  it("falls back when server headers do not include a host", async () => {
    requestHeaderMock.mockResolvedValue(null);

    await fetchAdminUsers();

    const [url] = lastFetchCall();
    expect(url).toBe("http://127.0.0.1:8787/api/private/admin/users");
  });

  it("uses http for localhost server headers and falls back when headers fail", async () => {
    requestHeaderMock.mockImplementation(async (name) =>
      name === "host" ? "localhost:3000" : null,
    );

    await fetchAdminUsers();
    expect(lastFetchCall()[0]).toBe(
      "http://localhost:3000/api/private/admin/users",
    );

    requestHeaderMock.mockRejectedValue(new Error("outside request"));
    await fetchAdminUsers();
    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:8787/api/private/admin/users",
    );
  });

  it("uses http for 127.0.0.1 server hosts when forwarded proto is absent", async () => {
    requestHeaderMock.mockImplementation(async (name) =>
      name === "host" ? "127.0.0.1:3000" : null,
    );

    await fetchAdminUsers();

    expect(lastFetchCall()[0]).toBe(
      "http://127.0.0.1:3000/api/private/admin/users",
    );
  });

  it("delegates to the realtime demo handler in demo mode", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    demoRequestMock.mockReturnValue({
      ok: true,
      data: [{ bucket: 1 }],
    });

    const result = await fetchPublicTrend("demo-site", { from: 1, to: 2 });

    expect(result).toEqual({ ok: true, data: [{ bucket: 1 }] });
    expect(demoRequestMock).toHaveBeenCalledWith({
      path: "/api/public/share/demo-site/trend",
      method: undefined,
      params: { from: 1, to: 2, interval: "day" },
      body: undefined,
    });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("keeps admin mutations on the server service in demo mode", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        data: { id: "team-1", name: "Team" },
      }),
    );

    const result = await createAdminTeam({ name: "Team", slug: "team" });

    expect(result).toEqual({ id: "team-1", name: "Team" });
    expect(demoRequestMock).not.toHaveBeenCalled();
    expect(lastFetchCall()).toMatchObject([
      "http://127.0.0.1:8787/api/private/admin/teams",
      {
        method: "POST",
        body: JSON.stringify({ name: "Team", slug: "team" }),
      },
    ]);
    expect(getSessionTokenMock).toHaveBeenCalled();
  });

  it("fetches notification email previews through the API in demo mode", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    const preview = {
      subject: "Demo",
      html: "<p>Demo</p>",
      text: "Demo",
    };
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ ok: true, data: preview }),
    );

    await expect(
      fetchNotificationEmailPreview({
        type: "test",
        locale: "en",
        format: "json",
      }),
    ).resolves.toEqual(preview);

    const [url, init] = lastFetchCall();
    expect(url).toBe(
      "http://127.0.0.1:8787/api/private/admin/notification-email-preview?type=test&locale=en&format=json",
    );
    expect((init.headers as Headers).get("authorization")).toBe(
      "Bearer session-token",
    );
    expect(demoRequestMock).not.toHaveBeenCalled();
  });

  it("wires the edge-client filter helper into at least one exported request wrapper", () => {
    const source = readFileSync("src/lib/edge-client.ts", "utf8");
    const callSites = source.match(/\bwithFilters\s*\(/g) ?? [];

    expect(callSites.length).toBeGreaterThan(1);
  });
});
