import { afterEach, describe, expect, it, vi } from "vitest";

import { registerSkeletonInteraction } from "./skeleton-interaction";

describe("skeleton interaction budget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares a pause across active tables and resumes after the last input", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.stubGlobal("requestIdleCallback", undefined);
    const a = document.createElement("table");
    const b = document.createElement("table");
    const unregistered = document.createElement("table");
    document.body.append(a, b, unregistered);
    const cleanupA = registerSkeletonInteraction(a);
    const cleanupB = registerSkeletonInteraction(b);
    const paused = (table: HTMLTableElement) =>
      table.hasAttribute("data-skeleton-paused");
    try {
      expect(paused(a)).toBe(false);
      document.dispatchEvent(new Event("wheel"));
      expect(paused(a)).toBe(true);
      expect(paused(b)).toBe(true);
      expect(paused(unregistered)).toBe(false);
      vi.advanceTimersByTime(200);
      document.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(200);
      expect(paused(a)).toBe(true);
      vi.advanceTimersByTime(101);
      expect(paused(a)).toBe(false);
      expect(paused(b)).toBe(false);
      document.dispatchEvent(new Event("keydown"));
      expect(paused(a)).toBe(true);
    } finally {
      cleanupA();
      cleanupB();
      a.remove();
      b.remove();
      unregistered.remove();
    }
    expect(paused(a)).toBe(false);
    expect(paused(b)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for an idle budget and cancels an obsolete resume on new input", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const pending = new Map<number, IdleRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      pending.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelIdleCallback", (key: number) => pending.delete(key));
    const table = document.createElement("table");
    const cleanup = registerSkeletonInteraction(table);
    const paused = () => table.hasAttribute("data-skeleton-paused");
    try {
      document.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(300);
      expect(pending.size).toBe(1);
      document.dispatchEvent(new Event("pointerdown"));
      expect(pending.size).toBe(0);
      vi.advanceTimersByTime(300);
      const first = pending.entries().next().value;
      if (!first) throw new Error("Expected idle callback");
      pending.delete(first[0]);
      first[1]({ didTimeout: false, timeRemaining: () => 0 });
      expect(paused()).toBe(true);
      vi.advanceTimersByTime(32);
      const second = pending.entries().next().value;
      if (!second) throw new Error("Expected retry");
      pending.delete(second[0]);
      second[1]({ didTimeout: false, timeRemaining: () => 20 });
      expect(paused()).toBe(false);
    } finally {
      cleanup();
    }
  });
});
