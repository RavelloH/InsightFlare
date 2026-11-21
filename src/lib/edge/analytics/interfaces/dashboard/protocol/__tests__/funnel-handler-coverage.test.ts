import { beforeEach, describe, expect, it, vi } from "vitest";

import { FunnelConfigValidationError } from "@/lib/edge/analytics/contract/funnel-config";
import {
  handleFunnel,
  handleFunnelAnalysisContract,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/funnels";
import type { Env } from "@/lib/edge/types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@/lib/edge/analytics/composition", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createEdgeSiteAnalyticsRuntime: () => ({
      resources: {
        funnels: {
          get: mocks.get,
          create: mocks.create,
          update: mocks.update,
          archive: mocks.archive,
        },
      },
      execute: mocks.execute,
    }),
  };
});

const env = {} as Env;
const siteId = "site-1";
const context = { requestId: "unit-funnel" } as never;
const validBody = {
  name: "Conversion",
  filterDslVersion: 1,
  progressionScope: "session",
  conversionWindowMs: null,
  steps: [
    { id: "visit", filterDsl: 'page.path eq "/landing"' },
    { id: "checkout", filterDsl: 'event.name eq "checkout"' },
  ],
};
const goal = { ...validBody, id: "funnel-1" };
function url(q = "id=funnel-1&from=0&to=86400000") {
  return new URL("https://example.test/api/private/funnels?" + q);
}
function req(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
  target = url(),
) {
  return new Request(target, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
}
function command(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
  target = url(),
) {
  return handleFunnel(env, siteId, target, context, req(method, body, target));
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.get.mockResolvedValue(goal);
  mocks.create.mockResolvedValue(goal);
  mocks.update.mockResolvedValue(goal);
  mocks.archive.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({
    ok: true,
    data: { funnel: goal, analysis: { stepCount: 2 } },
  });
});

describe("private funnel query and mutation error contract", () => {
  it("lists definitions without a funnel id and propagates canonical failures", async () => {
    const list = await handleFunnelAnalysisContract(
      env,
      siteId,
      url("limit=10"),
      context,
    );
    expect(list.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(
      "funnel-analysis",
      expect.objectContaining({ page: expect.objectContaining({ limit: 10 }) }),
    );
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid-cursor" },
    });
    expect(
      (
        await handleFunnelAnalysisContract(
          env,
          siteId,
          url("limit=10"),
          context,
        )
      ).status,
    ).toBe(400);
  });

  it("validates detail windows and distinguishes provider errors, missing funnels and incomplete analyses", async () => {
    expect(
      (
        await handleFunnelAnalysisContract(
          env,
          siteId,
          url("id=x&from=10&to=5"),
          context,
        )
      ).status,
    ).toBe(400);
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "range-not-supported", reason: "too-many-buckets" },
    });
    expect(
      (await handleFunnelAnalysisContract(env, siteId, url(), context)).status,
    ).toBe(422);
    mocks.execute.mockResolvedValueOnce({
      ok: true,
      data: { unexpected: true },
    });
    await expect(
      handleFunnelAnalysisContract(env, siteId, url(), context),
    ).rejects.toThrow("funnel_analysis_result_mismatch");
    mocks.execute.mockResolvedValueOnce({ ok: true, data: { funnel: null } });
    expect(
      (await handleFunnelAnalysisContract(env, siteId, url(), context)).status,
    ).toBe(404);
    mocks.execute.mockResolvedValueOnce({
      ok: true,
      data: { funnel: goal, analysis: null },
    });
    expect(
      (await handleFunnelAnalysisContract(env, siteId, url(), context)).status,
    ).toBe(400);
    const success = await handleFunnelAnalysisContract(
      env,
      siteId,
      url(),
      context,
    );
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({
      ok: true,
      data: { funnel: { id: "funnel-1" } },
    });
  });

  it("rejects non-object POST bodies and invalid definitions before writing, then creates valid funnels", async () => {
    const malformed = new Request(url(), {
      method: "POST",
      body: "{ invalid-json",
    });
    expect(
      (await handleFunnel(env, siteId, url(), context, malformed)).status,
    ).toBe(400);
    expect((await command("POST", [])).status).toBe(400);
    expect((await command("POST", { ...validBody, name: "" })).status).toBe(
      400,
    );
    expect((await command("POST", validBody)).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      siteId,
      "Conversion",
      expect.objectContaining({ progressionScope: "session" }),
    );
  });

  it("maps typed validation failures safely while allowing unexpected errors to propagate", async () => {
    mocks.create.mockRejectedValueOnce(
      new FunnelConfigValidationError("secret validation details"),
    );
    const bad = await command("POST", validBody);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("secret validation details");
    mocks.create.mockRejectedValueOnce(new Error("database disconnected"));
    await expect(command("POST", validBody)).rejects.toThrow(
      "database disconnected",
    );
  });

  it("updates a persisted funnel with partial fields and protects invalid ids and bodies", async () => {
    expect(
      (await command("PATCH", { name: "Updated" }, url("from=0&to=86400000")))
        .status,
    ).toBe(400);
    mocks.get.mockResolvedValueOnce(null);
    expect((await command("PATCH", { name: "Updated" })).status).toBe(404);
    const invalid = new Request(url(), { method: "PATCH", body: "invalid" });
    expect(
      (await handleFunnel(env, siteId, url(), context, invalid)).status,
    ).toBe(400);
    expect((await command("PATCH", { progressionScope: "other" })).status).toBe(
      400,
    );
    expect((await command("PATCH", { name: 1 })).status).toBe(400);
    expect((await command("PATCH", { name: "  " })).status).toBe(400);
    expect((await command("PATCH", { name: "  Revised  " })).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      siteId,
      "funnel-1",
      "Revised",
      expect.objectContaining({ steps: validBody.steps }),
    );
  });

  it("rejects invalid persisted update configurations and enforces archive id requirements", async () => {
    mocks.update.mockRejectedValueOnce(
      new FunnelConfigValidationError("bad funnel"),
    );
    expect((await command("PATCH", { name: "Next" })).status).toBe(400);
    mocks.update.mockRejectedValueOnce(new Error("unavailable"));
    await expect(command("PATCH", { name: "Next" })).rejects.toThrow(
      "unavailable",
    );
    expect(
      (await command("DELETE", undefined, url("from=0&to=100"))).status,
    ).toBe(400);
    expect((await command("DELETE")).status).toBe(200);
    expect(mocks.archive).toHaveBeenCalledWith(siteId, "funnel-1");
  });
});
