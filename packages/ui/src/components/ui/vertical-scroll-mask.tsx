import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { PartialOptions } from "overlayscrollbars";

import { cn } from "../../lib/utils";
import {
  observeScrollbarResize,
  SCROLLBAR_UPDATED_EVENT,
  useReactOverlayScrollbar,
  VERTICAL_SCROLLBAR_OPTIONS,
} from "./overlay-scrollbar";

export interface VerticalScrollMaskProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
  contentClassName?: string;
  enabled?: boolean;
  hostRef?: Ref<HTMLDivElement>;
  maskClassName?: string;
  scrollbarOptions?: PartialOptions;
  syncKey?: string | number | boolean | null;
}

export function VerticalScrollMask({
  children,
  className,
  contentClassName,
  enabled = true,
  hostRef: forwardedHostRef,
  maskClassName,
  scrollbarOptions,
  syncKey,
  ...props
}: VerticalScrollMaskProps) {
  const hostElementRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const topMaskRef = useRef<HTMLDivElement | null>(null);
  const bottomMaskRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const resolvedScrollbarOptions =
    scrollbarOptions ?? VERTICAL_SCROLLBAR_OPTIONS;
  const scrollbarRef = useReactOverlayScrollbar({
    hostRef: hostElementRef,
    viewportRef,
    contentRef,
    options: resolvedScrollbarOptions,
  });

  const syncMasks = useCallback(
    (viewport = viewportRef.current) => {
      if (!viewport) return;

      const maxScrollTop = enabled
        ? (scrollbarRef.current?.state().overflowAmount.y ??
          viewport.scrollHeight - viewport.clientHeight)
        : 0;
      const canScroll = maxScrollTop > 1;
      const scrollTop = canScroll ? viewport.scrollTop : 0;
      const showTop = canScroll && scrollTop > 10;
      const showBottom = canScroll && scrollTop < maxScrollTop - 10;
      topMaskRef.current?.classList.toggle("opacity-100", showTop);
      topMaskRef.current?.classList.toggle("opacity-0", !showTop);
      bottomMaskRef.current?.classList.toggle("opacity-100", showBottom);
      bottomMaskRef.current?.classList.toggle("opacity-0", !showBottom);
    },
    [enabled, scrollbarRef],
  );

  const scheduleMaskSync = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      syncMasks();
    });
  }, [syncMasks]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const sync = () => scheduleMaskSync();
    viewport.addEventListener("scroll", sync, { passive: true });
    viewport.addEventListener(SCROLLBAR_UPDATED_EVENT, sync);
    const stopObserving = observeScrollbarResize(
      viewport,
      contentRef.current,
      sync,
    );
    scheduleMaskSync();

    return () => {
      viewport.removeEventListener("scroll", sync);
      viewport.removeEventListener(SCROLLBAR_UPDATED_EVENT, sync);
      stopObserving();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [enabled, scheduleMaskSync, scrollbarRef]);

  useEffect(() => {
    scheduleMaskSync();
    if (!scrollbarRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      scrollbarRef.current?.update();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scheduleMaskSync, scrollbarRef, syncKey]);

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} {...props}>
      <div
        ref={topMaskRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-px right-0 left-0 z-10 h-5 bg-gradient-to-b opacity-0 transition-opacity duration-300",
          maskClassName ?? "from-background via-background/80 to-transparent",
        )}
      />
      <div
        ref={bottomMaskRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-0 -bottom-px left-0 z-10 h-5 bg-gradient-to-t opacity-0 transition-opacity duration-300",
          maskClassName ?? "from-background via-background/80 to-transparent",
        )}
      />
      <div
        ref={hostElementRef}
        className={cn("os-scrollbar-host", "min-h-0 flex-1 overflow-hidden")}
      >
        <div
          ref={(node) => {
            viewportRef.current = node;
            if (typeof forwardedHostRef === "function") {
              forwardedHostRef(node);
            } else if (forwardedHostRef) {
              forwardedHostRef.current = node;
            }
          }}
          className={cn("os-scrollbar-viewport", "h-full min-h-0")}
          data-scrollbar-axis="vertical"
        >
          <div
            ref={contentRef}
            className={cn("os-scrollbar-content", contentClassName)}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
