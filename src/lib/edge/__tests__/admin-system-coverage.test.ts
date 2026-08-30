import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleDoDiagnosticAdmin,
  handleE2eFlushAdmin,
  handleSystemPerformanceAdmin,
} from "@/lib/edge/admin-system";
import type { Env } from "@/lib/edge/types";
import type { DoDiagnosticPayload } from "@/lib/system-performance";

type QueryBinding = string | number | null;

type AdminActor = { isAdmin: boolean };
type AdminActorResolver = (
  env: Env,
  req: Request,
) => Promise<AdminActor | Response>;

interface MockStatement {
  sql?: string;
  bindings?: QueryBinding[];
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}

interface MockDurableObjectNamespace {
  idFromName: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

interface SystemPerformanceJson {
  topSites: Array<{ siteId: string; siteDomain: string }>;
  slowEvents: Array<{ siteName: string }>;
}

interface DiagnosticSiteJson {
  siteId: string;
  [key: string]: unknown;
}

interface DoDiagnosticJson {
  sites: DiagnosticSiteJson[];
}

function statement(
  input: {
    first?: unknown;
    all?: Record<string, unknown>[];
    firstReject?: unknown;
    allReject?: unknown;
  } = {},
): MockStatement {
  const stmt: MockStatement = {
    bind: vi.fn((...bindings: QueryBinding[]) => {
      stmt.bindings = bindings;
      return stmt;
    }),
    first: vi.fn(),
    all: vi.fn(),
  };

  if ("firstReject" in input) {
    stmt.first.mockRejectedValue(input.firstReject);
  } else {
    stmt.first.mockResolvedValue("first" in input ? input.first : null);
  }

  if ("allReject" in input) {
    stmt.all.mockRejectedValue(input.allReject);
  } else {
    stmt.all.mockResolvedValue({ results: input.all ?? [] });
  }

  return stmt;
}

function createIngestDo(
  handlers: Record<string, { fetch: ReturnType<typeof vi.fn> }> = {},
): MockDurableObjectNamespace {
  const idFromName = vi.fn((name: string) => `stub:${name}`);
  const get = vi.fn((id: string) => {
    const siteId = id.replace(/^stub:/, "");
    return (
      handlers[siteId] ?? {
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ ok: false }), { status: 500 }),
          ),
      }
    );
  });
  return { idFromName, get };
}

function createEnv(
  statements: MockStatement[] = [],
  ingestDo: MockDurableObjectNamespace = createIngestDo(),
) {
  let index = 0;
  const prepare = vi.fn((sql: string) => {
    const stmt = statements[index];
    index += 1;
    if (!stmt) throw new Error(`Unexpected SQL #${index}: ${sql}`);
    stmt.sql = sql;
    return stmt;
  });
  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      INGEST_DO: ingestDo as unknown as DurableObjectNamespace,
      DAILY_SALT_SECRET: "test-secret",
    } as Env,
    prepare,
  };
}

function adminResolver(): AdminActorResolver {
  return vi.fn().mockResolvedValue({ isAdmin: true });
}

function diagnosticPayload(
  overrides: Partial<DoDiagnosticPayload> = {},
): DoDiagnosticPayload {
  return {
    ok: true,
    snapshotAt: 1_000,
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
        oldestStartedAt: 900,
        newestActivityAt: 950,
        futureMaxActivityAt: null,
      },
      dirty: {
        total: 0,
        stuck: 0,
        maxFlushAttempts: 0,
      },
    },
    customEvents: {
      total: 0,
      dirty: 0,
      stuck: 0,
      maxFlushAttempts: 0,
      oldestOccurredAt: null,
    },
    alarm: {
      scheduledAt: null,
      nextDueAt: null,
      nextDueKind: null,
      nextDueEntity: null,
    },
    ...overrides,
  };
}

