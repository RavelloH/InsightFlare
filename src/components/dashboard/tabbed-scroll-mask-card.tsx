"use client";

import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { OverlayScrollbars } from "overlayscrollbars";
import type { PartialOptions } from "overlayscrollbars";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const PANEL_SCROLLBAR_OPTIONS = {
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

export interface TabbedScrollMaskCardTab<T extends string = string> {
  value: T;
  label: string;
}

interface TabbedScrollMaskCardProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  tabs: TabbedScrollMaskCardTab<T>[];
  children: ReactNode;
  headerRight?: ReactNode;
  syncKey?: string | number | boolean | null;
  className?: string;
  tabsListClassName?: string;
  tabTriggerClassName?: string;
  viewportClassName?: string;
}

export function TabbedScrollMaskCard<T extends string = string>({
  value,
  onValueChange,
  tabs,
  children,
  headerRight,
  syncKey,
  className,
  tabsListClassName,
  tabTriggerClassName,
  viewportClassName,
}: TabbedScrollMaskCardProps<T>) {
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(null);
  const topMaskRef = useRef<HTMLDivElement | null>(null);
  const bottomMaskRef = useRef<HTMLDivElement | null>(null);
  const topVisibleRef = useRef(false);
  const bottomVisibleRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const applyMaskVisibility = (showTop: boolean, showBottom: boolean) => {
    if (showTop !== topVisibleRef.current) {
      topVisibleRef.current = showTop;
      topMaskRef.current?.classList.toggle("opacity-100", showTop);
      topMaskRef.current?.classList.toggle("opacity-0", !showTop);
    }
    if (showBottom !== bottomVisibleRef.current) {
      bottomVisibleRef.current = showBottom;
      bottomMaskRef.current?.classList.toggle("opacity-100", showBottom);
      bottomMaskRef.current?.classList.toggle("opacity-0", !showBottom);
    }
  };

  const syncMasks = (container?: HTMLDivElement | null) => {
    const current =
      container ??
      (scrollbarRef.current?.elements().viewport as
        | HTMLDivElement
        | undefined) ??
      scrollHostRef.current;
    if (!current) {
      applyMaskVisibility(false, false);
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = current;
    const canScroll = scrollHeight > clientHeight + 1;
    if (!canScroll) {
      applyMaskVisibility(false, false);
      return;
    }

    applyMaskVisibility(
      scrollTop > 10,
      scrollTop < scrollHeight - clientHeight - 10,
    );
  };

  const scheduleMaskSync = (container?: HTMLDivElement | null) => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      syncMasks(container);
    });
  };

  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, PANEL_SCROLLBAR_OPTIONS);

    if (existing) {
      existing.options(PANEL_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;

    const sync = () =>
      scheduleMaskSync(instance.elements().viewport as HTMLDivElement);
    instance.on("scroll", sync);
    instance.on("updated", sync);
    const animationFrame = requestAnimationFrame(() =>
      syncMasks(instance.elements().viewport as HTMLDivElement),
    );

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
  }, []);

  useEffect(() => {
    scheduleMaskSync();
  }, [value, syncKey]);

  return (
    <Card className={cn("gap-0 py-0 overflow-hidden", className)}>
      <div className="border-b">
        <Tabs
          value={value}
          onValueChange={(next) => onValueChange(next as T)}
          className="gap-0"
        >
          <div className="flex items-center gap-1 px-2 py-1">
            <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
              <TabsList
                variant="line"
                className={cn(
                  "h-10 w-max min-w-max justify-start gap-1 border-0 px-0",
                  tabsListClassName,
                )}
              >
                {tabs.map((tab) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className={cn("h-8 flex-none px-3 text-xs", tabTriggerClassName)}
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {headerRight ? (
              <div className="shrink-0">{headerRight}</div>
            ) : null}
          </div>
        </Tabs>
      </div>

      <div className={cn("relative max-h-[60vh]", viewportClassName)}>
        <div
          ref={topMaskRef}
          className="pointer-events-none absolute top-0 left-0 right-0 z-10 h-6 bg-gradient-to-b from-card via-card/80 to-transparent opacity-0 transition-opacity duration-300"
        />
        <div
          ref={bottomMaskRef}
          className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-6 bg-gradient-to-t from-card via-card/80 to-transparent opacity-0 transition-opacity duration-300"
        />

        <div
          ref={scrollHostRef}
          className={cn("max-h-[60vh] overflow-hidden pt-1.5", viewportClassName)}
          data-overlayscrollbars-initialize
        >
          {children}
        </div>
      </div>
    </Card>
  );
}
