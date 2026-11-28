import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import {
  calculateScrollbarGeometry,
  observeScrollbarResize,
  OverlayScrollbar,
  PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS,
  SCROLLBAR_UPDATED_EVENT,
  useReactOverlayScrollbar,
} from "../src/components/ui/overlay-scrollbar";
import { VerticalScrollMask } from "../src/components/ui/vertical-scroll-mask";

function resizeEntry(target: Element): ResizeObserverEntry {
  return {
    target,
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
    contentRect: target.getBoundingClientRect(),
  };
}

function fixture(mode = "overlay") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  document.documentElement.dataset.scrollbarMode = mode;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let deliver: (entries: ResizeObserverEntry[]) => void = () => undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.set(++frameId, fn);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: typeof deliver) {
        deliver = fn;
      }
      observe = observe;
      unobserve() {}
      disconnect = disconnect;
    },
  );
  const flush = () =>
    act(() => {
      for (let i = 0; i < 8 && frames.size; i++) {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((fn) => fn(0));
      }
    });
  const cleanup = () => {
    act(() => root.unmount());
    container.remove();
    delete document.documentElement.dataset.scrollbarMode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  };
  return {
    container,
    root,
    frames,
    flush,
    cleanup,
    observe,
    disconnect,
    resize: (target: Element) => act(() => deliver([resizeEntry(target)])),
  };
}

it("calculates proportional thumbs, minimum size, short tracks and no overflow", () => {
  expect(calculateScrollbarGeometry(100, 400, 80)).toEqual({
    max: 300,
    length: 80,
    thumb: 20,
  });
  expect(calculateScrollbarGeometry(100, 10000, 80).thumb).toBe(18);
  expect(calculateScrollbarGeometry(100, 10000, 10).thumb).toBe(10);
  expect(calculateScrollbarGeometry(100, 100, 80)).toEqual({
    max: 0,
    length: 80,
    thumb: 80,
  });
  expect(calculateScrollbarGeometry(100, 80, 0)).toEqual({
    max: 0,
    length: 0,
    thumb: 0,
  });
});

it.each(["horizontal", "vertical", "native"] as const)(
  "preserves edge masks, cached scroll geometry and teardown (%s)",
  (scenario) => {
    const f = fixture(scenario === "native" ? "native" : "overlay");
    try {
      act(() =>
        f.root.render(
          scenario === "vertical" ? (
            <VerticalScrollMask
              scrollbarOptions={PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS}
            >
              Content
            </VerticalScrollMask>
          ) : (
            <OverlayScrollbar axis="horizontal" showEdgeMasks>
              <span>Content</span>
            </OverlayScrollbar>
          ),
        ),
      );
      const viewport = f.container.querySelector<HTMLDivElement>(
        ".os-scrollbar-viewport",
      )!;
      const track = f.container.querySelector<HTMLDivElement>(".os-scrollbar");
      const width = vi.fn(() => 300);
      const height = vi.fn(() => 300);
      Object.defineProperties(viewport, {
        clientWidth: { configurable: true, value: 100 },
        clientHeight: { configurable: true, value: 100 },
        scrollWidth: { configurable: true, get: width },
        scrollHeight: { configurable: true, get: height },
      });
      if (track)
        Object.defineProperties(track, {
          clientWidth: { value: 100 },
          clientHeight: { value: 100 },
        });
      const updated = vi.fn();
      viewport.addEventListener(SCROLLBAR_UPDATED_EVENT, updated);
      f.flush();
      const masks = [
        ...f.container.querySelectorAll('[aria-hidden="true"]'),
      ].filter((e) => e.classList.contains("pointer-events-none"));
      expect(masks).toHaveLength(2);
      expect(masks[0]?.classList.contains("opacity-0")).toBe(true);
      expect(masks[1]?.classList.contains("opacity-100")).toBe(true);
      expect(viewport.hasAttribute("data-scrollbar-enhanced")).toBe(
        scenario !== "native",
      );
      expect(Boolean(track)).toBe(scenario !== "native");
      if (track) {
        expect(track.classList.contains("os-scrollbar-visible")).toBe(true);
        expect(updated).toHaveBeenCalled();
      }
      width.mockClear();
      height.mockClear();
      act(() => {
        viewport.scrollLeft = 200;
        viewport.scrollTop = 200;
        viewport.dispatchEvent(new Event("scroll"));
        viewport.dispatchEvent(new Event("scroll"));
      });
      f.flush();
      expect(masks[0]?.classList.contains("opacity-100")).toBe(true);
      expect(masks[1]?.classList.contains("opacity-0")).toBe(true);
      expect(viewport.scrollLeft).toBe(200);
      expect(viewport.scrollTop).toBe(200);
      expect(height).not.toHaveBeenCalled();
      expect(width).toHaveBeenCalledTimes(scenario === "native" ? 1 : 0);
      if (track)
        expect(
          track.querySelector<HTMLElement>(".os-scrollbar-handle")!.style
            .transform,
        ).toContain("66.666");
    } finally {
      f.cleanup();
    }
    expect(f.container.querySelector(".os-scrollbar")).toBeNull();
    expect(f.frames.size).toBe(0);
    expect(f.disconnect).toHaveBeenCalledTimes(1);
  },
);

