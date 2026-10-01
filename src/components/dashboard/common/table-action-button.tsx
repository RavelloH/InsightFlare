import { forwardRef, type ReactNode } from "react";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Clickable } from "@insightflare/ui/clickable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@insightflare/ui/tooltip";
import type { HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/utils";
interface TableActionButtonProps extends Omit<
  HTMLMotionProps<"div">,
  "children" | "onClick" | "title"
> {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "destructive";
  className?: string;
  transitionKey?: string | number;
}
export const TableActionButton = forwardRef<
  HTMLDivElement,
  TableActionButtonProps
>(
  (
    {
      label,
      children,
      onClick,
      disabled = false,
      tone = "default",
      className,
      transitionKey,
      ...props
    },
    ref,
  ) => {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Clickable
            ref={ref}
            onClick={onClick}
            disabled={disabled}
            className={cn(
              "size-6 text-muted-foreground hover:text-foreground",
              tone === "destructive" &&
                "text-destructive/80 hover:text-destructive",
              className,
            )}
            aria-label={label}
            {...props}
          >
            <AutoTransition
              transitionKey={transitionKey}
              className="inline-flex items-center justify-center"
            >
              <span className="inline-flex items-center justify-center">
                {children}
              </span>
            </AutoTransition>
          </Clickable>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  },
);
TableActionButton.displayName = "TableActionButton";
