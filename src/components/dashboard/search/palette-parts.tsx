import type { ReactNode } from "react";
import { Spinner } from "@insightflare/ui/spinner";
import type { RemixiconComponentType } from "@remixicon/react";
import { RiCornerDownLeftLine } from "@remixicon/react";

import { cn } from "@/lib/utils";

/** Marks the first case-insensitive occurrence of the query in a label. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const term = query.trim().toLocaleLowerCase();
  const index = term ? text.toLocaleLowerCase().indexOf(term) : -1;
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <span className="text-primary">
        {text.slice(index, index + term.length)}
      </span>
      {text.slice(index + term.length)}
    </>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center border border-border bg-muted/50 px-1 font-sans text-[10px] leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}

export function PaletteGroup({
  label,
  status,
  busy,
  children,
}: {
  label: string;
  status?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="py-1">
      <div className="flex h-7 items-center justify-between gap-2 px-3 text-xs text-muted-foreground">
        <span>{label}</span>
        {status ? (
          <span role="status" className="flex items-center gap-1.5 truncate">
            {busy ? <Spinner className="size-3" /> : null}
            {status}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function PaletteRow({
  id,
  active,
  icon: Icon,
  label,
  detail,
  tag,
  onHover,
  onSelect,
}: {
  id: string;
  active: boolean;
  icon: RemixiconComponentType;
  label: ReactNode;
  detail?: ReactNode;
  tag?: ReactNode;
  onHover: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      data-active={active || undefined}
      className={cn(
        "flex h-8 cursor-pointer items-center gap-2.5 border-l-2 border-transparent px-3 text-xs text-foreground/90 select-none",
        active && "border-primary bg-muted text-foreground",
      )}
      onMouseMove={active ? undefined : onHover}
      onClick={onSelect}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 text-muted-foreground",
          active && "text-foreground",
        )}
      />
      <span className="min-w-0 truncate">{label}</span>
      {detail ? (
        <span className="min-w-0 shrink truncate text-muted-foreground">
          {detail}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-muted-foreground">
        {tag ? <span className="max-w-48 truncate">{tag}</span> : null}
        <RiCornerDownLeftLine
          aria-hidden="true"
          className={cn("size-3.5", active ? "opacity-100" : "opacity-0")}
        />
      </span>
    </div>
  );
}

export function TypeChip({
  active,
  label,
  onSelect,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      tabIndex={-1}
      className={cn(
        "h-6 shrink-0 border px-2 text-xs transition-colors",
        active
          ? "border-foreground/20 bg-foreground text-background"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}
