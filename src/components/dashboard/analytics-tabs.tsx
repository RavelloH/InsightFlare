"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "motion/react";
import {
  RiComputerLine,
  RiDashboardLine,
  RiFileList3Line,
  RiFlashlightLine,
  RiGlobalLine,
  RiMapPin2Line,
  RiShareForwardLine,
  RiTimeLine,
  RiUser3Line,
} from "@remixicon/react";
import { cn } from "@/lib/utils";

type AnalyticsTabKey =
  | "overview"
  | "pages"
  | "referrers"
  | "sessions"
  | "events"
  | "visitors"
  | "geo"
  | "devices"
  | "browsers";

interface AnalyticsTabItem {
  key: AnalyticsTabKey;
  href: string;
  label: string;
}

interface AnalyticsTabsProps {
  items: AnalyticsTabItem[];
}

function getAnalyticsSectionIcon(key: AnalyticsTabKey) {
  if (key === "overview") return RiDashboardLine;
  if (key === "pages") return RiFileList3Line;
  if (key === "referrers") return RiShareForwardLine;
  if (key === "sessions") return RiTimeLine;
  if (key === "events") return RiFlashlightLine;
  if (key === "visitors") return RiUser3Line;
  if (key === "geo") return RiMapPin2Line;
  if (key === "devices") return RiComputerLine;
  return RiGlobalLine;
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return pathname || "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isTabActive(item: AnalyticsTabItem, normalizedPathname: string): boolean {
  if (item.key === "overview") return normalizedPathname === item.href;
  return normalizedPathname.startsWith(item.href);
}

export function AnalyticsTabs({ items }: AnalyticsTabsProps) {
  const pathname = usePathname();
  const normalizedPathname = normalizePathname(pathname || "");
  const navRef = useRef<HTMLElement | null>(null);
  const linkRefs = useRef<Map<AnalyticsTabKey, HTMLAnchorElement>>(new Map());
  const [optimisticActiveKey, setOptimisticActiveKey] =
    useState<AnalyticsTabKey | null>(null);
  const [indicatorState, setIndicatorState] = useState({
    x: 0,
    width: 0,
    visible: false,
  });

  const pathActiveKey = useMemo(() => {
    const activeItem = items.find((item) => isTabActive(item, normalizedPathname));
    return activeItem?.key ?? items[0]?.key ?? null;
  }, [items, normalizedPathname]);

  const resolvedActiveKey = optimisticActiveKey ?? pathActiveKey;

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

  useLayoutEffect(() => {
    syncIndicator();
  }, [syncIndicator]);

  useEffect(() => {
    if (!optimisticActiveKey) return;
    if (pathActiveKey === optimisticActiveKey) {
      setOptimisticActiveKey(null);
    }
  }, [pathActiveKey, optimisticActiveKey]);

  useEffect(() => {
    if (!optimisticActiveKey) return;
    const timeout = window.setTimeout(() => {
      setOptimisticActiveKey(null);
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [optimisticActiveKey]);

  useEffect(() => {
    if (!navRef.current) return;
    const observer = new ResizeObserver(() => {
      syncIndicator();
    });
    observer.observe(navRef.current);

    if (resolvedActiveKey) {
      const activeLink = linkRefs.current.get(resolvedActiveKey);
      if (activeLink) observer.observe(activeLink);
    }

    return () => observer.disconnect();
  }, [resolvedActiveKey, syncIndicator]);

  return (
    <nav
      ref={navRef}
      className="no-scrollbar relative flex items-center gap-4 overflow-x-auto"
    >
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
            href={item.href}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              setOptimisticActiveKey(item.key);
            }}
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
  );
}
