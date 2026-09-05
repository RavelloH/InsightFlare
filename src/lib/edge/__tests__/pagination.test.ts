import { describe, expect, it } from "vitest";

import {
  decodePageCursor,
  encodePageCursor,
  pageResult,
  paginationBinding,
} from "@/lib/edge/analytics/providers/d1/internal/pagination";
import type { Env } from "@/lib/edge/types";

const secret = "pagination-test-secret";
const env = { DAILY_SALT_SECRET: secret } as Env;

function base64Url(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function sign(value: string): Promise<string> {
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
    new TextEncoder().encode(value),
  );
  return base64Url(String.fromCharCode(...new Uint8Array(signature)));
}

describe("D1 pagination cursor helpers", () => {
  it("binds, signs, and validates cursors", async () => {
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
    await expect(decodePageCursor(env, binding, cursor)).resolves.toEqual({
      pathname: "/docs",
      views: 3,
    });
    await expect(decodePageCursor(env, binding, null)).resolves.toBeNull();
    await expect(decodePageCursor(env, binding, undefined)).resolves.toBeNull();
    await expect(
      decodePageCursor(env, "other-binding", cursor),
    ).resolves.toBeNull();
    await expect(
      decodePageCursor(env, binding, `${cursor}.extra`),
    ).resolves.toBeNull();
    await expect(
      decodePageCursor(env, binding, cursor.replace(/\.[^.]+$/u, ".invalid")),
    ).resolves.toBeNull();
    await expect(encodePageCursor({} as Env, binding, "key")).rejects.toThrow(
      "data-unavailable",
    );
    await expect(
      decodePageCursor({} as Env, binding, cursor),
    ).resolves.toBeNull();
  });

  it("rejects malformed signed payloads and missing keys", async () => {
    const malformedPayload = base64Url("not-json");
    const malformedCursor = `${malformedPayload}.${await sign(malformedPayload)}`;
    await expect(
      decodePageCursor(env, "binding", malformedCursor),
    ).resolves.toBeNull();

    const missingKeyPayload = base64Url(JSON.stringify({ binding: "binding" }));
    const missingKeyCursor = `${missingKeyPayload}.${await sign(missingKeyPayload)}`;
    await expect(
      decodePageCursor(env, "binding", missingKeyCursor),
    ).resolves.toBeNull();
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
