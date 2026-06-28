import { describe, expect, it, vi } from "vitest";

import { handleAdminWs } from "@/lib/edge/admin-ws";

function bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function toArrayBuffer(input: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(input.length);
  out.set(input);
  return out.buffer;
}

function base64UrlEncode(input: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < input.length; i += 1) {
    binary += String.fromCharCode(input[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function hmacSha256(
  message: string,
  secret: string,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(bytes(message)),
  );
  return new Uint8Array(sig);
}

async function sessionToken(
  claims: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const payload = base64UrlEncode(bytes(JSON.stringify(claims)));
  const signature = await hmacSha256(payload, secret);
  return `${payload}.${base64UrlEncode(signature)}`;
}

function dbWithRows(rows: Record<string, unknown>[]) {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => rows.shift() ?? null),
      })),
    })),
  };
}

describe("handleAdminWs", () => {
  it("rejects requests when session secrets or tokens are invalid", async () => {
    const unavailable = await handleAdminWs(
      new Request("https://app.test/admin/ws?siteId=site-1"),
      { DB: dbWithRows([]), INGEST_DO: {} } as any,
    );
    expect(unavailable.status).toBe(503);

    const unauthorized = await handleAdminWs(
      new Request("https://app.test/admin/ws?siteId=site-1", {
        headers: { authorization: "Bearer invalid" },
      }),
      { MAIN_SECRET: "root", DB: dbWithRows([]), INGEST_DO: {} } as any,
    );
    expect(unauthorized.status).toBe(401);
  });

  it("checks site access and forwards websocket requests to the ingest DO", async () => {
    const secret = "dashboard-secret";
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "admin",
        systemRole: "admin",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );
    const fetchMock = vi.fn(async (_request: Request) =>
      Promise.resolve(new Response("upgraded")),
    );
    const env = {
      DASHBOARD_SESSION_SECRET: secret,
      DB: dbWithRows([{ id: "site-1" }]),
      INGEST_DO: {
        idFromName: vi.fn(() => "do-id"),
        get: vi.fn(() => ({ fetch: fetchMock })),
      },
    };

    const response = await handleAdminWs(
      new Request("https://app.test/admin/ws?siteId=site-1&token=client", {
        headers: { authorization: `Bearer ${token}` },
      }),
      env as any,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("upgraded");
    expect(env.INGEST_DO.idFromName).toHaveBeenCalledWith("site-1");
    expect(fetchMock).toHaveBeenCalledWith(expect.any(Request));
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe(
      "https://ingest.internal/ws?siteId=site-1&token=client",
    );
  });

  it("rejects missing and unauthorized site ids", async () => {
    const secret = "dashboard-secret";
    const token = await sessionToken(
      {
        userId: "user-1",
        username: "user",
        systemRole: "user",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret,
    );
    const headers = { authorization: `Bearer ${token}` };

    const missing = await handleAdminWs(
      new Request("https://app.test/admin/ws", { headers }),
      {
        DASHBOARD_SESSION_SECRET: secret,
        DB: dbWithRows([]),
        INGEST_DO: {},
      } as any,
    );
    expect(missing.status).toBe(400);

    const forbidden = await handleAdminWs(
      new Request("https://app.test/admin/ws?siteId=site-1", { headers }),
      {
        DASHBOARD_SESSION_SECRET: secret,
        DB: dbWithRows([null as any]),
        INGEST_DO: {},
      } as any,
    );
    expect(forbidden.status).toBe(403);
  });
});
