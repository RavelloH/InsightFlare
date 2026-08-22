import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
} from "react";
import type { PartialOptions } from "overlayscrollbars";
import { OverlayScrollbars } from "overlayscrollbars";

import {
  prepareNativeScrollbarHost,
  useNativeScrollbars,
  VERTICAL_SCROLLBAR_OPTIONS,
} from "@/components/ui/overlay-scrollbar";
import { cn } from "@/lib/utils";

interface VerticalScrollMaskProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
  contentClassName?: string;
  hostRef?: Ref<HTMLDivElement>;
  maskClassName?: string;
  scrollbarOptions?: PartialOptions;
  syncKey?: string | number | boolean | null;
}

export function VerticalScrollMask({
  children,
  className,
  contentClassName,
  hostRef: forwardedHostRef,
  maskClassName,
  scrollbarOptions,
  syncKey,
  ...props
}: VerticalScrollMaskProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );
  const topMaskRef = useRef<HTMLDivElement | null>(null);
  const bottomMaskRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const nativeScrollbars = useNativeScrollbars();
  const resolvedScrollbarOptions =
    scrollbarOptions ?? VERTICAL_SCROLLBAR_OPTIONS;

  const syncMasks = (viewport?: HTMLDivElement | null) => {
    const current =
      viewport ??
      (scrollbarRef.current?.elements().viewport as
        | HTMLDivElement
        | undefined) ??
      hostRef.current;
    if (!current) return;

    const { scrollTop, scrollHeight, clientHeight } = current;
    const canScroll = scrollHeight > clientHeight + 1;
    const showTop = canScroll && scrollTop > 10;
    const showBottom =
      canScroll && scrollTop < scrollHeight - clientHeight - 10;
    topMaskRef.current?.classList.toggle("opacity-100", showTop);
    topMaskRef.current?.classList.toggle("opacity-0", !showTop);
    bottomMaskRef.current?.classList.toggle("opacity-100", showBottom);
    bottomMaskRef.current?.classList.toggle("opacity-0", !showBottom);
  };

  const scheduleMaskSync = (viewport?: HTMLDivElement | null) => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      syncMasks(viewport);
    });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (prepareNativeScrollbarHost(host)) {
      const sync = () => scheduleMaskSync(host);
      host.addEventListener("scroll", sync);
      const animationFrame = requestAnimationFrame(sync);

      return () => {
        host.removeEventListener("scroll", sync);
        cancelAnimationFrame(animationFrame);
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
      };
    }

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, resolvedScrollbarOptions);
    if (existing) {
      existing.options(resolvedScrollbarOptions);
    }
    scrollbarRef.current = instance;

    const sync = () =>
      scheduleMaskSync(instance.elements().viewport as HTMLDivElement);
    instance.on("scroll", sync);
    instance.on("updated", sync);
    const animationFrame = requestAnimationFrame(sync);

    return () => {
      instance.off("scroll", sync);
      instance.off("updated", sync);
      cancelAnimationFrame(animationFrame);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (!existing) {
        instance.destroy();
      }
      if (scrollbarRef.current === instance) {
        scrollbarRef.current = null;
      }
    };
  }, [resolvedScrollbarOptions]);

  useEffect(() => {
    scrollbarRef.current?.update();
    scheduleMaskSync();
  }, [syncKey]);

  return (
    <div className={cn("relative", className)} {...props}>
      <div
        ref={topMaskRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0 right-0 left-0 z-10 h-5 bg-gradient-to-b opacity-0 transition-opacity duration-300",
          maskClassName ?? "from-background via-background/80 to-transparent",
        )}
      />
      <div
        ref={bottomMaskRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-0 bottom-0 left-0 z-10 h-5 bg-gradient-to-t opacity-0 transition-opacity duration-300",
          maskClassName ?? "from-background via-background/80 to-transparent",
        )}
      />
      <div
        ref={(node) => {
          hostRef.current = node;
          if (typeof forwardedHostRef === "function") {
            forwardedHostRef(node);
          } else if (forwardedHostRef) {
            forwardedHostRef.current = node;
          }
        }}
        className={cn(
          nativeScrollbars ? "overflow-y-auto" : "overflow-hidden",
          contentClassName,
        )}
        data-overlayscrollbars-initialize={nativeScrollbars ? undefined : ""}
      >
        {children}
      </div>
    </div>
  );
}
