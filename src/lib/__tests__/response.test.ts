import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bad,
  errorResponse,
  forb,
  getRequestId,
  j,
  jsonResponseFor,
  jsonResponseWith,
  na,
  nf,
  normalizeErrorMessage,
  readJsonResponse,
  toErrorCode,
  una,
} from "@/lib/response";

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("response helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("chooses stable request identifiers from headers before generating one", () => {
    expect(
      getRequestId(
        new Request("https://example.test", { headers: { "cf-ray": "ray-1" } }),
      ),
    ).toBe("ray-1");
    expect(
      getRequestId(
        new Request("https://example.test", {
          headers: { "x-request-id": "request-1" },
        }),
      ),
    ).toBe("request-1");

    const randomSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("12345678-1234-4234-9234-123456789abc");

    expect(getRequestId(null)).toBe("12345678-123");
    expect(randomSpy).toHaveBeenCalled();
  });

  it("formats JSON responses with optional metadata and headers", async () => {
    const simple = j({ ok: true }, 201, { "x-extra": "1" });
    expect(simple.status).toBe(201);
    expect(simple.headers.get("x-extra")).toBe("1");
    expect(await readJson(simple)).toEqual({ ok: true });

    const req = new Request("https://example.test", {
      headers: { "x-request-id": "request-2" },
    });
    const forRequest = await readJson(jsonResponseFor(req, { ok: true }));
    expect(forRequest).toMatchObject({ ok: true, requestId: "request-2" });
    expect(typeof forRequest.timestamp).toBe("string");

    const withoutContext = await readJson(
      jsonResponseWith(undefined, { ok: true }),
    );
    expect(withoutContext).toEqual({ ok: true });

    const withContext = await readJson(
      jsonResponseWith({ requestId: "ctx-1" }, { ok: true }, 202, {
        "x-context": "1",
      }),
    );
    expect(withContext).toMatchObject({ ok: true, requestId: "ctx-1" });
  });

  it("reuses internal JSON payloads and falls back for external responses", async () => {
    const internal = j({ rows: [{ value: 1 }] });
    const internalJson = vi.spyOn(internal, "json");

    await expect(readJsonResponse(internal)).resolves.toEqual({
      rows: [{ value: 1 }],
    });
    expect(internalJson).not.toHaveBeenCalled();

    const external = new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
    const externalJson = vi.spyOn(external, "json");

    await expect(readJsonResponse(external)).resolves.toEqual({ ok: true });
    expect(externalJson).toHaveBeenCalledTimes(1);
  });

  it("defers body serialization for structured internal responses", async () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const response = jsonResponseWith(
      { requestId: "internal-1", deferJsonSerialization: true },
      { rows: [{ value: 1 }] },
    );

    expect(stringify).not.toHaveBeenCalled();
    expect(await response.text()).toBe("");
    await expect(readJsonResponse(response)).resolves.toMatchObject({
      requestId: "internal-1",
      rows: [{ value: 1 }],
    });
  });

  it("normalizes error codes and common error response shortcuts", async () => {
    expect(toErrorCode(" Bad input! ")).toBe("bad_input");
    expect(toErrorCode("!!!")).toBe("error");
    expect(toErrorCode("A".repeat(80))).toHaveLength(64);

    await expect(readJson(bad("Bad input"))).resolves.toMatchObject({
      error: { code: "bad_input", message: "Bad input" },
      ok: false,
    });
    await expect(readJson(una())).resolves.toMatchObject({
      error: { code: "unauthorized", message: "Unauthorized" },
    });
    await expect(
      readJson(forb("No access", "no_access")),
    ).resolves.toMatchObject({
      error: { code: "no_access", message: "No access" },
    });
    await expect(readJson(nf())).resolves.toMatchObject({
      error: { code: "not_found", message: "Not Found" },
    });

    const methodNotAllowed = na();
    expect(methodNotAllowed.status).toBe(405);
    await expect(readJson(methodNotAllowed)).resolves.toMatchObject({
      error: { code: "method_not_allowed", message: "Method Not Allowed" },
    });
  });

  it("hides server error details in production and logs diagnostics", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = new Request("https://example.test/fail", {
      method: "POST",
      headers: { "x-request-id": "request-3" },
    });

    const response = errorResponse(req, 500, "boom", "Database exploded", {
      "x-error": "1",
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("x-error")).toBe("1");
    await expect(readJson(response)).resolves.toMatchObject({
      ok: false,
      requestId: "request-3",
      error: { code: "boom", message: "An internal error occurred" },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"api_error"'),
    );
  });

  it("extracts nested JSON error messages when available", () => {
    expect(
      normalizeErrorMessage(
        new Error('request failed {"message":"Clean message"}'),
      ),
    ).toBe("Clean message");
    expect(
      normalizeErrorMessage('request failed {"error":"Clean error"}'),
    ).toBe("Clean error");
    expect(normalizeErrorMessage("request failed {bad json")).toBe(
      "request failed {bad json",
    );
    expect(normalizeErrorMessage(42)).toBe("42");
  });
});
