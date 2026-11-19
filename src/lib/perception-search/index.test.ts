import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matchScore } from "./core";
import {
  MAX_PER_SCOPE,
  type ObservedCandidate,
  PerceptionIndex,
  safeCandidate,
} from "./index";

const first = { userId: "user-1", teamId: "team-1", siteId: "site-1" };
const second = { userId: "user-2", teamId: "team-1", siteId: "site-1" };
const otherTeam = { ...first, teamId: "team-2" };
const otherSite = { ...first, siteId: "site-2" };
const candidates: ObservedCandidate[] = [
  { field: "page.path", value: "/docs" },
  { field: "referrer.domain", value: "example.com" },
  { field: "event.name", value: "Signup" },
  { field: "utm.campaign", value: "Winter_launch" },
  { field: "client.browser", value: "Google Chrome" },
];

beforeEach(() => vi.stubGlobal("indexedDB", undefined));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("safe extraction whitelist", () => {
  it("accepts safe normalized dimensions only", () => {
    for (const item of candidates)
      expect(safeCandidate(item.field, item.value)).not.toBeNull();
    expect(safeCandidate("page.path", " /docs ")).toEqual({
      field: "page.path",
      value: "/docs",
    });
    expect(safeCandidate("event.name", "分析开始")).not.toBeNull();
    expect(safeCandidate("utm.source", "Bing Ads")).not.toBeNull();
  });
  it.each([
    ["event.payload", "anything"],
    ["visitor.id", "123"],
    ["session.id", "456"],
    ["page.path", "/checkout?email=test@example.com"],
    ["page.path", "/account/550e8400-e29b-41d4-a716-446655440000"],
    ["page.path", "/search%3Ftoken%3D1"],
    ["referrer.domain", "https://example.com/path?x=1"],
    ["event.name", "user@email.test"],
    ["event.name", "access_token"],
    ["event.name", "https://example.org"],
    ["utm.medium", "token=secret"],
    ["utm.campaign", "<script>"],
    ["utm.source", "1".repeat(121)],
    ["page.path", "/log/\nanything"],
  ])("rejects unsafe %s values", (field, value) => {
    expect(safeCandidate(field, value)).toBeNull();
  });
  it("rejects non-string values including raw objects and null", () => {
    expect(safeCandidate("event.name", { payload: "secret" })).toBeNull();
    expect(safeCandidate("event.name", null)).toBeNull();
    expect(safeCandidate("event.name", "")).toBeNull();
  });
});
describe("scope, lifecycle and fallback", () => {
  it("keeps user/team/site data isolated and never treats local absence as a server fact", async () => {
    const index = new PerceptionIndex();
    index.observe(first, candidates);
    index.observe(otherTeam, [{ field: "event.name", value: "OtherTeam" }]);
    index.observe(otherSite, [{ field: "event.name", value: "OtherSite" }]);
    index.observe(second, [{ field: "event.name", value: "OtherUser" }]);
    expect(index.search(first, "signup").map((r) => r.value)).toEqual([
      "Signup",
    ]);
    expect(index.search(first, "other")).toEqual([]);
    expect(index.search(otherTeam, "other")[0].value).toBe("OtherTeam");
    expect(index.search(otherSite, "other")[0].value).toBe("OtherSite");
    expect(index.search(second, "other")[0].value).toBe("OtherUser");
    await index.clearUser("user-1");
    expect(index.search(first, "")).toEqual([]);
    expect(index.search(second, "other")).toHaveLength(1);
    expect(index.storageMode).toBe("memory");
  });
  it("matches token prefixes without substring and enforces field-specific value search", () => {
    const index = new PerceptionIndex();
    index.observe(first, candidates);
    expect(index.search(first, "chr").map((r) => r.value)).toEqual([
      "Google Chrome",
    ]);
    expect(index.search(first, "rom")).toEqual([]);
    expect(index.search(first, "chr", "event.name")).toEqual([]);
    expect(matchScore("分析页面", "分析")).toBeGreaterThan(0);
    index.observe(first, [{ field: "client.browser", value: "Google Chrome" }]);
    expect(index.search(first, "chr")[0].observeCount).toBe(2);
  });
  it("expires old observations and bounds per-scope LRU", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
    const index = new PerceptionIndex();
    index.observe(first, [{ field: "event.name", value: "OldEvent" }]);
    vi.advanceTimersByTime(31 * 86400_000);
    expect(index.search(first, "old")).toEqual([]);
    for (let n = 0; n < 650; n += 100) {
      index.observe(
        first,
        Array.from({ length: 100 }, (_, i) => ({
          field: "event.name" as const,
          value: "Event" + (n + i),
        })),
      );
      vi.advanceTimersByTime(1);
    }
    // Memory is bounded; its private map is inspected to test exact capacity.
    const records = (index as unknown as { records: Map<string, unknown> })
      .records;
    expect(records.size).toBe(MAX_PER_SCOPE);
  });
  it("degrades to safe in-memory index when IndexedDB open throws", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("SecurityError");
      },
    });
    const index = new PerceptionIndex();
    await index.load(first);
    index.observe(first, [{ field: "event.name", value: "A" }]);
    expect(index.search(first, "a")).toHaveLength(1);
    expect(index.storageMode).toBe("memory");
  });
  it("requires nonempty user/team/site before observation", () => {
    const index = new PerceptionIndex();
    index.observe({ userId: "user-1" }, candidates);
    expect(index.search(first, "")).toEqual([]);
  });
});
