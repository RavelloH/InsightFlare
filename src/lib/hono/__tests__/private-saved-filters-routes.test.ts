import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as QueryCoreModule from "@/lib/edge/query/core";
import { resolvePrivateSiteForSession } from "@/lib/edge/query/core";
import { handleSavedFilters } from "@/lib/edge/saved-filters";
import { privateSavedFilterRoutes } from "@/lib/hono/routes/private/saved-filters";
import type { AppEnv } from "@/lib/hono/types";

vi.mock("@/lib/edge/saved-filters", () => ({
  handleSavedFilters: vi.fn(),
}));

vi.mock("@/lib/edge/query/core", async (importOriginal) => {
  const actual = await importOriginal<typeof QueryCoreModule>();
  return { ...actual, resolvePrivateSiteForSession: vi.fn() };
});

const env = { DB: {} };
const session = {
  userId: "user-1",
  username: "owner",
  displayName: "Owner",
  systemRole: "user" as const,
  exp: 9_999_999_999,
};
const ctx = {
  passThroughOnException: vi.fn(),
  waitUntil: vi.fn(),
} as unknown as ExecutionContext;

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("/api/private/*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/api/private/saved-filters", privateSavedFilterRoutes);
  return app;
}

describe("Hono private saved-filter routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolvePrivateSiteForSession).mockResolvedValue({
      id: "site-1",
      name: "Site",
      domain: "app.test",
    });
    vi.mocked(handleSavedFilters).mockResolvedValue(new Response("ok"));
  });

  it("resolves the private site and forwards collection requests", async () => {
    const response = await createApp().fetch(
      new Request("https://app.test/api/private/saved-filters?siteId=site-1"),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(handleSavedFilters).toHaveBeenCalledWith(expect.any(Request), env, {
      siteId: "site-1",
      session,
      filterId: undefined,
    });
  });

  it("forwards item identifiers for owner mutations", async () => {
    const response = await createApp().fetch(
      new Request(
        "https://app.test/api/private/saved-filters/filter-1?siteId=site-1",
        { method: "DELETE" },
      ),
      env as never,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(handleSavedFilters).toHaveBeenCalledWith(expect.any(Request), env, {
      siteId: "site-1",
      session,
      filterId: "filter-1",
    });
  });
});
