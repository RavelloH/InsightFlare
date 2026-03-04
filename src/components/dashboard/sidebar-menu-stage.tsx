"use client";

import { useRef, type ReactNode } from "react";
import { AutoTransition, type AutoTransitionProps } from "@/components/ui/auto-transition";
import { cn } from "@/lib/utils";

type SidebarMenuMode = "team" | "site";

interface SidebarMenuStageProps {
  mode: SidebarMenuMode;
  children: ReactNode;
  className?: string;
}

export function SidebarMenuStage({
  mode,
  children,
  className,
}: SidebarMenuStageProps) {
  const previousModeRef = useRef<SidebarMenuMode>(mode);
  const directionRef = useRef<1 | -1>(1);

  if (previousModeRef.current !== mode) {
    directionRef.current =
      previousModeRef.current === "team" && mode === "site" ? 1 : -1;
    previousModeRef.current = mode;
  }

  const variants: NonNullable<AutoTransitionProps["customVariants"]> = {
    initial: (direction) => ({
      opacity: 0,
      x: Number(direction) * 20,
    }),
    animate: {
      opacity: 1,
      x: 0,
    },
    exit: (direction) => ({
      opacity: 0,
      x: -Number(direction) * 20,
    }),
  };

  return (
    <div className={cn("relative grid overflow-hidden", className)}>
      <AutoTransition
        type="slide"
        duration={0.2}
        initial={false}
        custom={directionRef.current}
        presenceMode="sync"
        customVariants={variants}
        className="[grid-area:1/1] w-full will-change-transform"
      >
        <div key={mode}>{children}</div>
      </AutoTransition>
    </div>
  );
}
