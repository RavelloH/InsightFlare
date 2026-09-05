import { describe, expect, it, vi } from "vitest";

import {
  decodePageCursor,
  encodePageCursor,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  pageResponse,
  pageResult,
  paginationBinding,
  paginationBindingForWindow,
} from "@/lib/edge/analytics/providers/d1/internal/pagination";
import type { Env } from "@/lib/edge/types";

const secret = "pagination-test-secret";
const env = { DAILY_SALT_SECRET: secret } as Env;
const decodeKey = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.pathname === "string" &&
    Number.isSafeInteger(candidate.views)
    ? { pathname: candidate.pathname, views: candidate.views as number }
    : null;
};

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function signedCursor(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base64Url(new TextEncoder().encode(payload))),
  );
  const encodedPayload = base64Url(new TextEncoder().encode(payload));
  return `${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
}

describe("D1 pagination cursor helpers", () => {
  it("binds, signs, validates, and decodes versioned cursors", async () => {
    const binding = await paginationBinding([
      "pages",
      "private-dashboard",
      "site-1",
      { from: 1, to: 2 },
    ]);
    const cursor = await encodePageCursor(env, binding, {
      pathname: "/docs",
      views: 3,
    });

    expect(binding).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      decodePageCursor(env, binding, cursor, "pages", decodeKey),
    ).resolves.toEqual({ pathname: "/docs", views: 3 });
    await expect(
      decodePageCursor(env, binding, null, "pages", decodeKey),
    ).resolves.toBeNull();
    await expect(paginationBinding(["pages", undefined])).resolves.toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("rejects binding, signature, envelope, and payload-shape errors", async () => {
    const binding = await paginationBinding(["pages", "site-1"]);
    const cursor = await encodePageCursor(env, binding, {
      pathname: "/docs",
      views: 3,
    });
    const invalid = (promise: Promise<unknown>) =>
      expect(promise).rejects.toBeInstanceOf(InvalidCursorError);

    await invalid(
      decodePageCursor(env, "other-binding", cursor, "pages", decodeKey),
    );
    await invalid(
      decodePageCursor(env, binding, `${cursor}.extra`, "pages", decodeKey),
    );
    await invalid(
      decodePageCursor(
        env,
        binding,
        cursor.replace(/\.[^.]+$/u, ".invalid"),
        "pages",
        decodeKey,
      ),
    );
    await expect(
      decodePageCursor(env, binding, "a.b", "pages", decodeKey),
    ).rejects.toMatchObject({ cursorKind: "pages" });

    const extraEnvelopeField = await signedCursor(
      JSON.stringify({
        v: 1,
        binding,
        key: { pathname: "/docs", views: 3 },
        extra: true,
      }),
    );
    await invalid(
      decodePageCursor(env, binding, extraEnvelopeField, "pages", decodeKey),
    );

    const staleVersion = await signedCursor(
      JSON.stringify({
        v: 0,
        binding,
        key: { pathname: "/docs", views: 3 },
      }),
    );
    await invalid(
      decodePageCursor(env, binding, staleVersion, "pages", decodeKey),
    );

    const invalidKey = await signedCursor(
      JSON.stringify({ v: 1, binding, key: { pathname: "/docs" } }),
    );
    await invalid(
      decodePageCursor(env, binding, invalidKey, "pages", decodeKey),
    );
  });

  it("enforces encoded cursor size limits and returns canonical page results", async () => {
    const binding = await paginationBinding(["pages", "site-1"]);
    await expect(
      encodePageCursor(env, binding, { value: "x".repeat(9_000) }),
    ).rejects.toThrow("cursor-payload-too-large");

    const signSpy = vi
      .spyOn(crypto.subtle, "sign")
      .mockResolvedValue(new ArrayBuffer(MAX_CURSOR_LENGTH));
    try {
      await expect(encodePageCursor(env, binding, "key")).rejects.toThrow(
        "cursor-too-large",
      );
    } finally {
      signSpy.mockRestore();
    }

    expect(pageResponse([1, 2], 2, null)).toEqual({
      items: [1, 2],
      pagination: { limit: 2, returned: 2, hasMore: false, nextCursor: null },
    });
  });

  it("uses an API request binding override without changing semantic bindings", async () => {
    await expect(
      paginationBindingForWindow({ paginationBinding: "request-binding" }, [
        "ignored",
        Date.now(),
      ]),
    ).resolves.toBe("request-binding");

    const semanticBinding = await paginationBindingForWindow({}, [
      "pages",
      "site-1",
    ]);
    expect(semanticBinding).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("fails closed when signing material is unavailable", async () => {
    const binding = await paginationBinding(["pages"]);
    await expect(encodePageCursor({} as Env, binding, "key")).rejects.toThrow(
      "data-unavailable",
    );
    await expect(
      decodePageCursor({} as Env, binding, "a.b", "pages", () => "key"),
    ).rejects.toThrow("data-unavailable");
  });

  it("splits an extra row into a page and preserves the final row", () => {
    expect(pageResult([1, 2, 3], 2)).toEqual({
      rows: [1, 2],
      hasMore: true,
      last: 2,
    });
    expect(pageResult([1, 2], 2)).toEqual({
      rows: [1, 2],
      hasMore: false,
      last: 2,
    });
    expect(pageResult([], 2)).toEqual({
      rows: [],
      hasMore: false,
      last: undefined,
    });
  });
});
