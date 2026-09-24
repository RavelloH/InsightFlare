import type { ReactNode } from "react";

import { TableCell } from "@/components/ui/table";
import { cn } from "@/lib/utils";

interface ClickableTableCellProps {
  onClick: () => void;
  children: ReactNode;
  className?: string;
  buttonClassName?: string;
  focusable?: boolean;
  ariaLabel?: string;
}

export function ClickableTableCell({
  onClick,
  children,
  className,
  buttonClassName,
  focusable = false,
  ariaLabel,
}: ClickableTableCellProps) {
  return (
    <TableCell className={cn("p-0", className)}>
      <button
        type="button"
        tabIndex={focusable ? undefined : -1}
        aria-label={ariaLabel}
        className={cn(
          "block w-full min-w-0 max-w-full cursor-pointer appearance-none border-0 bg-transparent px-2 py-2 text-inherit no-underline outline-none [font:inherit] [text-align:inherit] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          buttonClassName,
        )}
        onClick={onClick}
      >
        {children}
      </button>
    </TableCell>
  );
}
