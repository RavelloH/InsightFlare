import { describe, expect, it, vi } from "vitest";

import {
  decodeGoalDefinitionCursor,
  handleGoal,
  queryGoalDefinitionsPage,
} from "@/lib/edge/analytics/providers/d1/internal/goals";
import type { Env } from "@/lib/edge/types";

const config = {
  filterDslVersion: 1,
  filterDsl: 'event.name eq "purchase"',
} as const;

function createEnv(
  selectResults: (sql: string) => Record<string, unknown>[] = () => [],
) {
  const calls: Array<{
    method: "all" | "run";
    sql: string;
    bindings: unknown[];
  }> = [];
  const env = {
    MAIN_SECRET: "test-main-secret-that-is-long-enough",
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

function makeRequest(path: string, init?: RequestInit) {
  const request = new Request(`https://app.test${path}`, init);
  return { request, url: new URL(request.url) };
}

function storedGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    site_id: "site-1",
    name: "Purchase",
    config_json: JSON.stringify(config),
    config_version: 1,
    created_at: 10,
    updated_at: 20,
    ...overrides,
  };
}

describe("private Goal definitions", () => {
  it("supports list and detail reads with definition-only payloads", async () => {
    const { env, calls } = createEnv((sql) =>
      sql.includes("analysis_definitions") ? [storedGoal()] : [],
    );

    const listRequest = makeRequest("/api/private/goals");
    const listResponse = await handleGoal(
      env,
      "site-1",
      listRequest.url,
      undefined,
      listRequest.request,
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        items: [
          {
            id: "goal-1",
            siteId: "site-1",
            name: "Purchase",
            filterDslVersion: 1,
            filterDsl: config.filterDsl,
            semanticFingerprint: expect.stringContaining("goal-v1:"),
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      },
    });

    const detailRequest = makeRequest("/api/private/goals?id=goal-1");
    const detailResponse = await handleGoal(
      env,
      "site-1",
      detailRequest.url,
      undefined,
      detailRequest.request,
    );
    await expect(detailResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        goal: {
          id: "goal-1",
          filterDsl: config.filterDsl,
        },
      },
    });
    expect(calls[0]?.sql).toContain("kind = ? AND archived_at IS NULL");

    const defaults = createEnv((sql) =>
      sql.includes("analysis_definitions")
        ? [
            storedGoal({
              id: null,
              site_id: null,
              name: null,
              created_at: null,
              updated_at: null,
            }),
          ]
        : [],
    );
    const defaultPage = await handleGoal(
      defaults.env,
      "site-1",
      new URL("https://app.test/api/private/goals?limit=not-a-number"),
    );
    await expect(defaultPage.json()).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ id: "", siteId: "", name: "", createdAt: 0, updatedAt: 0 }],
      },
    });
  });

  it("uses the created_at/id keyset and excludes archived rows", async () => {
    const { env, calls } = createEnv((sql) =>
      sql.includes("analysis_definitions")
        ? [
            storedGoal({ id: "goal-new", created_at: 30 }),
            storedGoal({ id: "goal-old", created_at: 20 }),
          ]
        : [],
    );

    const page = await queryGoalDefinitionsPage(env, "site-1", 1);
    expect(page.items).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(true);
    expect(page.pagination.nextCursor).toEqual(expect.any(String));
    expect(calls[0]?.sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(calls[0]?.sql).toContain("archived_at IS NULL");
    expect(calls[0]?.bindings).toEqual(["site-1", "goal", 2]);

    const nextPageRequest = makeRequest(
      `/api/private/goals?limit=1&cursor=${encodeURIComponent(page.pagination.nextCursor!)}`,
    );
    await expect(
      handleGoal(
        env,
        "site-1",
        nextPageRequest.url,
        undefined,
        nextPageRequest.request,
      ),
    ).resolves.toHaveProperty("status", 200);
    expect(calls.some((call) => call.bindings.includes("goal-new"))).toBe(true);
  });

  it("rejects malformed cursors and returns 404 for missing detail records", async () => {
    const { env } = createEnv();
    const invalidCursorRequest = makeRequest("/api/private/goals?cursor=bad");
    await expect(
      handleGoal(
        env,
        "site-1",
        invalidCursorRequest.url,
        undefined,
        invalidCursorRequest.request,
      ),
    ).rejects.toThrow("invalid-cursor");

    const detailRequest = makeRequest("/api/private/goals?id=missing");
    await expect(
      handleGoal(
        env,
        "site-1",
        detailRequest.url,
        undefined,
        detailRequest.request,
      ),
    ).resolves.toHaveProperty("status", 404);
    await expect(
      decodeGoalDefinitionCursor(env, "site-1", "bad"),
    ).rejects.toThrow("invalid-cursor");

    const missingUpdate = makeRequest("/api/private/goals?id=missing", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    await expect(
      handleGoal(
        env,
        "site-1",
        missingUpdate.url,
        undefined,
        missingUpdate.request,
      ),
    ).resolves.toHaveProperty("status", 404);
  });

  it("creates, partially updates, and soft-deletes a Goal", async () => {
    const { env, calls } = createEnv((sql) =>
      sql.includes("analysis_definitions") ? [storedGoal()] : [],
    );

    const createRequest = makeRequest("/api/private/goals", {
      method: "POST",
      body: JSON.stringify({ name: "Purchase", ...config }),
    });
    await expect(
      handleGoal(
        env,
        "site-1",
        createRequest.url,
        undefined,
        createRequest.request,
      ),
    ).resolves.toHaveProperty("status", 201);

    const updateRequest = makeRequest("/api/private/goals?id=goal-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    await expect(
      handleGoal(
        env,
        "site-1",
        updateRequest.url,
        undefined,
        updateRequest.request,
      ),
    ).resolves.toHaveProperty("status", 200);

    const deleteRequest = makeRequest("/api/private/goals?id=goal-1", {
      method: "DELETE",
    });
    await expect(
      handleGoal(
        env,
        "site-1",
        deleteRequest.url,
        undefined,
        deleteRequest.request,
      ),
    ).resolves.toHaveProperty("status", 200);

    const insert = calls.find((call) => call.method === "run");
    expect(insert?.sql).toContain("INSERT INTO analysis_definitions");
    expect(insert?.bindings).toContain("goal");
    expect(insert?.bindings).toContain(JSON.stringify(config));
    expect(
      calls.some(
        (call) =>
          call.method === "run" &&
          call.sql.startsWith("UPDATE analysis_definitions SET name"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === "run" &&
          call.sql.includes("SET archived_at = ?") &&
          call.sql.includes("kind = ?"),
      ),
    ).toBe(true);

    const noVersion = makeRequest("/api/private/goals", {
      method: "POST",
      body: JSON.stringify({ name: "Defaults", filterDsl: config.filterDsl }),
    });
    await expect(
      handleGoal(env, "site-1", noVersion.url, undefined, noVersion.request),
    ).resolves.toHaveProperty("status", 201);
  });

  it("rejects invalid Goal payloads and unsupported methods", async () => {
    const { env } = createEnv();
    const invalid = makeRequest("/api/private/goals", {
      method: "POST",
      body: JSON.stringify({
        name: "Purchase",
        filterDslVersion: 1,
        filterDsl: 'event.name nope "purchase"',
      }),
    });
    await expect(
      handleGoal(env, "site-1", invalid.url, undefined, invalid.request),
    ).resolves.toHaveProperty("status", 400);

    const malformed = makeRequest("/api/private/goals", {
      method: "POST",
      body: "not-json",
    });
    await expect(
      handleGoal(env, "site-1", malformed.url, undefined, malformed.request),
    ).resolves.toHaveProperty("status", 400);

    const unsupported = makeRequest("/api/private/goals", { method: "PUT" });
    await expect(
      handleGoal(
        env,
        "site-1",
        unsupported.url,
        undefined,
        unsupported.request,
      ),
    ).resolves.toHaveProperty("status", 405);

    const invalidArray = makeRequest("/api/private/goals", {
      method: "POST",
      body: JSON.stringify([]),
    });
    await expect(
      handleGoal(
        env,
        "site-1",
        invalidArray.url,
        undefined,
        invalidArray.request,
      ),
    ).resolves.toHaveProperty("status", 400);

    const malformedUpdate = makeRequest("/api/private/goals?id=goal-1", {
      method: "PATCH",
      body: "not-json",
    });
    const { env: existingEnv } = createEnv((sql) =>
      sql.includes("analysis_definitions") ? [storedGoal()] : [],
    );
    await expect(
      handleGoal(
        existingEnv,
        "site-1",
        malformedUpdate.url,
        undefined,
        malformedUpdate.request,
      ),
    ).resolves.toHaveProperty("status", 400);

    const invalidVersion = makeRequest("/api/private/goals", {
      method: "POST",
      body: JSON.stringify({
        name: "Purchase",
        filterDslVersion: 2,
        filterDsl: config.filterDsl,
      }),
    });
    await expect(
      handleGoal(
        env,
        "site-1",
        invalidVersion.url,
        undefined,
        invalidVersion.request,
      ),
    ).resolves.toHaveProperty("status", 400);

    const { env: updateEnv } = createEnv((sql) =>
      sql.includes("analysis_definitions") ? [storedGoal()] : [],
    );
    for (const updateBody of [
      { name: 42 },
      { name: "   " },
      { filterDslVersion: 2 },
      { filterDsl: 42 },
      { filterDsl: 'event.name nope "purchase"' },
    ]) {
      const updateRequest = makeRequest("/api/private/goals?id=goal-1", {
        method: "PATCH",
        body: JSON.stringify(updateBody),
      });
      await expect(
        handleGoal(
          updateEnv,
          "site-1",
          updateRequest.url,
          undefined,
          updateRequest.request,
        ),
      ).resolves.toHaveProperty("status", 400);
    }

    const missingUpdate = makeRequest("/api/private/goals", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    await expect(
      handleGoal(
        updateEnv,
        "site-1",
        missingUpdate.url,
        undefined,
        missingUpdate.request,
      ),
    ).resolves.toHaveProperty("status", 400);

    const missingDelete = makeRequest("/api/private/goals", {
      method: "DELETE",
    });
    await expect(
      handleGoal(
        updateEnv,
        "site-1",
        missingDelete.url,
        undefined,
        missingDelete.request,
      ),
    ).resolves.toHaveProperty("status", 400);

    const { env: readbackEnv } = createEnv();
    const validCreate = makeRequest("/api/private/goals", {
      method: "POST",
      body: JSON.stringify({ name: "Purchase", ...config }),
    });
    await expect(
      handleGoal(
        readbackEnv,
        "site-1",
        validCreate.url,
        undefined,
        validCreate.request,
      ),
    ).rejects.toThrow("goal_create_readback_failed");

    let reads = 0;
    const { env: updateReadbackEnv } = createEnv((sql) => {
      if (!sql.includes("analysis_definitions")) return [];
      reads += 1;
      return reads === 1 ? [storedGoal()] : [];
    });
    const updateReadback = makeRequest("/api/private/goals?id=goal-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    await expect(
      handleGoal(
        updateReadbackEnv,
        "site-1",
        updateReadback.url,
        undefined,
        updateReadback.request,
      ),
    ).rejects.toThrow("goal_update_readback_failed");

    await expect(
      handleGoal(env, "site-1", new URL("https://app.test/api/private/goals")),
    ).resolves.toHaveProperty("status", 200);
  });
});
