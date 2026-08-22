import * as React from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { FLOATING_LAYER_Z_ATTR } from "@/components/ui/floating-layer";
import {
  ModalOverlay,
  type ModalRootState,
  overlayZIndexFor,
  parseZIndex,
  useControllableOpen,
  useModalLayerId,
  useModalLayerZIndex,
} from "@/components/ui/modal-overlay";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { cn } from "@/lib/utils";

type DrawerRootProps = React.ComponentProps<typeof DrawerPrimitive.Root>;

interface DrawerRootState extends ModalRootState {
  onOpenChange?: (open: boolean) => void;
}

const DrawerRootContext = React.createContext<DrawerRootState | null>(null);

function Drawer({
  defaultOpen,
  modal = true,
  onOpenChange,
  open,
  ...props
}: DrawerRootProps) {
  const layerId = useModalLayerId("drawer");
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

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
  className,
  onClick,
  zIndex,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay> & {
  zIndex?: number;
}) {
  const rootState = React.useContext(DrawerRootContext);

  return (
    <ModalOverlay
      data-slot="drawer-overlay"
      layerId={rootState?.layerId ?? "drawer"}
      open={rootState?.modal !== false && (rootState?.open ?? true)}
      zIndex={zIndex}
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
  const rootState = React.useContext(DrawerRootContext);
  const fallbackLayerId = useModalLayerId("drawer-content");
  const layerId = rootState?.layerId ?? fallbackLayerId;
  const baseZIndex = parseZIndex(style?.zIndex) ?? 50;
  const contentZIndex = useModalLayerZIndex({
    baseZIndex,
    enabled: rootState?.modal !== false,
    layerId,
    open: rootState?.open ?? true,
  });
  const overlayZIndex = overlayZIndexFor(contentZIndex);
  const floatingLayerProps =
    rootState?.modal === false
      ? undefined
      : { [FLOATING_LAYER_Z_ATTR]: contentZIndex };

  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay className={overlayClassName} zIndex={overlayZIndex} />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        {...floatingLayerProps}
        className={cn(
          "group/drawer-content fixed z-50 flex h-auto flex-col bg-background text-xs/relaxed data-[vaul-drawer-direction=bottom]:inset-x-0 data-[vaul-drawer-direction=bottom]:bottom-0 data-[vaul-drawer-direction=bottom]:mt-24 data-[vaul-drawer-direction=bottom]:max-h-[80dvh] data-[vaul-drawer-direction=bottom]:rounded-none data-[vaul-drawer-direction=bottom]:border-t data-[vaul-drawer-direction=left]:inset-y-0 data-[vaul-drawer-direction=left]:left-0 data-[vaul-drawer-direction=left]:w-3/4 data-[vaul-drawer-direction=left]:rounded-none data-[vaul-drawer-direction=left]:border-r data-[vaul-drawer-direction=right]:inset-y-0 data-[vaul-drawer-direction=right]:right-0 data-[vaul-drawer-direction=right]:w-3/4 data-[vaul-drawer-direction=right]:rounded-none data-[vaul-drawer-direction=right]:border-l data-[vaul-drawer-direction=top]:inset-x-0 data-[vaul-drawer-direction=top]:top-0 data-[vaul-drawer-direction=top]:mb-24 data-[vaul-drawer-direction=top]:max-h-[80dvh] data-[vaul-drawer-direction=top]:rounded-none data-[vaul-drawer-direction=top]:border-b data-[vaul-drawer-direction=left]:sm:max-w-sm data-[vaul-drawer-direction=right]:sm:max-w-sm",
          className,
        )}
        style={{ ...style, zIndex: contentZIndex }}
        {...props}
      >
        <div className="mx-auto mt-4 hidden h-1 w-[100px] shrink-0 rounded-none bg-muted group-data-[vaul-drawer-direction=bottom]/drawer-content:block" />
        {children}
      </DrawerPrimitive.Content>
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
      contentClassName={cn("h-full min-h-0", contentClassName)}
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
