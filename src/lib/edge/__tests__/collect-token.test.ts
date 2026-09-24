import { afterEach, describe, expect, it } from "vitest";

import {
  COLLECT_TOKEN_TTL_SECONDS,
  issueCollectToken,
  requestIp,
  verifyCollectToken,
} from "@/lib/edge/auth/collect-token";
import { setE2eClock } from "@/lib/edge/runtime/e2e-clock";
import { collectTokenSigningSecret } from "@/lib/secrets";
const env = { MAIN_SECRET: "main-secret" };
const CLOCK_KEY = "__insightflare_e2e_clock__";
afterEach(() => {
  Reflect.deleteProperty(globalThis, CLOCK_KEY);
});
function b64u(input: unknown): string {
  const json = typeof input === "string" ? input : JSON.stringify(input);
  let binary = "";
  for (const byte of new TextEncoder().encode(json)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function b64uBytes(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
async function signToken(input: {
  env: { MAIN_SECRET?: string; DAILY_SALT_SECRET?: string };
  header?: unknown;
  payload: unknown;
}): Promise<string> {
  const header = b64u(
    "header" in input
      ? input.header
      : { alg: "HS256", typ: "JWT", kid: "collect-v1" },
  );
  const payload = b64u(input.payload);
  const secret = await collectTokenSigningSecret(input.env);
  if (!secret) throw new Error("missing test signing secret");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${b64uBytes(signature)}`;
}
describe("collect token", () => {
  it("issues and verifies IP-bound JWT collect tokens", async () => {
    const token = await issueCollectToken({
      env,
      siteId: "site-1",
      ip: " 203.0.113.7 ",
      nowSeconds: 1000,
    });

    const result = await verifyCollectToken({
      env,
      token,
      siteId: "site-1",
      ip: "203.0.113.7",
      nowSeconds: 1001,
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        aud: "collect",
        siteId: "site-1",
        ip: "203.0.113.7",
        iat: 1000,
        exp: 1000 + COLLECT_TOKEN_TTL_SECONDS,
      },
    });
  });

  it("uses the controlled E2E clock when callers do not supply a time", async () => {
    setE2eClock(1_000_000);
    const token = await issueCollectToken({
      env,
      siteId: "site-1",
      ip: "203.0.113.7",
    });

    await expect(
      verifyCollectToken({
        env,
        token,
        siteId: "site-1",
        ip: "203.0.113.7",
      }),
    ).resolves.toMatchObject({
      ok: true,
      payload: { exp: 1_000 + COLLECT_TOKEN_TTL_SECONDS, iat: 1_000 },
    });
  });

  it("extracts request IPs from Cloudflare and proxy headers", () => {
    expect(
      requestIp(
        new Request("https://collector.test/collect", {
          headers: {
            "cf-connecting-ip": "203.0.113.1",
            "x-forwarded-for": "203.0.113.2, 203.0.113.3",
            "x-real-ip": "203.0.113.4",
          },
        }),
      ),
    ).toBe("203.0.113.1");
    expect(
      requestIp(
        new Request("https://collector.test/collect", {
          headers: { "x-forwarded-for": "203.0.113.2, 203.0.113.3" },
        }),
      ),
    ).toBe("203.0.113.2");
    expect(
      requestIp(
        new Request("https://collector.test/collect", {
          headers: { "x-real-ip": "203.0.113.4" },
        }),
      ),
    ).toBe("203.0.113.4");
    expect(requestIp(new Request("https://collector.test/collect"))).toBe(
      "0.0.0.0",
    );
  });

  it("rejects malformed, tampered, and mismatched tokens", async () => {
    const token = await issueCollectToken({
      env,
      siteId: "site-1",
      ip: "203.0.113.7",
      nowSeconds: 1000,
    });
    const [header, payload, signature] = token.split(".");
    const wrongHeader = b64u({ alg: "none", typ: "JWT", kid: "collect-v1" });
    const wrongAudience = b64u({
      aud: "other",
      siteId: "site-1",
      ip: "203.0.113.7",
      iat: 1000,
      exp: 1000 + COLLECT_TOKEN_TTL_SECONDS,
    });

    const cases: Array<[string, string, number?]> = [
      ["", "missing_collect_token"],
      ["not.jwt", "invalid_collect_token_format"],
      [
        `${wrongHeader}.${payload}.${signature}`,
        "invalid_collect_token_header",
      ],
      [`${header}.${payload}.%%%`, "invalid_collect_token_signature_encoding"],
      [
        `${header}.${payload}.${signature.slice(1)}x`,
        "invalid_collect_token_signature",
      ],
      [
        `${header}.${wrongAudience}.${signature}`,
        "invalid_collect_token_signature",
      ],
      [token, "expired_collect_token", 1000 + COLLECT_TOKEN_TTL_SECONDS],
      [token, "future_collect_token", 939],
    ];

    for (const [candidate, reason, nowSeconds] of cases) {
      await expect(
        verifyCollectToken({
          env,
          token: candidate,
          siteId: "site-1",
          ip: "203.0.113.7",
          nowSeconds,
        }),
      ).resolves.toMatchObject({ ok: false, reason });
    }

    await expect(
      verifyCollectToken({
        env,
        token,
        siteId: "site-2",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "collect_token_site_mismatch",
    });
    await expect(
      verifyCollectToken({
        env,
        token,
        siteId: "site-1",
        ip: "203.0.113.8",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "collect_token_ip_mismatch",
    });
  });

  it("rejects invalid payloads and missing signing secrets", async () => {
    const token = await issueCollectToken({
      env,
      siteId: "site-1",
      ip: "203.0.113.7",
      nowSeconds: 1000,
    });
    const [header, , signature] = token.split(".");

    await expect(
      verifyCollectToken({
        env: {},
        token,
        siteId: "site-1",
        ip: "203.0.113.7",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "collect_token_secret_missing",
    });
    await expect(
      verifyCollectToken({
        env,
        token: `${header}.not-json.${signature}`,
        siteId: "site-1",
        ip: "203.0.113.7",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_collect_token_signature",
    });
    await expect(
      issueCollectToken({
        env: {},
        siteId: "site-1",
        ip: "203.0.113.7",
      }),
    ).rejects.toThrow("MAIN_SECRET or DAILY_SALT_SECRET is required");
  });

  it("rejects well-signed tokens with malformed decoded content", async () => {
    const invalidAudienceToken = await signToken({
      env,
      payload: {
        aud: "other",
        siteId: "site-1",
        ip: "203.0.113.7",
        iat: 1000,
        exp: 1000 + COLLECT_TOKEN_TTL_SECONDS,
      },
    });
    const nonObjectPayloadToken = await signToken({ env, payload: "literal" });
    const nonObjectHeaderToken = await signToken({
      env,
      header: "literal",
      payload: {
        aud: "collect",
        siteId: "site-1",
        ip: "203.0.113.7",
        iat: 1000,
        exp: 1000 + COLLECT_TOKEN_TTL_SECONDS,
      },
    });
    const nullHeaderToken = await signToken({
      env,
      header: null,
      payload: {
        aud: "collect",
        siteId: "site-1",
        ip: "203.0.113.7",
        iat: 1000,
        exp: 1000 + COLLECT_TOKEN_TTL_SECONDS,
      },
    });
    const missingHeaderFieldsToken = await signToken({
      env,
      header: {},
      payload: {
        aud: "collect",
        siteId: "site-1",
        ip: "203.0.113.7",
        iat: 1000,
        exp: 1000 + COLLECT_TOKEN_TTL_SECONDS,
      },
    });
    const missingPayloadFieldsToken = await signToken({
      env,
      payload: {},
    });
    const nullPayloadToken = await signToken({
      env,
      payload: null,
    });

    await expect(
      verifyCollectToken({
        env,
        token: invalidAudienceToken,
        siteId: "site-1",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_collect_token_payload",
    });
    await expect(
      verifyCollectToken({
        env,
        token: nonObjectPayloadToken,
        siteId: "site-1",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_collect_token_payload",
    });
    await expect(
      verifyCollectToken({
        env,
        token: nonObjectHeaderToken,
        siteId: "site-1",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_collect_token_header",
    });
    await expect(
      verifyCollectToken({
        env,
        token: nullHeaderToken,
        siteId: "site-1",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_collect_token_header",
    });
    await expect(
      verifyCollectToken({
        env,
        token: missingHeaderFieldsToken,
        siteId: "site-1",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_collect_token_header",
    });
    await expect(
      verifyCollectToken({
        env,
        token: missingPayloadFieldsToken,
        siteId: "site-1",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_collect_token_payload",
    });
    await expect(
      verifyCollectToken({
        env,
        token: nullPayloadToken,
        siteId: "site-1",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "invalid_collect_token_payload",
    });
  });

  it("supports DAILY_SALT_SECRET as a legacy signing root", async () => {
    const legacyEnv = { DAILY_SALT_SECRET: "daily-secret" };
    const token = await issueCollectToken({
      env: legacyEnv,
      siteId: "site-1",
      ip: "203.0.113.7",
      nowSeconds: 1000,
    });

    await expect(
      verifyCollectToken({
        env: legacyEnv,
        token,
        siteId: "site-1",
        ip: "203.0.113.7",
        nowSeconds: 1001,
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});
