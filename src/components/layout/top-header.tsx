"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { RiMenuLine as MenuIcon } from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "./sidebar-context";
import type { TeamData } from "@/lib/edge-client";

interface TopHeaderProps {
  locale: string;
  session: { userId: string; username: string; displayName: string; systemRole: string };
  teams: TeamData[];
}

const segmentLabels: Record<string, Record<string, string>> = {
  app: { en: "Dashboard", zh: "仪表盘" },
  settings: { en: "Settings", zh: "设置" },
  members: { en: "Members", zh: "成员" },
  overview: { en: "Overview", zh: "总览" },
  pages: { en: "Pages", zh: "页面" },
  realtime: { en: "Realtime", zh: "实时" },
  sessions: { en: "Sessions", zh: "会话" },
  precision: { en: "Precision", zh: "精准查询" },
  events: { en: "Events", zh: "事件" },
  profiles: { en: "Profiles", zh: "访客" },
};

function resolveMobileTitle(pathname: string, locale: string, teams: TeamData[]): string {
  const parts = pathname.replace(`/${locale}`, "").split("/").filter(Boolean);

  if (parts.length <= 1) {
    return segmentLabels.app[locale] ?? "Dashboard";
  }

  const last = parts[parts.length - 1] ?? "";
  if (segmentLabels[last]) {
    return segmentLabels[last][locale] ?? last;
  }

  if (parts.length >= 2 && parts[0] === "app") {
    const team = teams.find((item) => item.id === parts[1]);
    if (parts.length === 2) {
      return team?.name ?? (segmentLabels.app[locale] ?? "Dashboard");
    }
    if (parts.length >= 3) {
      return segmentLabels.overview[locale] ?? "Overview";
    }
  }

  return segmentLabels.app[locale] ?? "Dashboard";
}

export function TopHeader({ locale, teams }: TopHeaderProps) {
  const pathname = usePathname();
  const { setMobileOpen } = useSidebar();
  const title = useMemo(
    () => resolveMobileTitle(pathname, locale, teams),
    [pathname, locale, teams],
  );

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden">
      <Button
        variant="outline"
        size="icon"
        onClick={() => setMobileOpen(true)}
        aria-label="Open sidebar"
      >
        <MenuIcon className="h-4 w-4" />
      </Button>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{title}</p>
      </div>
    </header>
  );
}

