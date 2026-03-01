"use client";

import { usePathname } from "next/navigation";
import { useSidebar } from "./sidebar-context";
import { MenuIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TopHeaderProps {
  locale: string;
  session: { userId: string; username: string; displayName: string; systemRole: string };
}

function getBreadcrumbs(pathname: string, locale: string): Array<{ label: string; href: string }> {
  const segments = pathname.replace(`/${locale}`, "").split("/").filter(Boolean);
  const labels: Record<string, Record<string, string>> = {
    app: { en: "Dashboard", zh: "仪表盘" },
    teams: { en: "Teams", zh: "团队" },
    settings: { en: "Settings", zh: "设置" },
    precision: { en: "Precision", zh: "精准查询" },
  };

  const crumbs: Array<{ label: string; href: string }> = [];
  let path = `/${locale}`;
  for (const seg of segments) {
    path += `/${seg}`;
    crumbs.push({
      label: labels[seg]?.[locale] ?? seg,
      href: path,
    });
  }
  return crumbs;
}

export function TopHeader({ locale, session }: TopHeaderProps) {
  const pathname = usePathname();
  const crumbs = getBreadcrumbs(pathname, locale);
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

      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        {crumbs.map((crumb, i) => (
          <span key={crumb.href} className="flex items-center gap-1">
            {i > 0 && <span className="mx-1 text-def-400">/</span>}
            {i === crumbs.length - 1 ? (
              <span className="font-medium text-foreground">{crumb.label}</span>
            ) : (
              <a href={crumb.href} className="hover:text-foreground transition-colors">
                {crumb.label}
              </a>
            )}
          </span>
        ))}
      </nav>
    </header>
  );
}
