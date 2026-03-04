"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

export function AnalyticsTabs({ items }: AnalyticsTabsProps) {
  const pathname = usePathname();
  const normalizedPathname = normalizePathname(pathname || "");

  return (
    <nav className="no-scrollbar flex items-center gap-4 overflow-x-auto">
      {items.map((item) => {
        const isActive =
          item.key === "overview"
            ? normalizedPathname === item.href
            : normalizedPathname.startsWith(item.href);
        const AnalyticsIcon = getAnalyticsSectionIcon(item.key);

        return (
          <Link
            key={item.key}
            href={item.href}
            className={cn(
              "relative inline-flex items-center gap-1.5 px-2 py-3 text-xs whitespace-nowrap transition-colors",
              isActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <AnalyticsIcon className="size-3.5" />
            <span>{item.label}</span>
            {isActive ? (
              <motion.span
                layoutId="analytics-tabs-underline"
                className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary"
                transition={{
                  type: "spring",
                  stiffness: 520,
                  damping: 40,
                  mass: 0.5,
                }}
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
