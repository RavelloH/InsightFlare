import { afterEach, describe, expect, it, vi } from "vitest";

import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import { handleFunnel } from "@/lib/edge/analytics/interfaces/dashboard/protocol/funnels";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

interface PreparedCall {
  bindings: unknown[];
  method: "all" | "run";
  sql: string;
}

function createEnv(
  selectResults: (
    sql: string,
    bindings: unknown[],
  ) => Record<string, unknown>[] = () => [],
) {
  const calls: PreparedCall[] = [];
  const env = {
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...bindings: unknown[]) => ({
          all: vi.fn(async () => {
            calls.push({ sql, bindings, method: "all" });
            return { results: selectResults(sql, bindings) };
          }),
          run: vi.fn(async () => {
            calls.push({ sql, bindings, method: "run" });
            return { success: true };
          }),
        })),
      })),
    },
  } as unknown as Env;
  return { env, calls };
}

const v2 = {
  filterDslVersion: 1,
  progressionScope: "session",
  conversionWindowMs: null,
  steps: [
    { id: "landing", filterDsl: 'page.path eq "/pricing"' },
    { id: "signup", filterDsl: 'event.name eq "signup_started"' },
  ],
};

function request(path: string, init?: RequestInit) {
  const next = new Request(`https://edge.test${path}`, init);
  return { request: next, url: new URL(next.url) };
}

describe("funnel v2 query handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists definitions after decoding v1 rows into the v2 representation", async () => {
    const { env, calls } = createEnv((sql) =>
      sql.includes("analysis_definitions")
        ? [
            {
              id: "funnel-1",
              site_id: "site-1",
              name: "Signup",
              config_json: JSON.stringify({
                steps: [
                  { type: "pageview", value: "/pricing" },
                  { type: "event", value: "signup_started" },
                ],
              }),
              config_version: 1,
              created_at: 10,
              updated_at: 20,
            },
          ]
        : [],
    );
    const { request: req, url } = request("/api/private/funnels");
    const response = await handleFunnel(env, "site-1", url, undefined, req);
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.data.items[0]).toMatchObject({
      id: "funnel-1",
      progressionScope: "session",
      conversionWindowMs: null,
      steps: [
        { id: "v1:0", filterDsl: 'page.path eq "/pricing"' },
        { id: "v1:1", filterDsl: 'event.name eq "signup_started"' },
      ],
      semanticFingerprint: expect.stringContaining("funnel-v2:"),
    });
    expect(calls[0]?.sql).toContain("config_version");
  });

  it("writes v2 config on create and supports PATCH update", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const { env, calls } = createEnv((sql) =>
      sql.includes("analysis_definitions")
        ? [
            {
              id: "00000000-0000-4000-8000-000000000001",
              site_id: "site-1",
              name: "Signup",
              config_json: JSON.stringify(v2),
              config_version: 2,
              created_at: 100,
              updated_at: 100,
            },
          ]
        : [],
    );
    const created = await handleFunnel(
      env,
      "site-1",
      request("/api/private/funnels", {
        method: "POST",
        body: JSON.stringify({ name: "Signup", ...v2 }),
      }).url,
      undefined,
      request("/api/private/funnels", {
        method: "POST",
        body: JSON.stringify({ name: "Signup", ...v2 }),
      }).request,
    );
    expect(created.status).toBe(201);
    const insert = calls.find((call) => call.method === "run");
    expect(insert?.bindings).toContain(2);
    expect(insert?.bindings).toContain(JSON.stringify(v2));

    const update = await handleFunnel(
      env,
      "site-1",
      request("/api/private/funnels?id=00000000-0000-4000-8000-000000000001", {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed" }),
      }).url,
      undefined,
      request("/api/private/funnels?id=00000000-0000-4000-8000-000000000001", {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed" }),
      }).request,
    );
    expect(update.status).toBe(200);
    expect(
      calls.some(
        (call) =>
          call.sql.includes('UPDATE "analysis_definitions"') &&
          call.sql.includes('SET "name" = ?'),
      ),
    ).toBe(true);
  });

  it("runs one staged SQL statement and returns zero rows for later steps", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { env: rawEnv, calls } = createEnv((sql) => {
      if (sql.includes("analysis_definitions")) {
        return [
          {
            id: "funnel-1",
            site_id: "site-1",
            name: "Signup",
            config_json: JSON.stringify(v2),
            config_version: 2,
            created_at: 1,
            updated_at: 1,
          },
        ];
      }
      if (sql.includes("stepIndex"))
        return [
          { stepIndex: 0, sessions: 2, visitors: 1 },
          { stepIndex: 1, sessions: 0, visitors: 0 },
        ];
      return [];
    });
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const env = instrumentEnv(rawEnv, logger);
    const { request: req, url } = request(
      "/api/private/funnels?id=funnel-1&from=1&to=1000",
    );
    const response = await runWithInvocationLogger(logger, () =>
      handleFunnel(env, "site-1", url, undefined, req),
    );
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body.data.analysis.summary).toMatchObject({
      totalProgressions: 2,
      convertedProgressions: 0,
    });
    expect(body.data.analysis.steps[1]).toMatchObject({
      stepId: "signup",
      progression: { count: 0, dropOffCount: 2 },
    });
    const queryCalls = calls.filter(
      (call) =>
        call.method === "all" && !call.sql.includes("analysis_definitions"),
    );
    expect(queryCalls).toHaveLength(1);
    const queryCall = queryCalls[0];
    expect(queryCall?.sql).toMatch(/stepIndex/i);
    expect(queryCall?.sql).toMatch(/sessions/i);
    expect(queryCall?.sql).toMatch(/visitors/i);
    expect(
      new TextEncoder().encode(queryCall?.sql ?? "").byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(queryCall?.bindings.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const logRecord = await logger.emitWhenComplete();
    expect(logRecord.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "db.query.v1.all.success",
          data: expect.objectContaining({ tag: "analytics.query.all" }),
        }),
      ]),
    );
  });
});
