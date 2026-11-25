import * as React from "react";
import { RiSearchLine } from "@remixicon/react";

import { useIsMobile } from "../../hooks/use-mobile";
import { cn } from "../../lib/utils";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";
import { Input } from "./input";
import {
  OverlayScrollbar,
  type OverlayScrollbarProps,
  PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS,
} from "./overlay-scrollbar";
import {
  Popover,
  type PopoverContentProps,
  type PopoverTriggerProps,
} from "./popover";

const SELECTED_RESULT_SELECTOR =
  '[data-selected-item="true"], [aria-selected="true"], [aria-pressed="true"], [aria-checked="true"], [data-state="checked"]';

const MobileSearchContext = React.createContext(false);

function SearchablePopover({
  responsive = false,
  ...props
}: React.ComponentProps<typeof Popover.Root> & { responsive?: boolean }) {
  const isMobile = useIsMobile();
  const mobile = responsive && isMobile;
  return (
    <MobileSearchContext.Provider value={mobile}>
      {mobile ? (
        <Drawer
          open={props.open}
          defaultOpen={props.defaultOpen}
          onOpenChange={props.onOpenChange}
        >
          {props.children}
        </Drawer>
      ) : (
        <Popover.Root {...props} />
      )}
    </MobileSearchContext.Provider>
  );
}

export type SearchablePopoverTriggerProps = Omit<PopoverTriggerProps, "ref">;

const SearchablePopoverTrigger: React.ForwardRefExoticComponent<
  SearchablePopoverTriggerProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<HTMLButtonElement, SearchablePopoverTriggerProps>(
  function SearchablePopoverTrigger(props, ref) {
    const mobile = React.useContext(MobileSearchContext);
    return mobile ? (
      <DrawerTrigger ref={ref} {...props} />
    ) : (
      <Popover.Trigger ref={ref} {...props} />
    );
  },
);

export interface SearchablePopoverContentProps extends Omit<
  PopoverContentProps,
  "children"
> {
  /** Accessible title for the mobile drawer. */
  drawerTitle?: string;
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
    drawerTitle,
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
    onOpenAutoFocus,
    ...contentProps
  },
  ref,
) {
  const mobile = React.useContext(MobileSearchContext);
  const [uncontrolledSearchValue, setUncontrolledSearchValue] = React.useState(
    defaultSearchValue ?? "",
  );
  const resolvedSearchValue = searchValue ?? uncontrolledSearchValue;
  const resultsViewportRef = React.useRef<HTMLDivElement | null>(null);

  const resolvedResultsMaxHeight =
    typeof resultsMaxHeight === "number"
      ? `${resultsMaxHeight}px`
      : resultsMaxHeight;

  const scrollSelectedResultIntoView = React.useCallback(() => {
    const viewport = resultsViewportRef.current;
    const selectedItem = viewport?.querySelector<HTMLElement>(
      SELECTED_RESULT_SELECTOR,
    );
    if (!viewport || viewport.clientHeight === 0 || !selectedItem) return;

    const viewportRect = viewport.getBoundingClientRect();
    const selectedRect = selectedItem.getBoundingClientRect();
    const viewportBottom = viewportRect.top + viewport.clientHeight;

    if (selectedRect.top < viewportRect.top) {
      viewport.scrollTop += selectedRect.top - viewportRect.top;
    } else if (selectedRect.bottom > viewportBottom) {
      viewport.scrollTop += selectedRect.bottom - viewportBottom;
    }
  }, []);

  const setResultsViewportRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      resultsViewportRef.current = node;
    },
    [],
  );

  const handleOpenAutoFocus = (
    event: Parameters<
      NonNullable<SearchablePopoverContentProps["onOpenAutoFocus"]>
    >[0],
  ) => {
    onOpenAutoFocus?.(event);
    scrollSelectedResultIntoView();
  };

  const body = (
    <>
      {header}
      <div className="relative shrink-0">
        <RiSearchLine
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          {...searchInputProps}
          autoFocus={mobile ? false : searchInputProps?.autoFocus}
          value={resolvedSearchValue}
          aria-label={
            searchInputProps?.["aria-label"] ??
            searchPlaceholder ??
            searchInputProps?.placeholder
          }
          placeholder={searchPlaceholder ?? searchInputProps?.placeholder}
          className={cn(
            "border-0 pl-9 text-xs shadow-none focus-visible:ring-0",
            mobile && "h-11 text-base",
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
        options={PERSISTENT_VERTICAL_SCROLLBAR_OPTIONS}
        scrollElementRef={setResultsViewportRef}
        syncKey={syncKey}
        className={cn(
          "min-h-0 flex-1 border-t border-border",
          resultsClassName,
        )}
        style={{
          maxHeight: mobile
            ? undefined
            : `min(var(--radix-popover-content-available-height, 100vh), ${resolvedResultsMaxHeight})`,
        }}
      >
        {children}
      </OverlayScrollbar>
    </>
  );
  if (mobile)
    return (
      <DrawerContent
        ref={ref}
        className="h-[70dvh] min-h-0 overflow-hidden pb-[env(safe-area-inset-bottom)]"
        aria-describedby={undefined}
        onOpenAutoFocus={handleOpenAutoFocus}
      >
        <DrawerHeader>
          <DrawerTitle>
            {drawerTitle ??
              searchPlaceholder ??
              searchInputProps?.["aria-label"] ??
              searchInputProps?.placeholder}
          </DrawerTitle>
        </DrawerHeader>
        <div className="flex min-h-0 flex-1 flex-col [&_button]:min-h-11">
          {body}
        </div>
      </DrawerContent>
    );
  return (
    <Popover.Portal>
      <Popover.Content
        ref={ref}
        className={cn(
          "relative flex max-h-(--radix-popover-content-available-height) w-[var(--radix-popover-trigger-width)] origin-(--radix-popover-content-transform-origin) flex-col overflow-hidden rounded-none border border-border bg-popover text-popover-foreground shadow-md outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        style={style}
        onOpenAutoFocus={handleOpenAutoFocus}
        {...contentProps}
      >
        {body}
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
