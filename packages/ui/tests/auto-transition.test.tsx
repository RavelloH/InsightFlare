import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { AutoResizer } from "../src/components/ui/auto-resizer";
import { AutoTransition } from "../src/components/ui/auto-transition";

it("honors initial=false on SSR without hiding initial content", () => {
  expect(
    renderToStaticMarkup(
      <AutoTransition initial={false}>Visible</AutoTransition>,
    ),
  ).toContain("opacity:1");
  expect(
    renderToStaticMarkup(<AutoTransition initial>Entering</AutoTransition>),
  ).toContain("opacity:0");
});

it("does not remount unchanged children when the initial animation is disabled", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <AutoTransition initial={false} transitionKey="stable">
          <span>First</span>
        </AutoTransition>,
      ),
    );
    const element = container.querySelector("span");
    expect(element).not.toBeNull();
    await act(async () =>
      root.render(
        <AutoTransition initial={false} transitionKey="stable">
          <span>Second</span>
        </AutoTransition>,
      ),
    );
    expect(container.querySelector("span")).toBe(element);
    expect(container.textContent).toBe("Second");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("shares AutoResizer observation, measures only enabled axes, and releases the last subscriber", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const observers: Array<{
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(public callback: ResizeObserverCallback) {
        observers.push(this);
      }
    },
  );
  const reads: Array<{ id: string; axis: string }> = [];
  const sizeGetter = (axis: string) =>
    function (this: HTMLElement) {
      const id = this.firstElementChild?.id;
      if (this.parentElement?.dataset.slot === "auto-resizer" && id) {
        reads.push({ id, axis });
      }
      return 100;
    };
  const height = vi
    .spyOn(Element.prototype, "scrollHeight", "get")
    .mockImplementation(sizeGetter("height"));
  const width = vi
    .spyOn(Element.prototype, "scrollWidth", "get")
    .mockImplementation(sizeGetter("width"));
  const sample = (showWidth = true, showHeight = true) => (
    <>
      {showHeight && (
        <AutoResizer key="height">
          <span id="height">Height</span>
        </AutoResizer>
      )}
      {showWidth && (
        <AutoResizer key="width" animateHeight={false} animateWidth>
          <span id="width">Width</span>
        </AutoResizer>
      )}
      <AutoResizer key="none" animateHeight={false}>
        <span id="none">None</span>
      </AutoResizer>
    </>
  );
  try {
    await act(async () => root.render(sample()));
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    expect(observer.observe).toHaveBeenCalledTimes(2);
    expect(reads).toEqual([
      { id: "height", axis: "height" },
      { id: "width", axis: "width" },
    ]);
    const heightContent = host.querySelector("#height")!.parentElement!;
    const entry: ResizeObserverEntry = {
      target: heightContent,
      contentRect: heightContent.getBoundingClientRect(),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    };
    reads.length = 0;
    await act(async () => {
      observer.callback([entry], observer as unknown as ResizeObserver);
      observer.callback([entry], observer as unknown as ResizeObserver);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    expect(reads).toEqual([{ id: "height", axis: "height" }]);
    await act(async () => root.render(sample(false)));
    expect(observer.unobserve).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).not.toHaveBeenCalled();
    await act(async () => root.render(sample(false, false)));
    expect(observer.unobserve).toHaveBeenCalledTimes(2);
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("None");
    await act(async () => root.render(sample()));
    expect(observers).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    height.mockRestore();
    width.mockRestore();
    vi.unstubAllGlobals();
    host.remove();
  }
});
