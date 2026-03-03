"use client";

import { useEffect } from "react";
import { OverlayScrollbars } from "overlayscrollbars";
import type { PartialOptions } from "overlayscrollbars";

const globalScrollbarOptions = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;

export function GlobalScrollbars() {
  useEffect(() => {
    const existingInstance = OverlayScrollbars(document.body);
    const instance =
      existingInstance ??
      OverlayScrollbars(document.body, globalScrollbarOptions);

    if (existingInstance) {
      existingInstance.options(globalScrollbarOptions);
    }

    return () => {
      if (!existingInstance) {
        instance.destroy();
      }
    };
  }, []);

  return null;
}
