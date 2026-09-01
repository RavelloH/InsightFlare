import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiComputerLine,
  RiDashboardLine,
  RiFileList3Line,
  RiFilter2Line,
  RiFlashlightLine,
  RiGlobalLine,
  RiMapPin2Line,
  RiMegaphoneLine,
  RiPulseLine,
  RiRepeatLine,
  RiRobot2Line,
  RiSettings3Line,
  RiShareForwardLine,
  RiShieldCheckLine,
  RiSpeedUpLine,
  RiUser3Line,
} from "@remixicon/react";
import { motion } from "motion/react";
import type { PartialOptions } from "overlayscrollbars";
import { OverlayScrollbars } from "overlayscrollbars";

import {
  prepareNativeScrollbarHost,
  useNativeScrollbars,
} from "@/components/ui/overlay-scrollbar";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import Link from "@/lib/router";
import { usePathname, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

type AnalyticsTabKey =
  | "overview"
  | "realtime"
  | "pages"
  | "referrers"
  | "sessions"
  | "campaigns"
  | "events"
  | "funnels"
  | "visitors"
  | "retention"
  | "geo"
  | "devices"
  | "browsers"
  | "performance"
  | "settings"
  | "request-overview"
  | "request-abnormal"
  | "request-normal";

interface AnalyticsTabItem {
  key: AnalyticsTabKey;
  href: string;
  label: string;
  queryKey?: string;
  queryValue?: string;
  queryDefault?: boolean;
}

interface AnalyticsTabsProps {
  items: AnalyticsTabItem[];
}

const TABS_SCROLLBAR_OPTIONS = {
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

function getAnalyticsSectionIcon(key: AnalyticsTabKey) {
  if (key === "overview") return RiDashboardLine;
  if (key === "request-overview") return RiDashboardLine;
  if (key === "request-abnormal") return RiRobot2Line;
  if (key === "request-normal") return RiShieldCheckLine;
  if (key === "realtime") return RiPulseLine;
  if (key === "pages") return RiFileList3Line;
  if (key === "referrers") return RiShareForwardLine;
  if (key === "sessions") return RiPulseLine;
  if (key === "campaigns") return RiMegaphoneLine;
  if (key === "events") return RiFlashlightLine;
  if (key === "funnels") return RiFilter2Line;
  if (key === "visitors") return RiUser3Line;
  if (key === "retention") return RiRepeatLine;
  if (key === "geo") return RiMapPin2Line;
  if (key === "devices") return RiComputerLine;
  if (key === "performance") return RiSpeedUpLine;
  if (key === "settings") return RiSettings3Line;
  return RiGlobalLine;
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return pathname || "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isTabActive(
  item: AnalyticsTabItem,
  normalizedPathname: string,
  searchParams: URLSearchParams,
): boolean {
  const itemPath = normalizePathname(item.href.split("?")[0] || item.href);
  if (item.queryKey) {
    const currentValue =
      searchParams.get(item.queryKey) ??
      (item.queryDefault ? (item.queryValue ?? "") : "");
    return (
      normalizedPathname === itemPath &&
      String(currentValue) === String(item.queryValue ?? "")
    );
  }
  if (item.key === "overview") return normalizedPathname === itemPath;
  return normalizedPathname.startsWith(itemPath);
}

function globalNavigationSearchParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (
      key.startsWith("filter[") ||
      key === "range" ||
      key === "interval" ||
      key === "timeZone" ||
      key === "scope"
    ) {
      next.append(key, value);
    }
  }
  return next;
}

