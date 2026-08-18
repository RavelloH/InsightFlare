import * as React from "react";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";
import { OverlayScrollbars } from "overlayscrollbars";
import { Popover as PopoverPrimitive } from "radix-ui";

import {
  prepareNativeScrollbarHost,
  useNativeScrollbars,
  VERTICAL_SCROLLBAR_OPTIONS,
} from "@/components/ui/overlay-scrollbar";
import { cn } from "@/lib/utils";

type ItemMeta = {
  label: React.ReactNode;
  disabled: boolean;
};

type SelectContextValue = {
  value: string | undefined;
  onValueChange: (value: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  itemMap: Map<string, ItemMeta>;
  enabledValues: string[];
  highlightedValue: string | null;
  setHighlightedValue: (value: string | null) => void;
  triggerId: string;
  itemIdFor: (value: string) => string;
};

const SelectContext = React.createContext<SelectContextValue | null>(null);

function useSelectContext(name: string) {
  const ctx = React.useContext(SelectContext);
  if (!ctx) {
    throw new Error(`<${name}> must be used inside <Select>`);
  }
  return ctx;
}

function sanitizeIdSuffix(value: string): string {
  return value.replace(
    /[^a-zA-Z0-9_-]/g,
    (c) => `_${c.charCodeAt(0).toString(16)}_`,
  );
}

function findContentChildren(node: React.ReactNode): React.ReactNode {
  let result: React.ReactNode = null;
  React.Children.forEach(node, (child) => {
    if (result != null) return;
    if (!React.isValidElement(child)) return;
    if (child.type === SelectContent) {
      result = (child.props as { children?: React.ReactNode }).children ?? null;
      return;
    }
    if (child.type === React.Fragment) {
      const inner = findContentChildren(
        (child.props as { children?: React.ReactNode }).children,
      );
      if (inner != null) result = inner;
    }
  });
  return result;
}

function collectItems(node: React.ReactNode, out: Map<string, ItemMeta>): void {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as {
      value?: string;
      disabled?: boolean;
      children?: React.ReactNode;
    };
    if (child.type === SelectItem) {
      if (typeof props.value === "string") {
        out.set(props.value, {
          label: props.children,
          disabled: !!props.disabled,
        });
      }
      return;
    }
    if (props.children != null) {
      collectItems(props.children, out);
    }
  });
}

type SelectProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  children?: React.ReactNode;
};

function Select({
  value,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen,
  onOpenChange,
  disabled = false,
  name,
  required,
  children,
}: SelectProps) {
  const isValueControlled = value !== undefined;
  const [valueState, setValueState] = React.useState<string | undefined>(
    defaultValue,
  );
  const currentValue = isValueControlled ? value : valueState;

  const handleValueChange = React.useCallback(
    (next: string) => {
      if (!isValueControlled) setValueState(next);
      onValueChange?.(next);
    },
    [isValueControlled, onValueChange],
  );

  const isOpenControlled = openProp !== undefined;
  const [openState, setOpenState] = React.useState(defaultOpen ?? false);
  const open = isOpenControlled ? openProp : openState;

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!isOpenControlled) setOpenState(next);
      onOpenChange?.(next);
    },
    [isOpenControlled, onOpenChange],
  );

  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const triggerId = React.useId();
  const idPrefix = React.useMemo(
    () => `${triggerId.replace(/:/g, "_")}-item`,
    [triggerId],
  );

  const contentChildren = React.useMemo(
    () => findContentChildren(children),
    [children],
  );

  const { itemMap, enabledValues } = React.useMemo(() => {
    const m = new Map<string, ItemMeta>();
    collectItems(contentChildren, m);
    const enabled: string[] = [];
    m.forEach((meta, val) => {
      if (!meta.disabled) enabled.push(val);
    });
    return { itemMap: m, enabledValues: enabled };
  }, [contentChildren]);

  const itemIdFor = React.useCallback(
    (val: string) => `${idPrefix}-${sanitizeIdSuffix(val)}`,
    [idPrefix],
  );

  const [highlightedValue, setHighlightedValue] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    if (open) {
      setHighlightedValue(currentValue ?? null);
    } else {
      setHighlightedValue(null);
    }
  }, [open, currentValue]);

  const ctxValue = React.useMemo<SelectContextValue>(
    () => ({
      value: currentValue,
      onValueChange: handleValueChange,
      open,
      setOpen: handleOpenChange,
      disabled,
      triggerRef,
      contentRef,
      itemMap,
      enabledValues,
      highlightedValue,
      setHighlightedValue,
      triggerId,
      itemIdFor,
    }),
    [
      currentValue,
      handleValueChange,
      open,
      handleOpenChange,
      disabled,
      itemMap,
      enabledValues,
      highlightedValue,
      triggerId,
      itemIdFor,
    ],
  );

  return (
    <SelectContext.Provider value={ctxValue}>
      <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        {children}
      </PopoverPrimitive.Root>
      {name ? (
        <input
          type="hidden"
          name={name}
          value={currentValue ?? ""}
          required={required}
          disabled={disabled}
        />
      ) : null}
    </SelectContext.Provider>
  );
}

