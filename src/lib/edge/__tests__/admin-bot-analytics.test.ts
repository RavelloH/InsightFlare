import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BotAnalyticsConfig } from "@/lib/bot-analytics-config";
import { requireActor } from "@/lib/edge/admin-auth";
import {
  handleBotAnalyticsAdmin,
  handleBotAnalyticsConfigAdmin,
} from "@/lib/edge/admin-bot-analytics";
import { decryptBotAnalyticsSecret } from "@/lib/edge/secret-encryption";
import type { Env } from "@/lib/edge/types";

vi.mock("@/lib/edge/admin-auth", () => ({
  requireActor: vi.fn(),
}));

interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
}

const actor = {
  user: {
    id: "admin-1",
    username: "admin",
    email: "admin@example.test",
    name: "Admin",
    password_hash: null,
    system_role: "admin",
    timezone: "UTC",
    created_at: 1,
    updated_at: 1,
  },
  isAdmin: true,
};

function statement(options: { first?: unknown; all?: unknown[] } = {}) {
  const stmt: MockStatement = {
    bind: vi.fn((..._args: unknown[]) => stmt),
    first: vi.fn().mockResolvedValue(options.first ?? null),
    run: vi.fn().mockResolvedValue({ success: true }),
    all: vi.fn().mockResolvedValue({ results: options.all ?? [] }),
  };
  return stmt;
}

function createEnv(statements: MockStatement[]) {
  let index = 0;
  return {
    MAIN_SECRET: "main-secret",
    DB: {
      prepare: vi.fn(() => {
        const stmt = statements[index];
        index += 1;
        if (!stmt) throw new Error(`Unexpected SQL #${index}`);
        return stmt;
      }),
    } as unknown as D1Database,
  } as Env;
}

function request(path: string, init?: RequestInit) {
  return new Request(`https://app.test${path}`, {
    method: "GET",
    ...init,
  });
}

