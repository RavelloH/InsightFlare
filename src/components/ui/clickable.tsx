import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { forwardRef } from "react";
import { type HTMLMotionProps, motion } from "motion/react";

import { cn } from "@/lib/utils";

interface ClickableProps extends Omit<
  HTMLMotionProps<"div">,
  "children" | "onClick" | "onKeyDown" | "title"
> {
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  className?: string;
  disabled?: boolean;
  enableHoverScale?: boolean;
  hoverScale?: number;
  tapScale?: number;
  duration?: number;
  "aria-label"?: string;
}

export const Clickable = forwardRef<HTMLDivElement, ClickableProps>(
  (
    {
      children,
      onClick,
      className,
      disabled = false,
      enableHoverScale = true,
      hoverScale = 1.16,
      tapScale = 0.94,
      duration = 0.16,
      "aria-label": ariaLabel,
      ...props
    },
    ref,
  ) => {
    const handleClick = (event: MouseEvent<HTMLDivElement>) => {
      if (disabled) return;
      onClick?.(event);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick?.(event as unknown as MouseEvent<HTMLDivElement>);
      }
    };

    return (
      <motion.div
        ref={ref}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-disabled={disabled}
        className={cn(
          "inline-flex select-none items-center justify-center rounded-none outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          className,
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        {...props}
        whileHover={
          !disabled && enableHoverScale ? { scale: hoverScale } : undefined
        }
        whileTap={!disabled ? { scale: tapScale } : undefined}
        transition={{
          duration,
          ease: "easeOut",
        }}
      >
        {children}
      </motion.div>
    );
  },
);

Clickable.displayName = "Clickable";