type SelectTriggerProps = React.ComponentProps<"button"> & {
  size?: "sm" | "default";
};

function SelectTrigger({
  className,
  size = "default",
  children,
  disabled: disabledProp,
  ...props
}: SelectTriggerProps) {
  const ctx = useSelectContext("SelectTrigger");
  const isDisabled = disabledProp ?? ctx.disabled;
  const hasValue = ctx.value !== undefined && ctx.value !== "";

  return (
    <PopoverPrimitive.Trigger asChild>
      <button
        type="button"
        ref={ctx.triggerRef}
        id={ctx.triggerId}
        role="combobox"
        aria-haspopup="listbox"
        data-slot="select-trigger"
        data-size={size}
        data-placeholder={hasValue ? undefined : ""}
        disabled={isDisabled}
        className={cn(
          "flex w-fit items-center justify-between gap-1.5 rounded-none border border-input bg-transparent py-2 pr-2 pl-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-none *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className,
        )}
        {...props}
      >
        {children}
        <RiArrowDownSLine className="pointer-events-none size-4 text-muted-foreground" />
      </button>
    </PopoverPrimitive.Trigger>
  );
}

type SelectValueProps = Omit<React.ComponentProps<"span">, "children"> & {
  placeholder?: React.ReactNode;
  children?: React.ReactNode;
};

function SelectValue({
  placeholder,
  children,
  className,
  ...props
}: SelectValueProps) {
  const ctx = useSelectContext("SelectValue");
  const meta = ctx.value !== undefined ? ctx.itemMap.get(ctx.value) : undefined;
  const display = children ?? meta?.label ?? placeholder;

  return (
    <span data-slot="select-value" className={className} {...props}>
      {display}
    </span>
  );
}

type SelectContentProps = Omit<
  React.ComponentProps<typeof PopoverPrimitive.Content>,
  "role"
>;

