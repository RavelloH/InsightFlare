import { useState } from "react";
import {
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiEditLine,
  RiMoreLine,
} from "@remixicon/react";

import { Clickable } from "@/components/ui/clickable";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppMessages } from "@/lib/i18n/messages";

export function FunnelActions({
  labels,
  canManage,
  onOpen,
  onEdit,
  onDelete,
}: {
  readonly labels: AppMessages["funnels"];
  readonly canManage: boolean;
  readonly onOpen?: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {canManage ? (
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Clickable
              aria-label={labels.moreActions}
              enableHoverScale={false}
              hoverScale={1.05}
              tapScale={0.95}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              className="size-8 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
            >
              <RiMoreLine />
            </Clickable>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuLabel>{labels.moreActions}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                window.setTimeout(onEdit, 150);
              }}
            >
              <RiEditLine /> {labels.edit}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                window.setTimeout(onDelete, 150);
              }}
            >
              <RiDeleteBinLine /> {labels.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {onOpen ? (
        <Clickable
          aria-label={`${labels.open}: ${labels.title}`}
          enableHoverScale={false}
          hoverScale={1.05}
          tapScale={0.95}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="size-8 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
        >
          <RiArrowRightSLine />
        </Clickable>
      ) : null}
    </div>
  );
}
