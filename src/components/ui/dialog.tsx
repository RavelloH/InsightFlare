import * as React from "react";
import { createPortal } from "react-dom";
import type { RemixiconComponentType } from "@remixicon/react";
import { RiCloseLine, RiInformationLine } from "@remixicon/react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { AppOverlay } from "@/components/ui/app-overlay";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DialogOpenContext = React.createContext(false);

function Dialog({
  defaultOpen = false,
  open,
  onOpenChange,
  ...rootProps
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
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

  return (
    <DialogOpenContext.Provider value={currentOpen}>
      <DialogPrimitive.Root
        data-slot="dialog"
        {...rootProps}
        open={currentOpen}
        onOpenChange={handleOpenChange}
        modal={false}
      />
    </DialogOpenContext.Provider>
  );
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  children,
  container,
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  if (typeof document === "undefined") return null;

  return createPortal(children, container ?? document.body);
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogContent({
  className,
  children,
  overlayClassName,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  overlayClassName?: string;
  showCloseButton?: boolean;
}) {
  const open = React.useContext(DialogOpenContext);

  return (
    <DialogPortal>
      <AppOverlay
        className={overlayClassName}
        layerId="dialog-overlay"
        open={open}
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-none bg-background p-4 text-xs/relaxed ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <RiCloseLine />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">
            <RiCloseLine />
            <span>Close</span>
          </Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  children,
  icon: Icon = RiInformationLine,
  iconClassName,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & {
  icon?: RemixiconComponentType | null;
  iconClassName?: string;
}) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "inline-flex items-center gap-2 text-sm font-medium",
        className,
      )}
      {...props}
    >
      {Icon ? <Icon className={cn("size-4 shrink-0", iconClassName)} /> : null}
      <span className="min-w-0">{children}</span>
    </DialogPrimitive.Title>
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-xs/relaxed text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
