import type * as ReactStartModule from "@tanstack/react-start";
import type * as ReactStartServerModule from "@tanstack/react-start/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DashboardServerModule from "@/lib/dashboard/server";

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactStartModule>();
  return {
    ...actual,
    createServerFn: () => {
      let validatorFn: ((value: unknown) => unknown) | null = null;
      const callable = ((...args: unknown[]) =>
        callable.__handler(
          ...(validatorFn && args[0] && typeof args[0] === "object"
            ? [
                {
                  ...(args[0] as Record<string, unknown>),
                  data: validatorFn((args[0] as Record<string, unknown>).data),
                },
                ...args.slice(1),
              ]
            : args),
        )) as unknown as {
        __handler: (...args: unknown[]) => unknown;
        handler: (fn: (...args: unknown[]) => unknown) => unknown;
        validator: (v: unknown) => {
          handler: (fn: (...args: unknown[]) => unknown) => unknown;
        };
      };
      callable.__handler = () => undefined as unknown;
      callable.handler = (fn) => {
        callable.__handler = fn;
        return callable;
      };
      callable.validator = (v) => {
        validatorFn = v as (value: unknown) => unknown;
        return {
          handler: (fn) => {
            callable.__handler = fn;
            return callable;
          },
        };
      };
      return callable as never;
    },
  };
});

vi.mock("@tanstack/react-start/server", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactStartServerModule>();
  return { ...actual, getRequest: vi.fn() };
});

vi.mock("@/lib/dashboard/server", () => ({
  getDashboardRootContext: vi.fn(),
  getDashboardTeamSites: vi.fn(),
  getDashboardTeamContext: vi.fn(),
  getTeamSiteContext: vi.fn(),
  readDashboardAdmin: vi.fn(),
}));

vi.mock("@/lib/dashboard/query-preferences", () => ({
  resolveDashboardInitialWindow: vi.fn(),
}));

vi.mock("@/lib/dashboard/server-query", () => ({
  resolveTeamDashboardRequest: vi.fn(),
}));

vi.mock("@/lib/edge/analytics/providers/d1/operations/team-dashboard", () => ({
  readTeamDashboard: vi.fn(),
}));

vi.mock("@/lib/edge/runtime", () => ({
  resolveEdgeRuntime: vi.fn(),
}));

vi.mock("@/lib/edge-client", () => ({
  fetchPublicSite: vi.fn(),
  normalizeNotificationPreferencesData: vi.fn((value: unknown) => value),
}));

vi.mock("@/lib/github-releases", () => ({
  fetchGithubReleases: vi.fn(),
}));

vi.mock("@/lib/dashboard/client-request", () => ({
  publicDashboardSiteId: vi.fn((slug: string) => `public-${slug}`),
}));

import { getRequest } from "@tanstack/react-start/server";

import { resolveDashboardInitialWindow } from "@/lib/dashboard/query-preferences";
import {
  loadAccountNotificationPreferences,
  loadAdminTeamsInitialData,
  loadAdminUsersInitialData,
  loadApiKeysInitialData,
  loadDashboardInitialWindow,
  loadDashboardRoot,
  loadDashboardSite,
  loadDashboardTeam,
  loadNotificationCenterInitialData,
  loadRequestOrigin,
  loadScheduledTasksInitialData,
  loadShareSite,
  loadSiteSettingsInitialData,
  loadSystemPerformanceInitialData,
  loadSystemSettingsInitialData,
  loadTeamDashboardSnapshot,
  loadTeamManagementInitialData,
  loadTeamNotificationsInitialData,
  loadVersionReleases,
} from "@/lib/dashboard/route-data";
import {
  getDashboardTeamSites,
  readDashboardAdmin,
} from "@/lib/dashboard/server";
import { resolveTeamDashboardRequest } from "@/lib/dashboard/server-query";
import { readTeamDashboard } from "@/lib/edge/analytics/providers/d1/operations/team-dashboard";
import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import {
  fetchPublicSite,
  normalizeNotificationPreferencesData,
} from "@/lib/edge-client";
import { fetchGithubReleases } from "@/lib/github-releases";

