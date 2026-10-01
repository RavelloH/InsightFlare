import type { ReactNode } from "react";
import {
  OverlayScrollbar,
  PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS,
} from "@insightflare/ui/overlay-scrollbar";

export function GlobalScrollbars({ children }: { children: ReactNode }) {
  return (
    <OverlayScrollbar
      axis="vertical"
      className="h-svh min-h-0"
      options={PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS}
      data-global-scrollbar-viewport
    >
      <div className="min-h-full">{children}</div>
    </OverlayScrollbar>
  );
}
