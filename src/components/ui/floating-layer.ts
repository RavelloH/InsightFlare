export const FLOATING_LAYER_Z_ATTR = "data-dashboard-floating-layer-z";

export const DETAIL_DRAWER_Z_INDEX = 96;
export const DETAIL_DRAWER_Z_INDEX_STEP = 4;
export const MODAL_LAYER_Z_INDEX = 50;
export const MODAL_LAYER_Z_INDEX_STEP = 2;
export const EVENT_FILTER_DIALOG_Z_INDEX = 1000;
export const EVENT_RECORD_DRAWER_Z_INDEX = 1100;
export const NESTED_DETAIL_DRAWER_Z_INDEX = 1200;

export const FLOATING_LAYER_Z_INDEX = {
  detailDrawer: DETAIL_DRAWER_Z_INDEX,
  eventFilterDialog: EVENT_FILTER_DIALOG_Z_INDEX,
  eventRecordDrawer: EVENT_RECORD_DRAWER_Z_INDEX,
  modal: MODAL_LAYER_Z_INDEX,
  nestedDetailDrawer: NESTED_DETAIL_DRAWER_Z_INDEX,
} as const;

export function overlayZIndexFor(contentZIndex: number) {
  return Math.max(0, contentZIndex - 1);
}

interface RegisteredLayer {
  id: string;
  baseZIndex: number;
  order: number;
}

export interface FloatingLayer {
  id: string;
  baseZIndex: number;
  effectiveZIndex: number;
  order: number;
}

let nextLayerOrder = 0;

function createLayerStore(step: number) {
  let snapshot: FloatingLayer[] = [];
  const layers = new Map<string, RegisteredLayer>();
  const subscribers = new Set<() => void>();

  const emitChange = () => {
    const rankByBaseZIndex = new Map<number, number>();
    snapshot = Array.from(layers.values())
      .sort(
        (left, right) =>
          left.baseZIndex - right.baseZIndex || left.order - right.order,
      )
      .map((layer) => {
        const rank = rankByBaseZIndex.get(layer.baseZIndex) ?? 0;
        rankByBaseZIndex.set(layer.baseZIndex, rank + 1);

        return {
          ...layer,
          effectiveZIndex: layer.baseZIndex + rank * step,
        };
      });

    subscribers.forEach((subscriber) => subscriber());
  };

  return {
    getSnapshot() {
      return snapshot;
    },
    removeLayer(id: string) {
      if (!layers.delete(id)) return;
      emitChange();
    },
    setLayer(id: string, baseZIndex: number) {
      const existing = layers.get(id);
      if (existing?.baseZIndex === baseZIndex) return;

      layers.set(id, {
        id,
        baseZIndex,
        order: existing?.order ?? ++nextLayerOrder,
      });
      emitChange();
    },
    subscribe(onStoreChange: () => void) {
      subscribers.add(onStoreChange);
      return () => {
        subscribers.delete(onStoreChange);
      };
    },
  };
}

const detailDrawerLayerStore = createLayerStore(DETAIL_DRAWER_Z_INDEX_STEP);
const modalLayerStore = createLayerStore(MODAL_LAYER_Z_INDEX_STEP);

export type DetailDrawerLayer = FloatingLayer;
export type ModalLayer = FloatingLayer;

export function setDetailDrawerLayer(id: string, baseZIndex: number) {
  detailDrawerLayerStore.setLayer(id, baseZIndex);
}

export function removeDetailDrawerLayer(id: string) {
  detailDrawerLayerStore.removeLayer(id);
}

export function subscribeDetailDrawerLayers(onStoreChange: () => void) {
  return detailDrawerLayerStore.subscribe(onStoreChange);
}

export function getDetailDrawerLayerSnapshot() {
  return detailDrawerLayerStore.getSnapshot();
}

export function setModalLayer(id: string, baseZIndex: number) {
  modalLayerStore.setLayer(id, baseZIndex);
}

export function removeModalLayer(id: string) {
  modalLayerStore.removeLayer(id);
}

export function subscribeModalLayers(onStoreChange: () => void) {
  return modalLayerStore.subscribe(onStoreChange);
}

export function getModalLayerSnapshot() {
  return modalLayerStore.getSnapshot();
}

export function getTopFloatingLayerZIndex() {
  if (typeof document === "undefined") return Number.NEGATIVE_INFINITY;

  return Array.from(
    document.querySelectorAll(`[${FLOATING_LAYER_Z_ATTR}]`),
  ).reduce((topZIndex, element) => {
    const zIndex = Number(element.getAttribute(FLOATING_LAYER_Z_ATTR));
    if (!Number.isFinite(zIndex)) return topZIndex;
    return Math.max(topZIndex, zIndex);
  }, Number.NEGATIVE_INFINITY);
}

export function getFloatingLayerZIndexAbove(
  fallbackZIndex = MODAL_LAYER_Z_INDEX,
) {
  const topZIndex = getTopFloatingLayerZIndex();
  if (!Number.isFinite(topZIndex)) return fallbackZIndex;
  return Math.max(fallbackZIndex, topZIndex + 1);
}

export function hasHigherFloatingLayer(currentZIndex: number) {
  return getTopFloatingLayerZIndex() > currentZIndex;
}
