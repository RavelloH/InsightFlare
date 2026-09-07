import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DETAIL_DRAWER_Z_INDEX,
  DETAIL_DRAWER_Z_INDEX_STEP,
  FLOATING_LAYER_Z_ATTR,
  getDetailDrawerLayerSnapshot,
  getFloatingLayerZIndexAbove,
  getTopFloatingLayerZIndex,
  hasHigherFloatingLayer,
  removeDetailDrawerLayer,
  setDetailDrawerLayer,
  subscribeDetailDrawerLayers,
} from "@/components/dashboard/site-pages/floating-layer";

const TEST_LAYER_IDS = ["drawer-a", "drawer-b", "drawer-c"];

describe("floating layer helpers", () => {
  afterEach(() => {
    TEST_LAYER_IDS.forEach((id) => removeDetailDrawerLayer(id));
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps detail drawer layers ordered and offsets z-index ties", () => {
    const subscriber = vi.fn();
    const unsubscribe = subscribeDetailDrawerLayers(subscriber);

    setDetailDrawerLayer("drawer-a", DETAIL_DRAWER_Z_INDEX);
    setDetailDrawerLayer("drawer-b", DETAIL_DRAWER_Z_INDEX);
    setDetailDrawerLayer("drawer-c", DETAIL_DRAWER_Z_INDEX - 10);

    expect(getDetailDrawerLayerSnapshot()).toEqual([
      {
        id: "drawer-c",
        baseZIndex: DETAIL_DRAWER_Z_INDEX - 10,
        effectiveZIndex: DETAIL_DRAWER_Z_INDEX - 10,
        order: expect.any(Number),
      },
      {
        id: "drawer-a",
        baseZIndex: DETAIL_DRAWER_Z_INDEX,
        effectiveZIndex: DETAIL_DRAWER_Z_INDEX,
        order: expect.any(Number),
      },
      {
        id: "drawer-b",
        baseZIndex: DETAIL_DRAWER_Z_INDEX,
        effectiveZIndex: DETAIL_DRAWER_Z_INDEX + DETAIL_DRAWER_Z_INDEX_STEP,
        order: expect.any(Number),
      },
    ]);
    expect(subscriber).toHaveBeenCalledTimes(3);

    setDetailDrawerLayer("drawer-a", DETAIL_DRAWER_Z_INDEX);
    expect(subscriber).toHaveBeenCalledTimes(3);

    removeDetailDrawerLayer("drawer-a");
    expect(getDetailDrawerLayerSnapshot().map((layer) => layer.id)).toEqual([
      "drawer-c",
      "drawer-b",
    ]);
    expect(subscriber).toHaveBeenCalledTimes(4);

    unsubscribe();
    removeDetailDrawerLayer("drawer-b");
    expect(subscriber).toHaveBeenCalledTimes(4);
  });

  it("returns the highest finite DOM floating layer z-index", () => {
    const low = document.createElement("div");
    low.setAttribute(FLOATING_LAYER_Z_ATTR, "12");
    const invalid = document.createElement("div");
    invalid.setAttribute(FLOATING_LAYER_Z_ATTR, "top");
    const high = document.createElement("div");
    high.setAttribute(FLOATING_LAYER_Z_ATTR, "48");
    (document.body as any).append(low);
    (document.body as any).append(invalid);
    (document.body as any).append(high);

    expect(getTopFloatingLayerZIndex()).toBe(48);
    expect(hasHigherFloatingLayer(47)).toBe(true);
    expect(hasHigherFloatingLayer(48)).toBe(false);
  });

  it("returns negative infinity when no floating layer is registered in the DOM", () => {
    expect(getTopFloatingLayerZIndex()).toBe(Number.NEGATIVE_INFINITY);
    expect(hasHigherFloatingLayer(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("places a floating layer above the current top layer", () => {
    const outer = document.createElement("div");
    outer.setAttribute(FLOATING_LAYER_Z_ATTR, "50");
    const nested = document.createElement("div");
    nested.setAttribute(FLOATING_LAYER_Z_ATTR, "52");
    document.body.appendChild(outer);
    document.body.appendChild(nested);

    expect(getFloatingLayerZIndexAbove()).toBe(53);
    expect(getFloatingLayerZIndexAbove(100)).toBe(100);
  });
});
