import { describe, expect, it, vi } from "vitest";

import {
  createOperationCacheKey,
  OperationResultCache,
} from "@/lib/edge/analytics/application/cache";

describe("OperationResultCache", () => {
  it("hashes stable semantics without exposing the subject or filter", async () => {
    const first = await createOperationCacheKey({
      contractRevision: "1",
      operation: "site.analytics.overview",
      operationRevision: "1",
      subjectFingerprint: "subject-secret",
      policyRevision: "1",
      query: { filter: { b: 2, a: 1 }, from: 1 },
    });
    const second = await createOperationCacheKey({
      contractRevision: "1",
      operation: "site.analytics.overview",
      operationRevision: "1",
      subjectFingerprint: "subject-secret",
      policyRevision: "1",
      query: { from: 1, filter: { a: 1, b: 2 } },
    });
    expect(first).toBe(second);
    expect(first).not.toContain("subject-secret");
  });

  it("ignores request-scoped clock and diagnostic fields in semantic identity", async () => {
    const base = {
      contractRevision: "1",
      operation: "site.analytics.overview",
      operationRevision: "1",
      subjectFingerprint: "subject-hash",
      policyRevision: "policy-1",
    } as const;
    const first = await createOperationCacheKey({
      ...base,
      query: {
        from: 1,
        to: 2,
        requestId: "request-a",
        generatedAt: "2026-08-21T00:00:00.000Z",
        capturedAtMs: 100,
        diagnostics: { rows: 10 },
      },
    });
    const second = await createOperationCacheKey({
      ...base,
      query: {
        from: 1,
        to: 2,
        requestId: "request-b",
        generatedAt: "2026-08-21T01:00:00.000Z",
        capturedAtMs: 200,
        diagnostics: { rows: 20 },
      },
    });
    expect(first).toBe(second);
  });

  it("keeps identities isolated and expires entries", async () => {
    const cache = new OperationResultCache();
    const load = vi
      .fn()
      .mockResolvedValueOnce("one")
      .mockResolvedValueOnce("two");
    let now = 1_000;
    const policy = { ttlMs: 100, maxEntries: 2 };

    await expect(
      cache.getOrLoad({ key: "subject-a", policy, load, now: () => now }),
    ).resolves.toMatchObject({ value: "one", status: "miss" });
    await expect(
      cache.getOrLoad({ key: "subject-a", policy, load, now: () => now }),
    ).resolves.toMatchObject({ value: "one", status: "hit" });
    await expect(
      cache.getOrLoad({ key: "subject-b", policy, load, now: () => now }),
    ).resolves.toMatchObject({ value: "two", status: "miss" });
    expect(load).toHaveBeenCalledTimes(2);

    now += 101;
    await cache.getOrLoad({ key: "subject-a", policy, load, now: () => now });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent misses and never caches failures", async () => {
    const cache = new OperationResultCache();
    let resolve!: (value: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const policy = { ttlMs: 100, maxEntries: 2 };
    const first = cache.getOrLoad({ key: "same", policy, load });
    const second = cache.getOrLoad({ key: "same", policy, load });
    resolve("value");
    await expect(first).resolves.toMatchObject({
      status: "miss",
      value: "value",
    });
    await expect(second).resolves.toMatchObject({
      status: "shared",
      value: "value",
    });
    expect(load).toHaveBeenCalledTimes(1);

    const failure = vi.fn().mockRejectedValue(new Error("backend failure"));
    await expect(
      cache.getOrLoad({ key: "failure", policy, load: failure }),
    ).rejects.toThrow("backend failure");
    await expect(
      cache.getOrLoad({ key: "failure", policy, load: failure }),
    ).rejects.toThrow("backend failure");
    expect(failure).toHaveBeenCalledTimes(2);
  });

  it("evicts least recently used entries and supports bypass", async () => {
    const cache = new OperationResultCache();
    const policy = { ttlMs: 100, maxEntries: 1 };
    await cache.getOrLoad({ key: "a", policy, load: async () => "a" });
    await cache.getOrLoad({ key: "b", policy, load: async () => "b" });
    const reload = vi.fn().mockResolvedValue("new-a");
    await expect(
      cache.getOrLoad({ key: "a", policy, load: reload }),
    ).resolves.toMatchObject({ status: "miss", value: "new-a" });
    await expect(
      cache.getOrLoad({ key: "uncached", policy: null, load: async () => "x" }),
    ).resolves.toMatchObject({ status: "bypass" });
  });

  it("does not retain an oversized successful result", async () => {
    const cache = new OperationResultCache();
    const policy = { ttlMs: 100, maxEntries: 2, maxEntryBytes: 4 };
    const load = vi.fn().mockResolvedValue({ value: "too-large" });
    await expect(
      cache.getOrLoad({ key: "large", policy, load }),
    ).resolves.toMatchObject({
      status: "bypass",
    });
    await cache.getOrLoad({ key: "large", policy, load });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
