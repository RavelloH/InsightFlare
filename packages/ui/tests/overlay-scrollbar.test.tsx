import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import {
  OverlayScrollbar,
  SCROLLBAR_UPDATED_EVENT,
} from "../src/components/ui/overlay-scrollbar";

const mocks = vi.hoisted(() => {
  const instance = {
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    update: vi.fn(),
  };
  return { instance, initialize: vi.fn(), getInstance: vi.fn(() => instance) };
});
vi.mock("overlayscrollbars", () => ({
  OverlayScrollbars: { valid: () => true },
}));
vi.mock("overlayscrollbars-react", () => ({
  useOverlayScrollbars: () => [mocks.initialize, mocks.getInstance],
}));

it("keeps native overflow during hydration and enhances only when needed", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  document.documentElement.dataset.scrollbarMode = "overlay";
  const frames: FrameRequestCallback[] = [];
  const idle: Array<(deadline: IdleDeadline) => void> = [];
  const resize: Array<() => void> = [];
  const disconnect = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
    frames.push(fn),
  );
  vi.stubGlobal("requestIdleCallback", (fn: (deadline: IdleDeadline) => void) =>
    idle.push(fn),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: () => void) {
        resize.push(fn);
      }
      observe() {}
      disconnect() {
        disconnect();
      }
    },
  );
  function flushEnhancement(budget = 50) {
    act(() => {
      frames.shift()?.(0);
      idle.shift()?.({ didTimeout: false, timeRemaining: () => budget });
    });
  }
  try {
    act(() =>
      root.render(<OverlayScrollbar axis="vertical">Content</OverlayScrollbar>),
    );
    const viewport = container.querySelector<HTMLDivElement>(
      ".os-scrollbar-viewport",
    )!;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
    });
    expect(mocks.initialize).not.toHaveBeenCalled();
    flushEnhancement();
    expect(mocks.initialize).not.toHaveBeenCalled();
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 200,
    });
    const updated = vi.fn();
    viewport.addEventListener(SCROLLBAR_UPDATED_EVENT, updated);
    resize.forEach((fn) => fn());
    expect(mocks.initialize).not.toHaveBeenCalled();
    flushEnhancement(0);
    expect(mocks.initialize).not.toHaveBeenCalled();
    flushEnhancement();
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    delete document.documentElement.dataset.scrollbarMode;
    vi.unstubAllGlobals();
  }
  expect(mocks.instance.destroy).toHaveBeenCalledTimes(1);
});
