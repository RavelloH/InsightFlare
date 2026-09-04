import { describe, expect, it, vi } from "vitest";

import { createTestProviderRegistry } from "@/lib/api-v1/__tests__/provider-registry";
import {
  handleTeamBreakdown,
  type TeamBreakdownReader,
} from "@/lib/api-v1/team-breakdown-handler";
import {
  AnalyticsBreakdownResponseSchema,
  ApiV1ErrorEnvelopeSchema,
} from "@/lib/api-v1/wire";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};

function request(body: unknown = input, init: RequestInit = {}) {
  const method = init.method ?? "POST";
  return new Request(
    "https://app.test/api/v1/team/analytics/breakdowns/page.path",
    {
      ...init,
      method,
      headers: { "Content-Type": "application/json", ...init.headers },
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: JSON.stringify(body) }),
    },
  );
}

const input = {
  timeRange: {
    kind: "absolute",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    timeZone: "UTC",
  },
  limit: 20,
};

function reader() {
  return vi.fn<TeamBreakdownReader>().mockResolvedValue({
    items: [
      {
        key: "/pricing",
        label: "/pricing",
        views: 10,
        sessions: 4,
        visitors: 3,
      },
    ],
  });
}

describe("team breakdown HTTP adapter", () => {
  it("uses principal-derived team access and serializes the typed envelope", async () => {
    const provider = reader();
    const response = await handleTeamBreakdown(
      request(),
      principal,
      "page.path",
      createTestProviderRegistry(provider),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(AnalyticsBreakdownResponseSchema.safeParse(body).success).toBe(true);
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        allowedSiteIds: ["site-1"],
        dimension: "page.path",
        limit: 20,
      }),
    );
  });

  it("rejects protocol, permission, dimension, cancellation, and deadline failures", async () => {
    const provider = reader();
    const aborted = new AbortController();
    aborted.abort();
    const candidates = [
      [request(input, { method: "GET" }), principal, "page.path", {}],
      [
        request(input, { headers: { "Content-Type": "text/plain" } }),
        principal,
        "page.path",
        {},
      ],
      [
        request(input, { headers: { Accept: "text/plain" } }),
        principal,
        "page.path",
        {},
      ],
      [request({ ...input, limit: 0 }), principal, "page.path", {}],
      [
        request(),
        { ...principal, scopes: [] as ApiKeyPrincipal["scopes"] },
        "page.path",
        {},
      ],
      [request(), principal, "not-a-dimension", {}],
      [request(), principal, "page.path", { signal: aborted.signal }],
      [request(), principal, "page.path", { deadlineMs: 1, now: () => 1 }],
    ] as const;
    for (const [
      candidate,
      candidatePrincipal,
      dimension,
      context,
    ] of candidates) {
      const response = await handleTeamBreakdown(
        candidate,
        candidatePrincipal,
        dimension,
        createTestProviderRegistry(provider),
        context,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        ApiV1ErrorEnvelopeSchema.safeParse(await response.json()).success,
      ).toBe(true);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it("covers filter parsing, post-provider cancellation, and service errors", async () => {
    const provider = reader();
    const method = await handleTeamBreakdown(
      request(input, { method: "GET" }),
      principal,
      "page.path",
      createTestProviderRegistry(provider),
    );
    expect(method.headers.get("Allow")).toBe("POST");

    const invalidFilter = await handleTeamBreakdown(
      request({
        ...input,
        filter: {
          type: "inline",
          expression: {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "not-a-real-operator",
            value: "/pricing",
          },
        },
      }),
      principal,
      "page.path",
      createTestProviderRegistry(provider),
    );
    expect(invalidFilter.status).toBe(400);

    const dslFilter = await handleTeamBreakdown(
      request({
        ...input,
        scope: "session",
        filter: { type: "dsl", expression: 'geo.country eq "US"' },
      }),
      principal,
      "page.path",
      createTestProviderRegistry(provider),
    );
    expect(dslFilter.status).toBe(200);
    expect(provider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scopePreference: "session",
        filters: {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "geo.country" },
            operator: "eq",
            value: "us",
          },
        },
      }),
    );

    const unrestricted = await handleTeamBreakdown(
      request(),
      { ...principal, siteIds: [] },
      "page.path",
      createTestProviderRegistry(provider),
    );
    expect(unrestricted.status).toBe(200);
    expect(provider).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowedSiteIds: undefined }),
    );

    const controller = new AbortController();
    const aborting: TeamBreakdownReader = async () => {
      controller.abort();
      return { items: [] };
    };
    expect(
      (
        await handleTeamBreakdown(
          request(),
          principal,
          "page.path",
          createTestProviderRegistry(aborting),
          {
            signal: controller.signal,
          },
        )
      ).status,
    ).toBe(499);

    const failing = vi
      .fn<TeamBreakdownReader>()
      .mockRejectedValue(new Error("provider unavailable"));
    expect(
      (
        await handleTeamBreakdown(
          request(),
          principal,
          "page.path",
          createTestProviderRegistry(failing),
        )
      ).status,
    ).toBe(500);
  });

  it("honors content encoding, key status, and JSON wildcard negotiation", async () => {
    const provider = reader();
    expect(
      (
        await handleTeamBreakdown(
          request(input, { headers: { "content-encoding": "gzip" } }),
          principal,
          "page.path",
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handleTeamBreakdown(
          request(),
          { ...principal, status: "revoked" },
          "page.path",
          createTestProviderRegistry(provider),
        )
      ).status,
    ).toBe(403);
    for (const accept of ["application/*", "*/*"]) {
      expect(
        (
          await handleTeamBreakdown(
            request(input, { headers: { accept } }),
            principal,
            "page.path",
            createTestProviderRegistry(reader()),
          )
        ).status,
      ).toBe(200);
    }
  });
});
