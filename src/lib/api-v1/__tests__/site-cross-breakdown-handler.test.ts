import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
  type AnalysisDefinitionReader,
} from "@/lib/api-v1/analysis-definition-reader";
import {
  handlePlannedSiteCrossBreakdown,
  type SiteCrossBreakdownReader,
} from "@/lib/api-v1/site-cross-breakdown-handler";
import {
  AnalyticsCrossBreakdownResponseSchema,
  ApiV1ErrorEnvelopeSchema,
} from "@/lib/api-v1/wire";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  status: "active",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
};
const input = {
  timeRange: {
    kind: "absolute",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
  },
  primaryDimension: "page.path",
  secondaryDimension: "client.browser",
};
function reader() {
  return vi
    .fn<SiteCrossBreakdownReader>()
    .mockResolvedValue({ columns: [], rows: [], totalVisitors: 0 });
}

function request(
  body: BodyInit | null = JSON.stringify(input),
  init: RequestInit = {},
) {
  const method = init.method ?? "POST";
  return new Request(
    "https://app.test/api/v1/sites/site-1/analytics/cross-breakdowns",
    {
      ...init,
      method,
      headers: { "Content-Type": "application/json", ...init.headers },
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
    },
  );
}

describe("planned site cross-breakdown HTTP adapter", () => {
  it("serves a strict typed envelope through a live Hono route", async () => {
    const provider = reader();
    const app = new Hono();
    app.post("/api/v1/sites/:siteId/analytics/cross-breakdowns", (context) =>
      handlePlannedSiteCrossBreakdown(
        context.req.raw,
        principal,
        context.req.param("siteId"),
        provider,
      ),
    );
    const response = await app.fetch(request());
    expect(response.status).toBe(200);
    expect(
      AnalyticsCrossBreakdownResponseSchema.safeParse(await response.json())
        .success,
    ).toBe(true);
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryLimit: 5,
        secondaryLimit: 6,
        timeZone: "UTC",
      }),
    );
  });

  it("fails closed before the reader for transport, scope, site, and time failures", async () => {
    const provider = reader();
    for (const candidate of [
      request(null),
      request(JSON.stringify({ ...input, unexpected: true })),
      request(
        JSON.stringify({
          ...input,
          timeRange: { ...input.timeRange, to: input.timeRange.from },
        }),
      ),
      request(JSON.stringify(input), { headers: { Accept: "text/plain" } }),
      request(JSON.stringify(input), {
        headers: { "Content-Type": "text/plain" },
      }),
      request(JSON.stringify(input), {
        headers: { "Content-Encoding": "gzip" },
      }),
      request(JSON.stringify(input), { method: "GET" }),
    ]) {
      const response = await handlePlannedSiteCrossBreakdown(
        candidate,
        principal,
        "site-1",
        provider,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        ApiV1ErrorEnvelopeSchema.safeParse(await response.json()).success,
      ).toBe(true);
    }
    const method = await handlePlannedSiteCrossBreakdown(
      request(JSON.stringify(input), { method: "GET" }),
      principal,
      "site-1",
      provider,
    );
    expect(method.headers.get("Allow")).toBe("POST");
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          request(),
          { ...principal, scopes: [] },
          "site-1",
          provider,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          request(),
          { ...principal, status: "revoked" },
          "site-1",
          provider,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          request(),
          principal,
          "site-2",
          provider,
        )
      ).status,
    ).toBe(404);
    const hidden = await handlePlannedSiteCrossBreakdown(
      request(
        JSON.stringify({ ...input, filter: { type: "saved", id: "missing" } }),
      ),
      { ...principal, scopes: ["analytics:read", "analysis:read"] },
      "site-1",
      provider,
      {},
      { resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue(null) },
    );
    expect(hidden.status).toBe(404);
    expect(provider).not.toHaveBeenCalled();
  });

  it("resolves saved filters after its scope gate and retains cancellation/deadline semantics", async () => {
    const provider = reader();
    const definitions: AnalysisDefinitionReader = {
      resolveTeamVisibleSavedFilter: vi.fn().mockResolvedValue({
        document: { version: 1, root: null },
        fingerprint: "saved-filter-v1:test",
      }),
    };
    const saved = () =>
      request(
        JSON.stringify({ ...input, filter: { type: "saved", id: "filter-1" } }),
      );
    await expect(
      handlePlannedSiteCrossBreakdown(
        saved(),
        { ...principal, scopes: ["analytics:read", "analysis:read"] },
        "site-1",
        provider,
        {},
        definitions,
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(definitions.resolveTeamVisibleSavedFilter).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", id: "filter-1" }),
    );
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          saved(),
          principal,
          "site-1",
          provider,
          {},
          definitions,
        )
      ).status,
    ).toBe(403);

    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          request(),
          principal,
          "site-1",
          provider,
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          request(),
          principal,
          "site-1",
          provider,
          { deadlineMs: 1, now: () => 1 },
        )
      ).status,
    ).toBe(504);
  });

  it("uses DTO defaults and fails closed for definition and provider failures", async () => {
    const provider = reader();
    const defaulted = await handlePlannedSiteCrossBreakdown(
      request(
        JSON.stringify({
          timeRange: {
            kind: "absolute",
            from: input.timeRange.from,
            to: input.timeRange.to,
          },
          primaryDimension: input.primaryDimension,
          secondaryDimension: input.secondaryDimension,
        }),
      ),
      principal,
      "site-1",
      provider,
    );
    expect(defaulted.status).toBe(200);
    expect(provider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        primaryLimit: 5,
        secondaryLimit: 6,
        timeZone: "UTC",
      }),
    );

    const savedPrincipal: ApiKeyPrincipal = {
      ...principal,
      scopes: ["analytics:read", "analysis:read"],
    };
    const saved = () =>
      request(
        JSON.stringify({ ...input, filter: { type: "saved", id: "filter-1" } }),
      );
    for (const error of [
      new AnalysisDefinitionIntegrityError(),
      new Error("database unavailable"),
    ]) {
      const response = await handlePlannedSiteCrossBreakdown(
        saved(),
        savedPrincipal,
        "site-1",
        provider,
        {},
        { resolveTeamVisibleSavedFilter: vi.fn().mockRejectedValue(error) },
      );
      expect(response.status).toBe(500);
    }
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          saved(),
          savedPrincipal,
          "site-1",
          provider,
          {},
          {
            resolveTeamVisibleSavedFilter: vi
              .fn()
              .mockRejectedValue(new AnalysisDefinitionReadCancelledError()),
          },
        )
      ).status,
    ).toBe(499);

    let nowCalls = 0;
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          request(),
          principal,
          "site-1",
          provider,
          { deadlineMs: 1, now: () => (nowCalls++ === 0 ? 0 : 1) },
        )
      ).status,
    ).toBe(504);
    const aborting = new AbortController();
    const abortingProvider: SiteCrossBreakdownReader = async () => {
      aborting.abort();
      return { columns: [], rows: [], totalVisitors: 0 };
    };
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          request(),
          principal,
          "site-1",
          abortingProvider,
          { signal: aborting.signal },
        )
      ).status,
    ).toBe(499);
    const failing = vi
      .fn<SiteCrossBreakdownReader>()
      .mockRejectedValue(new Error("provider failure"));
    expect(
      (
        await handlePlannedSiteCrossBreakdown(
          request(),
          principal,
          "site-1",
          failing,
        )
      ).status,
    ).toBe(500);
  });
});
