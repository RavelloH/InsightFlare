import * as React from "react";
import { createPortal } from "react-dom";

import {
  LayerManagerContext,
  OverlayFrameContext,
  useLayerManager,
} from "@/components/ui/layer/layer-context";
import type {
  LayerPortalSlot,
  OverlayFrameContextValue,
  OverlayFrameKind,
  OverlayFrameRecord,
  OverlayFrameState,
} from "@/components/ui/layer/layer-types";

const FRAME_EXIT_DURATION_MS = 360;

interface FrameHandle extends OverlayFrameRecord {
  frameElement: HTMLDivElement;
  backdropHost: HTMLDivElement;
  surfaceHost: HTMLDivElement;
  floatingHost: HTMLDivElement;
}

interface LayerManagerRootProps {
  children: React.ReactNode;
}

export interface OverlayFrameProps {
  children: React.ReactNode;
  id?: string;
  kind: OverlayFrameKind;
  open: boolean;
  exitDurationMs?: number;
}

export class LayerManager {
  private overlayRoot: HTMLElement | null = null;
  private pageFloatingHost: HTMLElement | null = null;
  private systemHost: HTMLElement | null = null;
  private order = 0;
  private revision = 0;
  private environmentRevision = 0;
  private records = new Map<string, FrameHandle>();
  private subscribers = new Set<() => void>();

  private notify() {
    this.revision += 1;
    for (const subscriber of this.subscribers) subscriber();
  }

  subscribe = (subscriber: () => void) => {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  };

  getSnapshot = () => this.revision;

  getEnvironmentSnapshot = () => this.environmentRevision;

  setRoots({
    overlayRoot,
    pageFloatingHost,
    systemHost,
  }: {
    overlayRoot: HTMLElement | null;
    pageFloatingHost: HTMLElement | null;
    systemHost: HTMLElement | null;
  }) {
    const changed =
      this.overlayRoot !== overlayRoot ||
      this.pageFloatingHost !== pageFloatingHost ||
      this.systemHost !== systemHost;
    this.overlayRoot = overlayRoot;
    this.pageFloatingHost = pageFloatingHost;
    this.systemHost = systemHost;
    if (changed) {
      this.environmentRevision += 1;
      this.notify();
    }
  }

  getOverlayRoot() {
    return this.overlayRoot;
  }

  getPageFloatingHost() {
    return this.pageFloatingHost;
  }

  getSystemHost() {
    return this.systemHost;
  }

  registerFrame({
    id,
    kind,
    parentFrameId,
    state = "opening",
  }: {
    id: string;
    kind: OverlayFrameKind;
    parentFrameId: string | null;
    state?: OverlayFrameState;
  }): FrameHandle | null {
    if (typeof document === "undefined" || !this.overlayRoot) return null;

    const existing = this.records.get(id);
    if (existing) return existing;

    const frameElement = document.createElement("div");
    frameElement.dataset.layerFrame = "";
    frameElement.dataset.layerFrameId = id;
    frameElement.dataset.layerFrameKind = kind;
    frameElement.dataset.layerFrameParentId = parentFrameId ?? "";
    frameElement.dataset.layerFrameState = state;
    Object.assign(frameElement.style, {
      position: "fixed",
      inset: "0",
      isolation: "isolate",
      zIndex: "0",
    });

    const createHost = (
      slot: "backdrop" | "surface" | "floating",
      zIndex: number,
    ) => {
      const host = document.createElement("div");
      host.dataset.layerHost = slot;
      host.dataset.layerFrameId = id;
      Object.assign(host.style, {
        position: "absolute",
        inset: "0",
        pointerEvents: "none",
        zIndex: String(zIndex),
      });
      frameElement.appendChild(host);
      return host;
    };

    const handle: FrameHandle = {
      id,
      kind,
      parentFrameId,
      order: ++this.order,
      state,
      frameElement,
      backdropHost: createHost("backdrop", 0),
      surfaceHost: createHost("surface", 10),
      floatingHost: createHost("floating", 20),
    };

    this.overlayRoot.appendChild(frameElement);
    this.records.set(id, handle);
    this.notify();
    return handle;
  }

  updateFrameState(id: string, state: OverlayFrameState) {
    const record = this.records.get(id);
    if (!record || record.state === state) return;
    record.state = state;
    record.frameElement.dataset.layerFrameState = state;
    this.notify();
  }

  unregisterFrame(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    record.frameElement.remove();
    this.records.delete(id);
    this.notify();
  }

  getFrameRecords(): OverlayFrameRecord[] {
    return Array.from(this.records.values())
      .sort((left, right) => left.order - right.order)
      .map(({ id, kind, parentFrameId, order, state }) => ({
        id,
        kind,
        parentFrameId,
        order,
        state,
      }));
  }

