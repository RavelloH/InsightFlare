import * as React from "react";
import { AnimatePresence, type HTMLMotionProps, motion } from "motion/react";

import { cn } from "@/lib/utils";

export const APP_OVERLAY_FADE_MS = 100;

interface ControllableOpenProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface AppOverlayRootState {
  layerId: string;
  modal: boolean;
  open: boolean;
}

interface AppOverlayProps extends React.ComponentPropsWithoutRef<"div"> {
  layerId?: string;
  open: boolean;
}

export function useControllableOpen({
  defaultOpen = false,
  onOpenChange,
  open,
}: ControllableOpenProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const currentOpen = isControlled ? open : uncontrolledOpen;
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  return [currentOpen, handleOpenChange] as const;
}

export function AppOverlay({
  className,
  layerId = "app-overlay",
  open,
  ...props
}: AppOverlayProps) {
  const motionProps = props as HTMLMotionProps<"div">;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          {...motionProps}
          key={`${layerId}-overlay`}
          aria-hidden="true"
          data-slot="app-overlay"
          className={cn(
            "pointer-events-auto fixed inset-0 bg-black/10 supports-backdrop-filter:backdrop-blur-xs",
            className,
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{
            duration: APP_OVERLAY_FADE_MS / 1000,
            ease: "easeOut",
          }}
        />
      ) : null}
    </AnimatePresence>
  );
}
