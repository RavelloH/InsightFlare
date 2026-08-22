import { describe, expect, it, vi } from "vitest";

import {
  executeTypedBatch,
  type TypedBatchDispatchContext,
  type TypedBatchItem,
} from "@/lib/api-v1/typed-batch";

const principal = {
  keyId: "key-1",
  teamId: "team-1",
  prefix: "if_test",
  scopes: ["analytics:read" as const],
  siteIds: ["site-1"],
};

const input = {
  requests: [
    {
      id: "first",
      method: "POST" as const,
      path: "/api/v1/sites/site-1/analytics/overview",
      body: {},
    },
    {
      id: "second",
      method: "POST" as const,
      path: "/api/v1/sites/site-1/analytics/timeseries",
      body: {},
    },
  ],
};

describe("executeTypedBatch", () => {
  it("accepts the expanded 50-item request contract", async () => {
    const { TypedBatchRequestSchema } = await import("@/lib/api-v1/dto/batch");
    const requests = Array.from({ length: 50 }, (_, index) => ({
      id: `item-${index}`,
      method: "POST" as const,
      path: "/api/v1/sites/site-1/analytics/overview",
      body: {},
    }));

    expect(TypedBatchRequestSchema.safeParse({ requests }).success).toBe(true);
    expect(
      TypedBatchRequestSchema.safeParse({
        requests: [...requests, { ...requests[0], id: "item-50" }],
      }).success,
    ).toBe(false);
  });

  it("dispatches registry-backed POST children once, in input order, with partial failures", async () => {
    const dispatch = vi.fn(
      async (item: TypedBatchItem, _context: TypedBatchDispatchContext) =>
        new Response(JSON.stringify({ child: item.id }), {
          status: item.id === "first" ? 200 : 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      executeTypedBatch(
        new Request("https://app.test/api/v1/batch"),
        principal,
        input,
        { dispatch, maxConcurrency: 1 },
      ),
    ).resolves.toEqual({
      partialFailure: true,
      responses: [
        { id: "first", status: 200, body: { child: "first" } },
        { id: "second", status: 503, body: { child: "second" } },
      ],
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[1].principal).toBe(principal);
  });

  it("rejects nested batch, legacy mutation paths, and unregistered GET children before dispatch", async () => {
    const dispatch = vi.fn();
    await expect(
      executeTypedBatch(
        new Request("https://app.test/api/v1/batch"),
        principal,
        {
          requests: [
            { id: "nested", method: "POST", path: "/api/v1/batch" },
            {
              id: "mutation",
              method: "POST",
              path: "/api/v1/sites/site-1/funnels",
            },
            { id: "legacy", method: "GET", path: "/api/v1/capabilities" },
          ],
        },
        { dispatch },
      ),
    ).rejects.toMatchObject({
      code: "batch_child_not_allowed",
      itemIds: ["nested", "mutation", "legacy"],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("turns a weighted budget overrun into only that child's partial failure", async () => {
    const dispatch = vi.fn(async () => new Response("{}"));
    const response = await executeTypedBatch(
      new Request("https://app.test/api/v1/batch"),
      principal,
      input,
      { dispatch, maxWeight: 7 },
    );
    expect(response.responses).toEqual([
      { id: "first", status: 200, body: {} },
      {
        id: "second",
        status: 422,
        body: { error: { code: "budget_exceeded" } },
      },
    ]);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("bounds child output and reports an output payload failure locally", async () => {
    const response = await executeTypedBatch(
      new Request("https://app.test/api/v1/batch"),
      principal,
      {
        requests: [
          {
            id: "large-output",
            method: "POST",
            path: "/api/v1/sites/site-1/analytics/overview",
            body: {},
          },
        ],
      },
      {
        dispatch: async () =>
          new Response(JSON.stringify({ value: "x".repeat(65 * 1024) }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    expect(response.responses).toEqual([
      {
        id: "large-output",
        status: 413,
        body: { error: { code: "payload_too_large" } },
      },
    ]);
  });

  it("fails duplicate IDs at DTO validation before any batch work is scheduled", async () => {
    const { TypedBatchRequestSchema } = await import("@/lib/api-v1/dto/batch");
    expect(
      TypedBatchRequestSchema.safeParse({
        requests: [
          {
            id: "same",
            method: "POST",
            path: "/api/v1/sites/a/analytics/overview",
          },
          {
            id: "same",
            method: "POST",
            path: "/api/v1/sites/a/analytics/timeseries",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("normalizes realtime, saved-filter GET, 204, deadline, and internal child branches", async () => {
    const dispatch = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await executeTypedBatch(
      new Request("https://app.test/api/v1/batch"),
      principal,
      {
        requests: [
          {
            id: "saved",
            method: "GET",
            path: "/api/v1/sites/site-1/saved-filters",
          },
          {
            id: "realtime",
            method: "POST",
            path: "/api/v1/sites/site-1/analytics/realtime/snapshot",
            body: {
              page: { limit: 10 },
              timeRange: { from: "bad", to: "bad" },
            },
          },
        ],
      },
      { dispatch, maxConcurrency: 1 },
    );
    expect(result.responses[0]).toEqual({
      id: "saved",
      status: 204,
      body: null,
    });

    let clock = 100;
    const deadline = await executeTypedBatch(
      new Request("https://app.test/api/v1/batch"),
      principal,
      {
        requests: [
          {
            id: "deadline",
            method: "POST",
            path: "/api/v1/sites/site-1/analytics/overview",
            body: {},
          },
        ],
        deadlineMs: 1,
      },
      {
        maxConcurrency: 1,
        now: () => clock,
        dispatch: async () => {
          clock = 102;
          return new Response("{}", { status: 200 });
        },
      },
    );
    expect(deadline.responses[0]?.status).toBe(504);

    const internal = await executeTypedBatch(
      new Request("https://app.test/api/v1/batch"),
      principal,
      {
        requests: [
          {
            id: "internal",
            method: "POST",
            path: "/api/v1/sites/site-1/analytics/overview",
            body: {},
          },
        ],
      },
      {
        dispatch: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(internal.responses[0]?.status).toBe(500);
  });
});
