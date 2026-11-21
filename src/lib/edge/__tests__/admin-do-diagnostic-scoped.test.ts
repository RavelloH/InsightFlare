import { describe, expect, it, vi } from "vitest";

import { handleDoDiagnosticScopedAdmin } from "@/lib/edge/admin/system/do-diagnostic-handler";
import type { Env } from "@/lib/edge/types";
import type {
  DoDiagnosticScanResponse,
  DoDiagnosticSiteResponse,
} from "@/lib/system-performance";

function diagnostic(snapshotAt = 1700000000000) {
  return {
    ok: true,
    snapshotAt,
    thresholds: {
      staleMs: 1,
      timeoutMs: 2,
      hardAgedMs: 3,
      stuckFlushAttempts: 4,
    },
    visits: {
      total: 1,
      byStatus: { open: 1 },
      open: {
        total: 1,
        stale: 0,
        timedOut: 0,
        hardAged: 0,
        futureSkewed: 0,
        oldestStartedAt: null,
        newestActivityAt: null,
        futureMaxActivityAt: null,
      },
      dirty: { total: 0, stuck: 0, maxFlushAttempts: 0 },
    },
    customEvents: {
      total: 2,
      dirty: 1,
      stuck: 0,
      maxFlushAttempts: 1,
      oldestOccurredAt: null,
    },
    alarm: {
      scheduledAt: null,
      nextDueAt: null,
      nextDueKind: null,
      nextDueEntity: null,
    },
  };
}
function fixture(options?: {
  sites?: Array<{ id: string; name: string; domain: string }>;
  fails?: string[];
  corrupt?: string[];
}) {
  const sites = options?.sites ?? [
    { id: "site_a", name: "A", domain: "a.example" },
    { id: "site_b", name: "B", domain: "b.example" },
    { id: "site_c", name: "C", domain: "c.example" },
  ];
  const sql: string[] = [];
  const prepare = vi.fn((query: string) => {
    sql.push(query);
    let bindings: unknown[] = [];
    const stmt = {
      bind: vi.fn((...args: unknown[]) => {
        bindings = args;
        return stmt;
      }),
      first: vi.fn(async () => {
        if (query.includes("COUNT(*)")) return { count: sites.length };
        return sites.find((site) => site.id === bindings[0]) ?? null;
      }),
      all: vi.fn(async () => {
        const cursor = String(bindings[0] ?? "");
        const limit = Number(bindings[1] ?? sites.length);
        return {
          results: sites.filter((site) => site.id > cursor).slice(0, limit),
        };
      }),
    };
    return stmt;
  });
  const fetches = new Map<string, ReturnType<typeof vi.fn>>();
  const idFromName = vi.fn((id: string) => id);
  const get = vi.fn((id: string) => {
    let fn = fetches.get(id);
    if (!fn) {
      fn = vi.fn(async () => {
        if (options?.fails?.includes(id))
          throw new Error("Sensitive internal DO details");
        if (options?.corrupt?.includes(id)) return Response.json({ ok: true });
        return Response.json(diagnostic());
      });
      fetches.set(id, fn);
    }
    return { fetch: fn };
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    INGEST_DO: { idFromName, get } as unknown as DurableObjectNamespace,
  } as Env;
  const admin = vi.fn(async () => ({ isAdmin: true }));
  return { env, admin, prepare, sql, idFromName, get, fetches };
}
function req(query = "") {
  const url = new URL(
    "https://test.local/api/private/admin/do-diagnostic" + query,
  );
  return { url, request: new Request(url) };
}
describe("DO diagnostic explicit scopes", () => {
  it("requires explicit scope without opening any DO or reading site lists", async () => {
    const x = fixture();
    const { url, request } = req();
    const response = await handleDoDiagnosticScopedAdmin(
      request,
      x.env,
      url,
      x.admin,
    );
    expect(response.status).toBe(400);
    expect(x.prepare).not.toHaveBeenCalled();
    expect(x.get).not.toHaveBeenCalled();
  });
  it("checks a single known site with exactly one DO access", async () => {
    const x = fixture();
    const { url, request } = req("?scope=site&siteId=site_b");
    const response = await handleDoDiagnosticScopedAdmin(
      request,
      x.env,
      url,
      x.admin,
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as DoDiagnosticSiteResponse;
    expect(data.scope).toBe("site");
    expect(data.site.siteId).toBe("site_b");
    expect(data.site.diagnostic?.snapshotAt).toBe(1700000000000);
    expect(x.sql).toHaveLength(1);
    expect(x.sql[0]).toContain("WHERE id = ?");
    expect(x.get).toHaveBeenCalledExactlyOnceWith("site_b");
    expect(x.fetches.get("site_b")).toHaveBeenCalledTimes(1);
  });
  it("rejects unknown sites without DO fetch", async () => {
    const x = fixture();
    const { url, request } = req("?scope=site&siteId=missing");
    const response = await handleDoDiagnosticScopedAdmin(
      request,
      x.env,
      url,
      x.admin,
    );
    expect(response.status).toBe(404);
    expect(x.get).not.toHaveBeenCalled();
  });
  it("requires system admin even with an explicit site", async () => {
    const x = fixture();
    const { url, request } = req("?scope=site&siteId=site_b");
    const response = await handleDoDiagnosticScopedAdmin(
      request,
      x.env,
      url,
      vi.fn(async () => ({ isAdmin: false })),
    );
    expect(response.status).toBe(403);
    expect(x.prepare).not.toHaveBeenCalled();
    expect(x.get).not.toHaveBeenCalled();
  });
  it("paginates scan and reports unreachable sites without leaking exceptions", async () => {
    const x = fixture({ fails: ["site_b"], corrupt: ["site_c"] });
    const page1 = req("?scope=scan&limit=2");
    const res1 = await handleDoDiagnosticScopedAdmin(
      page1.request,
      x.env,
      page1.url,
      x.admin,
    );
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as DoDiagnosticScanResponse;
    expect(data1.scope).toBe("scan");
    expect(data1.totalSites).toBe(3);
    expect(data1.processedSites).toBe(2);
    expect(data1.reachableSites).toBe(1);
    expect(data1.unreachableSites).toBe(1);
    expect(data1.partial).toBe(true);
    expect(data1.nextCursor).toBe("site_b");
    expect(data1.sites[1].error).toBe("unavailable");
    expect(JSON.stringify(data1)).not.toContain("Sensitive internal");
    const page2 = req("?scope=scan&cursor=site_b&limit=2");
    const res2 = await handleDoDiagnosticScopedAdmin(
      page2.request,
      x.env,
      page2.url,
      x.admin,
    );
    const data2 = (await res2.json()) as DoDiagnosticScanResponse;
    expect(data2.processedSites).toBe(1);
    expect(data2.hasMore).toBe(false);
    expect(data2.nextCursor).toBe(null);
    expect(data2.sites[0].error).toBe("invalid_response");
  });
  it("rejects unbounded scans before database or DO access", async () => {
    const x = fixture();
    const { url, request } = req("?scope=scan&limit=5000");
    const response = await handleDoDiagnosticScopedAdmin(
      request,
      x.env,
      url,
      x.admin,
    );
    expect(response.status).toBe(400);
    expect(x.prepare).not.toHaveBeenCalled();
    expect(x.get).not.toHaveBeenCalled();
  });
});
