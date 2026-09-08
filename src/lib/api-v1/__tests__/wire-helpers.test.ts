import { describe, expect, it } from "vitest";

import {
  getRequestMeta,
  jsonError,
  jsonList,
  jsonSuccess,
  methodNotAllowed,
} from "@/lib/api-v1/wire-helpers";

describe("API v1 wire helpers", () => {
  it("creates request metadata and list envelopes", async () => {
    const request = new Request("https://app.test/api");
    const metadata = getRequestMeta(request);
    expect(metadata.requestId).toEqual(expect.any(String));
    expect(metadata.generatedAt).toEqual(expect.any(String));
    expect(getRequestMeta(null).requestId).toBeUndefined();

    const response = jsonList(["one"], {
      request,
      status: 201,
      links: { next: "/api?page=2" },
      meta: { source: "test" },
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: ["one"],
      links: { next: "/api?page=2" },
      meta: { source: "test" },
    });
  });

  it("serializes error details and the Allow header", async () => {
    const request = new Request("https://app.test/api");
    const error = jsonError(
      "validation_failed",
      "Invalid request",
      400,
      { field: "goalId" },
      request,
      [{ path: "goalId", code: "required", message: "Required" }],
    );
    expect(error.status).toBe(400);
    await expect(error.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        details: { field: "goalId" },
        issues: [{ path: "goalId", code: "required" }],
      },
    });

    const method = methodNotAllowed(request, "POST");
    expect(method.status).toBe(405);
    expect(method.headers.get("Allow")).toBe("POST");
    expect(jsonSuccess({ ok: true }).status).toBe(200);
  });
});
