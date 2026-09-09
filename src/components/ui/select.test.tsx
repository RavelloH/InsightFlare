import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LayerManagerProvider,
  OverlayFrame,
  useOverlayStackState,
} from "@/components/ui/layer/layer-manager";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function SelectFixture() {
  return (
    <Select defaultOpen>
      <SelectTrigger>
        <SelectValue placeholder="Choose a value" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="one">One</SelectItem>
      </SelectContent>
    </Select>
  );
}

function selectContent() {
  return document.querySelector<HTMLElement>('[data-slot="select-content"]');
}

function StackProbe({ id }: { id: string }) {
  const { depth, framesAbove, framesBelow, isTopmost } =
    useOverlayStackState(id);
  return (
    <output
      data-stack-id={id}
      data-depth={depth}
      data-frames-above={framesAbove}
      data-frames-below={framesBelow}
      data-topmost={isTopmost}
    />
  );
}

async function render(element: React.ReactNode) {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
}

describe("Select floating layer", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("resolves ordinary page content to the page floating host", async () => {
    await render(
      <LayerManagerProvider>
        <SelectFixture />
      </LayerManagerProvider>,
    );

    expect(selectContent()?.closest("[data-layer-page-floating-host]")).toBe(
      document.querySelector("[data-layer-page-floating-host]"),
    );
  });

  it("resolves content to the current frame floating host", async () => {
    await render(
      <LayerManagerProvider>
        <OverlayFrame id="frame-a" kind="drawer" open>
          <SelectFixture />
        </OverlayFrame>
      </LayerManagerProvider>,
    );

    const content = selectContent();
    const host = content?.closest<HTMLElement>("[data-layer-host]");
    expect(host?.dataset.layerHost).toBe("floating");
    expect(host?.dataset.layerFrameId).toBe("frame-a");
    expect(content?.style.zIndex).toBe("");
  });

  it("reports stack state from frame order", async () => {
    await render(
      <LayerManagerProvider>
        <OverlayFrame id="frame-a" kind="detail-drawer" open>
          <StackProbe id="frame-a" />
          <OverlayFrame id="frame-b" kind="detail-drawer" open>
            <StackProbe id="frame-b" />
          </OverlayFrame>
        </OverlayFrame>
      </LayerManagerProvider>,
    );

    expect(document.querySelector('[data-stack-id="frame-a"]')).toMatchObject({
      dataset: {
        depth: "0",
        framesAbove: "1",
        framesBelow: "0",
        topmost: "false",
      },
    });
    expect(document.querySelector('[data-stack-id="frame-b"]')).toMatchObject({
      dataset: {
        depth: "1",
        framesAbove: "0",
        framesBelow: "1",
        topmost: "true",
      },
    });
  });
});
