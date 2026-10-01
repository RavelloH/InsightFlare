import {
  type ComponentPropsWithoutRef,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { OverlayScrollbars, type PartialOptions } from "overlayscrollbars";
import { useOverlayScrollbars } from "overlayscrollbars-react";

import { cn } from "../../lib/utils";

const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

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

  useClientLayoutEffect(() => {
    if (!enabled || shouldUseNativeScrollbars()) return;

    const host = hostRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!host || !viewport || !content) return;

    initialize({ target: host, elements: { viewport, content } });
    const instance = getInstance();
    instanceRef.current = instance;

    return () => {
      if (instance && OverlayScrollbars.valid(instance)) instance.destroy();
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
      setEdgeMasks({ left: false, right: false, top: false, bottom: false });
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;
    const instance = scrollbarRef.current;
    const tracksHorizontal = axis === "horizontal" || axis === "both";
    const tracksVertical = axis === "vertical" || axis === "both";
    const sync = () => {
      const {
        clientHeight,
        clientWidth,
        scrollHeight,
        scrollLeft,
        scrollTop,
        scrollWidth,
      } = viewport;
      const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
      const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
      const canScrollHorizontally = tracksHorizontal && maxScrollLeft > 1;
      const canScrollVertically = tracksVertical && maxScrollTop > 1;
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

    viewport.addEventListener("scroll", sync, { passive: true });
    instance?.on("updated", sync);
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(viewport);
    if (contentRef.current) resizeObserver.observe(contentRef.current);
    sync();
    const frameId = window.requestAnimationFrame(sync);

    return () => {
      viewport.removeEventListener("scroll", sync);
      instance?.off("updated", sync);
      resizeObserver.disconnect();
      window.cancelAnimationFrame(frameId);
    };
  }, [axis, scrollbarRef, showEdgeMasks]);

  useEffect(() => {
    scrollbarRef.current?.update();
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
