import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendResendEmailWithRetry } from "@/lib/notifications/resend-client";

const payload = {
  from: "InsightFlare <from@example.test>",
  to: ["user@example.test"],
  subject: "Subject",
  text: "Text",
  html: "<p>Text</p>",
};

async function send(fetchImpl: typeof fetch, deadlineMs?: number) {
  const promise = sendResendEmailWithRetry({
    apiKey: "re_secret",
    body: payload,
    fetchImpl,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  await vi.runAllTimersAsync();
  return promise;
}

describe("sendResendEmailWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("binds the default Worker fetch implementation to globalThis", async () => {
    const fetchImpl = vi.fn(function (this: typeof globalThis) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        new Response(JSON.stringify({ id: "email-default-fetch" }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await sendResendEmailWithRetry({
      apiKey: "re_secret",
      body: payload,
    });

    expect(result).toMatchObject({
      ok: true,
      providerMessageId: "email-default-fetch",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure and succeeds on the second attempt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
      );

    const result = await send(fetchImpl);

    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
      retryCount: 1,
      providerMessageId: "email-1",
      durationMs: 1_000,
    });
  });

  it("retries a 500 response and succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "temporary" }), {
          status: 500,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email-2" }), { status: 200 }),
      );

    const result = await send(fetchImpl);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("does not retry deterministic 4xx errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "invalid_from" }), {
        status: 400,
      }),
    );

    const result = await send(fetchImpl);

    expect(result).toMatchObject({
      ok: false,
      attempts: 1,
      retryCount: 0,
      reason: "provider_failed",
      errorMessage: "invalid_from",
    });
  });

  it("retries 429 responses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate_limited" }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email-3" }), { status: 200 }),
      );

    const result = await send(fetchImpl);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("returns network_failed after repeated network failures within deadline", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network"));

    const result = await send(fetchImpl);

    expect(result).toMatchObject({
      ok: false,
      attempts: 15,
      retryCount: 14,
      reason: "network_failed",
    });
    expect(result.durationMs).toBe(14_000);
    expect(result.errorMessage).toContain("Unable to reach Resend email API");
    expect(result.errorMessage).toContain("Error: network");
  });

  it("stops when a short deadline leaves no retry budget", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network"));

    const result = await send(fetchImpl, 500);

    expect(result.ok).toBe(false);
    expect(result.durationMs).toBeLessThanOrEqual(500);
    expect(result.attempts).toBeLessThanOrEqual(1);
  });
});
