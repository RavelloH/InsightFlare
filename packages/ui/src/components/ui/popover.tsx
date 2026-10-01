import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "../../lib/utils";
import { LayerPortal } from "./layer/layer-portal";

function PopoverPortal({ children }: { children?: React.ReactNode }) {
  return <LayerPortal slot="floating">{children}</LayerPortal>;
}

const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, ...props }, ref) {
  const contentRef = React.useRef<React.ComponentRef<
    typeof PopoverPrimitive.Content
  > | null>(null);
  const composedRef = React.useCallback(
    (node: React.ComponentRef<typeof PopoverPrimitive.Content> | null) => {
      contentRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [ref],
  );
  const onEscapeKeyDownProp = props.onEscapeKeyDown;
  const onEscapeKeyDown = (event: KeyboardEvent) => {
    onEscapeKeyDownProp?.(event);
    if (
      !event.defaultPrevented &&
      event.target instanceof Node &&
      contentRef.current?.contains(event.target)
    ) {
      event.stopImmediatePropagation();
    }
  };

  return (
    <PopoverPrimitive.Content
      ref={composedRef}
      className={cn("pointer-events-auto", className)}
      {...props}
      onEscapeKeyDown={onEscapeKeyDown}
    />
  );
});

const Popover = {
  Anchor: PopoverPrimitive.Anchor,
  Close: PopoverPrimitive.Close,
  Content: PopoverContent,
  Portal: PopoverPortal,
  Root: PopoverPrimitive.Root,
  Trigger: PopoverPrimitive.Trigger,
};

export { Popover, PopoverContent, PopoverPortal };

export type PopoverAnchorProps = React.ComponentPropsWithRef<
  typeof PopoverPrimitive.Anchor
>;
export type PopoverCloseProps = React.ComponentPropsWithRef<
  typeof PopoverPrimitive.Close
>;
export type PopoverContentProps = React.ComponentPropsWithRef<
  typeof PopoverContent
>;
export type PopoverPortalProps = React.ComponentPropsWithRef<
  typeof PopoverPortal
>;
export type PopoverRootProps = React.ComponentPropsWithRef<
  typeof PopoverPrimitive.Root
>;
export type PopoverTriggerProps = React.ComponentPropsWithRef<
  typeof PopoverPrimitive.Trigger
>;