  getFrame(id: string) {
    return this.records.get(id) ?? null;
  }
}

export function LayerManagerProvider({ children }: LayerManagerRootProps) {
  const managerRef = React.useRef<LayerManager | null>(null);
  if (!managerRef.current) managerRef.current = new LayerManager();
  const manager = managerRef.current;

  const setRoots = React.useCallback(
    (node: HTMLElement | null, slot: "overlay" | "page" | "system") => {
      const current = {
        overlayRoot: manager.getOverlayRoot(),
        pageFloatingHost: manager.getPageFloatingHost(),
        systemHost: manager.getSystemHost(),
      };
      if (slot === "overlay") current.overlayRoot = node;
      if (slot === "page") current.pageFloatingHost = node;
      if (slot === "system") current.systemHost = node;
      manager.setRoots(current);
    },
    [manager],
  );
  const setPageFloatingHost = React.useCallback(
    (node: HTMLElement | null) => setRoots(node, "page"),
    [setRoots],
  );
  const setOverlayRoot = React.useCallback(
    (node: HTMLElement | null) => setRoots(node, "overlay"),
    [setRoots],
  );
  const setSystemHost = React.useCallback(
    (node: HTMLElement | null) => setRoots(node, "system"),
    [setRoots],
  );

  return (
    <LayerManagerContext.Provider value={manager}>
      {children}
      <div
        ref={setPageFloatingHost}
        data-layer-page-floating-host=""
        style={{ position: "relative", zIndex: 40 }}
      />
      <div
        ref={setOverlayRoot}
        data-layer-overlay-root=""
        style={{ isolation: "isolate", position: "relative", zIndex: 100 }}
      />
      <div
        ref={setSystemHost}
        data-layer-system-host=""
        style={{ position: "relative", zIndex: 200 }}
      />
    </LayerManagerContext.Provider>
  );
}

export function OverlayFrame({
  children,
  exitDurationMs = FRAME_EXIT_DURATION_MS,
  id: providedId,
  kind,
  open,
}: OverlayFrameProps) {
  const manager = useLayerManager();
  const parentFrame = React.useContext(OverlayFrameContext);
  const generatedId = React.useId();
  const id = providedId ?? `overlay-frame-${generatedId}`;
  const [rendered, setRendered] = React.useState(open);
  const [frame, setFrame] = React.useState<FrameHandle | null>(null);

  React.useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    if (!rendered) return;

    const timer = window.setTimeout(() => setRendered(false), exitDurationMs);
    return () => window.clearTimeout(timer);
  }, [exitDurationMs, open, rendered]);

  React.useEffect(() => {
    if (!rendered) return;
    const nextFrame = manager.registerFrame({
      id,
      kind,
      parentFrameId: parentFrame?.id ?? null,
      state: "opening",
    });
    if (!nextFrame) return;
    setFrame(nextFrame);
    return () => {
      manager.unregisterFrame(id);
      setFrame(null);
    };
  }, [id, kind, manager, parentFrame?.id, rendered]);

  React.useEffect(() => {
    if (!rendered || !frame) return;
    manager.updateFrameState(id, open ? "open" : "closing");
  }, [frame, id, manager, open, rendered]);

  if (!rendered || !frame) return null;

  const contextValue: OverlayFrameContextValue = {
    id: frame.id,
    parentFrameId: frame.parentFrameId,
    root: frame.frameElement,
    backdropHost: frame.backdropHost,
    surfaceHost: frame.surfaceHost,
    floatingHost: frame.floatingHost,
  };

  return createPortal(
    <OverlayFrameContext.Provider value={contextValue}>
      {children}
    </OverlayFrameContext.Provider>,
    frame.frameElement,
  );
}

export function useOverlayStackState(frameId: string) {
  const manager = useLayerManager();
  const revision = React.useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot,
  );
  const records = React.useMemo(
    () => manager.getFrameRecords(),
    [manager, revision],
  );
  const index = records.findIndex((record) => record.id === frameId);
  const framesAbove = index < 0 ? 0 : records.length - index - 1;
  const framesBelow = index < 0 ? 0 : index;

  return {
    depth: index < 0 ? 0 : index,
    framesAbove,
    framesBelow,
    isTopmost: index >= 0 && framesAbove === 0,
    records,
  };
}

export function resolveLayerHost(
  manager: LayerManager,
  frame: OverlayFrameContextValue | null,
  slot: LayerPortalSlot,
) {
  if (slot === "backdrop") return frame?.backdropHost ?? null;
  if (slot === "surface") return frame?.surfaceHost ?? null;
  if (slot === "floating") {
    return frame?.floatingHost ?? manager.getPageFloatingHost();
  }
  if (slot === "system") return manager.getSystemHost();
  return manager.getPageFloatingHost();
}
