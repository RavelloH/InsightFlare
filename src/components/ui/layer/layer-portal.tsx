import * as React from "react";
import { createPortal } from "react-dom";

import {
  useCurrentOverlayFrame,
  useLayerManager,
} from "@/components/ui/layer/layer-context";
import { resolveLayerHost } from "@/components/ui/layer/layer-manager";
import type { LayerPortalSlot } from "@/components/ui/layer/layer-types";

export function LayerPortal({
  children,
  slot = "floating",
}: {
  children: React.ReactNode;
  slot?: LayerPortalSlot;
}) {
  const manager = useLayerManager();
  const frame = useCurrentOverlayFrame();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useSyncExternalStore(
    manager.subscribe,
    manager.getEnvironmentSnapshot,
    manager.getEnvironmentSnapshot,
  );
  const host = resolveLayerHost(manager, frame, slot);

  if (!mounted || !host) return null;
  return createPortal(children, host);
}
