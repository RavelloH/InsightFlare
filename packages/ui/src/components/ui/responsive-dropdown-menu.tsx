import * as React from "react";
import { RiCheckLine } from "@remixicon/react";
import { Slot } from "radix-ui";

import { useIsMobile } from "../../hooks/use-mobile";
import { cn } from "../../lib/utils";
import { useControllableOpen } from "./app-overlay";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";

const MenuContext = React.createContext({ mobile: false, close: () => {} });
const MenuTitleContext = React.createContext<string | null>(null);
const RadioContext = React.createContext<{
  value?: string;
  change?: (value: string) => void;
}>({});

export function ResponsiveDropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  children,
  modal,
}: React.ComponentProps<typeof DropdownMenu>) {
  const mobile = useIsMobile();
  const [current, setOpen] = useControllableOpen({
    open,
    defaultOpen,
    onOpenChange,
  });
  const content = mobile ? (
    <Drawer open={current} onOpenChange={setOpen}>
      {children}
    </Drawer>
  ) : (
    <DropdownMenu open={current} onOpenChange={setOpen} modal={modal}>
      {children}
    </DropdownMenu>
  );
  return (
    <MenuContext.Provider value={{ mobile, close: () => setOpen(false) }}>
      {content}
    </MenuContext.Provider>
  );
}

export function ResponsiveDropdownMenuTrigger(
  props: React.ComponentProps<typeof DropdownMenuTrigger>,
) {
  const { mobile } = React.useContext(MenuContext);
  return mobile ? (
    <DrawerTrigger {...props} />
  ) : (
    <DropdownMenuTrigger {...props} />
  );
}

export function ResponsiveDropdownMenuContent({
  title,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent> & { title: string }) {
  const { mobile } = React.useContext(MenuContext);
  if (!mobile)
    return <DropdownMenuContent {...props}>{children}</DropdownMenuContent>;
  return (
    <DrawerContent aria-describedby={undefined}>
      <DrawerHeader>
        <DrawerTitle>{title}</DrawerTitle>
      </DrawerHeader>
      <DrawerScrollArea contentClassName="px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <MenuTitleContext.Provider value={title}>
          {children}
        </MenuTitleContext.Provider>
      </DrawerScrollArea>
    </DrawerContent>
  );
}

type ItemProps = React.ComponentProps<typeof DropdownMenuItem>;
export function ResponsiveDropdownMenuItem({
  asChild,
  children,
  className,
  disabled,
  variant,
  onSelect,
  onClick,
  ...props
}: ItemProps) {
  const { mobile, close } = React.useContext(MenuContext);
  if (!mobile)
    return (
      <DropdownMenuItem
        asChild={asChild}
        className={className}
        disabled={disabled}
        variant={variant}
        onSelect={onSelect}
        onClick={onClick}
        {...props}
      >
        {children}
      </DropdownMenuItem>
    );
  const classes = cn(
    "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent [&_svg]:size-4 [&_svg]:shrink-0",
    variant === "destructive" && "text-destructive",
    disabled && "pointer-events-none opacity-50",
    className,
  );
  const select = (click: React.MouseEvent<HTMLElement>) => {
    if (disabled) {
      click.preventDefault();
      return;
    }
    onClick?.(click as unknown as React.MouseEvent<HTMLDivElement>);
    const event = new Event("select", { cancelable: true });
    onSelect?.(event);
    if (!event.defaultPrevented) close();
  };
  if (asChild)
    return (
      <Slot.Root
        className={classes}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        onClick={select}
      >
        {children}
      </Slot.Root>
    );
  return (
    <button
      type="button"
      className={classes}
      disabled={disabled}
      onClick={select}
    >
      {children}
    </button>
  );
}

export function ResponsiveDropdownMenuLabel(
  props: React.ComponentProps<typeof DropdownMenuLabel>,
) {
  const { mobile } = React.useContext(MenuContext);
  const title = React.useContext(MenuTitleContext);
  if (mobile && props.children === title) return null;
  return mobile ? (
    <div
      className={cn("px-3 py-2 text-xs text-muted-foreground", props.className)}
    >
      {props.children}
    </div>
  ) : (
    <DropdownMenuLabel {...props} />
  );
}

export function ResponsiveDropdownMenuSeparator(
  props: React.ComponentProps<typeof DropdownMenuSeparator>,
) {
  const { mobile } = React.useContext(MenuContext);
  return mobile ? (
    <div role="separator" className="my-1 h-px bg-border" />
  ) : (
    <DropdownMenuSeparator {...props} />
  );
}

export function ResponsiveDropdownMenuRadioGroup(
  props: React.ComponentProps<typeof DropdownMenuRadioGroup>,
) {
  const { mobile } = React.useContext(MenuContext);
  if (!mobile) return <DropdownMenuRadioGroup {...props} />;
  return (
    <RadioContext.Provider
      value={{ value: props.value, change: props.onValueChange }}
    >
      <div role="radiogroup">{props.children}</div>
    </RadioContext.Provider>
  );
}

export function ResponsiveDropdownMenuRadioItem({
  value,
  children,
  disabled,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuRadioItem>) {
  const { mobile, close } = React.useContext(MenuContext);
  const radio = React.useContext(RadioContext);
  if (!mobile)
    return (
      <DropdownMenuRadioItem
        value={value}
        disabled={disabled}
        className={className}
        {...props}
      >
        {children}
      </DropdownMenuRadioItem>
    );
  const selected = radio.value === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      className={cn(
        "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        selected && "bg-accent text-accent-foreground",
        className,
      )}
      onClick={() => {
        radio.change?.(value);
        close();
      }}
    >
      {children}
      {selected && <RiCheckLine className="ml-auto" />}
    </button>
  );
}
