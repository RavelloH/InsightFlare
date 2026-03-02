"use client";

import { usePathname } from "next/navigation";
import { useSidebar } from "./sidebar-context";
import { MenuIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  precision: { en: "Precision", zh: "精准查询" },
  pages: { en: "Pages", zh: "页面" },
  realtime: { en: "Realtime", zh: "实时" },
  sessions: { en: "Sessions", zh: "会话" },
};

function getBreadcrumbs(
  pathname: string,
  locale: string,
  teams: TeamData[],
): Array<{ label: string; href: string }> {
  const segments = pathname.replace(`/${locale}`, "").split("/").filter(Boolean);
  // segments: ["app"] or ["app", teamId] or ["app", teamId, siteId, "pages"] etc.

  const crumbs: Array<{ label: string; href: string }> = [];
  let path = `/${locale}`;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    path += `/${seg}`;

    if (seg === "app") {
      crumbs.push({ label: segmentLabels.app[locale] ?? "Dashboard", href: path });
      continue;
    }

    // Check if this is a known fixed segment
    if (segmentLabels[seg]) {
      crumbs.push({ label: segmentLabels[seg][locale] ?? seg, href: path });
      continue;
    }

    // Dynamic segment: could be teamId or siteId
    // If previous segment is "app", this is a teamId
    if (i >= 1 && segments[i - 1] === "app") {
      const team = teams.find((t) => t.id === seg);
      crumbs.push({ label: team?.name ?? seg.slice(0, 8), href: path });
      continue;
    }

    // Otherwise it's likely a siteId (after teamId)
    crumbs.push({ label: seg.slice(0, 8), href: path });
  }

  return crumbs;
}

export function TopHeader({ locale, session, teams }: TopHeaderProps) {
  const pathname = usePathname();
  const crumbs = getBreadcrumbs(pathname, locale, teams);
  const { setMobileOpen } = useSidebar();

  return (
    <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-border bg-background/80 backdrop-blur-sm px-4 md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setMobileOpen(true)}
      >
        <MenuIcon className="h-5 w-5" />
      </Button>

      <nav className="flex items-center gap-1 text-sm text-muted-foreground overflow-hidden">
        {crumbs.map((crumb, i) => (
          <span key={crumb.href} className="flex items-center gap-1 min-w-0">
            {i > 0 && <span className="mx-1 text-def-400 shrink-0">/</span>}
            {i === crumbs.length - 1 ? (
              <span className="font-medium text-foreground truncate">{crumb.label}</span>
            ) : (
              <a href={crumb.href} className="hover:text-foreground transition-colors truncate">
                {crumb.label}
              </a>
            )}
          </span>
        ))}
      </nav>
    </header>
  );
}