function headersOf(init: Record<string, string>) {
  return {
    url: "https://app.test/",
    headers: {
      get: (name: string) => init[name] ?? null,
    },
  } as unknown as Request;
}

function mockAdminReads(reads: Record<string, unknown>) {
  vi.mocked(readDashboardAdmin).mockImplementation(async (route) => {
    const key = String(route);
    return Object.prototype.hasOwnProperty.call(reads, key)
      ? (reads[key] as never)
      : null;
  });
}

describe("Dashboard route data loaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRequest).mockReturnValue(
      headersOf({ host: "app.test" }) as never,
    );
    vi.mocked(fetchPublicSite).mockResolvedValue({
      id: "site-1",
      name: "Site",
      domain: "app.test",
    } as never);
    vi.mocked(fetchGithubReleases).mockResolvedValue([
      { tag_name: "v1.0.0", name: "v1.0.0", url: "", html_url: "" },
    ] as never);
    vi.mocked(resolveEdgeRuntime).mockResolvedValue({
      env: { DB: {} },
    } as never);
    vi.mocked(resolveTeamDashboardRequest).mockResolvedValue({
      env: { DB: {} },
      teamId: "team-1",
      allowedSiteIds: ["site-1"],
    } as never);
    vi.mocked(resolveDashboardInitialWindow).mockReturnValue({
      preset: "7d",
      from: 100,
      to: 200,
      interval: "day",
      timeZone: "Asia/Tokyo",
    });
    vi.mocked(readTeamDashboard).mockResolvedValue({
      data: { sites: [], trend: [] },
      source: "raw",
    } as never);
    vi.mocked(getDashboardTeamSites).mockResolvedValue([]);
  });

  describe("loadRequestOrigin", () => {
    it("prefers x-forwarded-host and x-forwarded-proto", async () => {
      vi.mocked(getRequest).mockReturnValue(
        headersOf({
          "x-forwarded-host": "edge.example.com",
          "x-forwarded-proto": "https",
        }) as never,
      );
      expect(loadRequestOrigin()).toBe("https://edge.example.com");
    });

    it("falls back to the host header when x-forwarded-host is absent", async () => {
      vi.mocked(getRequest).mockReturnValue(
        headersOf({ host: "app.test", "x-forwarded-proto": "http" }) as never,
      );
      expect(loadRequestOrigin()).toBe("http://app.test");
    });

    it("returns empty when no host header is present", async () => {
      vi.mocked(getRequest).mockReturnValue(headersOf({}) as never);
      expect(loadRequestOrigin()).toBe("");
    });

    it("treats a plain non-localhost host without forwarded proto as https", async () => {
      vi.mocked(getRequest).mockReturnValue(
        headersOf({ host: "app.test" }) as never,
      );
      expect(loadRequestOrigin()).toBe("https://app.test");
    });

    it("treats localhost hosts as http", async () => {
      vi.mocked(getRequest).mockReturnValue(
        headersOf({ host: "localhost:5173" }) as never,
      );
      expect(loadRequestOrigin()).toBe("http://localhost:5173");
    });

    it("treats 127.0.0.1 hosts as http", async () => {
      vi.mocked(getRequest).mockReturnValue(
        headersOf({ host: "127.0.0.1:8787" }) as never,
      );
      expect(loadRequestOrigin()).toBe("http://127.0.0.1:8787");
    });
  });

  it("derives the initial dashboard window from the request cookie", () => {
    const window = loadDashboardInitialWindow();
    expect(resolveDashboardInitialWindow).toHaveBeenCalledWith(null);
    expect(window).toMatchObject({
      preset: "7d",
      interval: "day",
      timeZone: "Asia/Tokyo",
    });
  });

  describe("loadVersionReleases", () => {
    it("returns releases on success", async () => {
      await expect(loadVersionReleases()).resolves.toEqual({
        releases: [
          { tag_name: "v1.0.0", name: "v1.0.0", url: "", html_url: "" },
        ],
        error: null,
      });
    });

    it("returns an error message when the fetch throws", async () => {
      vi.mocked(fetchGithubReleases).mockRejectedValueOnce(new Error("boom"));
      const result = (await loadVersionReleases()) as {
        error: string;
        releases: [];
      };
      expect(result.error).toBe("boom");
      expect(result.releases).toEqual([]);
    });
  });

  describe("loadShareSite", () => {
    it("returns the site and public id on success", async () => {
      const result = (await loadShareSite({
        data: { slug: "demo" },
      } as never)) as {
        site: unknown;
        publicSiteId: string;
      };
      expect(result).toMatchObject({ publicSiteId: "public-demo" });
      expect(fetchPublicSite).toHaveBeenCalledWith("demo");
    });

    it("returns null when the site cannot be resolved", async () => {
      vi.mocked(fetchPublicSite).mockRejectedValueOnce(new Error("nope"));
      await expect(
        loadShareSite({ data: { slug: "missing" } } as never),
      ).resolves.toBeNull();
    });
  });

  describe("dashboard context loaders", () => {
    it("loads a typed SSR snapshot with the resolved request scope", async () => {
      const result = await loadTeamDashboardSnapshot({
        data: { teamId: "team-requested" },
      } as never);

      expect(result).toEqual({
        data: { sites: [], trend: [] },
        window: {
          from: 100,
          to: 200,
          interval: "day",
          timeZone: "Asia/Tokyo",
        },
        range: "7d",
        fetchedAt: expect.any(Number),
      });
      expect(resolveTeamDashboardRequest).toHaveBeenCalledWith({
        request: expect.anything(),
        env: { DB: {} },
        teamId: "team-requested",
      });
      expect(readTeamDashboard).toHaveBeenCalledWith({
        env: { DB: {} },
        teamId: "team-1",
        window: {
          startMs: 100,
          endExclusiveMs: 200,
          nowMs: 200,
          timeZone: "Asia/Tokyo",
        },
        interval: "day",
        allowedSiteIds: ["site-1"],
        preloadedSites: [],
      });
    });

    it("keeps typed operation failures as SSR errors", async () => {
      vi.mocked(readTeamDashboard).mockRejectedValueOnce(new Error("internal"));

      await expect(
        loadTeamDashboardSnapshot({
          data: { teamId: "team-requested" },
        } as never),
      ).rejects.toThrow("internal");
      expect(readTeamDashboard).toHaveBeenCalled();
    });

    it("loads the dashboard root context", async () => {
      const server =
        (await import("@/lib/dashboard/server")) as typeof DashboardServerModule;
      vi.mocked(server.getDashboardRootContext).mockResolvedValue({
        ok: true,
      } as never);
      await expect(loadDashboardRoot()).resolves.toEqual({ ok: true });
    });

    it("loads the team context with the team slug", async () => {
      const server =
        (await import("@/lib/dashboard/server")) as typeof DashboardServerModule;
      vi.mocked(server.getDashboardTeamContext).mockResolvedValue({
        team: "t",
      } as never);
      await expect(
        loadDashboardTeam({ data: { teamSlug: "acme" } } as never),
      ).resolves.toEqual({ team: "t" });
      expect(server.getDashboardTeamContext).toHaveBeenCalledWith("acme");
    });

    it("loads the site context with team and site slugs", async () => {
      const server =
        (await import("@/lib/dashboard/server")) as typeof DashboardServerModule;
      vi.mocked(server.getTeamSiteContext).mockResolvedValue({
        site: "s",
      } as never);
      await expect(
        loadDashboardSite({
          data: { teamSlug: "acme", siteSlug: "web" },
        } as never),
      ).resolves.toEqual({ site: "s" });
      expect(server.getTeamSiteContext).toHaveBeenCalledWith("acme", "web");
    });
  });

  describe("management initial data loaders", () => {
    it("loads team management data without exposing invite secrets", async () => {
      mockAdminReads({
        members: [{ id: "member-1" }],
        sites: [{ id: "site-1" }],
        "team-invites": [
          {
            id: "invite-1",
            email: "member@example.com",
            payload: { teamRole: "member" },
            code: "secret-code",
            url: "https://app.test/invite/secret-code",
            createdByUserId: "user-1",
            createdAt: 1,
            expiresAt: 2,
            usedAt: null,
            usedByUserId: "",
            revokedAt: null,
            status: "active",
          },
        ],
      });

      const result = await loadTeamManagementInitialData({
        data: { teamId: "team-1" },
      } as never);

      expect(result).toMatchObject({
        members: [{ id: "member-1" }],
        sites: [{ id: "site-1" }],
        invites: [{ id: "invite-1", email: "member@example.com" }],
        fetchedAt: expect.any(Number),
      });
      expect(result?.invites[0]).not.toHaveProperty("code");
      expect(result?.invites[0]).not.toHaveProperty("url");
    });

    it("loads normalized site settings and the install snippet", async () => {
      vi.mocked(getRequest).mockReturnValue({
        ...headersOf({}),
        url: "https://edge.example/zh/app/site/settings",
      } as never);
      mockAdminReads({
        "site-config": {
          trackingStrength: "strong",
          trackQueryParams: "true",
          trackHash: false,
          autoTrackOutboundLinks: false,
          domainWhitelist: "edge.example",
          pathBlacklist: "/private",
          ignoreDoNotTrack: true,
          performanceSampleRate: "80",
        },
        "script-snippet": { snippet: "<script data-test />" },
      });

      const result = await loadSiteSettingsInitialData({
        data: { siteId: "site-1" },
      } as never);

      expect(result).toMatchObject({
        config: {
          trackingStrength: "strong",
          trackQueryParams: true,
          performanceSampleRate: 80,
        },
        scriptSnippet: "<script data-test />",
        origin: "https://edge.example",
        fetchedAt: expect.any(Number),
      });
    });

    it("loads API keys, teams, and users snapshots", async () => {
      mockAdminReads({ "api-keys": [{ id: "key-1" }] });
      await expect(
        loadApiKeysInitialData({ data: { teamId: "team-1" } } as never),
      ).resolves.toMatchObject({
        keys: [{ id: "key-1" }],
        fetchedAt: expect.any(Number),
      });

      mockAdminReads({ teams: [{ id: "team-1" }] });
      await expect(loadAdminTeamsInitialData()).resolves.toMatchObject({
        teams: [{ id: "team-1" }],
        fetchedAt: expect.any(Number),
      });

      mockAdminReads({ users: [{ id: "user-1" }] });
      await expect(loadAdminUsersInitialData()).resolves.toMatchObject({
        users: [{ id: "user-1" }],
        fetchedAt: expect.any(Number),
      });
    });

    it("serializes team notifications and computes email availability", async () => {
      mockAdminReads({
        "notification-rules": [
          {
            id: "rule-1",
            schedule: { type: "daily" },
            condition: { field: "views" },
            recipient: { type: "team" },
            state: { lastStatus: "ok" },
          },
        ],
        sites: [{ id: "site-1" }],
        members: [{ id: "member-1" }],
        "notification-email": {
          enabled: true,
          provider: "resend",
          fromEmail: "alerts@example.com",
          resend: { configured: true },
        },
      });

      const result = await loadTeamNotificationsInitialData({
        data: { teamId: "team-1" },
      } as never);

      expect(result).toMatchObject({
        rules: [
          {
            id: "rule-1",
            schedule: { type: "daily" },
            condition: { field: "views" },
            recipient: { type: "team" },
            state: { lastStatus: "ok" },
          },
        ],
        emailConfigured: true,
        fetchedAt: expect.any(Number),
      });
    });

    it("serializes notification center messages with the requested scope", async () => {
      mockAdminReads({
        notifications: {
          messages: [
            {
              id: "message-1",
              data: { source: "test" },
              channels: { inApp: true },
              deliveryResults: { inApp: "created" },
            },
          ],
          unreadAttentionCount: 3,
        },
      });

      const result = await loadNotificationCenterInitialData({
        data: { teamId: "team-1", ruleId: "rule-1", locale: "zh" },
      } as never);

      expect(result).toMatchObject({
        messages: [
          {
            id: "message-1",
            data: { source: "test" },
            channels: { inApp: true },
            deliveryResults: { inApp: "created" },
          },
        ],
        unreadAttentionCount: 3,
        fetchedAt: expect.any(Number),
      });
      expect(readDashboardAdmin).toHaveBeenCalledWith("notifications", {
        teamId: "team-1",
        ruleId: "rule-1",
        locale: "zh",
        limit: 80,
      });
    });

    it("normalizes account preferences and loads system settings", async () => {
      const preferences = {
        inApp: true,
        email: false,
        webPush: false,
        attention: {
          reportsCreateUnread: true,
          milestonesCreateUnread: false,
          alertsCreateUnread: true,
        },
      };
      mockAdminReads({ "notifications/preferences": preferences });

      await expect(loadAccountNotificationPreferences()).resolves.toEqual({
        preferences,
        fetchedAt: expect.any(Number),
      });
      expect(normalizeNotificationPreferencesData).toHaveBeenCalledWith(
        preferences,
      );

      mockAdminReads({
        "bot-analytics-config": { enabled: true },
        "login-turnstile": { enabled: true },
        "notification-email": { enabled: true },
      });
      await expect(loadSystemSettingsInitialData()).resolves.toMatchObject({
        botAnalytics: { enabled: true },
        loginTurnstile: { enabled: true },
        notificationEmail: { enabled: true },
        fetchedAt: expect.any(Number),
      });
    });

    it("loads the first scheduled-task page and system performance snapshot", async () => {
      const scheduledTasks = {
        ok: true,
        generatedAt: 100,
        retentionDays: 30,
        tasks: [],
        runs: [],
        runsMeta: {
          page: 1,
          pageSize: 50,
          returned: 0,
          hasMore: false,
          nextPage: null,
        },
        selectedRun: null,
        logs: [],
        health: {
          totalRuns24h: 0,
          failedRuns24h: 0,
          partialRuns24h: 0,
          runningRuns: 0,
          staleRunningRuns: 0,
          successRate24h: null,
          lastRunAt: null,
        },
      };
      mockAdminReads({ "scheduled-tasks": scheduledTasks });

      await expect(loadScheduledTasksInitialData()).resolves.toMatchObject({
        ...scheduledTasks,
        fetchedAt: expect.any(Number),
      });
      expect(readDashboardAdmin).toHaveBeenCalledWith("scheduled-tasks", {
        page: 1,
        pageSize: 50,
      });

      const systemPerformance = {
        ok: true,
        generatedAt: 200,
        window: { minutes: 60 },
        thresholds: {},
        summary: { totalEvents: 10 },
        openVisits: { total: 2 },
        trend: [],
        topSites: [],
        slowEvents: [],
      };
      mockAdminReads({ "system-performance": systemPerformance });

      await expect(loadSystemPerformanceInitialData()).resolves.toEqual({
        data: systemPerformance,
        fetchedAt: expect.any(Number),
      });
      expect(readDashboardAdmin).toHaveBeenCalledWith("system-performance", {
        minutes: 60,
      });
    });
  });
});
