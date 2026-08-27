import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, type HTMLMotionProps, motion } from "motion/react";

import {
  FLOATING_LAYER_Z_ATTR,
  getModalLayerSnapshot,
  MODAL_LAYER_Z_INDEX,
  removeModalLayer,
  setModalLayer,
  subscribeModalLayers,
} from "@/components/ui/floating-layer";
import { cn } from "@/lib/utils";

export { overlayZIndexFor } from "@/components/ui/floating-layer";

export const APP_OVERLAY_FADE_MS = 100;

interface ControllableOpenProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface AppOverlayRootState {
  layerId: string;
  modal: boolean;
  open: boolean;
}

interface AppOverlayProps extends React.ComponentPropsWithoutRef<"div"> {
  layerId: string;
  open: boolean;
  portal?: boolean;
  zIndex?: number;
}

interface OverlayLayerOptions {
  baseZIndex?: number;
  enabled?: boolean;
  layerId: string;
  open: boolean;
}

export function parseZIndex(value: React.CSSProperties["zIndex"]) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function useControllableOpen({
  defaultOpen = false,
  onOpenChange,
  open,
}: ControllableOpenProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const currentOpen = isControlled ? open : uncontrolledOpen;

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  return [currentOpen, handleOpenChange] as const;
}

export function useOverlayLayerId(prefix: string) {
  const reactId = React.useId();
  return `${prefix}-${reactId}`;
}

export function useOverlayLayerZIndex({
  baseZIndex = MODAL_LAYER_Z_INDEX,
  enabled = true,
  layerId,
  open,
}: OverlayLayerOptions) {
  const shouldRegister = enabled && open;

  React.useEffect(() => {
    if (!shouldRegister) return;

    setModalLayer(layerId, baseZIndex);
    return () => {
      removeModalLayer(layerId);
    };
  }, [baseZIndex, layerId, shouldRegister]);

  const modalLayers = React.useSyncExternalStore(
    subscribeModalLayers,
    getModalLayerSnapshot,
    getModalLayerSnapshot,
  );

  if (!enabled) return baseZIndex;
  return (
    modalLayers.find((layer) => layer.id === layerId)?.effectiveZIndex ??
    baseZIndex
  );
}

export function AppOverlay({
  className,
  layerId,
  open,
  portal = false,
  style,
  zIndex,
  ...props
}: AppOverlayProps) {
  const floatingLayerZIndex =
    zIndex ?? parseZIndex(style?.zIndex) ?? MODAL_LAYER_Z_INDEX;
  const motionProps = props as HTMLMotionProps<"div">;

  const overlay = (
    <AnimatePresence>
      {open ? (
        <motion.div
          {...motionProps}
          key={`${layerId}-overlay`}
          aria-hidden="true"
          data-slot="app-overlay"
          data-dashboard-floating-layer={`${layerId}-overlay`}
          {...{ [FLOATING_LAYER_Z_ATTR]: floatingLayerZIndex }}
          className={cn(
            "pointer-events-auto fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs",
            className,
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{
            duration: APP_OVERLAY_FADE_MS / 1000,
            ease: "easeOut",
          }}
          style={{ ...style, zIndex: floatingLayerZIndex }}
        />
      ) : null}
    </AnimatePresence>
  );

  if (!portal) return overlay;
  if (typeof document === "undefined") return null;

  return createPortal(overlay, document.body);
}
