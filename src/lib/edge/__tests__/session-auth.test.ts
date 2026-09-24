import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractSessionToken,
  requireSession,
  verifySessionToken,
} from "@/lib/edge/auth/session-auth";
import type { Env } from "@/lib/edge/types";
function base64UrlEncode(input: string | Uint8Array): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
async function createToken(payload: unknown, secret: string): Promise<string> {
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
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
    new TextEncoder().encode(payloadPart),
  );
  return `${payloadPart}.${base64UrlEncode(new Uint8Array(signature))}`;
}
function requestWithHeaders(headers: Record<string, string>): Request {
  return {
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  } as unknown as Request;
}
describe("edge session authentication", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("extracts bearer tokens before cookie tokens", () => {
    const request = new Request("https://example.test", {
      headers: {
        authorization: "Bearer bearer-token",
        cookie: `if_session=${encodeURIComponent("cookie-token")}`,
      },
    });

    expect(extractSessionToken(request)).toBe("bearer-token");
  });

  it("extracts URL-decoded session cookie tokens when bearer auth is absent", () => {
    const request = requestWithHeaders({
      cookie: `theme=dark; if_session=${encodeURIComponent(
        "payload.signature==",
      )}; other=1`,
    });

    expect(extractSessionToken(request)).toBe("payload.signature==");
  });

  it("verifies valid HMAC session tokens and normalizes claims", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T12:00:00Z"));
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = await createToken(
      {
        userId: "user-1",
        username: "admin",
        displayName: "Admin User",
        systemRole: "admin",
        exp,
      },
      await import("@/lib/secrets").then(({ deriveSecret, SECRET_PURPOSES }) =>
        deriveSecret("root-secret", SECRET_PURPOSES.dashboardSession),
      ),
    );

    await expect(
      verifySessionToken(token, {
        MAIN_SECRET: "root-secret",
      } as Env),
    ).resolves.toEqual({
      userId: "user-1",
      username: "admin",
      displayName: "Admin User",
      systemRole: "admin",
      exp,
    });
  });

  it("uses root-derived secrets and defaults non-admin roles to user", async () => {
    const secret = await import("@/lib/secrets").then(
      ({ deriveSecret, SECRET_PURPOSES }) =>
        deriveSecret("root-secret", SECRET_PURPOSES.dashboardSession),
    );
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = await createToken(
      {
        userId: "user-2",
        username: "member",
        displayName: "",
        systemRole: "owner",
        exp,
      },
      secret,
    );

    await expect(
      verifySessionToken(token, {
        MAIN_SECRET: "root-secret",
      } as Env),
    ).resolves.toMatchObject({
      userId: "user-2",
      username: "member",
      systemRole: "user",
    });
  });

  it("reuses the imported verification key across requests", async () => {
    const root = `session-cache-${crypto.randomUUID()}`;
    const secret = await import("@/lib/secrets").then(
      ({ deriveSecret, SECRET_PURPOSES }) =>
        deriveSecret(root, SECRET_PURPOSES.dashboardSession),
    );
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = await createToken(
      { userId: "user-cache", username: "cached", exp },
      secret,
    );
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await verifySessionToken(token, { MAIN_SECRET: root } as Env);
    await verifySessionToken(token, { MAIN_SECRET: root } as Env);

    expect(importKey).toHaveBeenCalledTimes(2);
    importKey.mockRestore();
  });

  it("coalesces failed imports, clears them, and retries", async () => {
    const root = `session-retry-${crypto.randomUUID()}`;
    const secret = await import("@/lib/secrets").then(
      ({ dashboardSessionSecret }) =>
        dashboardSessionSecret({ MAIN_SECRET: root }),
    );
    expect(secret).toBeTruthy();
    const token = await createToken(
      {
        userId: "user-retry",
        username: "retry",
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      secret!,
    );
    const importKey = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValueOnce(new Error("import failed"));

    const attempts = await Promise.allSettled([
      verifySessionToken(token, { MAIN_SECRET: root } as Env),
      verifySessionToken(token, { MAIN_SECRET: root } as Env),
    ]);

    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    await expect(
      verifySessionToken(token, { MAIN_SECRET: root } as Env),
    ).resolves.toMatchObject({ userId: "user-retry" });
    expect(importKey).toHaveBeenCalledTimes(2);
    importKey.mockRestore();
  });

  it("rejects malformed, tampered, incomplete, and expired tokens", async () => {
    const env = { MAIN_SECRET: "root-secret" } as Env;
    const secret = await import("@/lib/secrets").then(
      ({ deriveSecret, SECRET_PURPOSES }) =>
        deriveSecret("root-secret", SECRET_PURPOSES.dashboardSession),
    );
    const validPayload = {
      userId: "user-1",
      username: "admin",
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const token = await createToken(validPayload, secret);
    const [payloadPart, signaturePart] = token.split(".");
    const expired = await createToken(
      { ...validPayload, exp: Math.floor(Date.now() / 1000) - 1 },
      secret,
    );
    const missingUser = await createToken(
      { username: "admin", exp: validPayload.exp },
      secret,
    );
    const invalidPayload = await createToken(null, secret);

    await expect(verifySessionToken("", env)).resolves.toBeNull();
    await expect(verifySessionToken("too-short", env)).resolves.toBeNull();
    await expect(
      verifySessionToken(`${payloadPart}.not-valid-base64`, env),
    ).resolves.toBeNull();
    await expect(
      verifySessionToken(`${payloadPart}x.${signaturePart}`, env),
    ).resolves.toBeNull();
    await expect(verifySessionToken(expired, env)).resolves.toBeNull();
    await expect(verifySessionToken(missingUser, env)).resolves.toBeNull();
    await expect(verifySessionToken(invalidPayload, env)).resolves.toBeNull();
  });

  it("requires a session token from requests", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const secret = await import("@/lib/secrets").then(
      ({ deriveSecret, SECRET_PURPOSES }) =>
        deriveSecret("root-secret", SECRET_PURPOSES.dashboardSession),
    );
    const token = await createToken(
      { userId: "user-1", username: "admin", exp },
      secret,
    );
    const env = { MAIN_SECRET: "root-secret" } as Env;

    await expect(
      requireSession(
        requestWithHeaders({
          cookie: `if_session=${encodeURIComponent(token)}`,
        }),
        env,
      ),
    ).resolves.toMatchObject({ userId: "user-1", username: "admin" });
    await expect(
      requireSession(new Request("https://example.test"), env),
    ).resolves.toBeNull();
  });

  it("throws for signed session tokens when no root secret is configured", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const secret = await import("@/lib/secrets").then(
      ({ deriveSecret, SECRET_PURPOSES }) =>
        deriveSecret("root-secret", SECRET_PURPOSES.dashboardSession),
    );
    const token = await createToken(
      { userId: "user-1", username: "admin", exp },
      secret,
    );

    await expect(verifySessionToken(token, {} as Env)).rejects.toThrow(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for sessions",
    );
  });
});
