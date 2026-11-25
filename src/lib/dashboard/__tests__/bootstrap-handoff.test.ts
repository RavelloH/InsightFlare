import { describe, expect, it, vi } from "vitest";

import { createBootstrapHandoff } from "@/lib/dashboard/bootstrap-handoff";

describe("dashboard bootstrap handoff", () => {
  it("shares one in-flight preload with navigation, then forces fresh reads", async () => {
    const handoff = createBootstrapHandoff<string>();
    const read = vi.fn(async () => "snapshot");
    const preload = handoff("destination", true, read);
    expect(handoff("destination", false, read)).toBe(preload);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(handoff("destination", false, read)).resolves.toBe("snapshot");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not reuse other destinations, expired preloads or failures", async () => {
    let now = 0;
    const handoff = createBootstrapHandoff<string>(() => now);
    const read = vi.fn(async () => "snapshot");
    const first = handoff("a", true, read);
    expect(handoff("b", false, read)).not.toBe(first);
    const second = handoff("a", true, read);
    now = 1001;
    expect(handoff("a", false, read)).not.toBe(second);
    const reject = vi.fn(async () => {
      throw new Error("failed");
    });
    await expect(handoff("a", true, reject)).rejects.toThrow("failed");
    await expect(handoff("a", false, read)).resolves.toBe("snapshot");
    expect(read).toHaveBeenCalledTimes(5);
  });
  it("reuses identical preloads and releases an abandoned entry after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const handoff = createBootstrapHandoff<string>();
      const read = vi.fn(async () => "snapshot");
      const first = handoff("a", true, read);
      expect(handoff("a", true, read)).toBe(first);
      await first;
      await vi.advanceTimersByTimeAsync(1000);
      expect(handoff("a", false, read)).not.toBe(first);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
