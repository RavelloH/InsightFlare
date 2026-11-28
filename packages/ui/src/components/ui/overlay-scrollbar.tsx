import {
  type ComponentPropsWithoutRef,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/utils";

export interface ScrollbarOptions {
  overflow: { x: "scroll" | "hidden"; y: "scroll" | "hidden" };
  scrollbars: { autoHide: "move" | "never"; autoHideDelay?: number };
}

export const HORIZONTAL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "scroll",
    y: "hidden",
  },
  scrollbars: {
    autoHide: "move",
    autoHideDelay: 420,
  },
} satisfies ScrollbarOptions;

export const VERTICAL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    autoHide: "move",
    autoHideDelay: 420,
  },
} satisfies ScrollbarOptions;

export const BOTH_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "scroll",
    y: "scroll",
  },
  scrollbars: {
    autoHide: "move",
    autoHideDelay: 420,
  },
} satisfies ScrollbarOptions;

export const PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS = {
  ...VERTICAL_SCROLLBAR_OPTIONS,
  scrollbars: {
    ...VERTICAL_SCROLLBAR_OPTIONS.scrollbars,
    autoHide: "never",
  },
} satisfies ScrollbarOptions;

function isSafariFamily(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
) {
  const isIOS =
    /iPhone|iPad|iPod/i.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1);
  const isWebKit = /AppleWebKit/i.test(userAgent);
  const isOtherDesktopEngine =
    /Chrome|Chromium|CriOS|Edg|OPR|Opera|Brave/i.test(userAgent);

  return (
    isWebKit && (isIOS || (!isOtherDesktopEngine && /Safari/i.test(userAgent)))
  );
}

export const SCROLLBAR_POLICY_INIT_SCRIPT = `(() => {
  const userAgent = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  const isWebKit = /AppleWebKit/i.test(userAgent);
  const isOtherDesktopEngine = /Chrome|Chromium|CriOS|Edg|OPR|Opera|Brave/i.test(userAgent);
  const isSafariFamily = isWebKit && (isIOS || (!isOtherDesktopEngine && /Safari/i.test(userAgent)));
  document.documentElement.dataset.scrollbarMode = isSafariFamily ? "native" : "overlay";
})();`;

export function shouldUseNativeScrollbars(): boolean {
  if (typeof navigator === "undefined") return false;
  const mode =
    typeof document === "undefined"
      ? undefined
      : document.documentElement.dataset.scrollbarMode;
  if (mode === "native") return true;
  if (mode === "overlay") return false;

  return isSafariFamily(
    navigator.userAgent || "",
    navigator.platform || "",
    navigator.maxTouchPoints || 0,
  );
}

export const SCROLLBAR_UPDATED_EVENT = "insightflare:scrollbar-updated";

// Share size observations across all scrollbars and edge masks. One callback per subscriber per delivery.
const resizeSubscribers = new Map<Element, Set<() => void>>();
let scrollbarResizeObserver: ResizeObserver | null = null;

export function observeScrollbarResize(
  viewport: Element,
  content: Element | null,
  notify: () => void,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  if (!scrollbarResizeObserver) {
    scrollbarResizeObserver = new ResizeObserver((entries) => {
      const callbacks = new Set<() => void>();
      for (const entry of entries)
        for (const callback of resizeSubscribers.get(entry.target) ?? [])
          callbacks.add(callback);
      for (const callback of callbacks) callback();
    });
  }
  const observer = scrollbarResizeObserver;
  const nodes =
    content && content !== viewport ? [viewport, content] : [viewport];
  for (const node of nodes) {
    const subscribers = resizeSubscribers.get(node);
    if (subscribers) {
      subscribers.add(notify);
    } else {
      resizeSubscribers.set(node, new Set([notify]));
      observer.observe(node);
    }
  }
  return () => {
    for (const node of nodes) {
      const subscribers = resizeSubscribers.get(node);
      if (!subscribers?.delete(notify)) continue;
      if (subscribers.size === 0) {
        resizeSubscribers.delete(node);
        observer.unobserve(node);
      }
    }
    if (resizeSubscribers.size === 0 && scrollbarResizeObserver === observer) {
      observer.disconnect();
      scrollbarResizeObserver = null;
    }
  };
}

