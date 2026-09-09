import { afterEach, describe, expect, it } from "vitest";

import { LayerManager } from "@/components/ui/layer/layer-manager";

afterEach(() => {
  document.body.replaceChildren();
});

function createManager() {
  const overlayRoot = document.createElement("div");
  const pageFloatingHost = document.createElement("div");
  const systemHost = document.createElement("div");
  document.body.appendChild(overlayRoot);
  document.body.appendChild(pageFloatingHost);
  document.body.appendChild(systemHost);
  const manager = new LayerManager();
  manager.setRoots({ overlayRoot, pageFloatingHost, systemHost });
  return { manager, overlayRoot };
}

describe("LayerManager", () => {
  it("keeps frame DOM order equal to registration order", () => {
    const { manager, overlayRoot } = createManager();
    const a = manager.registerFrame({
      id: "a",
      kind: "drawer",
      parentFrameId: null,
    });
    const b = manager.registerFrame({
      id: "b",
      kind: "dialog",
      parentFrameId: "a",
    });
    const c = manager.registerFrame({
      id: "c",
      kind: "detail-drawer",
      parentFrameId: "b",
    });

    expect(
      Array.from(overlayRoot.querySelectorAll("[data-layer-frame]")).map(
        (element) => element.getAttribute("data-layer-frame-id"),
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      manager.getFrameRecords().map((record) => record.parentFrameId),
    ).toEqual([null, "a", "b"]);
    expect(a?.frameElement.style.zIndex).toBe("0");
    expect(b?.frameElement.style.zIndex).toBe("0");
    expect(c?.frameElement.style.zIndex).toBe("0");
  });

  it("keeps a closing frame until it is explicitly unregistered", () => {
    const { manager, overlayRoot } = createManager();
    manager.registerFrame({ id: "a", kind: "drawer", parentFrameId: null });
    manager.registerFrame({ id: "b", kind: "dialog", parentFrameId: "a" });

    manager.updateFrameState("b", "closing");
    expect(manager.getFrameRecords().map((record) => record.id)).toEqual([
      "a",
      "b",
    ]);
    expect(
      overlayRoot
        .querySelector('[data-layer-frame-id="b"]')
        ?.getAttribute("data-layer-frame-state"),
    ).toBe("closing");

    manager.unregisterFrame("b");
    expect(manager.getFrameRecords().map((record) => record.id)).toEqual(["a"]);
  });

  it("supports unlimited frame depth and arbitrary removal", () => {
    const { manager } = createManager();
    for (let index = 0; index < 50; index += 1) {
      manager.registerFrame({
        id: `frame-${index}`,
        kind: "detail-drawer",
        parentFrameId: index === 0 ? null : `frame-${index - 1}`,
      });
    }

    expect(manager.getFrameRecords()).toHaveLength(50);
    expect(manager.getFrameRecords().at(-1)?.id).toBe("frame-49");
    manager.unregisterFrame("frame-17");
    expect(manager.getFrameRecords()).toHaveLength(49);
    expect(manager.getFrameRecords().at(-1)?.id).toBe("frame-49");
  });
});
