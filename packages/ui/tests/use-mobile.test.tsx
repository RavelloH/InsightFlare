import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIsMobile } from "../src/hooks/use-mobile";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function createMatchMediaMock() {
  const listeners = new Set<() => void>();

  return {
    listeners,
    matchMedia: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "change") listeners.add(listener);
      }),
      removeEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "change") listeners.delete(listener);
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  };
}

describe("useIsMobile in the UI package", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tracks width changes and removes the media-query listener on unmount", () => {
    const matchMediaMock = createMatchMediaMock();
    vi.stubGlobal("matchMedia", matchMediaMock.matchMedia);
    setWindowWidth(1024);

    function Probe() {
      return createElement("span", null, useIsMobile() ? "mobile" : "desktop");
    }

    act(() => {
      root.render(createElement(Probe));
    });

    expect(container.textContent).toBe("desktop");
    expect(matchMediaMock.matchMedia).toHaveBeenCalledWith(
      "(max-width: 767px)",
    );
    expect(matchMediaMock.listeners.size).toBe(1);

    setWindowWidth(480);
    act(() => {
      matchMediaMock.listeners.forEach((listener) => listener());
    });

    expect(container.textContent).toBe("mobile");

    act(() => {
      root.unmount();
    });
    expect(matchMediaMock.listeners.size).toBe(0);
  });
});
