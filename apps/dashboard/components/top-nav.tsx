import { BarChart3, Cog, UserCog, Users } from "lucide-react";
import { cn } from "@/lib/utils";

interface TopNavProps {
  active: "dashboard" | "teams" | "config" | "precision" | "account";
  siteId?: string;
  teamId?: string;
}

function hrefWithState(base: string, state: { siteId?: string; teamId?: string }): string {
  const url = new URL(base, "http://localhost");
  if (state.siteId) url.searchParams.set("siteId", state.siteId);
  if (state.teamId) url.searchParams.set("teamId", state.teamId);
  return `${url.pathname}${url.search}`;
}

export function TopNav({ active, siteId, teamId }: TopNavProps): React.JSX.Element {
  const links = [
    {
      id: "dashboard" as const,
      label: "Dashboard",
      href: hrefWithState("/app", { siteId, teamId }),
      icon: BarChart3,
    },
    {
      id: "teams" as const,
      label: "Teams",
      href: hrefWithState("/app/teams", { siteId, teamId }),
      icon: Users,
    },
    {
      id: "config" as const,
      label: "Config",
      href: hrefWithState("/app/config", { siteId, teamId }),
      icon: Cog,
    },
    {
      id: "precision" as const,
      label: "Precision",
      href: hrefWithState("/app/precision", { siteId, teamId }),
      icon: BarChart3,
    },
    {
      id: "account" as const,
      label: "Account",
      href: hrefWithState("/app/account", { siteId, teamId }),
      icon: UserCog,
    },
  ];

  return (
    <nav className="flex flex-wrap gap-2">
      {links.map((link) => (
        <a
          key={link.id}
          href={link.href}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl2 px-3 py-2 text-sm font-medium transition",
            active === link.id
              ? "bg-accent text-white shadow-card"
              : "bg-white/70 text-slate-700 hover:bg-white",
          )}
        >
          <link.icon className="h-4 w-4" />
          {link.label}
        </a>
      ))}
    </nav>
  );
}
