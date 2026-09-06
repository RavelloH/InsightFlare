import { describe, expect, it, vi } from "vitest";

import { handleFunnel } from "@/lib/edge/analytics/providers/d1/internal/funnels";
import type { Env } from "@/lib/edge/types";

function createEnv(
  selectResults: (sql: string) => Record<string, unknown>[] = () => [],
) {
  const calls: Array<{
    method: "all" | "run";
    sql: string;
    bindings: unknown[];
  }> = [];
  const env = {
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...bindings: unknown[]) => ({
          all: vi.fn(async () => {
            calls.push({ method: "all", sql, bindings });
            return { results: selectResults(sql) };
          }),
          run: vi.fn(async () => {
            calls.push({ method: "run", sql, bindings });
            return { success: true };
          }),
        })),
      })),
    },
  } as unknown as Env;
  return { env, calls };
}

const config = {
  filterDslVersion: 1,
  progressionScope: "session" as const,
  conversionWindowMs: null,
  steps: [
    { id: "landing", filterDsl: 'page.path eq "/landing"' },
    { id: "signup", filterDsl: 'event.name eq "signup"' },
  ],
};

function makeRequest(path: string, init?: RequestInit) {
  const request = new Request(`https://app.test${path}`, init);
  return { request, url: new URL(request.url) };
}

describe("handleFunnel", () => {
  it("rejects malformed JSON and unsupported methods", async () => {
    const { env } = createEnv();
    const malformed = makeRequest("/api/private/funnels", {
      method: "POST",
      body: "not-json",
    });
    await expect(
      handleFunnel(env, "site-1", malformed.url, undefined, malformed.request),
    ).resolves.toHaveProperty("status", 400);

    const unsupported = makeRequest("/api/private/funnels", { method: "PUT" });
    await expect(
      handleFunnel(
        env,
        "site-1",
        unsupported.url,
        undefined,
        unsupported.request,
      ),
    ).resolves.toHaveProperty("status", 405);
  });

  it("writes config version 2 and supports a partial PATCH update", async () => {
    const { env, calls } = createEnv((sql) =>
      sql.includes("analysis_definitions")
        ? [
            {
              id: "funnel-1",
              site_id: "site-1",
              name: "Signup",
              config_json: JSON.stringify(config),
              config_version: 2,
              created_at: 1,
              updated_at: 1,
            },
          ]
        : [],
    );

    const create = makeRequest("/api/private/funnels", {
      method: "POST",
      body: JSON.stringify({ name: "Signup", ...config }),
    });
    await expect(
      handleFunnel(env, "site-1", create.url, undefined, create.request),
    ).resolves.toHaveProperty("status", 201);
    const insert = calls.find((call) => call.method === "run");
    expect(insert?.bindings).toContain(2);
    expect(insert?.bindings).toContain(JSON.stringify(config));

    const update = makeRequest("/api/private/funnels?id=funnel-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    await expect(
      handleFunnel(env, "site-1", update.url, undefined, update.request),
    ).resolves.toHaveProperty("status", 200);
    expect(
      calls.some((call) =>
        call.sql.startsWith("UPDATE analysis_definitions SET name"),
      ),
    ).toBe(true);
  });

  it("requires a positive visitor conversion window", async () => {
    const { env } = createEnv();
    const request = makeRequest("/api/private/funnels", {
      method: "POST",
      body: JSON.stringify({
        name: "Visitors",
        ...config,
        progressionScope: "visitor",
        conversionWindowMs: null,
      }),
    });
    const response = await handleFunnel(
      env,
      "site-1",
      request.url,
      undefined,
      request.request,
    );
    expect(response.status).toBe(400);
  });

  it("keeps historical v1 rows readable with generated semantic metadata", async () => {
    const { env } = createEnv((sql) =>
      sql.includes("analysis_definitions")
        ? [
            {
              id: "legacy",
              site_id: "site-1",
              name: "Legacy",
              config_json: JSON.stringify({
                steps: [
                  { type: "pageview", value: "/landing" },
                  { type: "event", value: "signup" },
                ],
              }),
              config_version: 1,
              created_at: 1,
              updated_at: 2,
            },
          ]
        : [],
    );
    const request = makeRequest("/api/private/funnels");
    const response = await handleFunnel(
      env,
      "site-1",
      request.url,
      undefined,
      request.request,
    );
    const body = (await response.json()) as {
      data: { items: Array<Record<string, unknown>> };
    };
    expect(body.data.items[0]).toMatchObject({
      filterDslVersion: 1,
      progressionScope: "session",
      semanticFingerprint: expect.stringContaining("funnel-v2:"),
    });
    expect(
      (body.data.items[0]?.steps as Array<Record<string, unknown>>)[0]?.id,
    ).toBe("v1:0");
  });
});
