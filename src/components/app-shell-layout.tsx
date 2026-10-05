import type { ReactNode } from "react";
import {
  OverlayScrollbar,
  PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS,
} from "@insightflare/ui/overlay-scrollbar";
import { SidebarInset, SidebarProvider } from "@insightflare/ui/sidebar";

import { PageTransition } from "@/components/page-transition";
import { cn } from "@/lib/utils";

interface AppShellLayoutProps {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
  contentAs?: "div" | "main";
  contentClassName?: string;
  contentDataAttributes?: Record<string, string>;
}

/** Shared application frame for production pages and internal UI tools. */
export function AppShellLayout({
  sidebar,
  header,
  children,
  contentAs: Content = "div",
  contentClassName,
  contentDataAttributes,
}: AppShellLayoutProps) {
  return (
    <SidebarProvider>
      {sidebar}
      <SidebarInset className="h-svh min-h-0 overflow-hidden">
        <OverlayScrollbar
          axis="vertical"
          className="h-full min-h-0 flex-1"
          viewportClassName="h-full min-h-0"
          contentClassName="flex min-h-full flex-col"
          options={PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS}
          data-page-scroll-container=""
        >
          <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
            {header}
          </header>
          <Content
            {...contentDataAttributes}
            className={cn("min-w-0 w-full", contentClassName)}
          >
            <PageTransition>{children}</PageTransition>
          </Content>
        </OverlayScrollbar>
      </SidebarInset>
    </SidebarProvider>
  );
}