it("responds to content resize, hides non-overflowing tracks and measures only the tracked axis", () => {
  const f = fixture();
  try {
    act(() =>
      f.root.render(
        <OverlayScrollbar axis="horizontal">
          <span>Content</span>
        </OverlayScrollbar>,
      ),
    );
    const viewport = f.container.querySelector<HTMLDivElement>(
      ".os-scrollbar-viewport",
    )!;
    const child = f.container.querySelector(".os-scrollbar-content > span")!;
    const track = f.container.querySelector<HTMLDivElement>(".os-scrollbar")!;
    let width = 100;
    const getWidth = vi.fn(() => width);
    const getHeight = vi.fn(() => 100);
    Object.defineProperties(viewport, {
      clientWidth: { value: 100 },
      scrollWidth: { get: getWidth },
      scrollHeight: { get: getHeight },
    });
    Object.defineProperty(track, "clientWidth", { value: 98 });
    f.flush();
    expect(track.classList.contains("os-scrollbar-visible")).toBe(false);
    expect(f.observe).toHaveBeenCalledWith(child);
    width = 500;
    f.resize(child);
    f.flush();
    expect(track.classList.contains("os-scrollbar-visible")).toBe(true);
    expect(
      track.querySelector<HTMLElement>(".os-scrollbar-handle")!.style.width,
    ).toBe("19.6px");
    expect(getHeight).not.toHaveBeenCalled();
    width = 100;
    f.resize(child);
    f.flush();
    expect(track.classList.contains("os-scrollbar-visible")).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("maps captured pointer movement to the native scroll offset and releases capture", () => {
  const f = fixture();
  try {
    act(() =>
      f.root.render(
        <OverlayScrollbar
          axis="vertical"
          options={PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS}
        >
          Content
        </OverlayScrollbar>,
      ),
    );
    const viewport = f.container.querySelector<HTMLDivElement>(
      ".os-scrollbar-viewport",
    )!;
    const track = f.container.querySelector<HTMLDivElement>(".os-scrollbar")!;
    const handle = track.querySelector<HTMLDivElement>(".os-scrollbar-handle")!;
    Object.defineProperties(viewport, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 400 },
    });
    Object.defineProperty(track, "clientHeight", { value: 100 });
    f.flush();
    const capture = vi.fn();
    const release = vi.fn();
    Object.defineProperties(handle, {
      setPointerCapture: { value: capture },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: release },
    });
    function pointer(type: string, y: number) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientY: y,
        clientX: 0,
      });
      act(() => handle.dispatchEvent(event));
    }
    pointer("pointerdown", 5);
    pointer("pointermove", 30);
    expect(viewport.scrollTop).toBe(100);
    pointer("pointerup", 30);
    expect(capture).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledWith(1);
    pointer("pointermove", 45);
    expect(viewport.scrollTop).toBe(100);
  } finally {
    f.cleanup();
  }
});

it("preserves explicit controller opt-out and restores enhancement when enabled again", () => {
  const f = fixture();
  function Example({ enabled }: { enabled: boolean }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    useReactOverlayScrollbar({
      hostRef,
      viewportRef,
      contentRef,
      enabled,
      options: PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS,
    });
    return (
      <div ref={hostRef}>
        <div ref={viewportRef} className="os-scrollbar-viewport">
          <div ref={contentRef}>Content</div>
        </div>
      </div>
    );
  }
  try {
    act(() => f.root.render(<Example enabled={false} />));
    const viewport = f.container.querySelector(".os-scrollbar-viewport")!;
    expect(viewport.hasAttribute("data-scrollbar-fallback")).toBe(true);
    expect(f.container.querySelector(".os-scrollbar")).toBeNull();
    act(() => f.root.render(<Example enabled />));
    f.flush();
    expect(viewport.hasAttribute("data-scrollbar-fallback")).toBe(false);
    expect(viewport.hasAttribute("data-scrollbar-enhanced")).toBe(true);
    expect(f.container.querySelector(".os-scrollbar")).not.toBeNull();
    act(() => f.root.render(<Example enabled={false} />));
    expect(viewport.hasAttribute("data-scrollbar-fallback")).toBe(true);
    expect(viewport.hasAttribute("data-scrollbar-enhanced")).toBe(false);
    expect(f.container.querySelector(".os-scrollbar")).toBeNull();
  } finally {
    f.cleanup();
  }
});

