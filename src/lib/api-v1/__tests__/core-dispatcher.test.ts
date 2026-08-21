import { describe, expect, it } from "vitest";

import { dispatchApiV1CoreRoute } from "@/lib/api-v1/core-dispatcher";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  name: "Primary key",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};

function createEnv() {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: "team-1",
            name: "Team One",
            createdAt: 1_700_000_000,
          }),
          all: async () => ({ results: [{ id: "site-1" }, { id: "site-2" }] }),
        }),
      }),
    },
  } as never;
}

async function payload(response: Response) {
  return (await response.json()) as { data: Record<string, unknown> };
}

describe("API v1 core dispatcher", () => {
  it("serves the root without a principal", async () => {
    const response = await dispatchApiV1CoreRoute({
      routeId: "core.root",
      request: new Request("https://app.test/api/v1"),
      env: createEnv(),
    });
    expect(response.status).toBe(200);
    expect((await payload(response)).data.service).toBe("insightflare");
  });

  it("implements token discovery and visible team usage without the legacy executor", async () => {
    const token = await dispatchApiV1CoreRoute({
      routeId: "core.token.get",
      request: new Request("https://app.test/api/v1/token"),
      env: createEnv(),
      principal,
    });
    expect((await payload(token)).data).toMatchObject({
      id: "key-1",
      team: { id: "team-1", name: "Team One" },
      siteAccess: { mode: "restricted", siteIds: ["site-1"] },
    });

    const usage = await dispatchApiV1CoreRoute({
      routeId: "core.team.usage",
      request: new Request("https://app.test/api/v1/team/usage"),
      env: createEnv(),
      principal,
    });
    expect((await payload(usage)).data).toEqual({ sites: 1 });
  });

  it("validates token checks and preserves method guards", async () => {
    const invalid = await dispatchApiV1CoreRoute({
      routeId: "core.token.check",
      request: new Request("https://app.test/api/v1/token/check", {
        method: "POST",
        body: "{}",
      }),
      env: createEnv(),
      principal,
    });
    expect(invalid.status).toBe(400);

    const check = await dispatchApiV1CoreRoute({
      routeId: "core.token.check",
      request: new Request("https://app.test/api/v1/token/check", {
        method: "POST",
        body: JSON.stringify({ checks: [{ scope: "analytics:read" }] }),
      }),
      env: createEnv(),
      principal,
    });
    expect((await payload(check)).data).toEqual({
      checks: [{ scope: "analytics:read", allowed: true }],
    });

    const method = await dispatchApiV1CoreRoute({
      routeId: "core.capabilities",
      request: new Request("https://app.test/api/v1/capabilities", {
        method: "POST",
      }),
      env: createEnv(),
      principal,
    });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
  });
});