function SelectContent({
  className,
  children,
  align = "center",
  sideOffset = 4,
  onKeyDown: onKeyDownProp,
  onWheel: onWheelProp,
  onWheelCapture: onWheelCaptureProp,
  onOpenAutoFocus: onOpenAutoFocusProp,
  ...props
}: SelectContentProps) {
  const ctx = useSelectContext("SelectContent");
  const scrollHostRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollHost, setScrollHost] = React.useState<HTMLDivElement | null>(
    null,
  );
  const scrollbarRef = React.useRef<ReturnType<
    typeof OverlayScrollbars
  > | null>(null);
  const nativeScrollbars = useNativeScrollbars();
  const setScrollHostRef = React.useCallback((node: HTMLDivElement | null) => {
    scrollHostRef.current = node;
    setScrollHost(node);
  }, []);

  React.useEffect(() => {
    if (!scrollHost) return;
    const host = scrollHost;
    if (prepareNativeScrollbarHost(host)) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, VERTICAL_SCROLLBAR_OPTIONS);
    if (existing) existing.options(VERTICAL_SCROLLBAR_OPTIONS);
    scrollbarRef.current = instance;

    return () => {
      if (!existing) instance.destroy();
      if (scrollbarRef.current === instance) scrollbarRef.current = null;
    };
  }, [nativeScrollbars, scrollHost]);

  const scrollViewport = () =>
    (scrollbarRef.current?.elements().viewport as HTMLDivElement | undefined) ??
    scrollHostRef.current;

  const focusValue = React.useCallback(
    (val: string) => {
      ctx.setHighlightedValue(val);
      const el = document.getElementById(ctx.itemIdFor(val));
      el?.scrollIntoView({ block: "nearest" });
    },
    [ctx],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDownProp?.(event);
    if (event.defaultPrevented) return;

    const values = ctx.enabledValues;
    if (values.length === 0) return;
    const currentIdx = ctx.highlightedValue
      ? values.indexOf(ctx.highlightedValue)
      : -1;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        const next =
          currentIdx >= 0 ? Math.min(currentIdx + 1, values.length - 1) : 0;
        focusValue(values[next]);
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        const next = currentIdx > 0 ? currentIdx - 1 : 0;
        focusValue(values[next]);
        break;
      }
      case "Home": {
        event.preventDefault();
        focusValue(values[0]);
        break;
      }
      case "End": {
        event.preventDefault();
        focusValue(values[values.length - 1]);
        break;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        if (ctx.highlightedValue) {
          ctx.onValueChange(ctx.highlightedValue);
          ctx.setOpen(false);
        }
        break;
      }
      case "Tab": {
        ctx.setOpen(false);
        break;
      }
    }
  };

  const handleOpenAutoFocus = (event: Event) => {
    onOpenAutoFocusProp?.(
      event as unknown as Parameters<
        NonNullable<SelectContentProps["onOpenAutoFocus"]>
      >[0],
    );
    if (event.defaultPrevented) return;
    event.preventDefault();
    ctx.contentRef.current?.focus({ preventScroll: true });
    if (ctx.highlightedValue) {
      const el = document.getElementById(ctx.itemIdFor(ctx.highlightedValue));
      el?.scrollIntoView({ block: "nearest" });
    }
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    onWheelProp?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    const target = scrollViewport();
    if (!target) return;
    target.scrollTop += event.deltaY;
    target.scrollLeft += event.deltaX;
  };

  const handleWheelCapture = (event: React.WheelEvent<HTMLDivElement>) => {
    onWheelCaptureProp?.(event);
    if (event.defaultPrevented) return;
    event.stopPropagation();
  };

  const activeDescendantId = ctx.highlightedValue
    ? ctx.itemIdFor(ctx.highlightedValue)
    : undefined;

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ctx.contentRef}
        role="listbox"
        aria-labelledby={ctx.triggerId}
        aria-activedescendant={activeDescendantId}
        tabIndex={-1}
        align={align}
        sideOffset={sideOffset}
        onKeyDown={handleKeyDown}
        onWheelCapture={handleWheelCapture}
        onWheel={handleWheel}
        onOpenAutoFocus={handleOpenAutoFocus}
        data-slot="select-content"
        className={cn(
          "relative z-50 min-w-(--radix-popover-trigger-width) origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-none bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        )}
        {...props}
      >
        <div
          ref={setScrollHostRef}
          className={cn(
            "max-h-(--radix-popover-content-available-height) overflow-x-hidden",
            nativeScrollbars ? "overflow-y-auto" : "overflow-hidden",
            className,
          )}
          data-overlayscrollbars-initialize={nativeScrollbars ? undefined : ""}
        >
          {children}
        </div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

function SelectGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="select-group"
      className={cn("scroll-my-1", className)}
      {...props}
    />
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-label"
      className={cn("px-2 py-2 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

type SelectItemProps = Omit<
  React.ComponentProps<"div">,
  "value" | "onSelect"
> & {
  value: string;
  disabled?: boolean;
  textValue?: string;
};

function SelectItem({
  className,
  children,
  value,
  disabled = false,
  textValue: _textValue,
  onPointerMove,
  onClick,
  ...props
}: SelectItemProps) {
  const ctx = useSelectContext("SelectItem");
  const itemId = ctx.itemIdFor(value);

  const isSelected = ctx.value === value;
  const isHighlighted = ctx.highlightedValue === value;

  return (
    <div
      id={itemId}
      role="option"
      data-slot="select-item"
      data-value={value}
      data-state={isSelected ? "checked" : "unchecked"}
      data-highlighted={isHighlighted ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      aria-selected={isSelected}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (disabled) return;
        ctx.onValueChange(value);
        ctx.setOpen(false);
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (disabled) return;
        if (ctx.highlightedValue !== value) ctx.setHighlightedValue(value);
      }}
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-none py-2 pr-8 pl-2 text-xs outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        {isSelected ? <RiCheckLine className="pointer-events-none" /> : null}
      </span>
      <span>{children}</span>
    </div>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
