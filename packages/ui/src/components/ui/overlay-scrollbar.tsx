import {
  type ComponentPropsWithoutRef,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import { OverlayScrollbars, type PartialOptions } from "overlayscrollbars";
import { useOverlayScrollbars } from "overlayscrollbars-react";

import { cn } from "../../lib/utils";

export const HORIZONTAL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "scroll",
    y: "hidden",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;

export const VERTICAL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;

export const BOTH_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "scroll",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;

export const PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS = {
  ...VERTICAL_SCROLLBAR_OPTIONS,
  scrollbars: {
    ...VERTICAL_SCROLLBAR_OPTIONS.scrollbars,
    autoHide: "never",
  },
} satisfies PartialOptions;

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

// Initialization and edge masks observe the same React-owned nodes. Share
// only our size notifications, not OverlayScrollbars' internal observers or
// initialization lifecycle. One callback per subscriber per delivery.
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

/**
 * Enhancement is visual only: native overflow works before it starts. Run
 * at most one costly initialization per frame, outside React's layout commit.
 */
const enhancements = new Set<() => void>();
let enhancementScheduled = false;

function scheduleNextEnhancement() {
  if (enhancementScheduled || enhancements.size === 0) return;
  enhancementScheduled = true;
  window.requestAnimationFrame(() => {
    // An idle deadline is not guaranteed on a busy page. Yield the frame
    // before initializing one host, but never wait for an idle budget.
    window.setTimeout(() => {
      enhancementScheduled = false;
      const next = enhancements.values().next().value;
      if (next) {
        enhancements.delete(next);
        next();
      }
      scheduleNextEnhancement();
    }, 0);
  });
}

function enqueueEnhancement(job: () => void) {
  enhancements.add(job);
  scheduleNextEnhancement();
  return () => enhancements.delete(job);
}

function hasScrollableOverflow(
  viewport: HTMLDivElement,
  options: PartialOptions,
) {
  const x = options.overflow?.x;
  const y = options.overflow?.y;
  return (
    (x !== "hidden" &&
      x !== "visible" &&
      viewport.scrollWidth > viewport.clientWidth + 1) ||
    (y !== "hidden" &&
      y !== "visible" &&
      viewport.scrollHeight > viewport.clientHeight + 1)
  );
}

interface OverlayScrollbarNodes {
  hostRef: { current: HTMLDivElement | null };
  viewportRef: { current: HTMLDivElement | null };
  contentRef: { current: HTMLDivElement | null };
  options: PartialOptions;
  enabled?: boolean;
}

/**
 * Initializes OverlayScrollbars against a React-owned viewport/content pair.
 * Providing both nodes keeps OverlayScrollbars from moving React children while
 * it builds its scrollbar UI around the host.
 */
export function useReactOverlayScrollbar({
  hostRef,
  viewportRef,
  contentRef,
  options,
  enabled = true,
}: OverlayScrollbarNodes) {
  const [initialize, getInstance] = useOverlayScrollbars({ options });
  const instanceRef = useRef<OverlayScrollbars | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (shouldUseNativeScrollbars()) return;

    const host = hostRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!host || !viewport || !content) return;
    if (!enabled) {
      viewport.setAttribute("data-scrollbar-fallback", "");
      return () => viewport.removeAttribute("data-scrollbar-fallback");
    }

    let cancelled = false;
    let failed = false;
    let instance: OverlayScrollbars | null = null;
    let cancelQueued: (() => void) | null = null;
    let stopObserving: (() => void) | null = null;
    const notify = () =>
      viewport.dispatchEvent(new Event(SCROLLBAR_UPDATED_EVENT));
    const enhance = () => {
      cancelQueued = null;
      if (cancelled || failed || instance || !host.isConnected) return;
      // The outer shell often has no overflow; don't build a scrollbar until
      // the viewport actually needs one.
      if (!hasScrollableOverflow(viewport, optionsRef.current)) return;
      try {
        initialize({ target: host, elements: { viewport, content } });
        const candidate = getInstance();
        instance =
          candidate && OverlayScrollbars.valid(candidate) ? candidate : null;
      } catch {
        // Keep the original viewport scrollable if enhancement fails.
      }
      instanceRef.current = instance;
      if (instance) {
        stopObserving?.();
        stopObserving = null;
        viewport.removeEventListener("scroll", queue);
        instance.on("updated", notify);
      } else {
        failed = true;
        stopObserving?.();
        stopObserving = null;
        viewport.removeEventListener("scroll", queue);
        viewport.setAttribute("data-scrollbar-fallback", "");
      }
      notify();
    };
    const queue = () => {
      if (!cancelled && !failed && !instance && !cancelQueued)
        cancelQueued = enqueueEnhancement(enhance);
    };
    stopObserving = observeScrollbarResize(viewport, content, queue);
    viewport.addEventListener("scroll", queue, { passive: true });
    queue();

    return () => {
      cancelled = true;
      cancelQueued?.();
      viewport.removeEventListener("scroll", queue);
      stopObserving?.();
      if (instance && OverlayScrollbars.valid(instance)) {
        instance.off("updated", notify);
        instance.destroy();
      }
      viewport.removeAttribute("data-scrollbar-fallback");
      instanceRef.current = null;
    };
  }, [enabled, getInstance, hostRef, initialize, viewportRef, contentRef]);

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
  options?: PartialOptions;
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
      const scrollLeft = canScrollHorizontally ? viewport.scrollLeft : 0;
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
  }, [scrollbarRef, syncKey]);

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
