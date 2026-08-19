import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveSecret, SECRET_PURPOSES } from "@/lib/secrets";
import {
  createSessionToken,
  hasConfiguredSessionSecret,
  hasConfiguredSessionSecretSource,
  verifySessionToken,
} from "@/lib/session";

function bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
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

describe("Session Authentication (Web Crypto HMAC)", () => {
  const mockClaims = {
    userId: "user_99182",
    username: "john_doe",
    displayName: "John Doe",
    systemRole: "admin" as const,
  };

  beforeEach(() => {
    process.env.MAIN_SECRET =
      "a-very-long-test-main-secret-longer-than-32-bytes";
  });

  afterEach(() => {
    delete process.env.MAIN_SECRET;
    delete process.env.DAILY_SALT_SECRET;
  });

  describe("configured session secret helpers", () => {
    it("returns true when MAIN_SECRET is configured", () => {
      process.env.MAIN_SECRET = "configured";
      delete process.env.DAILY_SALT_SECRET;
      expect(
        hasConfiguredSessionSecretSource({
          MAIN_SECRET: "configured",
          DAILY_SALT_SECRET: undefined,
        }),
      ).toBe(true);
    });

    it("returns true when DAILY_SALT_SECRET is configured", () => {
      expect(
        hasConfiguredSessionSecretSource({
          MAIN_SECRET: undefined,
          DAILY_SALT_SECRET: "salt",
        }),
      ).toBe(true);
    });

    it("returns false when no secret is configured", () => {
      expect(
        hasConfiguredSessionSecretSource({
          MAIN_SECRET: undefined,
          DAILY_SALT_SECRET: undefined,
        }),
      ).toBe(false);
    });

    it("hasConfiguredSessionSecret reflects process env", () => {
      delete process.env.MAIN_SECRET;
      delete process.env.DAILY_SALT_SECRET;
      expect(hasConfiguredSessionSecret()).toBe(false);

      process.env.DAILY_SALT_SECRET = "a-daily-salt";
      expect(hasConfiguredSessionSecret()).toBe(true);
    });
  });

  it("should successfully create and verify a valid session token", async () => {
    const maxAge = 3600; // 1 hour
    const token = await createSessionToken(mockClaims, maxAge);

    expect(token).toBeTypeOf("string");
    expect(token.split(".")).toHaveLength(2); // encodedPayload.signature

    const verified = await verifySessionToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe(mockClaims.userId);
    expect(verified!.username).toBe(mockClaims.username);
    expect(verified!.displayName).toBe(mockClaims.displayName);
    expect(verified!.systemRole).toBe(mockClaims.systemRole);

    // Verify expiration time is correct
    const now = Math.floor(Date.now() / 1000);
    expect(verified!.exp).toBeGreaterThan(now);
    expect(verified!.exp).toBeLessThanOrEqual(now + maxAge);
  });

  it("should fail verification if the token payload or signature is tampered with", async () => {
    const token = await createSessionToken(mockClaims, 3600);
    const [payloadPart, sigPart] = token.split(".");

    // 1. Tamper with the payload's last character
    const tamperedPayload =
      payloadPart.slice(0, -1) + (payloadPart.slice(-1) === "a" ? "b" : "a");
    const tamperedToken1 = `${tamperedPayload}.${sigPart}`;
    const verified1 = await verifySessionToken(tamperedToken1);
    expect(verified1).toBeNull();

    // 2. Tamper with signature characters (modify the first two characters to break Base64 decoding)
    const tamperedSig =
      (sigPart.startsWith("ab") ? "xy" : "ab") + sigPart.slice(2);
    const tamperedToken2 = `${payloadPart}.${tamperedSig}`;
    const verified2 = await verifySessionToken(tamperedToken2);
    expect(verified2).toBeNull();
  });

  it("should fail verification and return null if the token has expired", async () => {
    vi.useFakeTimers();
    try {
      const maxAge = 10; // 10 seconds
      const token = await createSessionToken(mockClaims, maxAge);

      // Still valid after 5 seconds
      vi.advanceTimersByTime(5000);
      const verifiedMid = await verifySessionToken(token);
      expect(verifiedMid).not.toBeNull();

      // Expired after another 6 seconds (11 seconds total)
      vi.advanceTimersByTime(6000);
      const verifiedAfter = await verifySessionToken(token);
      expect(verifiedAfter).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should robustly return null for malformed, empty, or short tokens", async () => {
    expect(await verifySessionToken(null)).toBeNull();
    expect(await verifySessionToken(undefined)).toBeNull();
    expect(await verifySessionToken("")).toBeNull();
    expect(await verifySessionToken("short")).toBeNull();
    expect(
      await verifySessionToken("no-dot-in-token-but-long-enough-1234567890"),
    ).toBeNull();
    expect(await verifySessionToken("invalid.payload.no.real.sig")).toBeNull();
  });

  it("should support overriding session secret with custom key", async () => {
    const customSecret = "custom-overridden-super-secret-key-123456";
    const token = await createSessionToken(mockClaims, 1800);

    // Verification should fail if custom key override is provided for token signed with default key
    const verifiedWrongSecret = await verifySessionToken(token, customSecret);
    expect(verifiedWrongSecret).toBeNull();
  });

  it("should handle empty or wrong secret key overrides gracefully", async () => {
    const token = await createSessionToken(mockClaims, 1800);

    // Empty string keeps using the configured runtime session secret.
    const verifiedEmpty = await verifySessionToken(token, "");
    expect(verifiedEmpty).not.toBeNull();
    expect(verifiedEmpty!.userId).toBe(mockClaims.userId);

    // A wrong non-empty key override securely fails.
    const verifiedWrong = await verifySessionToken(
      token,
      "invalid-secret-key-override",
    );
    expect(verifiedWrong).toBeNull();
  });

  it("should return null when token payload is valid Base64 but fails JSON parsing", async () => {
    // Construct a payload containing valid Base64 but is just raw text "invalid-json" rather than stringified JSON object
    const payloadPart = "aW52YWxpZC1qc29u"; // Base64 for "invalid-json"

    // Manually calculate signature using Node's crypto to pass the signature integrity check
    const crypto = await import("crypto");
    const secret = await deriveSecret(
      process.env.MAIN_SECRET || "",
      SECRET_PURPOSES.dashboardSession,
    );
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payloadPart);
    const signature = hmac.digest();

    const signaturePart = signature
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const token = `${payloadPart}.${signaturePart}`;

    // The token successfully bypasses signature equality checks, but will fail during TextDecoder and JSON parsing.
    // Assert it gracefully handles this without crashing and returns null.
    const verified = await verifySessionToken(token);
    expect(verified).toBeNull();
  });

  it("rejects session token creation when no root secret is configured", async () => {
    delete process.env.MAIN_SECRET;
    delete process.env.DAILY_SALT_SECRET;

    const userClaims = { ...mockClaims, systemRole: "user" as const };
    await expect(createSessionToken(userClaims, 3600)).rejects.toThrow(
      "MAIN_SECRET or DAILY_SALT_SECRET is required for sessions",
    );
  });

  it("should fail validation if base64 signature is highly malformed (Line 122)", async () => {
    process.env.MAIN_SECRET =
      "a-very-long-test-main-secret-longer-than-32-bytes";
    const payload = base64UrlEncode(bytes(JSON.stringify(mockClaims)));
    // Highly malformed base64 containing illegal atob characters like non-ascii characters or illegal spacing
    const malformedToken = `${payload}.$$$!!!%%%`;
    const verified = await verifySessionToken(malformedToken);
    expect(verified).toBeNull();
  });

  it("should return null if token parsed JSON is not an object (Line 136)", async () => {
    // Stringified "123" is a valid JSON but not an object
    const payloadPart = base64UrlEncode(bytes(JSON.stringify(123)));

    // Manually calculate signature
    const crypto = await import("crypto");
    const secret = await deriveSecret(
      process.env.MAIN_SECRET || "",
      SECRET_PURPOSES.dashboardSession,
    );
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payloadPart);
    const signature = hmac.digest();
    const signaturePart = base64UrlEncode(new Uint8Array(signature));

    const token = `${payloadPart}.${signaturePart}`;
    const verified = await verifySessionToken(token);
    expect(verified).toBeNull();
  });

  it("should return null if mandatory fields are missing from payload (Line 146)", async () => {
    // Missing userId and username
    const invalidClaims = { displayName: "No User" };
    const payloadPart = base64UrlEncode(bytes(JSON.stringify(invalidClaims)));

    // Manually calculate signature
    const crypto = await import("crypto");
    const secret = await deriveSecret(
      process.env.MAIN_SECRET || "",
      SECRET_PURPOSES.dashboardSession,
    );
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payloadPart);
    const signature = hmac.digest();
    const signaturePart = base64UrlEncode(new Uint8Array(signature));

    const token = `${payloadPart}.${signaturePart}`;
    const verified = await verifySessionToken(token);
    expect(verified).toBeNull();
  });
});
