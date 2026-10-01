import { memo, useState } from "react";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@insightflare/ui/dropdown-menu";
import { Spinner } from "@insightflare/ui/spinner";
import {
  RiLogoutBoxRLine,
  RiNotification3Line,
  RiSettings3Line,
} from "@remixicon/react";
import { toast } from "sonner";

import {
  SIDEBAR_FOOTER_TRIGGER_BASE_CLASS,
  SidebarAppearanceMenus,
} from "@/components/sidebar-appearance-menus";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";
import Link from "@/lib/router";
import { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";

interface SidebarFooterMenusProps {
  locale: Locale;
  switchToEn: string;
  switchToZh: string;
  switchToJa: string;
  accountHref: string;
  notificationsHref: string;
  unreadAttentionCount?: number;
  user: {
    username: string;
    name: string;
    email: string;
    systemRole: "admin" | "user";
  };
  messages: AppMessages;
}

function userInitial(name: string, username: string): string {
  const raw = String(name || username || "").trim();
  if (!raw) return "?";
  const first = Array.from(raw)[0];
  return first ? first.toUpperCase() : "?";
}

export const SidebarFooterMenus = memo(function SidebarFooterMenus({
  locale,
  switchToEn,
  switchToZh,
  switchToJa,
  accountHref,
  notificationsHref,
  unreadAttentionCount = 0,
  user,
  messages,
}: SidebarFooterMenusProps) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const initial = userInitial(user.name, user.username);
  const displayName = String(user.name || user.username);
  const roleLabel =
    user.systemRole === "admin" ? messages.common.admin : messages.common.user;

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const response = await fetch("/api/public/session", {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error(messages.sidebarFooter.logoutFailed);
      toast.success(messages.sidebarFooter.logoutSuccess);
      navigateWithTransition(router, "/" + locale + "/login");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : messages.sidebarFooter.logoutFailed;
      toast.error(message || messages.sidebarFooter.logoutFailed);
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <SidebarAppearanceMenus
      locale={locale}
      switchToEn={switchToEn}
      switchToZh={switchToZh}
      switchToJa={switchToJa}
      messages={messages}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            SIDEBAR_FOOTER_TRIGGER_BASE_CLASS,
            "left-2/3 group-data-[collapsible=icon]:left-0 group-data-[collapsible=icon]:top-20",
          )}
          aria-label={messages.common.account}
        >
          <span className="relative inline-flex size-6 items-center justify-center">
            <span className="inline-flex size-6 items-center justify-center rounded-full border border-sidebar-border bg-transparent text-xs">
              {initial}
            </span>
            {unreadAttentionCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-destructive ring-2 ring-sidebar" />
            ) : null}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={8} className="!w-64 !min-w-64">
          <DropdownMenuLabel className="space-y-1">
            <div className="text-sm font-semibold text-foreground">
              {displayName}
            </div>
            <div className="text-xs text-muted-foreground">
              @{user.username}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="space-y-1 font-normal">
            <div className="text-xs text-muted-foreground">{user.email}</div>
            <div className="text-xs text-muted-foreground">
              {messages.common.role}: {roleLabel}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={notificationsHref}>
              <RiNotification3Line />
              <span>{messages.notificationCenter.title}</span>
              {unreadAttentionCount > 0 ? (
                <span className="ml-auto pr-2 font-mono text-xs tabular-nums text-destructive">
                  {unreadAttentionCount > 99 ? "99+" : unreadAttentionCount}
                </span>
              ) : null}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={accountHref}>
              <RiSettings3Line />
              <span>{messages.accountSettings.title}</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={loggingOut}
            onSelect={(event) => {
              event.preventDefault();
              void handleLogout();
            }}
          >
            <RiLogoutBoxRLine />
            <AutoTransition className="inline-flex items-center gap-2">
              {loggingOut ? (
                <span
                  key="logging-out"
                  className="inline-flex items-center gap-2"
                >
                  <Spinner className="size-4" />
                  {messages.sidebarFooter.loggingOut}
                </span>
              ) : (
                <span key="logout">{messages.actions.logout}</span>
              )}
            </AutoTransition>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarAppearanceMenus>
  );
});
