"use client";

import { usePathname } from "next/navigation";
import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { UserMenu } from "./user-menu";
import { LanguageSwitcher } from "./language-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  const { setTheme } = useTheme();
  const crumbs = getBreadcrumbs(pathname, locale);

  return (
    <header className="flex h-14 items-center gap-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 md:px-6">
      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        {crumbs.map((crumb, i) => (
          <span key={crumb.href} className="flex items-center gap-1">
            {i > 0 && <span className="mx-1">/</span>}
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

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span className="sr-only">Toggle theme</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <Sun className="mr-2 h-4 w-4" />
              Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <Moon className="mr-2 h-4 w-4" />
              Dark
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <Monitor className="mr-2 h-4 w-4" />
              System
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <LanguageSwitcher locale={locale} />

        <Separator orientation="vertical" className="h-6" />

        <UserMenu session={session} locale={locale} />
      </div>
    </header>
  );
}