describe("admin system handlers coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes through actor resolution responses before method or database work", async () => {
    const actorResponse = Response.json(
      { ok: false, error: "session expired" },
      { status: 401 },
    );
    const requireActor = vi.fn().mockResolvedValue(actorResponse);
    const { env, prepare } = createEnv();

    const response = await handleSystemPerformanceAdmin(
      new Request("https://edge.test/api/private/admin/system-performance", {
        method: "POST",
      }),
      env,
      new URL("https://edge.test/api/private/admin/system-performance"),
      requireActor,
    );

    expect(response).toBe(actorResponse);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("uses minute buckets for 15-minute windows and normalizes non-finite rows", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const trendStatement = statement({
      all: [
        {
          bucketSec: "bad",
          visits: "bad",
          customEvents: 2,
          totalEvents: 2,
          avgLatencyMs: "bad",
          p50LatencyMs: undefined,
          p75LatencyMs: 5,
          p95LatencyMs: Number.POSITIVE_INFINITY,
          delayedEvents: null,
          futureSkewedEvents: 1,
        },
      ],
    });
    const { env } = createEnv([
      statement({
        first: {
          totalEvents: 2,
          visits: "1",
          customEvents: 1,
          activeSites: 1,
          avgLatencyMs: 12,
          trustedLatencySamples: 2,
          delayedEvents: 0,
          futureSkewedEvents: 0,
          latestCreatedAtSec: 1_800_000_010,
        },
      }),
      statement({
        first: {
          p50LatencyMs: "bad",
          p75LatencyMs: 20,
          p95LatencyMs: null,
        },
      }),
      trendStatement,
      statement({
        all: [
          {
            siteId: "s".repeat(130),
            siteName: "",
            siteDomain: "d".repeat(300),
            totalEvents: "9",
            visits: "bad",
            customEvents: 4,
            avgLatencyMs: "bad",
            delayedEvents: 1,
            futureSkewedEvents: null,
          },
        ],
      }),
      statement({
        all: [
          {
            kind: "custom_event",
            siteId: "s".repeat(130),
            siteName: "n".repeat(140),
            siteDomain: "d".repeat(300),
            eventAtMs: "bad",
            serverAtMs: 10,
            latencyMs: "20",
          },
        ],
      }),
      statement({
        first: {
          total: "bad",
          stale: 1,
          timedOut: null,
          oldestStartedAt: "bad",
          newestActivityAt: 1,
        },
      }),
    ]);

    const response = await handleSystemPerformanceAdmin(
      new Request("https://edge.test/api/private/admin/system-performance"),
      env,
      new URL(
        "https://edge.test/api/private/admin/system-performance?minutes=15",
      ),
      adminResolver(),
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as SystemPerformanceJson;
    expect(data).toMatchObject({
      ok: true,
      window: {
        from: 1_799_999_100_000,
        to: 1_800_000_000_000,
        minutes: 15,
        bucketSizeMs: 60_000,
      },
      summary: {
        totalEvents: 2,
        visits: 1,
        dataFreshnessMs: 0,
        p50LatencyMs: null,
        p75LatencyMs: 20,
        p95LatencyMs: 0,
      },
      openVisits: {
        total: 0,
        stale: 1,
        timedOut: 0,
        oldestStartedAt: null,
        newestActivityAt: 1,
      },
      trend: [
        {
          bucket: 0,
          timestampMs: 0,
          visits: 0,
          customEvents: 2,
          avgLatencyMs: null,
          p50LatencyMs: null,
          p75LatencyMs: 5,
          p95LatencyMs: null,
          delayedEvents: 0,
          futureSkewedEvents: 1,
        },
      ],
      topSites: [
        {
          siteName: "",
          totalEvents: 9,
          visits: 0,
          avgLatencyMs: null,
          futureSkewedEvents: 0,
        },
      ],
      slowEvents: [
        {
          kind: "custom_event",
          eventAt: 0,
          serverAt: 10,
          latencyMs: 20,
        },
      ],
    });
    expect(data.topSites[0].siteId).toHaveLength(120);
    expect(data.topSites[0].siteDomain).toHaveLength(255);
    expect(data.slowEvents[0].siteName).toHaveLength(120);
    expect(trendStatement.bindings?.slice(0, 6)).toEqual([
      1_799_999_100, 1_800_000_000, 1_799_999_100, 1_800_000_000, 60, 60,
    ]);
  });

  it("propagates system performance database failures", async () => {
    const { env } = createEnv([
      statement({ firstReject: new Error("summary failed") }),
      statement({ first: {} }),
      statement({ all: [] }),
      statement({ all: [] }),
      statement({ all: [] }),
      statement({ first: {} }),
    ]);

    await expect(
      handleSystemPerformanceAdmin(
        new Request("https://edge.test/api/private/admin/system-performance"),
        env,
        new URL("https://edge.test/api/private/admin/system-performance"),
        adminResolver(),
      ),
    ).rejects.toThrow("summary failed");
  });

  it("passes through DO diagnostic actor responses before database work", async () => {
    const actorResponse = Response.json(
      { ok: false, error: "locked" },
      { status: 423 },
    );
    const requireActor = vi.fn().mockResolvedValue(actorResponse);
    const { env, prepare } = createEnv();

    const response = await handleDoDiagnosticAdmin(
      new Request("https://edge.test/api/private/admin/do-diagnostic", {
        method: "POST",
      }),
      env,
      new URL("https://edge.test/api/private/admin/do-diagnostic"),
      requireActor,
    );

    expect(response).toBe(actorResponse);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("records invalid DO diagnostic payloads, parse errors, and truncated exceptions", async () => {
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    const diagnostic = diagnosticPayload();
    const ingestDo = createIngestDo({
      "site-ok": {
        fetch: vi.fn().mockResolvedValue(Response.json(diagnostic)),
      },
      "site-invalid": {
        fetch: vi.fn().mockResolvedValue(Response.json({ ok: false })),
      },
      "site-json": {
        fetch: vi.fn().mockResolvedValue(new Response("not-json")),
      },
      "site-throw": {
        fetch: vi.fn().mockRejectedValue(new Error("x".repeat(220))),
      },
    });
    const { env } = createEnv(
      [
        statement({
          all: [
            { id: "site-ok", name: "Working", domain: "ok.example.test" },
            { id: "site-invalid", name: "Invalid", domain: "" },
            { id: "site-json", name: "", domain: "" },
            { id: "site-throw", name: "Throws", domain: "" },
          ],
        }),
      ],
      ingestDo,
    );

    const response = await handleDoDiagnosticAdmin(
      new Request("https://edge.test/api/private/admin/do-diagnostic"),
      env,
      new URL("https://edge.test/api/private/admin/do-diagnostic"),
      adminResolver(),
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as DoDiagnosticJson;
    const sitesById = new Map(data.sites.map((site) => [site.siteId, site]));
    expect(data).toMatchObject({
      ok: true,
      generatedAt: 50_000,
      totalSites: 4,
      reachableSites: 1,
      unreachableSites: 3,
      thresholds: diagnostic.thresholds,
      totals: {
        bufferedVisits: 1,
        openVisits: 1,
        activeAlarms: 0,
      },
    });
    expect(sitesById.get("site-ok")).toMatchObject({
      ok: true,
      diagnostic,
    });
    expect(sitesById.get("site-invalid")).toMatchObject({
      ok: false,
      error: "do_invalid_response",
    });
    expect(sitesById.get("site-json")).toMatchObject({
      siteName: "site-json",
      ok: false,
      error: expect.stringContaining("JSON"),
    });
    expect(sitesById.get("site-throw")).toMatchObject({
      ok: false,
      error: "x".repeat(160),
    });
    expect(ingestDo.idFromName).toHaveBeenCalledTimes(4);
  });

  it("propagates DO diagnostic site listing failures", async () => {
    const { env } = createEnv([
      statement({ allReject: new Error("site listing failed") }),
    ]);

    await expect(
      handleDoDiagnosticAdmin(
        new Request("https://edge.test/api/private/admin/do-diagnostic"),
        env,
        new URL("https://edge.test/api/private/admin/do-diagnostic"),
        adminResolver(),
      ),
    ).rejects.toThrow("site listing failed");
  });

  it("keeps the E2E flush route unavailable outside its generated environment", async () => {
    const { env, prepare } = createEnv();
    const response = await handleE2eFlushAdmin(
      new Request("https://edge.test/api/private/admin/e2e/flush", {
        method: "POST",
        body: JSON.stringify({ siteId: "site-1" }),
      }),
      env,
      new URL("https://edge.test/api/private/admin/e2e/flush"),
      adminResolver(),
    );
    expect(response.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("validates and flushes E2E ingest only for system admins", async () => {
    const ingestDo = createIngestDo({
      "site-1": {
        fetch: vi.fn().mockResolvedValue(Response.json({ ok: true })),
      },
    });
    const { env, prepare } = createEnv(
      [statement({ first: { id: "site-1" } })],
      ingestDo,
    );
    env.INSIGHTFLARE_E2E = "1";
    const url = new URL("https://edge.test/api/private/admin/e2e/flush");
    const denied = await handleE2eFlushAdmin(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ siteId: "site-1" }),
      }),
      env,
      url,
      vi.fn().mockResolvedValue({ isAdmin: false }),
    );
    expect(denied.status).toBe(403);
    const response = await handleE2eFlushAdmin(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ siteId: "site-1" }),
      }),
      env,
      url,
      adminResolver(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { flushed: true, siteId: "site-1" },
      ok: true,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(ingestDo.idFromName).toHaveBeenCalledWith("site-1");
  });

  it("handles E2E flush actor, method, input, missing-site, and DO failures", async () => {
    const url = new URL("https://edge.test/api/private/admin/e2e/flush");
    const { env: baseEnv } = createEnv();
    baseEnv.INSIGHTFLARE_E2E = "1";
    const actorResponse = new Response(null, { status: 401 });
    await expect(
      handleE2eFlushAdmin(
        new Request(url),
        baseEnv,
        url,
        vi.fn().mockResolvedValue(actorResponse),
      ),
    ).resolves.toBe(actorResponse);
    await expect(
      handleE2eFlushAdmin(new Request(url), baseEnv, url, adminResolver()),
    ).resolves.toMatchObject({ status: 405 });
    await expect(
      handleE2eFlushAdmin(
        new Request(url, { method: "POST", body: "{}" }),
        baseEnv,
        url,
        adminResolver(),
      ),
    ).resolves.toMatchObject({ status: 400 });

    const { env: missingEnv } = createEnv([statement({ first: null })]);
    missingEnv.INSIGHTFLARE_E2E = "1";
    await expect(
      handleE2eFlushAdmin(
        new Request(url, {
          method: "POST",
          body: JSON.stringify({ siteId: "missing" }),
        }),
        missingEnv,
        url,
        adminResolver(),
      ),
    ).resolves.toMatchObject({ status: 404 });

    const failingDo = createIngestDo({
      "site-1": {
        fetch: vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
      },
    });
    const { env: failingEnv } = createEnv(
      [statement({ first: { id: "site-1" } })],
      failingDo,
    );
    failingEnv.INSIGHTFLARE_E2E = "1";
    await expect(
      handleE2eFlushAdmin(
        new Request(url, {
          method: "POST",
          body: JSON.stringify({ siteId: "site-1" }),
        }),
        failingEnv,
        url,
        adminResolver(),
      ),
    ).resolves.toMatchObject({ status: 502 });
  });
});
