import {
  type ComponentPropsWithoutRef,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PartialOptions } from "overlayscrollbars";
import { OverlayScrollbars } from "overlayscrollbars";

import { cn } from "@/lib/utils";

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

export function shouldUseNativeScrollbars(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  const platform = uaData?.platform || navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  const vendor = navigator.vendor || "";
  const isApplePlatform =
    /Mac|iPhone|iPad|iPod/i.test(platform) ||
    /iPhone|iPad|iPod/i.test(userAgent);
  const isSafari =
    /Safari/i.test(userAgent) &&
    /Apple/i.test(vendor) &&
    !/Android|Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Opera/i.test(userAgent);

  return isApplePlatform || isSafari;
}

export function prepareNativeScrollbarHost(host: HTMLElement): boolean {
  if (!shouldUseNativeScrollbars()) return false;
  host.removeAttribute("data-overlayscrollbars-initialize");
  return true;
}

export function useNativeScrollbars() {
  const [nativeScrollbars, setNativeScrollbars] = useState(false);

  useEffect(() => {
    setNativeScrollbars(shouldUseNativeScrollbars());
  }, []);

  return nativeScrollbars;
}

function syncHorizontalMaskVisibility(
  leftMask: HTMLDivElement | null,
  rightMask: HTMLDivElement | null,
  viewport: HTMLElement | null,
) {
  if (!viewport) return;

  const { clientWidth, scrollLeft, scrollWidth } = viewport;
  const canScroll = scrollWidth > clientWidth + 1;
  const showLeft = canScroll && scrollLeft > 10;
  const showRight = canScroll && scrollLeft < scrollWidth - clientWidth - 10;

  leftMask?.classList.toggle("opacity-100", showLeft);
  leftMask?.classList.toggle("opacity-0", !showLeft);
  rightMask?.classList.toggle("opacity-100", showRight);
  rightMask?.classList.toggle("opacity-0", !showRight);
}

interface OverlayScrollbarProps extends ComponentPropsWithoutRef<"div"> {
  axis?: "horizontal" | "vertical";
  maskClassName?: string;
  options?: PartialOptions;
  showEdgeMasks?: boolean;
  syncKey?: string | number | boolean | null;
}

