import { describe, expect, it, vi } from "vitest";

import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
} from "@/lib/api-v1/analysis-definition-reader";
import {
  type ComparisonBreakdownReader,
  handleSiteComparisonBreakdown,
} from "@/lib/api-v1/comparison-breakdown-handler";
import { AnalyticsComparisonBreakdownResponseSchema } from "@/lib/api-v1/wire";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const principal: ApiKeyPrincipal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "prefix",
  scopes: ["analytics:read"],
  siteIds: ["site-1"],
  status: "active",
};

const input = {
  mode: "explicit",
  timeZone: "UTC",
  a: {
    timeRange: {
      kind: "absolute",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    },
  },
  b: {
    timeRange: {
      kind: "absolute",
      from: "2026-07-31T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
  },
  query: {
    limit: 20,
    sort: { metric: "sessions", side: "b", direction: "desc" },
  },
};

function request(body: unknown = input, init: RequestInit = {}) {
  return new Request(
    "https://app.test/api/v1/sites/site-1/analytics/comparison/breakdowns/page.path",
    {
      ...init,
      method: "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: JSON.stringify(body),
    },
  );
}

describe("site comparison breakdown HTTP adapter", () => {
  it.each([
    [
      new Request("https://app.test", { method: "GET" }),
      principal,
      "page.path",
      405,
    ],
    [
      request(input, { headers: { "content-encoding": "gzip" } }),
      principal,
      "page.path",
      415,
    ],
    [
      request(input, { headers: { accept: "text/html" } }),
      principal,
      "page.path",
      406,
    ],
    [request(input), { ...principal, scopes: [] }, "page.path", 403],
    [request(input), principal, "unknown-dimension", 400],
    [request({}), principal, "page.path", 400],
  ])(
    "rejects invalid HTTP input before breakdown execution",
    async (httpRequest, inputPrincipal, dimension, status) => {
      const reader = vi.fn<ComparisonBreakdownReader>();
      const response = await handleSiteComparisonBreakdown(
        httpRequest,
        inputPrincipal,
        "site-1",
        dimension,
        reader,
        {},
      );
      expect(response.status).toBe(status);
      expect(reader).not.toHaveBeenCalled();
    },
  );

  it("unions A/B keys before sorting and emits zero-filled additive metrics", async () => {
    const reader = vi
      .fn<ComparisonBreakdownReader>()
      .mockResolvedValueOnce({
        items: [
          {
            key: "/a",
            label: "/a",
            views: 10,
            sessions: 1,
            visitors: 1,
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            key: "/b",
            label: "/b",
            views: 5,
            sessions: 9,
            visitors: 2,
          },
        ],
      });

    const response = await handleSiteComparisonBreakdown(
      request(),
      principal,
      "site-1",
      "page.path",
      reader,
      { capturedAtMs: Date.parse("2026-08-02T00:00:00.000Z") },
    );
    const body = (await response.json()) as {
      readonly data: { readonly items: readonly unknown[] };
    };

    expect(response.status).toBe(200);
    expect(
      AnalyticsComparisonBreakdownResponseSchema.safeParse(body).success,
    ).toBe(true);
    expect(body.data.items).toMatchObject([
      {
        key: "/b",
        a: { views: 0, sessions: 0, visitors: 0 },
        b: { views: 5, sessions: 9, visitors: 2 },
        delta: { sessions: { absolute: -9, relative: -1 } },
      },
      {
        key: "/a",
        b: { views: 0, sessions: 0, visitors: 0 },
        delta: { views: { absolute: 10, relative: null } },
      },
    ]);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("rejects saved references without analysis:read before executing either side", async () => {
    const reader = vi.fn<ComparisonBreakdownReader>();
    const response = await handleSiteComparisonBreakdown(
      request({
        ...input,
        a: { ...input.a, filter: { type: "saved", id: "filter-1" } },
      }),
      principal,
      "site-1",
      "page.path",
      reader,
      {},
    );
    expect(response.status).toBe(403);
    expect(reader).not.toHaveBeenCalled();
  });

  it("maps site authorization, cancellation, and deadline before either side", async () => {
    const reader = vi.fn<ComparisonBreakdownReader>();
    const cases: readonly [
      ApiKeyPrincipal,
      Parameters<typeof handleSiteComparisonBreakdown>[5],
      number,
    ][] = [
      [{ ...principal, siteIds: ["site-2"] }, {}, 404],
      [principal, { now: () => 10, deadlineMs: 10 }, 504],
    ];
    for (const [inputPrincipal, context, status] of cases) {
      expect(
        (
          await handleSiteComparisonBreakdown(
            request(),
            inputPrincipal,
            "site-1",
            "page.path",
            reader,
            context,
          )
        ).status,
      ).toBe(status);
    }
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await handleSiteComparisonBreakdown(
          request(),
          principal,
          "site-1",
          "page.path",
          reader,
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
    expect(reader).not.toHaveBeenCalled();
  });

  it("keeps protocol negotiation and saved-filter failures explicit", async () => {
    const savedPrincipal: ApiKeyPrincipal = {
      ...principal,
      scopes: ["analytics:read", "analysis:read"],
    };
    const savedInput = {
      ...input,
      a: { ...input.a, filter: { type: "saved" as const, id: "filter-1" } },
    };
    const reader = vi.fn<ComparisonBreakdownReader>();

    const method = await handleSiteComparisonBreakdown(
      new Request("https://app.test", { method: "GET" }),
      principal,
      "site-1",
      "page.path",
      reader,
      {},
    );
    expect(method.headers.get("Allow")).toBe("POST");

    for (const accept of ["application/*", "*/*"]) {
      const response = await handleSiteComparisonBreakdown(
        request(input, { headers: { accept } }),
        principal,
        "site-1",
        "page.path",
        vi.fn<ComparisonBreakdownReader>().mockResolvedValue({ items: [] }),
        {},
      );
      expect(response.status).toBe(200);
    }

    expect(
      (
        await handleSiteComparisonBreakdown(
          request(savedInput),
          savedPrincipal,
          "site-1",
          "page.path",
          reader,
          {},
        )
      ).status,
    ).toBe(404);

    for (const error of [
      new AnalysisDefinitionIntegrityError(),
      new Error("definition backend unavailable"),
    ]) {
      expect(
        (
          await handleSiteComparisonBreakdown(
            request(savedInput),
            savedPrincipal,
            "site-1",
            "page.path",
            reader,
            {},
            {
              resolveTeamVisibleSavedFilter: vi.fn().mockRejectedValue(error),
            },
          )
        ).status,
      ).toBe(500);
    }
    expect(
      (
        await handleSiteComparisonBreakdown(
          request(savedInput),
          savedPrincipal,
          "site-1",
          "page.path",
          reader,
          {},
          {
            resolveTeamVisibleSavedFilter: vi
              .fn()
              .mockRejectedValue(new AnalysisDefinitionReadCancelledError()),
          },
        )
      ).status,
    ).toBe(499);
    expect(reader).not.toHaveBeenCalled();
  });

  it("does not emit comparison data after a provider failure or cancellation", async () => {
    const failed = vi
      .fn<ComparisonBreakdownReader>()
      .mockRejectedValue(new Error("provider unavailable"));
    expect(
      (
        await handleSiteComparisonBreakdown(
          request(),
          principal,
          "site-1",
          "page.path",
          failed,
          {},
        )
      ).status,
    ).toBe(500);

    const controller = new AbortController();
    const aborting: ComparisonBreakdownReader = async () => {
      controller.abort();
      throw new Error("request cancelled");
    };
    expect(
      (
        await handleSiteComparisonBreakdown(
          request(),
          principal,
          "site-1",
          "page.path",
          aborting,
          { signal: controller.signal },
        )
      ).status,
    ).toBe(499);
  });
});
