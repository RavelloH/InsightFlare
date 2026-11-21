import { describe, expect, it, vi } from "vitest";

import { handleE2eFlushAdmin } from "@/lib/edge/admin/system/handler";
import type { Env } from "@/lib/edge/types";

function fixture(found = true, doStatus = 200) {
  const stmt = {
    bind: vi.fn(),
    first: vi.fn().mockResolvedValue(found ? { id: "site-1" } : null),
  };
  stmt.bind.mockReturnValue(stmt);
  const prepare = vi.fn().mockReturnValue(stmt);
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: doStatus }));
  const idFromName = vi.fn((siteId: string) => siteId);
  const get = vi.fn().mockReturnValue({ fetch });
  const env = {
    DB: { prepare },
    INGEST_DO: { idFromName, get },
  } as unknown as Env;
  const requireAdmin = vi.fn().mockResolvedValue({ isAdmin: true });
  const url = new URL("https://edge.test/api/private/admin/e2e/flush");
  const request = (method: "GET" | "POST", body?: object) =>
    new Request(url, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { env, prepare, fetch, idFromName, get, requireAdmin, url, request };
}

describe("E2E-only flush retained after removing legacy D1 performance queries", () => {
  it("does not expose the E2E flush route in production", async () => {
    const x = fixture();
    const response = await handleE2eFlushAdmin(
      x.request("POST", { siteId: "site-1" }),
      x.env,
      x.url,
      x.requireAdmin,
    );
    expect(response.status).toBe(404);
    expect(x.requireAdmin).not.toHaveBeenCalled();
    expect(x.prepare).not.toHaveBeenCalled();
    expect(x.get).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and non-admin requests without database work", async () => {
    const x = fixture();
    x.env.INSIGHTFLARE_E2E = "1";
    const denied = await handleE2eFlushAdmin(
      x.request("POST", { siteId: "site-1" }),
      x.env,
      x.url,
      vi.fn().mockResolvedValue({ isAdmin: false }),
    );
    expect(denied.status).toBe(403);
    const unauthorized = new Response(null, { status: 401 });
    expect(
      await handleE2eFlushAdmin(
        x.request("POST", { siteId: "site-1" }),
        x.env,
        x.url,
        vi.fn().mockResolvedValue(unauthorized),
      ),
    ).toBe(unauthorized);
    expect(x.prepare).not.toHaveBeenCalled();
    expect(x.get).not.toHaveBeenCalled();
  });

  it("rejects GET and missing site identifiers before database access", async () => {
    const x = fixture();
    x.env.INSIGHTFLARE_E2E = "1";
    const get = await handleE2eFlushAdmin(
      x.request("GET"),
      x.env,
      x.url,
      x.requireAdmin,
    );
    expect(get.status).toBe(405);
    const empty = await handleE2eFlushAdmin(
      x.request("POST", {}),
      x.env,
      x.url,
      x.requireAdmin,
    );
    expect(empty.status).toBe(400);
    expect(x.prepare).not.toHaveBeenCalled();
  });

  it("returns not found without touching a DO when the site is missing", async () => {
    const x = fixture(false);
    x.env.INSIGHTFLARE_E2E = "1";
    const response = await handleE2eFlushAdmin(
      x.request("POST", { siteId: "not-found" }),
      x.env,
      x.url,
      x.requireAdmin,
    );
    expect(response.status).toBe(404);
    expect(x.get).not.toHaveBeenCalled();
  });

  it("flushes only the specified site's DO in the isolated E2E environment", async () => {
    const x = fixture();
    x.env.INSIGHTFLARE_E2E = "1";
    const response = await handleE2eFlushAdmin(
      x.request("POST", { siteId: "site-1" }),
      x.env,
      x.url,
      x.requireAdmin,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { flushed: true, siteId: "site-1" },
    });
    expect(x.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("WHERE id=?"),
    );
    expect(x.idFromName).toHaveBeenCalledExactlyOnceWith("site-1");
    expect(x.fetch).toHaveBeenCalledWith(
      "https://ingest.internal/flush?force=1",
      { method: "POST" },
    );
  });

  it("returns a safe failure status when the DO refuses an E2E flush", async () => {
    const x = fixture(true, 500);
    x.env.INSIGHTFLARE_E2E = "1";
    const response = await handleE2eFlushAdmin(
      x.request("POST", { siteId: "site-1" }),
      x.env,
      x.url,
      x.requireAdmin,
    );
    expect(response.status).toBe(502);
  });
});
