import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  resource: {
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
  },
}));
vi.mock("@/lib/edge/analytics/composition", () => ({
  createEdgeSiteAnalyticsRuntime: () => ({
    execute: mocks.execute,
    resources: { funnels: mocks.resource },
  }),
}));

import { FunnelConfigValidationError } from "@/lib/edge/analytics/contract/funnel-config";
import {
  handleFunnel,
  handleFunnelAnalysisContract,
} from "@/lib/edge/analytics/interfaces/dashboard/protocol/funnels";
import type { Env } from "@/lib/edge/types";

const env = {} as Env;
const siteId = "site-1";
const base = "from=1767225600000&to=1767312000000";
const steps = [
  { type: "pageview", value: "/" },
  { type: "event", value: "signup" },
];
const current = {
  id: "f1",
  name: "Current",
  filterDslVersion: 1,
  progressionScope: "session",
  conversionWindowMs: null,
  steps,
};

function url(query = "") {
  return new URL(`https://edge.test/funnel?${query}`);
}
function req(method: string, body?: unknown, raw?: string) {
  return new Request("https://edge.test/funnel", {
    method,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}
async function text(response: Response) {
  return JSON.stringify(await response.json());
}

describe("funnel protocol", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("maps a failed definition listing to an error response", async () => {
    mocks.execute.mockResolvedValue({
      ok: false,
      error: { kind: "invalid-cursor" },
    });
    const response = await handleFunnelAnalysisContract(env, siteId, url());
    expect(response.status).toBe(400);
  });

  it("rejects an invalid time window for analysis", async () => {
    const response = await handleFunnelAnalysisContract(
      env,
      siteId,
      url("id=f1&from=abc"),
    );
    expect(response.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps analysis query failures", async () => {
    mocks.execute.mockResolvedValue({ ok: false, error: { kind: "internal" } });
    const response = await handleFunnelAnalysisContract(
      env,
      siteId,
      url(`id=f1&${base}`),
    );
    expect(response.status).toBe(500);
  });

  it("throws when the analysis result is a listing", async () => {
    mocks.execute.mockResolvedValue({ ok: true, data: { items: [] } });
    await expect(
      handleFunnelAnalysisContract(env, siteId, url(`id=f1&${base}`)),
    ).rejects.toThrow("funnel_analysis_result_mismatch");
  });

  it("returns 404 when the funnel is missing", async () => {
    mocks.execute.mockResolvedValue({
      ok: true,
      data: { funnel: null, analysis: null },
    });
    const response = await handleFunnelAnalysisContract(
      env,
      siteId,
      url(`id=f1&${base}`),
    );
    expect(response.status).toBe(404);
  });

  describe("create", () => {
    it("rejects non-object and malformed JSON bodies", async () => {
      for (const request of [
        req("POST", [1]),
        req("POST", null),
        req("POST", undefined, "{not json"),
      ]) {
        const response = await handleFunnel(
          env,
          siteId,
          url(),
          undefined,
          request,
        );
        expect(response.status).toBe(400);
        expect(await text(response)).toContain("Invalid JSON body");
      }
    });

    it("rejects invalid funnel configuration", async () => {
      const response = await handleFunnel(
        env,
        siteId,
        url(),
        undefined,
        req("POST", { name: "  ", steps }),
      );
      expect(response.status).toBe(400);
      expect(await text(response)).toContain("Invalid funnel configuration");
      expect(mocks.resource.create).not.toHaveBeenCalled();
    });

    it("creates a funnel with defaults", async () => {
      mocks.resource.create.mockResolvedValue({ id: "new" });
      const response = await handleFunnel(
        env,
        siteId,
        url(),
        undefined,
        req("POST", { name: " Name ", steps }),
      );
      expect(response.status).toBe(201);
      expect(mocks.resource.create).toHaveBeenCalledWith(siteId, "Name", {
        filterDslVersion: 1,
        progressionScope: "session",
        conversionWindowMs: null,
        steps,
      });
    });

    it("maps validation errors and rethrows others", async () => {
      mocks.resource.create.mockRejectedValueOnce(
        new FunnelConfigValidationError("bad"),
      );
      const response = await handleFunnel(
        env,
        siteId,
        url(),
        undefined,
        req("POST", { name: "n", steps }),
      );
      expect(response.status).toBe(400);
      mocks.resource.create.mockRejectedValueOnce(new Error("boom"));
      await expect(
        handleFunnel(
          env,
          siteId,
          url(),
          undefined,
          req("POST", { name: "n", steps }),
        ),
      ).rejects.toThrow("boom");
    });
  });

  describe("update", () => {
    const patch = (query: string, body?: unknown) =>
      handleFunnel(
        env,
        siteId,
        url(query),
        undefined,
        req("PATCH", body ?? {}),
      );

    it("requires an id and an existing funnel", async () => {
      const missingId = await patch("");
      expect(missingId.status).toBe(400);
      expect(await text(missingId)).toContain("Funnel id is required");
      mocks.resource.get.mockResolvedValue(null);
      expect((await patch("id=f1")).status).toBe(404);
    });

    it("rejects a bad body", async () => {
      mocks.resource.get.mockResolvedValue(current);
      const response = await handleFunnel(
        env,
        siteId,
        url("id=f1"),
        undefined,
        req("PATCH", undefined, "nope"),
      );
      expect(response.status).toBe(400);
    });

    it("rejects invalid configuration and names", async () => {
      mocks.resource.get.mockResolvedValue(current);
      for (const body of [
        { filterDslVersion: 2 },
        { progressionScope: "global" },
        { conversionWindowMs: "x" },
      ]) {
        const response = await patch("id=f1", body);
        expect(response.status).toBe(400);
        expect(await text(response)).toContain("Invalid funnel configuration");
      }
      for (const body of [{ name: 5 }, { name: "   " }]) {
        const response = await patch("id=f1", body);
        expect(response.status).toBe(400);
        expect(await text(response)).toContain("Name is required");
      }
      expect(mocks.resource.update).not.toHaveBeenCalled();
    });

    it("merges the patch over the current definition", async () => {
      mocks.resource.get.mockResolvedValue(current);
      mocks.resource.update.mockResolvedValue({ id: "f1" });
      const response = await patch("id=f1", {
        name: " Renamed ",
        progressionScope: "visitor",
        conversionWindowMs: 1000,
      });
      expect(response.status).toBe(200);
      expect(mocks.resource.update).toHaveBeenCalledWith(
        siteId,
        "f1",
        "Renamed",
        {
          filterDslVersion: 1,
          progressionScope: "visitor",
          conversionWindowMs: 1000,
          steps,
        },
      );
    });

    it("maps validation errors and rethrows others", async () => {
      mocks.resource.get.mockResolvedValue(current);
      mocks.resource.update.mockRejectedValueOnce(
        new FunnelConfigValidationError("bad"),
      );
      expect((await patch("id=f1")).status).toBe(400);
      mocks.resource.update.mockRejectedValueOnce(new Error("boom"));
      await expect(patch("id=f1")).rejects.toThrow("boom");
    });
  });

  describe("delete and dispatch", () => {
    it("requires an id and archives the funnel", async () => {
      const missing = await handleFunnel(
        env,
        siteId,
        url(),
        undefined,
        req("DELETE"),
      );
      expect(missing.status).toBe(400);
      const ok = await handleFunnel(
        env,
        siteId,
        url("id=f1"),
        undefined,
        req("DELETE"),
      );
      expect(ok.status).toBe(200);
      expect(mocks.resource.archive).toHaveBeenCalledWith(siteId, "f1");
    });

    it("rejects unsupported methods", async () => {
      const response = await handleFunnel(
        env,
        siteId,
        url(),
        undefined,
        req("PUT"),
      );
      expect(response.status).toBe(405);
    });
  });
});