// Batch all geometry reads before writes; scroll-only updates reuse cached sizes.
type ScrollbarFrame = () => (() => void) | undefined;
const pendingFrames = new Set<ScrollbarFrame>();
let pendingFrameId: number | null = null;
function scheduleScrollbarFrame(read: ScrollbarFrame) {
  pendingFrames.add(read);
  if (pendingFrameId !== null) return;
  pendingFrameId = requestAnimationFrame(() => {
    pendingFrameId = null;
    const reads = [...pendingFrames];
    pendingFrames.clear();
    const writes = reads.map((job) => job());
    for (const write of writes) write?.();
  });
}
function cancelScrollbarFrame(read: ScrollbarFrame) {
  pendingFrames.delete(read);
  if (!pendingFrames.size && pendingFrameId !== null) {
    cancelAnimationFrame(pendingFrameId);
    pendingFrameId = null;
  }
}

type ScrollAxis = "x" | "y";
type ScrollbarGeometry = { max: number; length: number; thumb: number };

export function calculateScrollbarGeometry(
  client: number,
  scroll: number,
  track: number,
): ScrollbarGeometry {
  const max = Math.max(0, scroll - client);
  const length = Math.max(0, track);
  const thumb =
    max > 1 && scroll > 0
      ? Math.min(length, Math.max(18, (length * client) / scroll))
      : length;
  return { max, length, thumb };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
interface ScrollbarState {
  overflowAmount: { x: number; y: number };
  rtl: boolean;
}
interface ScrollbarInstance {
  state: () => ScrollbarState;
  update: () => void;
}
interface ScrollbarTrack {
  axis: ScrollAxis;
  element: HTMLDivElement;
  handle: HTMLDivElement;
  geometry: ScrollbarGeometry;
  position: number;
  dispose: () => void;
}

function createScrollbar(
  host: HTMLDivElement,
  viewport: HTMLDivElement,
  content: HTMLDivElement,
  options: ScrollbarOptions,
): ScrollbarInstance & { destroy: () => void } {
  const tracks: ScrollbarTrack[] = [];
  const state: ScrollbarState = { overflowAmount: { x: 0, y: 0 }, rtl: false };
  let disposed = false;
  let dirty = true;
  let measured = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let activeDrag = false;
  let activeHover = false;
  const persistent = options.scrollbars.autoHide === "never";
  const delay = options.scrollbars.autoHideDelay ?? 420;
  const position = (axis: ScrollAxis, max: number) =>
    clamp(
      axis === "x"
        ? viewport.scrollLeft + (state.rtl ? max : 0)
        : viewport.scrollTop,
      0,
      max,
    );
  function setPosition(axis: ScrollAxis, next: number, max: number) {
    const value = clamp(next, 0, max);
    if (axis === "x") viewport.scrollLeft = value - (state.rtl ? max : 0);
    else viewport.scrollTop = value;
  }
  function hide() {
    clearTimeout(hideTimer);
    if (persistent || activeDrag || activeHover) return;
    hideTimer = setTimeout(() => {
      for (const track of tracks)
        track.element.classList.add("os-scrollbar-auto-hide-hidden");
    }, delay);
  }
  function show() {
    if (persistent) return;
    for (const track of tracks)
      if (track.element.classList.contains("os-scrollbar-auto-hide-hidden"))
        track.element.classList.remove("os-scrollbar-auto-hide-hidden");
    hide();
  }
  function makeTrack(axis: ScrollAxis) {
    const element = document.createElement("div");
    element.className =
      "os-scrollbar os-theme-insightflare os-scrollbar-" +
      (axis === "x" ? "horizontal" : "vertical") +
      (persistent
        ? ""
        : " os-scrollbar-auto-hide os-scrollbar-auto-hide-hidden");
    element.setAttribute("aria-hidden", "true");
    const rail = document.createElement("div");
    rail.className = "os-scrollbar-track";
    const handle = document.createElement("div");
    handle.className = "os-scrollbar-handle";
    rail.append(handle);
    element.append(rail);
    host.append(element);
    const track: ScrollbarTrack = {
      axis,
      element,
      handle,
      geometry: { max: 0, length: 0, thumb: 0 },
      position: 0,
      dispose: () => undefined,
    };
    let drag: {
      id: number;
      start: number;
      scroll: number;
      ratio: number;
    } | null = null;
    const coordinate = (event: PointerEvent) =>
      axis === "x" ? event.clientX : event.clientY;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || track.geometry.max <= 1)
        return;
      const travel = track.geometry.length - track.geometry.thumb;
      if (travel <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      drag = {
        id: event.pointerId,
        start: coordinate(event),
        scroll: position(axis, track.geometry.max),
        ratio: track.geometry.max / travel,
      };
      activeDrag = true;
      element.classList.add("os-scrollbar-dragging");
      show();
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      setPosition(
        axis,
        drag.scroll + (coordinate(event) - drag.start) * drag.ratio,
        track.geometry.max,
      );
    };
    const finish = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      drag = null;
      activeDrag = false;
      element.classList.remove("os-scrollbar-dragging");
      if (handle.hasPointerCapture(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
      hide();
    };
    const enter = () => {
      activeHover = true;
      show();
    };
    const leave = () => {
      activeHover = false;
      hide();
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const delta = axis === "x" ? event.deltaX || event.deltaY : event.deltaY;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? axis === "x"
              ? viewport.clientWidth
              : viewport.clientHeight
            : 1;
      const current = position(axis, track.geometry.max);
      const next = clamp(current + delta * unit, 0, track.geometry.max);
      if (next === current) return;
      event.preventDefault();
      setPosition(axis, next, track.geometry.max);
    };
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("wheel", wheel, { passive: false });
    track.dispose = () => {
      if (drag && handle.hasPointerCapture(drag.id))
        handle.releasePointerCapture(drag.id);
      drag = null;
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("wheel", wheel);
      element.remove();
    };
    tracks.push(track);
  }
  if (options.overflow.x === "scroll") makeTrack("x");
  if (options.overflow.y === "scroll") makeTrack("y");
  for (const track of tracks)
    track.element.classList.toggle("os-scrollbar-both", tracks.length === 2);

  const read: ScrollbarFrame = () => {
    if (disposed) return;
    const needsMeasure = dirty;
    dirty = false;
    const previous = state.overflowAmount;
    const previousRtl = state.rtl;
    if (needsMeasure) {
      state.rtl = getComputedStyle(viewport).direction === "rtl";
      const overflowAmount = { x: 0, y: 0 };
      for (const track of tracks) {
        const x = track.axis === "x";
        track.geometry = calculateScrollbarGeometry(
          x ? viewport.clientWidth : viewport.clientHeight,
          x ? viewport.scrollWidth : viewport.scrollHeight,
          x ? track.element.clientWidth : track.element.clientHeight,
        );
        overflowAmount[track.axis] = track.geometry.max;
      }
      state.overflowAmount = overflowAmount;
    }
    for (const track of tracks)
      track.position = position(track.axis, track.geometry.max);
    const notify =
      !measured ||
      previous.x !== state.overflowAmount.x ||
      previous.y !== state.overflowAmount.y ||
      previousRtl !== state.rtl;
    measured = true;
    return () => {
      if (disposed) return;
      for (const track of tracks) {
        const { max, length, thumb } = track.geometry;
        const visible = max > 1 && length > 0;
        track.element.classList.toggle("os-scrollbar-visible", visible);
        if (needsMeasure)
          track.element.classList.toggle("os-scrollbar-rtl", state.rtl);
        if (!visible) continue;
        const offset = max > 0 ? (track.position / max) * (length - thumb) : 0;
        const x = track.axis === "x";
        if (needsMeasure) {
          const size = thumb + "px";
          if (x) track.handle.style.width = size;
          else track.handle.style.height = size;
        }
        const transform = x
          ? "translate3d(" + offset + "px,0,0)"
          : "translate3d(0," + offset + "px,0)";
        if (track.handle.style.transform !== transform)
          track.handle.style.transform = transform;
      }
      if (notify) viewport.dispatchEvent(new Event(SCROLLBAR_UPDATED_EVENT));
    };
  };
  const update = () => {
    if (disposed) return;
    dirty = true;
    scheduleScrollbarFrame(read);
  };
  const onScroll = () => {
    if (
      !measured ||
      tracks.some(
        (track) =>
          track.geometry.max <= 1 &&
          Math.abs(
            track.axis === "x" ? viewport.scrollLeft : viewport.scrollTop,
          ) > 1,
      )
    )
      update();
    else scheduleScrollbarFrame(read);
    show();
  };
  // A table may change intrinsic width without resizing its block wrapper.
  // Observe only immediate children, never each row or attribute mutation.
  const stopResize = observeScrollbarResize(viewport, content, update);
  const childObservers = new Map<Element, () => void>();
  const observeChildren = () => {
    if (options.overflow.x !== "scroll") return;
    const children = new Set(Array.from(content.children));
    for (const [child, stop] of childObservers)
      if (!children.has(child)) {
        stop();
        childObservers.delete(child);
      }
    for (const child of children)
      if (!childObservers.has(child))
        childObservers.set(child, observeScrollbarResize(child, null, update));
  };
  observeChildren();
  const childObserver =
    options.overflow.x === "scroll" && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          observeChildren();
          update();
        })
      : null;
  childObserver?.observe(content, { childList: true });
  viewport.addEventListener("scroll", onScroll, { passive: true });
  content.addEventListener("load", update, true);
  host.addEventListener("pointermove", show, { passive: true });
  host.addEventListener("pointerleave", hide);
  viewport.setAttribute("data-scrollbar-enhanced", "");
  update();
  return {
    state: () => state,
    update,
    destroy() {
      disposed = true;
      clearTimeout(hideTimer);
      cancelScrollbarFrame(read);
      stopResize();
      childObserver?.disconnect();
      for (const stop of childObservers.values()) stop();
      childObservers.clear();
      viewport.removeEventListener("scroll", onScroll);
      content.removeEventListener("load", update, true);
      host.removeEventListener("pointermove", show);
      host.removeEventListener("pointerleave", hide);
      for (const track of tracks) track.dispose();
      clearTimeout(hideTimer);
      viewport.removeAttribute("data-scrollbar-enhanced");
    },
  };
}