export const AnalyticsTabs = memo(function AnalyticsTabs({
  items,
}: AnalyticsTabsProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const normalizedPathname = normalizePathname(pathname || "");
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );
  const navRef = useRef<HTMLElement | null>(null);
  const linkRefs = useRef<Map<AnalyticsTabKey, HTMLAnchorElement>>(new Map());
  const leftMaskRef = useRef<HTMLDivElement | null>(null);
  const rightMaskRef = useRef<HTMLDivElement | null>(null);
  const leftVisibleRef = useRef(false);
  const rightVisibleRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const [indicatorState, setIndicatorState] = useState({
    x: 0,
    width: 0,
    visible: false,
  });
  const nativeScrollbars = useNativeScrollbars();

  const pathActiveKey = useMemo(() => {
    const activeItem = items.find((item) =>
      isTabActive(item, normalizedPathname, searchParams),
    );
    return activeItem?.key ?? items[0]?.key ?? null;
  }, [items, normalizedPathname, searchParams]);

  const resolvedActiveKey = pathActiveKey;
  const hrefForItem = useCallback(
    (item: AnalyticsTabItem) => {
      const itemPath = normalizePathname(item.href.split("?")[0] || item.href);
      const nextParams = item.queryKey
        ? new URLSearchParams(searchParams.toString())
        : globalNavigationSearchParams(searchParams);
      if (item.queryKey) {
        if (item.queryDefault) {
          nextParams.delete(item.queryKey);
        } else if (item.queryValue) {
          nextParams.set(item.queryKey, item.queryValue);
        }
      }
      const nextQuery = serializeDashboardSearchParams(nextParams);
      return nextQuery ? `${itemPath}?${nextQuery}` : itemPath;
    },
    [searchParams],
  );

  const applyMaskVisibility = useCallback(
    (showLeft: boolean, showRight: boolean) => {
      if (showLeft !== leftVisibleRef.current) {
        leftVisibleRef.current = showLeft;
        leftMaskRef.current?.classList.toggle("opacity-100", showLeft);
        leftMaskRef.current?.classList.toggle("opacity-0", !showLeft);
      }
      if (showRight !== rightVisibleRef.current) {
        rightVisibleRef.current = showRight;
        rightMaskRef.current?.classList.toggle("opacity-100", showRight);
        rightMaskRef.current?.classList.toggle("opacity-0", !showRight);
      }
    },
    [],
  );

  const syncMasks = useCallback(
    (container?: HTMLDivElement | null) => {
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

      const { scrollLeft, scrollWidth, clientWidth } = current;
      const maxScrollLeft = scrollWidth - clientWidth;
      const canScroll = maxScrollLeft > 1;
      if (!canScroll) {
        applyMaskVisibility(false, false);
        return;
      }

      applyMaskVisibility(scrollLeft > 10, scrollLeft < maxScrollLeft - 10);
    },
    [applyMaskVisibility],
  );

  const scheduleMaskSync = useCallback(
    (container?: HTMLDivElement | null) => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        syncMasks(container);
      });
    },
    [syncMasks],
  );

  const syncIndicator = useCallback(() => {
    if (!resolvedActiveKey || !navRef.current) {
      setIndicatorState((prev) =>
        prev.visible ? { ...prev, visible: false } : prev,
      );
      return;
    }

    const activeLink = linkRefs.current.get(resolvedActiveKey);
    if (!activeLink) {
      setIndicatorState((prev) =>
        prev.visible ? { ...prev, visible: false } : prev,
      );
      return;
    }

    const x = activeLink.offsetLeft;
    const width = activeLink.offsetWidth;
    setIndicatorState((prev) => {
      if (prev.visible && prev.x === x && prev.width === width) return prev;
      return { x, width, visible: true };
    });
  }, [resolvedActiveKey]);
  const syncIndicatorRef = useRef(syncIndicator);

  useLayoutEffect(() => {
    syncIndicatorRef.current = syncIndicator;
    syncIndicator();
  }, [syncIndicator]);

  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host) return;
    if (prepareNativeScrollbarHost(host)) {
      const sync = () => {
        syncIndicatorRef.current();
        scheduleMaskSync(host);
      };
      const handleWheel = (event: WheelEvent) => {
        if (!event.shiftKey) return;
        const delta =
          Math.abs(event.deltaY) >= Math.abs(event.deltaX)
            ? event.deltaY
            : event.deltaX;
        if (delta === 0) return;
        event.preventDefault();
        host.scrollLeft += delta;
      };

      host.addEventListener("scroll", sync, { passive: true });
      host.addEventListener("wheel", handleWheel, { passive: false });
      const animationFrame = requestAnimationFrame(() => {
        syncIndicatorRef.current();
        syncMasks(host);
      });

      return () => {
        host.removeEventListener("scroll", sync);
        host.removeEventListener("wheel", handleWheel);
        cancelAnimationFrame(animationFrame);
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
      };
    }

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, TABS_SCROLLBAR_OPTIONS);

    if (existing) {
      existing.options(TABS_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;

    const viewport = instance.elements().viewport as HTMLDivElement;
    const sync = () => {
      syncIndicatorRef.current();
      scheduleMaskSync(viewport);
    };
    const handleWheel = (event: WheelEvent) => {
      if (!event.shiftKey) return;
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      if (delta === 0) return;
      event.preventDefault();
      viewport.scrollLeft += delta;
    };

    instance.on("scroll", sync);
    instance.on("updated", sync);
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    const animationFrame = requestAnimationFrame(() => {
      syncIndicatorRef.current();
      syncMasks(viewport);
    });

    return () => {
      instance.off("scroll", sync);
      instance.off("updated", sync);
      viewport.removeEventListener("wheel", handleWheel);
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
  }, [scheduleMaskSync, syncMasks]);

  useEffect(() => {
    if (!navRef.current) return;
    const observer = new ResizeObserver(() => {
      syncIndicator();
      scheduleMaskSync();
    });
    observer.observe(navRef.current);
    if (scrollHostRef.current) observer.observe(scrollHostRef.current);

    if (resolvedActiveKey) {
      const activeLink = linkRefs.current.get(resolvedActiveKey);
      if (activeLink) observer.observe(activeLink);
    }

    return () => observer.disconnect();
  }, [resolvedActiveKey, scheduleMaskSync, syncIndicator]);

  useEffect(() => {
    scheduleMaskSync();
  }, [items, scheduleMaskSync]);

  return (
    <div className="relative">
      <div
        ref={leftMaskRef}
        className="pointer-events-none absolute top-0 bottom-0 left-0 z-10 w-24 bg-gradient-to-r from-background/85 via-background/60 via-45% to-transparent opacity-0 transition-opacity duration-300"
      />
      <div
        ref={rightMaskRef}
        className="pointer-events-none absolute top-0 right-0 bottom-0 z-10 w-24 bg-gradient-to-l from-background/85 via-background/60 via-45% to-transparent opacity-0 transition-opacity duration-300"
      />

      <div
        ref={scrollHostRef}
        className={nativeScrollbars ? "overflow-x-auto" : "overflow-hidden"}
        data-overlayscrollbars-initialize={nativeScrollbars ? undefined : ""}
      >
        <nav ref={navRef} className="relative flex w-max items-center gap-4">
          {items.map((item) => {
            const isActive = resolvedActiveKey === item.key;
            const AnalyticsIcon = getAnalyticsSectionIcon(item.key);

            return (
              <Link
                key={item.key}
                ref={(node) => {
                  if (node) {
                    linkRefs.current.set(item.key, node);
                  } else {
                    linkRefs.current.delete(item.key);
                  }
                }}
                href={hrefForItem(item)}
                className={cn(
                  "relative inline-flex items-center gap-1.5 px-2 py-3 text-xs whitespace-nowrap transition-colors",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <AnalyticsIcon className="size-3.5" />
                <span>{item.label}</span>
              </Link>
            );
          })}

          <motion.div
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-primary"
            initial={false}
            animate={{
              x: indicatorState.x,
              width: indicatorState.width,
              opacity: indicatorState.visible ? 1 : 0,
            }}
            transition={{
              type: "spring",
              stiffness: 520,
              damping: 40,
              mass: 0.5,
            }}
          />
        </nav>
      </div>
    </div>
  );
});
