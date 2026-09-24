import { describe, expect, it, vi } from "vitest";

import {
  clampString,
  coerceNumber,
  coerceString,
  DEFAULT_SESSION_WINDOW_MINUTES,
  deriveDailySalt,
  deriveEuVisitorId,
  deriveServerSessionId,
  deriveSessionId,
  isSameHostname,
  jsonCloneRecord,
  MAX_SESSION_WINDOW_MINUTES,
  nowEpochSeconds,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  resolveSessionWindowMinutes,
  safeHostname,
  TEN_MINUTES_MS,
} from "@/lib/edge/utils";
import { sha256Hex } from "@/lib/sha256";

describe("edge utility helpers", () => {
  it("exports millisecond duration constants", () => {
    expect(TEN_MINUTES_MS).toBe(600_000);
    expect(ONE_HOUR_MS).toBe(3_600_000);
    expect(ONE_DAY_MS).toBe(86_400_000);
    expect(DEFAULT_SESSION_WINDOW_MINUTES).toBe(30);
    expect(MAX_SESSION_WINDOW_MINUTES).toBe(1440);
  });

  it("coerces strings and numbers with fallbacks", () => {
    expect(coerceString("value", "fallback")).toBe("value");
    expect(coerceString(5, "fallback")).toBe("fallback");

    expect(coerceNumber(12)).toBe(12);
    expect(coerceNumber("12.5")).toBe(12.5);
    expect(coerceNumber("", 7)).toBe(7);
    expect(coerceNumber(Number.NaN, 7)).toBe(7);
    expect(coerceNumber({}, null)).toBeNull();
  });

  it("clones JSON records and rejects non-record or unserializable values", () => {
    const input = { nested: { value: 1 } };
    const cloned = jsonCloneRecord(input);

    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
    expect(jsonCloneRecord(null)).toBeNull();
    expect(jsonCloneRecord({ bad: 1n })).toBeNull();
  });

  it("normalizes hostnames for safe comparison", () => {
    expect(safeHostname("https://Example.com/path")).toBe("example.com");
    expect(safeHostname("not a url")).toBe("");

    expect(isSameHostname(" Example.COM. ", "example.com")).toBe(true);
    expect(isSameHostname("", "example.com")).toBe(false);
    expect(isSameHostname("a.example", "b.example")).toBe(false);
  });

  it("clamps strings by maximum length", () => {
    expect(clampString("abc", 5)).toBe("abc");
    expect(clampString("abcdef", 3)).toBe("abc");
  });

  it("derives stable SHA-256 based identifiers", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    const eventAtMs = Date.UTC(2026, 4, 26, 12);
    const salt = await deriveDailySalt("secret", eventAtMs);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      deriveDailySalt("secret", eventAtMs + ONE_HOUR_MS),
    ).resolves.toBe(salt);

    const visitorId = await deriveEuVisitorId({
      ip: "203.0.113.10",
      ua: "Mozilla/5.0",
      eventAtMs,
      secret: "secret",
    });
    expect(visitorId).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      deriveEuVisitorId({
        ip: "203.0.113.10",
        ua: "Mozilla/5.0",
        eventAtMs,
        secret: "secret",
      }),
    ).resolves.toBe(visitorId);

    const sessionId = await deriveSessionId({
      visitorId,
      eventAtMs,
      sessionWindowMinutes: 30,
    });
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      deriveSessionId({
        visitorId,
        eventAtMs: eventAtMs + 29 * 60 * 1000,
        sessionWindowMinutes: 30,
      }),
    ).resolves.toBe(sessionId);

    const serverSessionId = await deriveServerSessionId({
      siteId: "site-1",
      visitorId,
      visitId: "visit-1",
      startedAt: eventAtMs,
      secret: "secret",
    });
    expect(serverSessionId).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      deriveServerSessionId({
        siteId: "site-1",
        visitorId,
        visitId: "visit-1",
        startedAt: eventAtMs,
        secret: "secret",
      }),
    ).resolves.toBe(serverSessionId);
  });

  it("normalizes session window configuration", () => {
    expect(resolveSessionWindowMinutes({ SESSION_WINDOW_MINUTES: "45" })).toBe(
      45,
    );
    expect(resolveSessionWindowMinutes({ SESSION_WINDOW_MINUTES: "0" })).toBe(
      30,
    );
    expect(resolveSessionWindowMinutes({ SESSION_WINDOW_MINUTES: "abc" })).toBe(
      30,
    );
    expect(
      resolveSessionWindowMinutes({ SESSION_WINDOW_MINUTES: "99999" }),
    ).toBe(1440);
  });

  it("returns epoch seconds for the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T12:34:56.789Z"));
    try {
      expect(nowEpochSeconds()).toBe(1_779_798_896);
    } finally {
      vi.useRealTimers();
    }
  });
});
