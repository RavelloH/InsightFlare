import { afterEach, describe, expect, it, vi } from "vitest";

import { observeSkeletonRows } from "./use-skeleton-row-motion";

describe("skeleton row visibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("enhances visible rows only in idle time, tracks appended rows and cancels on cleanup", () => {
    const observed = new Set<Element>();
    const disconnect = vi.fn();
    let intersect: IntersectionObserverCallback | undefined;
    let mutate: MutationCallback | undefined;
    const idle = new Map<number, IdleRequestCallback>();
    let nextId = 0;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe(node: Element) {
          observed.add(node);
        }
        unobserve(node: Element) {
          observed.delete(node);
        }
        disconnect() {
          disconnect();
        }
      },
    );
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: MutationCallback) {
          mutate = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idle.set(++nextId, callback);
      return nextId;
    });
    vi.stubGlobal("cancelIdleCallback", (id: number) => idle.delete(id));
    const table = document.createElement("table");
    const body = table.createTBody();
    const row = body.insertRow();
    row.dataset.skeletonMotion = "active";
    const next = body.insertRow();
    next.dataset.skeletonMotion = "static";
    const emit = (target: Element, isIntersecting: boolean) => {
      intersect?.(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    };
    const flush = (budget: number) => {
      const entry = idle.entries().next().value;
      if (!entry) throw new Error("Expected an idle job");
      idle.delete(entry[0]);
      entry[1]({ didTimeout: false, timeRemaining: () => budget });
    };
    const cleanup = observeSkeletonRows(table);
    try {
      expect(observed.size).toBe(2);
      emit(row, true);
      emit(next, false);
      expect(row.dataset.skeletonVisible).toBeUndefined();
      expect(next.dataset.skeletonVisible).toBe("false");
      flush(0);
      expect(row.dataset.skeletonVisible).toBeUndefined();
      flush(20);
      expect(row.dataset.skeletonVisible).toBe("true");
      emit(row, false);
      expect(row.dataset.skeletonVisible).toBe("false");
      emit(next, true);
      const appended = body.insertRow();
      appended.dataset.skeletonMotion = "static";
      row.remove();
      mutate?.([], {} as MutationObserver);
      expect(observed.has(appended)).toBe(true);
      expect(observed.has(row)).toBe(false);
      expect(row.dataset.skeletonVisible).toBeUndefined();
      emit(appended, true);
      expect(idle.size).toBe(1);
      expect(body.querySelectorAll("tr")).toHaveLength(2);
    } finally {
      cleanup();
    }
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(next.dataset.skeletonVisible).toBeUndefined();
    expect(idle.size).toBe(0);
  });
});