interface OverlayScrollbarNodes {
  hostRef: { current: HTMLDivElement | null };
  viewportRef: { current: HTMLDivElement | null };
  contentRef: { current: HTMLDivElement | null };
  options: ScrollbarOptions;
  enabled?: boolean;
}

export function useReactOverlayScrollbar({
  hostRef,
  viewportRef,
  contentRef,
  options,
  enabled = true,
}: OverlayScrollbarNodes) {
  const instanceRef = useRef<ScrollbarInstance | null>(null);
  const { x, y } = options.overflow;
  const { autoHide, autoHideDelay } = options.scrollbars;
  useEffect(() => {
    if (shouldUseNativeScrollbars()) return;
    const host = hostRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!host || !viewport || !content || !enabled) return;
    const instance = createScrollbar(host, viewport, content, {
      overflow: { x, y },
      scrollbars: { autoHide, autoHideDelay },
    });
    instanceRef.current = instance;
    return () => {
      instance.destroy();
      instanceRef.current = null;
    };
  }, [
    enabled,
    hostRef,
    viewportRef,
    contentRef,
    x,
    y,
    autoHide,
    autoHideDelay,
  ]);
  return instanceRef;
}

function assignRef(
  ref: Ref<HTMLDivElement> | undefined,
  node: HTMLDivElement | null,
) {
  if (typeof ref === "function") {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
}

export interface OverlayScrollbarProps extends ComponentPropsWithoutRef<"div"> {
  axis?: "both" | "horizontal" | "vertical";
  contentClassName?: string;
  maskClassName?: string;
  options?: ScrollbarOptions;
  scrollElementRef?: Ref<HTMLDivElement>;
  showEdgeMasks?: boolean;
  syncKey?: string | number | boolean | null;
  viewportClassName?: string;
}

export function OverlayScrollbar({
  axis = "horizontal",
  children,
  className,
  contentClassName,
  maskClassName,
  options,
  scrollElementRef,
  showEdgeMasks = false,
  syncKey,
  viewportClassName,
  ...props
}: OverlayScrollbarProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [edgeMasks, setEdgeMasks] = useState({
    left: false,
    right: false,
    top: false,
    bottom: false,
  });
  const resolvedOptions =
    options ??
    (axis === "both"
      ? BOTH_SCROLLBAR_OPTIONS
      : axis === "vertical"
        ? VERTICAL_SCROLLBAR_OPTIONS
        : HORIZONTAL_SCROLLBAR_OPTIONS);
  const scrollbarRef = useReactOverlayScrollbar({
    hostRef,
    viewportRef,
    contentRef,
    options: resolvedOptions,
  });

  useEffect(() => {
    if (!showEdgeMasks) {
      setEdgeMasks((current) =>
        current.left || current.right || current.top || current.bottom
          ? { left: false, right: false, top: false, bottom: false }
          : current,
      );
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;
    const tracksHorizontal = axis === "horizontal" || axis === "both";
    const tracksVertical = axis === "vertical" || axis === "both";
    let frameId: number | null = null;
    const sync = () => {
      frameId = null;
      // The enhanced scrollbar already owns these layout measurements.
      // Until it initializes (or on native/fallback), read only the tracked axis.
      const overflow = scrollbarRef.current?.state().overflowAmount;
      const maxScrollLeft = tracksHorizontal
        ? Math.max(
            0,
            overflow?.x ?? viewport.scrollWidth - viewport.clientWidth,
          )
        : 0;
      const maxScrollTop = tracksVertical
        ? Math.max(
            0,
            overflow?.y ?? viewport.scrollHeight - viewport.clientHeight,
          )
        : 0;
      const canScrollHorizontally = maxScrollLeft > 1;
      const canScrollVertically = maxScrollTop > 1;
      const rtl =
        canScrollHorizontally &&
        (scrollbarRef.current?.state().rtl ??
          getComputedStyle(viewport).direction === "rtl");
      const scrollLeft = canScrollHorizontally
        ? viewport.scrollLeft + (rtl ? maxScrollLeft : 0)
        : 0;
      const scrollTop = canScrollVertically ? viewport.scrollTop : 0;
      const next = {
        left: canScrollHorizontally && scrollLeft > 10,
        right: canScrollHorizontally && scrollLeft < maxScrollLeft - 10,
        top: canScrollVertically && scrollTop > 10,
        bottom: canScrollVertically && scrollTop < maxScrollTop - 10,
      };
      setEdgeMasks((current) =>
        current.left === next.left &&
        current.right === next.right &&
        current.top === next.top &&
        current.bottom === next.bottom
          ? current
          : next,
      );
    };

    const scheduleSync = () => {
      if (frameId === null) frameId = window.requestAnimationFrame(sync);
    };
    viewport.addEventListener("scroll", scheduleSync, { passive: true });
    viewport.addEventListener(SCROLLBAR_UPDATED_EVENT, scheduleSync);
    const stopObserving = observeScrollbarResize(
      viewport,
      contentRef.current,
      scheduleSync,
    );
    scheduleSync();

    return () => {
      viewport.removeEventListener("scroll", scheduleSync);
      viewport.removeEventListener(SCROLLBAR_UPDATED_EVENT, scheduleSync);
      stopObserving();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [axis, scrollbarRef, showEdgeMasks]);

  useEffect(() => {
    if (!scrollbarRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      scrollbarRef.current?.update();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollbarRef, syncKey, props.dir]);

  return (
    <div
      {...props}
      ref={hostRef}
      className={cn("os-scrollbar-host relative overflow-hidden", className)}
      data-scrollbar-axis={axis}
    >
      {showEdgeMasks && (axis === "horizontal" || axis === "both") ? (
        <>
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 bottom-0 left-0 z-10 w-8 bg-gradient-to-r transition-opacity duration-300",
              edgeMasks.left ? "opacity-100" : "opacity-0",
              maskClassName ??
                "from-background via-background/80 to-transparent",
            )}
          />
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 right-0 bottom-0 z-10 w-8 bg-gradient-to-l transition-opacity duration-300",
              edgeMasks.right ? "opacity-100" : "opacity-0",
              maskClassName ??
                "from-background via-background/80 to-transparent",
            )}
          />
        </>
      ) : null}
      {showEdgeMasks && (axis === "vertical" || axis === "both") ? (
        <>
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 right-0 left-0 z-10 h-8 bg-gradient-to-b transition-opacity duration-300",
              edgeMasks.top ? "opacity-100" : "opacity-0",
              maskClassName ??
                "from-background via-background/80 to-transparent",
            )}
          />
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute right-0 bottom-0 left-0 z-10 h-8 bg-gradient-to-t transition-opacity duration-300",
              edgeMasks.bottom ? "opacity-100" : "opacity-0",
              maskClassName ??
                "from-background via-background/80 to-transparent",
            )}
          />
        </>
      ) : null}
      <div
        ref={(node) => {
          viewportRef.current = node;
          assignRef(scrollElementRef, node);
        }}
        className={cn(
          "os-scrollbar-viewport h-full min-h-0",
          viewportClassName,
        )}
        data-scrollbar-axis={axis}
      >
        <div
          ref={contentRef}
          className={cn("os-scrollbar-content", contentClassName)}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
