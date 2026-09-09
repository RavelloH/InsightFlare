import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { AppOverlay, useControllableOpen } from "@/components/ui/app-overlay";
import { OverlayFrame } from "@/components/ui/layer/layer-manager";
import { LayerPortal } from "@/components/ui/layer/layer-portal";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { cn } from "@/lib/utils";

type DrawerRootProps = React.ComponentProps<typeof DrawerPrimitive.Root>;

interface DrawerRootState {
  layerId: string;
  modal: boolean;
  onOpenChange?: (open: boolean) => void;
  open: boolean;
}

const DrawerRootContext = React.createContext<DrawerRootState | null>(null);

function Drawer({
  defaultOpen,
  modal = true,
  onOpenChange,
  open,
  ...props
}: DrawerRootProps) {
  const layerId = React.useId();
  const [currentOpen, handleOpenChange] = useControllableOpen({
    defaultOpen,
    onOpenChange,
    open,
  });
  const rootState = React.useMemo(
    () => ({
      layerId,
      modal,
      onOpenChange: handleOpenChange,
      open: currentOpen,
    }),
    [currentOpen, handleOpenChange, layerId, modal],
  );

  return (
    <DrawerRootContext.Provider value={rootState}>
      <DrawerPrimitive.Root
        data-slot="drawer"
        defaultOpen={undefined}
        modal={modal}
        onOpenChange={handleOpenChange}
        open={currentOpen}
        {...props}
      />
    </DrawerRootContext.Provider>
  );
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ children }: { children: React.ReactNode }) {
  const rootState = React.useContext(DrawerRootContext);
  return (
    <OverlayFrame
      kind="drawer"
      open={rootState?.open ?? true}
      id={rootState?.layerId}
    >
      {children}
    </OverlayFrame>
  );
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  const rootState = React.useContext(DrawerRootContext);

  return (
    <AppOverlay
      data-slot="drawer-overlay"
      layerId={rootState?.layerId ?? "drawer"}
      open={rootState?.modal !== false && (rootState?.open ?? true)}
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        rootState?.onOpenChange?.(false);
      }}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  overlayClassName,
  style,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & {
  overlayClassName?: string;
}) {
  const { zIndex: _zIndex, ...contentStyle } = style ?? {};

  return (
    <DrawerPortal>
      <LayerPortal slot="backdrop">
        <DrawerOverlay className={overlayClassName} />
      </LayerPortal>
      <LayerPortal slot="surface">
        <DrawerPrimitive.Content
          data-slot="drawer-content"
          className={cn(
            "pointer-events-auto group/drawer-content fixed flex h-auto flex-col bg-background text-xs/relaxed data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80dvh] data-[vaul-drawer-direction=bottom]:rounded-none data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:rounded-none data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:rounded-none data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80dvh] data-[vaul-drawer-direction=top]:border-b data-[vaul-drawer-direction=left]:sm:max-w-sm data-[vaul-drawer-direction=right]:sm:max-w-sm",
            className,
          )}
          style={contentStyle}
          {...props}
        >
          <div className="mx-auto mt-4 hidden h-1 w-[100px] shrink-0 rounded-none bg-muted group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
          {children}
        </DrawerPrimitive.Content>
      </LayerPortal>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex flex-col gap-0.5 p-4 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-center group-data-[vaul-drawer-direction=top]/drawer-content:text-center md:gap-0.5 md:text-left",
        className,
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function DrawerScrollArea({
  className,
  contentClassName,
  ...props
}: React.ComponentProps<typeof VerticalScrollMask>) {
  return (
    <VerticalScrollMask
      className={cn("min-h-0 flex-1", className)}
      contentClassName={cn("min-h-0", contentClassName)}
      {...props}
    />
  );
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-sm font-medium text-foreground", className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-xs/relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerScrollArea,
  DrawerTitle,
  DrawerTrigger,
};
