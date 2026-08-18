import type * as ReactStartModule from "@tanstack/react-start";
import type * as ReactStartServerModule from "@tanstack/react-start/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DashboardServerModule from "@/lib/dashboard/server";

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactStartModule>();
  return {
    ...actual,
    createServerFn: () => {
      const callable = ((...args: unknown[]) =>
        callable.__handler(...args)) as unknown as {
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
      callable.validator = () => ({
        handler: (fn) => {
          callable.__handler = fn;
          return callable;
        },
      });
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
  getDashboardTeamContext: vi.fn(),
  getTeamSiteContext: vi.fn(),
}));

vi.mock("@/lib/edge-client", () => ({
  fetchPublicSite: vi.fn(),
}));

vi.mock("@/lib/github-releases", () => ({
  fetchGithubReleases: vi.fn(),
}));

vi.mock("@/lib/dashboard/client-request", () => ({
  publicDashboardSiteId: vi.fn((slug: string) => `public-${slug}`),
}));

import { getRequest } from "@tanstack/react-start/server";

import {
  loadDashboardRoot,
  loadDashboardSite,
  loadDashboardTeam,
  loadRequestOrigin,
  loadShareSite,
  loadVersionReleases,
} from "@/lib/dashboard/route-data";
import { fetchPublicSite } from "@/lib/edge-client";
import { fetchGithubReleases } from "@/lib/github-releases";

function headersOf(init: Record<string, string>) {
  return {
    headers: {
      get: (name: string) => init[name] ?? null,
    },
  } as unknown as Request;
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
});
