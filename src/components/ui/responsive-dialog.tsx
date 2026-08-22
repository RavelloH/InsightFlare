"use client";

import * as React from "react";
import { RiCloseLine, RiInformationLine } from "@remixicon/react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

const ResponsiveDialogContext = React.createContext(false);

export function ResponsiveDialog({
  children,
  ...props
}: React.ComponentProps<typeof Dialog>) {
  const isMobile = useIsMobile();
  const Root = isMobile ? Drawer : Dialog;

  return (
    <ResponsiveDialogContext.Provider value={isMobile}>
      <Root {...props}>{children}</Root>
    </ResponsiveDialogContext.Provider>
  );
}

export function ResponsiveDialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogTrigger>) {
  const isMobile = React.useContext(ResponsiveDialogContext);
  const Trigger = isMobile ? DrawerTrigger : DialogTrigger;

  return <Trigger {...props} />;
}

export function ResponsiveDialogClose({
  ...props
}: React.ComponentProps<typeof DialogClose>) {
  const isMobile = React.useContext(ResponsiveDialogContext);
  const Close = isMobile ? DrawerClose : DialogClose;

  return <Close {...props} />;
}

export function ResponsiveDialogContent({
  children,
  className,
  desktopClassName,
  drawerClassName,
  overlayClassName,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogContent> & {
  desktopClassName?: string;
  drawerClassName?: string;
}) {
  const isMobile = React.useContext(ResponsiveDialogContext);

  if (isMobile) {
    return (
      <DrawerContent
        className={cn(
          "max-h-[80dvh] min-h-0 flex flex-col overflow-hidden",
          drawerClassName,
          className,
        )}
        overlayClassName={overlayClassName}
        {...props}
      >
        {children}
      </DrawerContent>
    );
  }

  return (
    <DialogContent
      className={cn("max-h-screen max-w-full", desktopClassName, className)}
      overlayClassName={overlayClassName}
      showCloseButton={showCloseButton}
      {...props}
    >
      {children}
    </DialogContent>
  );
}

export function ResponsiveDialogBody({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  const isMobile = React.useContext(ResponsiveDialogContext);

  if (isMobile) {
    return (
      <DrawerScrollArea
        className="min-h-0 flex-1"
        contentClassName={cn("px-4 pb-2", className)}
        {...props}
      >
        {children}
      </DrawerScrollArea>
    );
  }

  return (
    <div className={cn("min-h-0 overflow-y-auto", className)} {...props}>
      {children}
    </div>
  );
}

export function ResponsiveDialogHeader({
  className,
  ...props
}: React.ComponentProps<typeof DialogHeader>) {
  const isMobile = React.useContext(ResponsiveDialogContext);

  if (isMobile) {
    return (
      <DrawerHeader
        className={cn("shrink-0 p-4 text-center md:text-center", className)}
        {...props}
      />
    );
  }

  return <DialogHeader className={className} {...props} />;
}

export function ResponsiveDialogTitle({
  children,
  className,
  icon: Icon = RiInformationLine,
  iconClassName,
  ...props
}: React.ComponentProps<typeof DialogTitle>) {
  const isMobile = React.useContext(ResponsiveDialogContext);

  if (isMobile) {
    return (
      <DrawerTitle
        className={cn(
          "flex w-full items-center justify-center gap-2 text-center",
          className,
        )}
        {...props}
      >
        {Icon ? (
          <Icon className={cn("size-4 shrink-0", iconClassName)} />
        ) : null}
        <span className="min-w-0">{children}</span>
      </DrawerTitle>
    );
  }

  return (
    <DialogTitle
      className={className}
      icon={Icon}
      iconClassName={iconClassName}
      {...props}
    >
      {children}
    </DialogTitle>
  );
}

export function ResponsiveDialogDescription({
  ...props
}: React.ComponentProps<typeof DialogDescription>) {
  const isMobile = React.useContext(ResponsiveDialogContext);
  const Description = isMobile ? DrawerDescription : DialogDescription;

  return <Description {...props} />;
}

export function ResponsiveDialogFooter({
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof DialogFooter>) {
  const isMobile = React.useContext(ResponsiveDialogContext);

  if (isMobile) {
    return (
      <DrawerFooter className={cn("shrink-0 p-4", className)} {...props}>
        {children}
        {showCloseButton ? (
          <DrawerClose asChild>
            <Button variant="outline">
              <RiCloseLine />
              <span>Close</span>
            </Button>
          </DrawerClose>
        ) : null}
      </DrawerFooter>
    );
  }

  return (
    <DialogFooter
      className={className}
      showCloseButton={showCloseButton}
      {...props}
    >
      {children}
    </DialogFooter>
  );
}
