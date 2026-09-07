import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FLOATING_LAYER_Z_ATTR,
  MODAL_LAYER_Z_INDEX,
} from "@/components/ui/floating-layer";
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

  it("keeps the default layer on ordinary pages", () => {
    act(() => root.render(<SelectFixture />));

    expect(selectContent()?.style.zIndex).toBe(String(MODAL_LAYER_Z_INDEX));
  });

  it("places content above nested modal and drawer layers", () => {
    const outerLayer = document.createElement("div");
    outerLayer.setAttribute(FLOATING_LAYER_Z_ATTR, "50");
    const nestedLayer = document.createElement("div");
    nestedLayer.setAttribute(FLOATING_LAYER_Z_ATTR, "1200");
    document.body.appendChild(outerLayer);
    document.body.appendChild(nestedLayer);

    act(() => root.render(<SelectFixture />));

    expect(selectContent()?.style.zIndex).toBe("1201");
  });

  it("tracks a floating layer added while the menu is open", async () => {
    act(() => root.render(<SelectFixture />));
    expect(selectContent()?.style.zIndex).toBe(String(MODAL_LAYER_Z_INDEX));

    const nestedLayer = document.createElement("div");
    nestedLayer.setAttribute(FLOATING_LAYER_Z_ATTR, "1200");
    document.body.appendChild(nestedLayer);

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(selectContent()?.style.zIndex).toBe("1201");
  });
});
