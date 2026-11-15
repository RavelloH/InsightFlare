import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { DetailDrawer } from "@/components/dashboard/site-pages/common/detail-drawer";
import type * as AppOverlayModule from "@/components/ui/app-overlay";
import { LayerManagerProvider } from "@/components/ui/layer/layer-manager";
import type * as VerticalScrollMaskModule from "@/components/ui/vertical-scroll-mask";

// Keep the actual drawer/layer lifecycles; CSS event delivery is controlled below.
vi.mock("@/components/ui/app-overlay", () => ({
  AppOverlay: ({
    open,
    onClick,
    className,
  }: React.ComponentProps<typeof AppOverlayModule.AppOverlay>) =>
    open ? (
      <div data-slot="app-overlay" className={className} onClick={onClick} />
    ) : null,
}));
vi.mock("@/components/ui/overlay-scrollbar", () => ({
  shouldUseNativeScrollbars: () => true,
}));
vi.mock("@/components/ui/vertical-scroll-mask", () => ({
  VerticalScrollMask: ({
    children,
    hostRef,
    onClick,
  }: React.ComponentProps<
    typeof VerticalScrollMaskModule.VerticalScrollMask
  >) => (
    <div data-test-scroll="" ref={hostRef} onClick={onClick}>
      {children}
    </div>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface FixtureState {
  open: boolean;
  key: string;
  latest: boolean;
}

function requiredElement(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing fixture element: ${selector}`);
  return element;
}

async function fixture(strict = false) {
  vi.useFakeTimers();
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++next, callback);
    return next;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const changed = vi.fn<(open: boolean) => void>();
  const latest = vi.fn<(open: boolean) => void>();
  let control: ((value: Partial<FixtureState>) => void) | undefined;
  let mounted = true;

  function Fixture() {
    const [state, setState] = React.useState<FixtureState>({
      open: true,
      key: "one",
      latest: false,
    });
    control = (value) => setState((current) => ({ ...current, ...value }));
    return (
      <LayerManagerProvider>
        <DetailDrawer
          ariaLabel="test"
          drawerKey={state.key}
          open={state.open}
          onOpenChange={(open) => {
            (state.latest ? latest : changed)(open);
            setState((current) => ({ ...current, open }));
          }}
        >
          <span data-child="">body</span>
        </DetailDrawer>
      </LayerManagerProvider>
    );
  }

  await act(async () =>
    root.render(
      strict ? (
        <React.StrictMode>
          <Fixture />
        </React.StrictMode>
      ) : (
        <Fixture />
      ),
    ),
  );
  const frameCount = () =>
    document.querySelectorAll("[data-layer-frame]").length;
  const flush = async () =>
    act(async () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      queued.forEach((callback) => callback(0));
    });
  const advance = async (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });
  const set = async (value: Partial<FixtureState>) =>
    act(async () => {
      if (!control) throw new Error("Fixture is not mounted");
      control(value);
    });
  const click = async () =>
    act(async () => requiredElement("[data-slot=app-overlay]").click());
  const end = async (
    property = "transform",
    child = false,
    type = "transitionend",
  ) =>
    act(async () => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: property });
      requiredElement(child ? "[data-child]" : "[role=dialog]").dispatchEvent(
        event,
      );
    });
  const unmount = async () => {
    if (!mounted) return;
    await act(async () => root.unmount());
    mounted = false;
  };
  const cleanup = async () => {
    await unmount();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  };
  return {
    changed,
    latest,
    frameCount,
    flush,
    advance,
    set,
    click,
    end,
    unmount,
    cleanup,
  };
}

it("completes early/no-transition close at its committed deadline exactly once", async () => {
  const f = await fixture();
  try {
    await f.click();
    await f.advance(1000);
    expect(f.changed).not.toHaveBeenCalled();
    await f.flush();
    await f.advance(359);
    expect(f.frameCount()).toBe(1);
    expect(f.changed).not.toHaveBeenCalled();
    await f.advance(1);
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(false);
    await f.advance(400);
    expect(f.frameCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
it("normal transition completion cancels the deadline and ignores child/other property ends", async () => {
  const f = await fixture();
  try {
    await f.click();
    await f.flush();
    await f.end("opacity");
    await f.end("transform", true);
    expect(f.changed).not.toHaveBeenCalled();
    await f.end();
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(false);
    await f.advance(2000);
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.frameCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
it("drawer key replacement cancels stale pending close and allows the new close", async () => {
  const f = await fixture();
  try {
    await f.click();
    await f.flush();
    await f.advance(100);
    await f.set({ key: "two", open: true });
    await f.advance(1000);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.frameCount()).toBe(1);
    await f.click();
    await f.flush();
    await f.advance(360);
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    await f.cleanup();
  }
});
it("key replacement before the closing rAF invalidates it", async () => {
  const f = await fixture();
  try {
    await f.click();
    await f.set({ key: "two", open: true });
    await f.flush();
    await f.advance(1000);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.frameCount()).toBe(1);
  } finally {
    await f.cleanup();
  }
});
it("same-key reopen cancels either an uncommitted or committed prop close", async () => {
  for (const committed of [false, true]) {
    const f = await fixture();
    try {
      await f.set({ open: false });
      if (committed) {
        await f.flush();
        await f.advance(100);
      }
      await f.set({ open: true });
      await f.flush();
      await f.advance(1000);
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.frameCount()).toBe(1);
      await f.click();
      await f.flush();
      await f.advance(360);
      expect(f.changed).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await f.cleanup();
    }
  }
});
it("unmount before or after close commit cannot send a stale notification", async () => {
  for (const committed of [false, true]) {
    const f = await fixture();
    try {
      await f.click();
      if (committed) await f.flush();
      await f.unmount();
      await f.flush();
      await f.advance(2000);
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.frameCount()).toBe(0);
      expect(document.body.style.overflow).toBe("");
    } finally {
      await f.cleanup();
    }
  }
});
it("StrictMode effect replay still completes once without transition events", async () => {
  const f = await fixture(true);
  try {
    await f.click();
    await f.flush();
    await f.advance(360);
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(false);
    await f.advance(500);
    expect(f.frameCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
it("prop open=false follows the same bounded completion path", async () => {
  const f = await fixture();
  try {
    await f.set({ open: false });
    await f.flush();
    await f.advance(360);
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(false);
    await f.advance(400);
    expect(f.frameCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
it("latest close callback is used without restarting the committed deadline", async () => {
  const f = await fixture();
  try {
    await f.click();
    await f.flush();
    await f.advance(300);
    await f.set({ latest: true });
    await f.advance(60);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.latest).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    await f.cleanup();
  }
});
it("cancelled/reduced-motion transition still cleans up without an end event", async () => {
  const f = await fixture();
  try {
    await f.click();
    await f.flush();
    await f.end("transform", false, "transitioncancel");
    await f.advance(360);
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    await f.cleanup();
  }
});
it("long scroll preserves the actual maximum close duration", async () => {
  const f = await fixture();
  try {
    requiredElement("[data-test-scroll]").scrollTop = 1500;
    await f.click();
    await f.flush();
    expect(requiredElement("[role=dialog]").style.transition).toContain(
      "640ms",
    );
    await f.advance(639);
    expect(f.changed).not.toHaveBeenCalled();
    await f.advance(1);
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(false);
  } finally {
    await f.cleanup();
  }
});
