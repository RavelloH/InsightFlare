import * as React from "react";

import type { LayerManager } from "@/components/ui/layer/layer-manager";
import type { OverlayFrameContextValue } from "@/components/ui/layer/layer-types";

export const LayerManagerContext = React.createContext<LayerManager | null>(
  null,
);

export const OverlayFrameContext =
  React.createContext<OverlayFrameContextValue | null>(null);

export function useLayerManager(): LayerManager {
  const manager = React.useContext(LayerManagerContext);
  if (!manager) {
    throw new Error(
      "Layer components must be used inside LayerManagerProvider",
    );
  }
  return manager;
}

export function useCurrentOverlayFrame() {
  return React.useContext(OverlayFrameContext);
}
