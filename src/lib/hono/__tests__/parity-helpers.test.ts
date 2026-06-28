import { describe, expect, it } from "vitest";

import {
  expectResponsesToMatch,
  normalizeResponse,
} from "@/lib/hono/__tests__/parity-helpers";

describe("Hono parity helpers", () => {
  it("normalizes dynamic JSON fields and session cookie values", async () => {
    const first = new Response(
      JSON.stringify({
        ok: true,
        requestId: "a",
        timestamp: "2026-01-01T00:00:00.000Z",
        data: { id: "site-1", now: "dynamic" },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie":
            "if_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400",
        },
      },
    );
    const second = new Response(
      JSON.stringify({
        ok: true,
        requestId: "b",
        timestamp: "2026-01-02T00:00:00.000Z",
        data: { id: "site-1", now: "other" },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie":
            "if_session=xyz; Path=/; HttpOnly; SameSite=Lax; Max-Age=10",
        },
      },
    );

    await expectResponsesToMatch(first, second);
  });

  it("keeps status, compared headers, and non-json body text strict", async () => {
    const normalized = await normalizeResponse(
      new Response("plain", {
        status: 206,
        headers: {
          "content-range": "bytes 0-4/10",
          "content-length": "5",
        },
      }),
    );

    expect(normalized).toEqual({
      status: 206,
      headers: {
        "content-length": "5",
        "content-range": "bytes 0-4/10",
        "content-type": "text/plain;charset=UTF-8",
      },
      bodyText: "plain",
      json: null,
    });
  });
});
