import * as React from "react";
import { RiSearchLine } from "@remixicon/react";

import { cn } from "../../lib/utils";
import { Input } from "./input";
import {
  OverlayScrollbar,
  type OverlayScrollbarProps,
} from "./overlay-scrollbar";
import {
  Popover,
  type PopoverContentProps,
  type PopoverTriggerProps,
} from "./popover";

function SearchablePopover(props: React.ComponentProps<typeof Popover.Root>) {
  return <Popover.Root {...props} />;
}

export type SearchablePopoverTriggerProps = Omit<PopoverTriggerProps, "ref">;

const SearchablePopoverTrigger: React.ForwardRefExoticComponent<
  SearchablePopoverTriggerProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<HTMLButtonElement, SearchablePopoverTriggerProps>(
  function SearchablePopoverTrigger(props, ref) {
    return <Popover.Trigger ref={ref} {...props} />;
  },
);

export interface SearchablePopoverContentProps extends Omit<
  PopoverContentProps,
  "children"
> {
  /** Optional content shown above the search input, such as selected values. */
  header?: React.ReactNode;
  /** Props for specialized search inputs, such as numeric filters. */
  searchInputProps?: Omit<
    React.ComponentPropsWithoutRef<typeof Input>,
    "value" | "onChange"
  >;
  searchPlaceholder?: string;
  /** Controlled search text. Omit it to let the shell own the input value. */
  searchValue?: string;
  /** Initial text for the internally managed input value. */
  defaultSearchValue?: string;
  onSearchValueChange?: (value: string) => void;
  /** Maximum height for the results viewport. The available popover height is also respected. */
  resultsMaxHeight?: React.CSSProperties["maxHeight"];
  resultsClassName?: string;
  syncKey?: OverlayScrollbarProps["syncKey"];
  children?: React.ReactNode;
}

const SearchablePopoverContent = React.forwardRef<
  React.ComponentRef<typeof Popover.Content>,
  SearchablePopoverContentProps
>(function SearchablePopoverContent(
  {
    children,
    className,
    defaultSearchValue,
    header,
    onSearchValueChange,
    resultsClassName,
    resultsMaxHeight = "18rem",
    searchInputProps,
    searchPlaceholder,
    searchValue,
    style,
    syncKey,
    ...contentProps
  },
  ref,
) {
  const [uncontrolledSearchValue, setUncontrolledSearchValue] = React.useState(
    defaultSearchValue ?? "",
  );
  const resolvedSearchValue = searchValue ?? uncontrolledSearchValue;

  const resolvedResultsMaxHeight =
    typeof resultsMaxHeight === "number"
      ? `${resultsMaxHeight}px`
      : resultsMaxHeight;

  return (
    <Popover.Portal>
      <Popover.Content
        ref={ref}
        className={cn(
          "relative flex max-h-(--radix-popover-content-available-height) w-[var(--radix-popover-trigger-width)] origin-(--radix-popover-content-transform-origin) flex-col overflow-hidden rounded-none border border-border bg-popover text-popover-foreground shadow-md outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        style={style}
        {...contentProps}
      >
        {header}
        <div className="relative shrink-0">
          <RiSearchLine
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            {...searchInputProps}
            value={resolvedSearchValue}
            aria-label={
              searchInputProps?.["aria-label"] ??
              searchPlaceholder ??
              searchInputProps?.placeholder
            }
            placeholder={searchPlaceholder ?? searchInputProps?.placeholder}
            className={cn(
              "border-0 pl-9 text-xs shadow-none focus-visible:ring-0",
              searchInputProps?.className,
            )}
            onChange={(event) => {
              const value = event.target.value;
              if (searchValue === undefined) {
                setUncontrolledSearchValue(value);
              }
              onSearchValueChange?.(value);
            }}
          />
        </div>
        <OverlayScrollbar
          axis="vertical"
          syncKey={syncKey}
          className={cn(
            "min-h-0 flex-1 border-t border-border",
            resultsClassName,
          )}
          style={{
            maxHeight: `min(var(--radix-popover-content-available-height, 100vh), ${resolvedResultsMaxHeight})`,
          }}
        >
          {children}
        </OverlayScrollbar>
      </Popover.Content>
    </Popover.Portal>
  );
});

SearchablePopoverContent.displayName = "SearchablePopoverContent";
SearchablePopoverTrigger.displayName = "SearchablePopoverTrigger";

export {
  SearchablePopover,
  SearchablePopoverContent,
  SearchablePopoverTrigger,
};

export type SearchablePopoverRootProps = React.ComponentPropsWithRef<
  typeof SearchablePopover
>;