it("does not propagate thumb clicks to an overlay outside-click handler", () => {
  const f = fixture();
  const outsideClick = vi.fn();
  try {
    act(() =>
      f.root.render(
        <VerticalScrollMask
          onClick={outsideClick}
          scrollbarOptions={PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS}
        >
          <button type="button">Content</button>
        </VerticalScrollMask>,
      ),
    );
    const thumb = f.container.querySelector<HTMLElement>(
      ".os-scrollbar-handle",
    )!;
    act(() => thumb.click());
    expect(outsideClick).not.toHaveBeenCalled();
    act(() => f.container.querySelector("button")!.click());
    expect(outsideClick).toHaveBeenCalledTimes(1);
    outsideClick.mockClear();
    const track = thumb.parentElement!.parentElement!;
    act(() => f.root.unmount());
    const listener = vi.fn();
    track.addEventListener("click", listener);
    const click = new MouseEvent("click", { bubbles: true });
    thumb.dispatchEvent(click);
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    f.cleanup();
  }
});

it("uses physical horizontal progress for RTL and marks tracks without relying on language selectors", () => {
  const f = fixture();
  try {
    act(() =>
      f.root.render(
        <OverlayScrollbar axis="both" dir="rtl" showEdgeMasks>
          Content
        </OverlayScrollbar>,
      ),
    );
    const viewport = f.container.querySelector<HTMLDivElement>(
      ".os-scrollbar-viewport",
    )!;
    viewport.style.direction = "rtl";
    Object.defineProperties(viewport, {
      clientWidth: { value: 100 },
      scrollWidth: { value: 300 },
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 },
    });
    const tracks = [
      ...f.container.querySelectorAll<HTMLDivElement>(".os-scrollbar"),
    ];
    for (const track of tracks)
      Object.defineProperties(track, {
        clientWidth: { value: 100 },
        clientHeight: { value: 100 },
      });
    f.flush();
    expect(
      tracks.every((track) => track.classList.contains("os-scrollbar-rtl")),
    ).toBe(true);
    viewport.scrollLeft = -200;
    act(() => viewport.dispatchEvent(new Event("scroll")));
    f.flush();
    const horizontal = tracks[0]!.querySelector<HTMLElement>(
      ".os-scrollbar-handle",
    )!;
    expect(horizontal.style.transform).toBe("translate3d(0px,0,0)");
  } finally {
    f.cleanup();
  }
});

it("shares viewport/content observation while preserving independent subscribers and cleanup", () => {
  const viewport = document.createElement("div");
  const content = document.createElement("div");
  const other = document.createElement("div");
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  let deliver!: (entries: ResizeObserverEntry[]) => void;
  const create = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: typeof deliver) {
        create();
        deliver = fn;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  const init = vi.fn();
  const mask = vi.fn();
  const next = vi.fn();
  const stopInit = observeScrollbarResize(viewport, content, init);
  const stopMask = observeScrollbarResize(viewport, content, mask);
  const stopNext = observeScrollbarResize(other, null, next);
  try {
    expect(create).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls).toEqual([[viewport], [content], [other]]);
    deliver([viewport, content, other].map((target) => resizeEntry(target)));
    expect(init).toHaveBeenCalledTimes(1);
    expect(mask).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    stopInit();
    expect(unobserve).not.toHaveBeenCalled();
    deliver([viewport, content].map((target) => resizeEntry(target)));
    expect(init).toHaveBeenCalledTimes(1);
    expect(mask).toHaveBeenCalledTimes(2);
    stopMask();
    expect(unobserve.mock.calls).toEqual([[viewport], [content]]);
    expect(disconnect).not.toHaveBeenCalled();
  } finally {
    stopInit();
    stopMask();
    stopNext();
    vi.unstubAllGlobals();
  }
  expect(unobserve.mock.calls).toEqual([[viewport], [content], [other]]);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
