import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyTurnstileToken } from "@/lib/edge/turnstile-siteverify";

describe("Turnstile Siteverify", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects missing tokens without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      verifyTurnstileToken({ secret: "secret", token: "" }),
    ).resolves.toEqual({
      ok: false,
      reason: "missing_token",
      errorCodes: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when an E2E run has no local siteverify URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      verifyTurnstileToken({
        requireSiteverifyUrl: true,
        secret: "secret",
        token: "token",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "network_error",
      errorCodes: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns success for valid Siteverify responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ success: true, hostname: "app.test" }),
    );

    await expect(
      verifyTurnstileToken({
        secret: "secret",
        token: "token",
        remoteIp: "203.0.113.1",
        expectedHostname: "app.test",
      }),
    ).resolves.toEqual({ ok: true, hostname: "app.test" });
  });

  it("maps provider failures and network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(
        { success: false, "error-codes": ["invalid-input-response"] },
        { status: 200 },
      ),
    );

    await expect(
      verifyTurnstileToken({ secret: "secret", token: "bad" }),
    ).resolves.toEqual({
      ok: false,
      reason: "siteverify_failed",
      errorCodes: ["invalid-input-response"],
    });

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    await expect(
      verifyTurnstileToken({ secret: "secret", token: "token" }),
    ).resolves.toEqual({
      ok: false,
      reason: "network_error",
      errorCodes: [],
    });
  });

  it("optionally rejects hostname mismatches", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ success: true, hostname: "other.test" }),
    );

    await expect(
      verifyTurnstileToken({
        secret: "secret",
        token: "token",
        expectedHostname: "app.test",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "hostname_mismatch",
      errorCodes: [],
    });
  });
});