function jsonRequest(path: string, body: unknown, method = "PATCH") {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function row(config: Partial<BotAnalyticsConfig>) {
  return {
    value_json: JSON.stringify({
      accountId: "442fe5198bff93bdf60d4223d9618033",
      dataset: "insightflare_bot_events",
      apiTokenEncrypted: "",
      apiTokenHint: "",
      configured: false,
      updatedAt: 0,
      ...config,
    }),
  };
}

async function jsonOf(response: Response) {
  return (await response.json()) as Record<string, any>;
}

function jsonEachRow(rows: Record<string, unknown>[]) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function firstBucketTimestampMs(sql: string) {
  const match = sql.match(/timestamp\s+>=\s+toDateTime\((\d+)\)/);
  return Number(match?.[1] ?? 0) * 1000;
}

describe("admin bot analytics handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.mocked(requireActor).mockResolvedValue(actor);
  });

  it("saves Cloudflare reader settings with encrypted token and redacts response", async () => {
    const select = statement();
    const upsert = statement();
    const env = createEnv([select, upsert]);

    const response = await handleBotAnalyticsConfigAdmin(
      jsonRequest("/api/private/admin/bot-analytics-config", {
        accountId: "442fe5198bff93bdf60d4223d9618033",
        dataset: "insightflare_bot_events",
        apiToken: "cf_token_secret",
      }),
      env,
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(body.data.apiTokenConfigured).toBe(true);
    expect(body.data.apiTokenHint).toBe("••••cret");
    expect(JSON.stringify(body)).not.toContain("cf_token_secret");

    const saved = JSON.parse(
      upsert.bind.mock.calls[0][1],
    ) as BotAnalyticsConfig;
    expect(saved.apiTokenEncrypted).toMatch(/^v1:/);
    await expect(
      decryptBotAnalyticsSecret(env, saved.apiTokenEncrypted),
    ).resolves.toBe("cf_token_secret");
  });

  it("returns an unconfigured data shape when reader settings are incomplete", async () => {
    const response = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics"),
      createEnv([statement()]),
      new URL("https://app.test/api/private/admin/bot-analytics"),
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.events).toEqual([]);
    expect(body.summary.total).toBe(0);
    expect(body.summary.baselineRequests).toBe(0);
    expect(body.summary.botRequestRatio).toBe(0);
    expect(body.summary.affectedSites).toBe(0);
  });

  it("reports Analytics Engine disabled state and blocks config writes", async () => {
    const env = {
      ...createEnv([statement(), statement()]),
      INSIGHTFLARE_ANALYTICS_ENGINE_DISABLED: "1",
    } as Env;

    const configResponse = await handleBotAnalyticsConfigAdmin(
      request("/api/private/admin/bot-analytics-config"),
      env,
    );
    const configBody = await jsonOf(configResponse);
    expect(configResponse.status).toBe(200);
    expect(configBody.data.analyticsEngineDisabled).toBe(true);
    expect(configBody.data.analyticsEngineEnableUrl).toContain(
      "/workers/analytics-engine",
    );

    const writeResponse = await handleBotAnalyticsConfigAdmin(
      jsonRequest("/api/private/admin/bot-analytics-config", {
        accountId: "442fe5198bff93bdf60d4223d9618033",
        dataset: "insightflare_bot_events",
      }),
      env,
    );
    expect(writeResponse.status).toBe(400);

    const analyticsResponse = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics"),
      env,
      new URL("https://app.test/api/private/admin/bot-analytics"),
    );
    const analyticsBody = await jsonOf(analyticsResponse);
    expect(analyticsResponse.status).toBe(200);
    expect(analyticsBody).toMatchObject({
      configured: false,
      error: "analytics_engine_disabled",
      events: [],
    });
    expect(analyticsBody.config.analyticsEngineDisabled).toBe(true);
  });

  it("passes through auth responses, rejects non-admins, and handles methods", async () => {
    const unauthorized = new Response("unauthorized", { status: 401 });
    vi.mocked(requireActor).mockResolvedValueOnce(unauthorized);
    await expect(
      handleBotAnalyticsConfigAdmin(
        request("/api/private/admin/bot-analytics-config"),
        createEnv([]),
      ),
    ).resolves.toBe(unauthorized);

    vi.mocked(requireActor).mockResolvedValueOnce({ ...actor, isAdmin: false });
    const forbidden = await handleBotAnalyticsConfigAdmin(
      request("/api/private/admin/bot-analytics-config"),
      createEnv([]),
    );
    expect(forbidden.status).toBe(403);

    const deleteStatement = statement();
    const deleted = await handleBotAnalyticsConfigAdmin(
      request("/api/private/admin/bot-analytics-config", { method: "DELETE" }),
      createEnv([deleteStatement]),
    );
    expect(deleted.status).toBe(200);
    expect(deleteStatement.run).toHaveBeenCalled();

    const unsupported = await handleBotAnalyticsConfigAdmin(
      request("/api/private/admin/bot-analytics-config", { method: "PUT" }),
      createEnv([]),
    );
    expect(unsupported.status).toBe(405);
  });

  it("reports token and Analytics Engine query failures", async () => {
    const invalidSecret = statement({
      first: row({
        apiTokenEncrypted: "invalid",
        apiTokenHint: "••••oken",
        configured: true,
      }),
    });
    const decryptFailed = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics"),
      createEnv([invalidSecret]),
      new URL("https://app.test/api/private/admin/bot-analytics"),
    );
    expect(decryptFailed.status).toBe(400);

    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret(
          { MAIN_SECRET: "main-secret" },
          "cf_reader_token",
        ),
    );
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockImplementation(
        async () => new Response("{bad-json", { status: 200 }),
      );

    const cfFailed = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics"),
      createEnv([
        statement({
          first: row({
            apiTokenEncrypted: encrypted,
            apiTokenHint: "••••oken",
            configured: true,
          }),
        }),
      ]),
      new URL("https://app.test/api/private/admin/bot-analytics"),
    );
    expect(cfFailed.status).toBe(400);

    const parseFailed = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics"),
      createEnv([
        statement({
          first: row({
            apiTokenEncrypted: encrypted,
            apiTokenHint: "••••oken",
            configured: true,
          }),
        }),
      ]),
      new URL("https://app.test/api/private/admin/bot-analytics"),
    );
    expect(parseFailed.status).toBe(400);
  });

  it("fails closed when an E2E run has no local Cloudflare Analytics URL", async () => {
    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret(
          { MAIN_SECRET: "main-secret" },
          "cf_reader_token",
        ),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const env = {
      ...createEnv([
        statement({
          first: row({
            apiTokenEncrypted: encrypted,
            apiTokenHint: "••••oken",
            configured: true,
          }),
        }),
      ]),
      INSIGHTFLARE_E2E: "1",
    } as Env;

    const response = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics"),
      env,
      new URL("https://app.test/api/private/admin/bot-analytics"),
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: expect.objectContaining({
        code: "e2e_analytics_mock_url_required",
      }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("queries Analytics Engine and maps bot rows with site metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret(
          { MAIN_SECRET: "main-secret" },
          "cf_reader_token",
        ),
    );
    const configSelect = statement({
      first: row({
        apiTokenEncrypted: encrypted,
        apiTokenHint: "••••oken",
        configured: true,
      }),
    });
    const siteSelect = statement({
      all: [{ id: "site-1", name: "Blog", domain: "example.test" }],
    });
    const rollupSelect = statement({ first: { requests: 99 } });
    const rollupTrendSelect = statement({
      all: [{ hourBucket: 499999, requests: 99 }],
    });
    const env = createEnv([
      configSelect,
      siteSelect,
      rollupSelect,
      rollupTrendSelect,
    ]);
    const botRow = {
      timestamp: "2026-07-03 10:00:00",
      siteId: "site-1",
      kind: "pageview",
      category: "medium",
      reasons: "hosting_asn",
      ip: "203.0.113.8",
      userAgent: "Mozilla/5.0",
      origin: "https://example.test",
      hostname: "example.test",
      pathname: "/post",
      country: "JP",
      region: "Tokyo",
      city: "Tokyo",
      continent: "AS",
      colo: "NRT",
      asnText: "16509",
      asOrganization: "Amazon.com, Inc.",
      verifiedBotCategory: "",
      rayId: "ray-1",
      traceId: "trace-1",
      metadataJson: "{}",
      receivedAt: 1_799_999_900_000,
      asn: 16509,
      latitude: 35.6895,
      longitude: 139.6917,
      botScore: 0,
      userAgentLength: 11,
    };
    const normalRow = {
      timestamp: "2026-07-03 10:00:00",
      siteId: "site-1",
      kind: "pageview",
      origin: "https://example.test",
      hostname: "example.test",
      pathname: "/post",
      country: "JP",
      region: "Tokyo",
      city: "Tokyo",
      continent: "AS",
      colo: "NRT",
      asnText: "16509",
      asOrganization: "Amazon.com, Inc.",
      rayId: "normal-ray-1",
      traceId: "normal-trace-1",
      requestMethod: "GET",
      metadataJson: JSON.stringify({
        eventId: "event-1",
        visitId: "visit-1",
        visibilityState: "visible",
      }),
      receivedAt: 1_799_999_900_000,
      eventAt: 1_799_999_899_960,
      edgeLatencyMs: 40,
      asn: 16509,
      latitude: 35.6895,
      longitude: 139.6917,
      userAgentLength: 11,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const sql = String((init as RequestInit | undefined)?.body || "");
        if (sql.includes("blob3 AS category")) {
          return new Response(jsonEachRow([botRow]), { status: 200 });
        }
        if (sql.includes("blob3 AS origin")) {
          return new Response(jsonEachRow([normalRow]), { status: 200 });
        }
        if (sql.includes("GROUP BY timestampMs")) {
          const timestampMs = firstBucketTimestampMs(sql);
          if (sql.includes("latencyWeightedSumMs")) {
            return new Response(
              jsonEachRow([
                {
                  timestampMs,
                  weightedRequestCount: 99,
                  count: 99,
                  pageviews: 99,
                  customEvents: 0,
                  pageviewCount: 99,
                  leaveCount: 7,
                  visibilityCount: 8,
                  customEventCount: 9,
                  identifyCount: 10,
                  latencyWeightedSumMs: 3960,
                  latencySampleWeight: 99,
                  p50LatencyMs: 40,
                  p75LatencyMs: 40,
                  p95LatencyMs: 40,
                  p99LatencyMs: 40,
                },
              ]),
              { status: 200 },
            );
          }
          return new Response(
            jsonEachRow([
              {
                timestampMs,
                count: 1,
                pageviews: 1,
                customEvents: 0,
              },
            ]),
            { status: 200 },
          );
        }
        if (sql.includes("GROUP BY latitude, longitude, country")) {
          return new Response(
            jsonEachRow([
              {
                latitude: 35.69,
                longitude: 139.692,
                country: "JP",
                pointCount: 1,
              },
            ]),
            { status: 200 },
          );
        }
        if (sql.includes("count(DISTINCT blob1)")) {
          return new Response(
            jsonEachRow([
              sql.includes("blob15) AS uniqueAsns")
                ? {
                    total: 1,
                    highThreat: 0,
                    mediumThreat: 1,
                    customBlocked: 0,
                    affectedSites: 1,
                    uniqueAsns: 1,
                    uniqueCountries: 1,
                  }
                : {
                    total: 99,
                    affectedSites: 1,
                    uniqueAsns: 1,
                    uniqueCountries: 1,
                  },
            ]),
            { status: 200 },
          );
        }
        if (sql.includes("blob15 AS label")) {
          return new Response(
            jsonEachRow([
              {
                label: "13335",
                count: 42,
                highThreat: 17,
              },
              {
                label: "16509",
                count: 31,
                highThreat: 9,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("", { status: 200 });
      });

    const response = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics?minutes=60&limit=10"),
      env,
      new URL(
        "https://app.test/api/private/admin/bot-analytics?minutes=60&limit=10",
      ),
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/442fe5198bff93bdf60d4223d9618033/analytics_engine/sql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer cf_reader_token",
        }),
      }),
    );
    const [, fetchInit] = fetchMock.mock.calls[0] ?? [];
    const sql = String((fetchInit as RequestInit | undefined)?.body || "");
    expect(sql).toContain("FROM insightflare_bot_events");
    expect(sql).not.toContain("`insightflare_bot_events`");
    expect(sql).toContain("double1 AS receivedAt");
    expect(sql).toContain("double3 AS latitude");
    expect(sql).toContain("double4 AS longitude");
    expect(sql).toContain("ORDER BY timestamp DESC");
    expect(sql).not.toMatch(/AND\s+double1\s+>=/);
    expect(sql).not.toContain("ORDER BY double1 DESC");
    const allSql = fetchMock.mock.calls.map(([, init]) =>
      String((init as RequestInit | undefined)?.body || ""),
    );
    expect(allSql.join("\n")).toContain("quantileExactWeighted(0.95)");
    expect(
      allSql.some(
        (statement) =>
          statement.includes("GROUP BY timestampMs") &&
          statement.includes("sumIf(_sample_interval * double3") &&
          statement.includes("latencyWeightedSumMs") &&
          statement.includes("latencySampleWeight") &&
          /p50LatencyMs|p75LatencyMs|p95LatencyMs|p99LatencyMs/.test(statement),
      ),
    ).toBe(true);
    expect(allSql.join("\n")).toContain(
      "sum(_sample_interval) AS weightedRequestCount",
    );
    expect(body.configured).toBe(true);
    expect(body.summary).toMatchObject({
      total: 1,
      baselineRequests: 99,
      botRequestRatio: 0.01,
      mediumThreat: 1,
      affectedSites: 1,
      uniqueAsns: 1,
      uniqueCountries: 1,
    });
    const preparedSql = (
      env.DB.prepare as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.map(([sql]) => String(sql));
    expect(preparedSql.some((sql) => sql.includes("FROM sites"))).toBe(true);
    expect(preparedSql.some((sql) => sql.includes("FROM visits"))).toBe(false);
    expect(body.events[0]).toMatchObject({
      siteName: "Blog",
      siteDomain: "example.test",
      category: "medium_threat",
      asn: 16509,
      latitude: 35.6895,
      longitude: 139.6917,
      reasons: ["hosting_asn"],
    });
    expect(allSql.join("\n")).toContain(
      "blob3 IN ('medium', 'high', 'medium_threat', 'high_threat', 'custom_block')",
    );
    expect(allSql.join("\n")).not.toContain("'low'");
    expect(body.normalEvents[0]).toMatchObject({
      metadataJson: JSON.stringify({
        eventId: "event-1",
        visitId: "visit-1",
        visibilityState: "visible",
      }),
    });
    expect(body.mapPoints[0]).toMatchObject({
      country: "JP",
      latitude: 35.69,
      longitude: 139.692,
      pointCount: 1,
    });
    expect(body.abnormal.dimensions.network.asn).toEqual([
      {
        key: "13335\u0000\u0000",
        label: "13335",
        count: 42,
        highThreat: 17,
        country: "",
        region: "",
      },
      {
        key: "16509\u0000\u0000",
        label: "16509",
        count: 31,
        highThreat: 9,
        country: "",
        region: "",
      },
    ]);
    expect(
      allSql.some(
        (statement) =>
          statement.includes("blob15 AS label") &&
          statement.includes("GROUP BY label") &&
          statement.includes("sum(_sample_interval) AS count") &&
          statement.includes("LIMIT 30"),
      ),
    ).toBe(true);
    expect(body.trend.some((point: any) => point.baselineCount === 99)).toBe(
      true,
    );
    expect(body.trend).toContainEqual(
      expect.objectContaining({
        baselineCount: 99,
        weightedRequestCount: 100,
        latencyWeightedSumMs: 3960,
        latencySampleWeight: 99,
        avgLatencyMs: 40,
        pageviewCount: 99,
        leaveCount: 7,
        visibilityCount: 8,
        customEventCount: 9,
        identifyCount: 10,
      }),
    );
  });

  it("expands day-bucket Analytics Engine windows to the full leading day", async () => {
    const now = Date.UTC(2026, 6, 6, 7, 30, 0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret(
          { MAIN_SECRET: "main-secret" },
          "cf_reader_token",
        ),
    );
    const env = createEnv([
      statement({
        first: row({
          apiTokenEncrypted: encrypted,
          apiTokenHint: "••••oken",
          configured: true,
        }),
      }),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 200 }));
    const rollingFrom = Date.UTC(2026, 5, 6, 7, 30, 0);
    const expectedFrom = Date.UTC(2026, 5, 5, 16, 0, 0);

    const response = await handleBotAnalyticsAdmin(
      request(
        `/api/private/admin/bot-analytics?from=${rollingFrom}&to=${now}&interval=day&timeZone=Asia%2FShanghai`,
      ),
      env,
      new URL(
        `https://app.test/api/private/admin/bot-analytics?from=${rollingFrom}&to=${now}&interval=day&timeZone=Asia%2FShanghai`,
      ),
    );
    const body = await jsonOf(response);
    const allSql = fetchMock.mock.calls.map(([, init]) =>
      String((init as RequestInit | undefined)?.body || ""),
    );

    expect(response.status).toBe(200);
    expect(body.window).toMatchObject({
      from: expectedFrom,
      to: now,
      interval: "day",
      timeZone: "Asia/Shanghai",
    });
    expect(allSql.join("\n")).toContain(
      `timestamp >= toDateTime(${Math.floor(expectedFrom / 1000)})`,
    );
    expect(allSql.join("\n")).toContain(
      "intDiv(toUnixTimestamp(timestamp) + 28800, 86400)",
    );
    expect(allSql.join("\n")).not.toContain("toStartOfInterval");
    expect(body.trend[0]?.timestampMs).toBe(expectedFrom);
  });

  it("calculates the full-window Worker latency from weighted bucket totals", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret(
          { MAIN_SECRET: "main-secret" },
          "cf_reader_token",
        ),
    );
    const env = createEnv([
      statement({
        first: row({
          apiTokenEncrypted: encrypted,
          apiTokenHint: "••••oken",
          configured: true,
        }),
      }),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const sql = String((init as RequestInit | undefined)?.body || "");
        if (sql.includes("GROUP BY timestampMs")) {
          const timestampMs = firstBucketTimestampMs(sql);
          if (sql.includes("latencyWeightedSumMs")) {
            return new Response(
              jsonEachRow([
                {
                  timestampMs,
                  weightedRequestCount: 1,
                  count: 1,
                  pageviews: 1,
                  customEvents: 0,
                  latencyWeightedSumMs: 10,
                  latencySampleWeight: 1,
                  p50LatencyMs: 10,
                  p75LatencyMs: 10,
                  p95LatencyMs: 10,
                  p99LatencyMs: 10,
                },
                {
                  timestampMs: timestampMs + 60 * 60 * 1000,
                  weightedRequestCount: 9,
                  count: 9,
                  pageviews: 9,
                  customEvents: 0,
                  latencyWeightedSumMs: 900,
                  latencySampleWeight: 9,
                  p50LatencyMs: 100,
                  p75LatencyMs: 100,
                  p95LatencyMs: 100,
                  p99LatencyMs: 100,
                },
              ]),
              { status: 200 },
            );
          }
          return new Response("", { status: 200 });
        }
        return new Response("", { status: 200 });
      });

    const response = await handleBotAnalyticsAdmin(
      request(
        "/api/private/admin/bot-analytics?from=1799996400000&to=1800000000000&interval=hour",
      ),
      env,
      new URL(
        "https://app.test/api/private/admin/bot-analytics?from=1799996400000&to=1800000000000&interval=hour",
      ),
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(body.overview).toMatchObject({
      normalRequests: 10,
      abnormalRequests: 0,
      avgLatencyMs: 91,
    });
    expect(body.trend).toContainEqual(
      expect.objectContaining({
        weightedRequestCount: 1,
        latencyWeightedSumMs: 10,
        latencySampleWeight: 1,
        avgLatencyMs: 10,
      }),
    );
    expect(body.trend).toContainEqual(
      expect.objectContaining({
        weightedRequestCount: 9,
        latencyWeightedSumMs: 900,
        latencySampleWeight: 9,
        avgLatencyMs: 100,
      }),
    );
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        String((init as RequestInit | undefined)?.body || "").includes(
          "sumIf(_sample_interval * double3, double3 >= 0)",
        ),
      ),
    ).toBe(true);
  });

  it("falls back to blob-only Analytics Engine queries when double columns are unavailable", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret(
          { MAIN_SECRET: "main-secret" },
          "cf_reader_token",
        ),
    );
    const configSelect = statement({
      first: row({
        apiTokenEncrypted: encrypted,
        apiTokenHint: "••••oken",
        configured: true,
      }),
    });
    const siteSelect = statement({
      all: [{ id: "site-1", name: "Blog", domain: "example.test" }],
    });
    const rollupSelect = statement({ first: { requests: 49 } });
    const rollupTrendSelect = statement({
      all: [{ hourBucket: 500000, requests: 49 }],
    });
    const env = createEnv([
      configSelect,
      siteSelect,
      rollupSelect,
      rollupTrendSelect,
    ]);
    const fallbackRow = {
      timestamp: "2026-07-03 10:00:00",
      siteId: "site-1",
      kind: "pageview",
      category: "medium",
      reasons: "hosting_asn",
      ip: "203.0.113.8",
      userAgent: "Mozilla/5.0",
      origin: "https://example.test",
      hostname: "example.test",
      pathname: "/post",
      country: "JP",
      region: "Tokyo",
      city: "Tokyo",
      continent: "AS",
      colo: "NRT",
      asnText: "16509",
      asOrganization: "Amazon.com, Inc.",
      verifiedBotCategory: "",
      rayId: "ray-1",
      traceId: "trace-1",
      metadataJson: "{}",
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [
              {
                message:
                  'Input was invalid: unable to find type of column: "double1"',
              },
            ],
          }),
          { status: 422 },
        ),
      )
      .mockImplementation(async (_input, init) => {
        const sql = String((init as RequestInit | undefined)?.body || "");
        if (
          sql.includes("blob3 AS category") ||
          sql.includes("blob3 AS origin")
        ) {
          return new Response(jsonEachRow([fallbackRow]), { status: 200 });
        }
        if (sql.includes("GROUP BY timestampMs")) {
          const timestampMs = firstBucketTimestampMs(sql);
          return new Response(
            jsonEachRow([
              {
                timestampMs,
                weightedRequestCount: sql.includes("latencyWeightedSumMs")
                  ? 49
                  : 1,
                count: sql.includes("latencyWeightedSumMs") ? 49 : 1,
                pageviews: sql.includes("latencyWeightedSumMs") ? 49 : 1,
                customEvents: 0,
                latencyWeightedSumMs: sql.includes("latencyWeightedSumMs")
                  ? 0
                  : undefined,
                latencySampleWeight: sql.includes("latencyWeightedSumMs")
                  ? 49
                  : undefined,
                avgLatencyMs: 0,
              },
            ]),
            { status: 200 },
          );
        }
        if (sql.includes("GROUP BY latitude, longitude, country")) {
          return new Response("", { status: 200 });
        }
        if (sql.includes("count(DISTINCT blob1)")) {
          return new Response(
            jsonEachRow([
              sql.includes("blob15) AS uniqueAsns")
                ? {
                    total: 1,
                    highThreat: 0,
                    mediumThreat: 1,
                    customBlocked: 0,
                    affectedSites: 1,
                    uniqueAsns: 1,
                    uniqueCountries: 1,
                  }
                : {
                    total: 49,
                    affectedSites: 1,
                    uniqueAsns: 1,
                    uniqueCountries: 1,
                  },
            ]),
            { status: 200 },
          );
        }
        return new Response("", { status: 200 });
      });

    const response = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics?minutes=60&limit=10"),
      env,
      new URL(
        "https://app.test/api/private/admin/bot-analytics?minutes=60&limit=10",
      ),
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(21);
    const firstSql = String(
      (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body || "",
    );
    const fallbackSql = String(
      (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body || "",
    );
    expect(firstSql).toContain("double1 AS receivedAt");
    expect(fallbackSql).not.toContain("double1 AS receivedAt");
    expect(fallbackSql).toContain("ORDER BY timestamp DESC");
    expect(
      fetchMock.mock.calls
        .map(([, init]) =>
          String((init as RequestInit | undefined)?.body || ""),
        )
        .join("\n"),
    ).toContain("quantileExactWeighted(0.95)");
    expect(body.events[0]).toMatchObject({
      siteName: "Blog",
      asn: 16509,
      receivedAt: Date.UTC(2026, 6, 3, 10, 0, 0),
    });
    expect(body.summary).toMatchObject({
      total: 1,
      baselineRequests: 49,
      botRequestRatio: 0.02,
      mediumThreat: 1,
      affectedSites: 1,
      uniqueAsns: 1,
      uniqueCountries: 1,
    });
  });

  it("maps empty analytics rows, explicit windows, and fallback row fields", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret(
          { MAIN_SECRET: "main-secret" },
          "cf_reader_token",
        ),
    );
    const env = createEnv([
      statement({
        first: row({
          apiTokenEncrypted: encrypted,
          apiTokenHint: "••••oken",
          configured: true,
        }),
      }),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const sql = String((init as RequestInit | undefined)?.body || "");
        if (sql.includes("blob3 AS category")) {
          return new Response(
            jsonEachRow([
              {
                timestamp: "not-a-date",
                siteId: "",
                kind: "",
                category: "high",
                reasons: "ua_isbot, ,hosting_asn",
                ip: "",
                userAgent: "",
                origin: "",
                hostname: "",
                pathname: "",
                country: "",
                region: "",
                city: "",
                continent: "",
                colo: "",
                asnText: "0",
                asOrganization: "",
                verifiedBotCategory: "",
                rayId: "",
                traceId: "",
                metadataJson: "",
                receivedAt: 0,
                asn: 0,
                latitude: 0,
                longitude: Number.NaN,
                botScore: 17,
                userAgentLength: "bad",
              },
            ]),
            { status: 200 },
          );
        }
        if (sql.includes("blob3 AS origin")) {
          return new Response(
            jsonEachRow([
              {
                timestamp: "2026-07-03T10:00:00.000Z",
                siteId: "",
                kind: "custom_event",
                origin: "",
                hostname: "",
                pathname: "",
                country: "",
                region: "",
                city: "",
                continent: "",
                colo: "",
                asnText: "",
                asOrganization: "",
                rayId: "",
                traceId: "",
                requestMethod: "",
                metadataJson: "",
                receivedAt: 0,
                eventAt: 1_799_999_999_000,
                edgeLatencyMs: -12,
                asn: 0,
                latitude: 0,
                longitude: 0,
                userAgentLength: "bad",
              },
            ]),
            { status: 200 },
          );
        }
        if (sql.includes("GROUP BY timestampMs")) {
          return new Response(
            jsonEachRow([
              {
                timestampMs: 0,
                count: -1,
                pageviews: -1,
                customEvents: -1,
                avgLatencyMs: "bad",
                p95LatencyMs: "bad",
              },
            ]),
            { status: 200 },
          );
        }
        if (sql.includes("GROUP BY latitude, longitude, country")) {
          return new Response(
            jsonEachRow([
              {
                latitude: 0,
                longitude: 0,
                country: "",
                pointCount: -1,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response("", { status: 200 });
      });

    const response = await handleBotAnalyticsAdmin(
      request(
        "/api/private/admin/bot-analytics?from=1799990000000&to=1800000000000&interval=minute&limit=bad",
      ),
      env,
      new URL(
        "https://app.test/api/private/admin/bot-analytics?from=1799990000000&to=1800000000000&interval=minute&limit=bad",
      ),
    );
    const body = await jsonOf(response);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        String((init as RequestInit | undefined)?.body || "").includes(
          "LIMIT 101",
        ),
      ),
    ).toBe(true);
    expect(body.window).toMatchObject({
      from: 1_799_990_000_000,
      to: 1_800_000_000_000,
      interval: "minute",
    });
    expect(body.events[0]).toMatchObject({
      siteName: "Unknown site",
      siteDomain: "",
      reasons: ["ua_isbot", "hosting_asn"],
      latitude: null,
      longitude: null,
      botScore: 17,
      userAgentLength: 0,
    });
    expect(body.normalEvents[0]).toMatchObject({
      siteName: "Unknown site",
      edgeLatencyMs: 0,
      latitude: null,
      longitude: null,
    });
    expect(body.summary).toMatchObject({
      total: 0,
      baselineRequests: 0,
      botRequestRatio: 0,
      highThreat: 0,
      affectedSites: 0,
      uniqueAsns: 0,
      uniqueCountries: 0,
    });
    expect(body.mapPoints).toEqual([]);
    expect(body.normal.mapPoints).toEqual([]);
  });

  it("supports detail queries, fallback detail reads, and config token clearing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret(
          { MAIN_SECRET: "main-secret" },
          "cf_reader_token",
        ),
    );

    const missingDetail = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics?detail=1"),
      createEnv([
        statement({
          first: row({
            apiTokenEncrypted: encrypted,
            apiTokenHint: "••••oken",
            configured: true,
          }),
        }),
      ]),
      new URL("https://app.test/api/private/admin/bot-analytics?detail=1"),
    );
    expect(missingDetail.status).toBe(400);

    const detailEnv = createEnv([
      statement({
        first: row({
          apiTokenEncrypted: encrypted,
          apiTokenHint: "••••oken",
          configured: true,
        }),
      }),
      statement({
        all: [{ id: "site-2", name: "", domain: "" }],
      }),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [
              {
                message:
                  'Input was invalid: unable to find type of column: "double1"',
              },
            ],
          }),
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          jsonEachRow([
            {
              timestamp: "2026-07-03 10:00:00",
              siteId: "site-2",
              kind: "collect",
              category: "custom_block",
              reasons: "",
              ip: "203.0.113.9",
              userAgent: "curl/8",
              origin: "",
              hostname: "",
              pathname: "",
              country: "US",
              region: "",
              city: "",
              continent: "",
              colo: "",
              asnText: "",
              asOrganization: "",
              verifiedBotCategory: "",
              rayId: "ray-detail",
              traceId: "trace-detail",
              metadataJson: JSON.stringify({
                requestMethod: "GET",
                referer: "https://example.test/",
              }),
            },
          ]),
          { status: 200 },
        ),
      );

    const detailResponse = await handleBotAnalyticsAdmin(
      request(
        "/api/private/admin/bot-analytics?traceId=trace-detail&rayId=ray-detail",
      ),
      detailEnv,
      new URL(
        "https://app.test/api/private/admin/bot-analytics?traceId=trace-detail&rayId=ray-detail",
      ),
    );
    const detailBody = await jsonOf(detailResponse);

    expect(detailResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(detailBody.detail).toMatchObject({
      siteId: "site-2",
      siteName: "site-2",
      rayId: "ray-detail",
      traceId: "trace-detail",
      receivedAt: Date.UTC(2026, 6, 3, 10, 0, 0),
      metadataJson: JSON.stringify({
        requestMethod: "GET",
        referer: "https://example.test/",
      }),
    });
    const firstDetailSql = String(
      (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body || "",
    );
    const fallbackDetailSql = String(
      (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body || "",
    );
    expect(firstDetailSql).toContain("double1 AS receivedAt");
    expect(fallbackDetailSql).not.toContain("double1 AS receivedAt");
    expect(fallbackDetailSql).toContain("blob18 = 'ray-detail'");
    expect(fallbackDetailSql).not.toContain("blob19");

    const upsert = statement();
    const clearResponse = await handleBotAnalyticsConfigAdmin(
      jsonRequest("/api/private/admin/bot-analytics-config", {
        accountId: "442fe5198bff93bdf60d4223d9618033",
        dataset: "insightflare_bot_events",
        normalDataset: "insightflare_normal_events",
        clearApiToken: true,
      }),
      createEnv([
        statement({
          first: row({
            apiTokenEncrypted: encrypted,
            apiTokenHint: "••••oken",
            configured: true,
          }),
        }),
        upsert,
      ]),
    );
    const clearBody = await jsonOf(clearResponse);
    const saved = JSON.parse(
      upsert.bind.mock.calls[0][1],
    ) as BotAnalyticsConfig;

    expect(clearResponse.status).toBe(200);
    expect(clearBody.data.apiTokenConfigured).toBe(false);
    expect(saved).toMatchObject({
      normalDataset: "insightflare_normal_events",
      apiTokenEncrypted: "",
      apiTokenHint: "",
      configured: false,
    });
  });

  it("pages detail rows and reads breakdown cards from Analytics Engine", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const encrypted = await import("@/lib/edge/secret-encryption").then(
      ({ encryptBotAnalyticsSecret }) =>
        encryptBotAnalyticsSecret({ MAIN_SECRET: "main-secret" }, "token"),
    );
    const event = {
      timestamp: "2026-07-03 10:00:00",
      siteId: "site-1",
      kind: "pageview",
      category: "high",
      reasons: "hosting_asn",
      country: "US",
      region: "CA",
      city: "San Francisco",
      asnText: "13335",
      asOrganization: "Cloudflare",
      rayId: "ray-1",
      traceId: "trace-1",
    };
    const env = createEnv([
      statement({
        first: row({ apiTokenEncrypted: encrypted, configured: true }),
      }),
      statement({ all: [{ id: "site-1", name: "Site", domain: "site.test" }] }),
    ]);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const sql = String((init as RequestInit | undefined)?.body || "");
        if (sql.includes("blob1 AS label")) {
          return new Response(
            jsonEachRow([{ label: "site-1", count: 12, highThreat: 7 }]),
            { status: 200 },
          );
        }
        if (sql.includes("blob11 AS label, blob10 AS country")) {
          return new Response(
            jsonEachRow([
              {
                label: "Tokyo",
                country: "JP",
                count: 12,
                highThreat: 7,
              },
            ]),
            { status: 200 },
          );
        }
        if (sql.includes("GROUP BY label")) {
          return new Response(
            jsonEachRow([{ label: "13335", count: 12, highThreat: 7 }]),
            { status: 200 },
          );
        }
        return new Response(
          jsonEachRow([
            event,
            { ...event, traceId: "trace-0", rayId: "ray-0" },
          ]),
          { status: 200 },
        );
      });

    const pageResponse = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics?page=abnormal&limit=1"),
      env,
      new URL(
        "https://app.test/api/private/admin/bot-analytics?page=abnormal&limit=1",
      ),
    );
    const pageBody = await jsonOf(pageResponse);
    expect(pageResponse.status).toBe(200);
    expect(pageBody.page).toMatchObject({
      source: "abnormal",
      hasMore: true,
      events: [expect.objectContaining({ traceId: "trace-1" })],
    });
    expect(pageBody.page.nextCursor).toMatchObject({
      timestamp: "2026-07-03 10:00:00",
      receivedAt: 1783072800000,
    });
    expect(
      fetchMock.mock.calls.every(
        ([, init]) =>
          !String((init as RequestInit | undefined)?.body || "").includes(
            "blob19",
          ),
      ),
    ).toBe(true);

    const dimensionResponse = await handleBotAnalyticsAdmin(
      request(
        "/api/private/admin/bot-analytics?dimensionSource=abnormal&dimensionGroup=network&dimensionTab=asn",
      ),
      createEnv([
        statement({
          first: row({ apiTokenEncrypted: encrypted, configured: true }),
        }),
      ]),
      new URL(
        "https://app.test/api/private/admin/bot-analytics?dimensionSource=abnormal&dimensionGroup=network&dimensionTab=asn",
      ),
    );
    const dimensionBody = await jsonOf(dimensionResponse);
    expect(dimensionResponse.status).toBe(200);
    expect(dimensionBody.dimension.rows).toEqual([
      expect.objectContaining({ label: "13335", count: 12, highThreat: 7 }),
    ]);
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        String((init as RequestInit | undefined)?.body || "").includes(
          "GROUP BY label",
        ),
      ),
    ).toBe(true);

    const siteDimensionResponse = await handleBotAnalyticsAdmin(
      request(
        "/api/private/admin/bot-analytics?dimensionSource=abnormal&dimensionGroup=target&dimensionTab=site",
      ),
      createEnv([
        statement({
          first: row({ apiTokenEncrypted: encrypted, configured: true }),
        }),
        statement({
          all: [{ id: "site-1", name: "Site", domain: "site.test" }],
        }),
      ]),
      new URL(
        "https://app.test/api/private/admin/bot-analytics?dimensionSource=abnormal&dimensionGroup=target&dimensionTab=site",
      ),
    );
    const siteDimensionBody = await jsonOf(siteDimensionResponse);
    expect(siteDimensionResponse.status).toBe(200);
    expect(siteDimensionBody.dimension.rows).toEqual([
      expect.objectContaining({
        label: "Site",
        iconLabel: "site.test",
        count: 12,
      }),
    ]);

    const regionDimensionResponse = await handleBotAnalyticsAdmin(
      request(
        "/api/private/admin/bot-analytics?dimensionSource=abnormal&dimensionGroup=network&dimensionTab=region",
      ),
      createEnv([
        statement({
          first: row({ apiTokenEncrypted: encrypted, configured: true }),
        }),
      ]),
      new URL(
        "https://app.test/api/private/admin/bot-analytics?dimensionSource=abnormal&dimensionGroup=network&dimensionTab=region",
      ),
    );
    const regionDimensionBody = await jsonOf(regionDimensionResponse);
    expect(regionDimensionResponse.status).toBe(200);
    expect(regionDimensionBody.dimension.rows).toEqual([
      expect.objectContaining({
        label: "Tokyo",
        country: "JP",
        region: "Tokyo",
      }),
    ]);

    for (const [source, group, tab] of [
      ["abnormal", "detection", "category"],
      ["abnormal", "target", "pathname"],
      ["abnormal", "client", "userAgentLengthBucket"],
      ["normal", "target", "hostname"],
      ["normal", "network", "city"],
    ] as const) {
      const response = await handleBotAnalyticsAdmin(
        request(
          `/api/private/admin/bot-analytics?dimensionSource=${source}&dimensionGroup=${group}&dimensionTab=${tab}`,
        ),
        createEnv([
          statement({
            first: row({ apiTokenEncrypted: encrypted, configured: true }),
          }),
        ]),
        new URL(
          `https://app.test/api/private/admin/bot-analytics?dimensionSource=${source}&dimensionGroup=${group}&dimensionTab=${tab}`,
        ),
      );
      expect(response.status).toBe(200);
    }

    const invalidCursor = await handleBotAnalyticsAdmin(
      request("/api/private/admin/bot-analytics?page=normal&cursor=invalid"),
      createEnv([
        statement({
          first: row({ apiTokenEncrypted: encrypted, configured: true }),
        }),
      ]),
      new URL(
        "https://app.test/api/private/admin/bot-analytics?page=normal&cursor=invalid",
      ),
    );
    expect(invalidCursor.status).toBe(400);

    const normalPage = await handleBotAnalyticsAdmin(
      request(
        `/api/private/admin/bot-analytics?page=normal&cursor=${encodeURIComponent(JSON.stringify({ timestamp: "2026-07-03 10:00:00", receivedAt: 1783072800000 }))}`,
      ),
      createEnv([
        statement({
          first: row({ apiTokenEncrypted: encrypted, configured: true }),
        }),
        statement({
          all: [{ id: "site-1", name: "Site", domain: "site.test" }],
        }),
      ]),
      new URL(
        `https://app.test/api/private/admin/bot-analytics?page=normal&cursor=${encodeURIComponent(JSON.stringify({ timestamp: "2026-07-03 10:00:00", receivedAt: 1783072800000 }))}`,
      ),
    );
    expect(normalPage.status).toBe(200);

    const invalidDimension = await handleBotAnalyticsAdmin(
      request(
        "/api/private/admin/bot-analytics?dimensionSource=normal&dimensionGroup=client&dimensionTab=ip",
      ),
      createEnv([
        statement({
          first: row({ apiTokenEncrypted: encrypted, configured: true }),
        }),
      ]),
      new URL(
        "https://app.test/api/private/admin/bot-analytics?dimensionSource=normal&dimensionGroup=client&dimensionTab=ip",
      ),
    );
    expect(invalidDimension.status).toBe(400);
  });
});