export function OverlayScrollbar({
  axis = "horizontal",
  children,
  className,
  maskClassName,
  options,
  showEdgeMasks = false,
  syncKey,
  ...props
}: OverlayScrollbarProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const leftMaskRef = useRef<HTMLDivElement | null>(null);
  const rightMaskRef = useRef<HTMLDivElement | null>(null);
  const edgeMaskFrameRef = useRef<number | null>(null);
  const syncEdgeMasksRef = useRef<(() => void) | null>(null);
  const syncSlotBoundsRef = useRef<(() => void) | null>(null);
  const syncSlotBoundsFrameRef = useRef<number | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );
  const nativeScrollbars = useNativeScrollbars();
  const resolvedOptions =
    options ??
    (axis === "vertical"
      ? VERTICAL_SCROLLBAR_OPTIONS
      : HORIZONTAL_SCROLLBAR_OPTIONS);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (prepareNativeScrollbarHost(host)) return;

    if (axis === "vertical") {
      const existing = OverlayScrollbars(host);
      const instance = existing ?? OverlayScrollbars(host, resolvedOptions);
      if (existing) {
        existing.options(resolvedOptions);
      }
      scrollbarRef.current = instance;

      const resizeObserver = new ResizeObserver(() => instance.update());
      resizeObserver.observe(host);
      instance.update();

      return () => {
        resizeObserver.disconnect();
        if (!existing) {
          instance.destroy();
        }
        if (scrollbarRef.current === instance) {
          scrollbarRef.current = null;
        }
      };
    }

    const slot = document.createElement("div");
    slot.style.position = "fixed";
    slot.style.bottom = "0";
    slot.style.left = "0";
    slot.style.width = "0";
    slot.style.height = "12px";
    slot.style.zIndex = "99999";
    slot.style.setProperty("overflow-anchor", "none");
    document.body.appendChild(slot);

    const existing = OverlayScrollbars(host);
    const horizontalInstance =
      existing ??
      OverlayScrollbars(
        {
          target: host,
          scrollbars: {
            slot,
          },
        },
        resolvedOptions,
      );
    if (existing) {
      existing.options(resolvedOptions);
    }
    scrollbarRef.current = horizontalInstance;

    const syncSlotBounds = () => {
      const rect = host.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const width = Math.max(0, right - left);
      const isVisible = rect.bottom > 0 && rect.top < window.innerHeight;
      const hasHorizontalOverflow = horizontalInstance.state().hasOverflow.x;
      const slotHeight = slot.offsetHeight || 12;
      const isAtHostBottom = rect.bottom <= window.innerHeight;

      slot.style.display = isVisible && hasHorizontalOverflow ? "" : "none";
      slot.style.width = `${width}px`;
      if (isAtHostBottom) {
        slot.style.position = "absolute";
        slot.style.bottom = "";
        slot.style.top = `${window.scrollY + rect.bottom - slotHeight}px`;
        slot.style.left = `${window.scrollX + left}px`;
      } else {
        slot.style.position = "fixed";
        slot.style.top = "";
        slot.style.bottom = "0";
        slot.style.left = `${left}px`;
      }
    };
    const updateAndSyncSlotBounds = () => {
      horizontalInstance.update();
      syncSlotBounds();
    };
    const scheduleSlotBoundsSync = () => {
      if (syncSlotBoundsFrameRef.current !== null) return;

      syncSlotBoundsFrameRef.current = window.requestAnimationFrame(() => {
        syncSlotBoundsFrameRef.current = null;
        syncSlotBounds();
      });
    };

    syncSlotBoundsRef.current = syncSlotBounds;
    const resizeObserver = new ResizeObserver(updateAndSyncSlotBounds);

    resizeObserver.observe(host);
    window.addEventListener("resize", updateAndSyncSlotBounds);
    window.addEventListener("scroll", scheduleSlotBoundsSync, {
      capture: true,
      passive: true,
    });
    horizontalInstance.update();
    syncSlotBounds();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateAndSyncSlotBounds);
      window.removeEventListener("scroll", scheduleSlotBoundsSync, true);
      if (syncSlotBoundsFrameRef.current !== null) {
        window.cancelAnimationFrame(syncSlotBoundsFrameRef.current);
        syncSlotBoundsFrameRef.current = null;
      }
      if (!existing) {
        horizontalInstance.destroy();
      }
      if (scrollbarRef.current === horizontalInstance) {
        scrollbarRef.current = null;
      }
      if (syncSlotBoundsRef.current === syncSlotBounds) {
        syncSlotBoundsRef.current = null;
      }
      slot.remove();
    };
  }, [axis, resolvedOptions]);

  useEffect(() => {
    if (!showEdgeMasks || axis !== "horizontal") return;

    const host = hostRef.current;
    if (!host) return;

    const getViewport = () =>
      (shouldUseNativeScrollbars()
        ? host
        : scrollbarRef.current?.elements().viewport) ?? host;
    const sync = () => {
      if (edgeMaskFrameRef.current !== null) return;

      edgeMaskFrameRef.current = requestAnimationFrame(() => {
        edgeMaskFrameRef.current = null;
        syncHorizontalMaskVisibility(
          leftMaskRef.current,
          rightMaskRef.current,
          getViewport(),
        );
      });
    };
    const instance = scrollbarRef.current;

    host.addEventListener("scroll", sync, { passive: true });
    instance?.on("scroll", sync);
    instance?.on("updated", sync);

    const resizeObserver = new ResizeObserver(() => {
      sync();
    });
    resizeObserver.observe(host);
    syncEdgeMasksRef.current = sync;
    sync();

    return () => {
      host.removeEventListener("scroll", sync);
      instance?.off("scroll", sync);
      instance?.off("updated", sync);
      resizeObserver.disconnect();
      if (edgeMaskFrameRef.current !== null) {
        cancelAnimationFrame(edgeMaskFrameRef.current);
        edgeMaskFrameRef.current = null;
      }
      if (syncEdgeMasksRef.current === sync) {
        syncEdgeMasksRef.current = null;
      }
    };
  }, [axis, nativeScrollbars, showEdgeMasks]);

  useEffect(() => {
    syncSlotBoundsRef.current?.();
    syncEdgeMasksRef.current?.();
  }, [children]);

  useEffect(() => {
    scrollbarRef.current?.update();
    syncSlotBoundsRef.current?.();
    syncEdgeMasksRef.current?.();
  }, [syncKey]);

  const scrollbarHost = (
    <div
      {...props}
      ref={hostRef}
      className={cn(
        nativeScrollbars
          ? axis === "vertical"
            ? "overflow-y-auto"
            : "overflow-x-auto"
          : "overflow-hidden",
        className,
      )}
      data-overlayscrollbars-initialize={nativeScrollbars ? undefined : ""}
    >
      {children}
    </div>
  );

  if (!showEdgeMasks || axis !== "horizontal") return scrollbarHost;

  return (
    <div className="relative">
      <div
        ref={leftMaskRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0 bottom-0 left-0 z-10 w-8 bg-gradient-to-r opacity-0 transition-opacity duration-300",
          maskClassName ?? "from-background via-background/80 to-transparent",
        )}
      />
      <div
        ref={rightMaskRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0 right-0 bottom-0 z-10 w-8 bg-gradient-to-l opacity-0 transition-opacity duration-300",
          maskClassName ?? "from-background via-background/80 to-transparent",
        )}
      />
      {scrollbarHost}
    </div>
  );
}
