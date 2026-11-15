import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AppOverlayModule from "@/components/ui/app-overlay";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { LayerManagerProvider } from "@/components/ui/layer/layer-manager";
import { Popover } from "@/components/ui/popover";

// Animation timing does not participate in modal accessibility ownership.
vi.mock("@/components/ui/app-overlay", async (importOriginal) => {
  const actual = await importOriginal<typeof AppOverlayModule>();
  return { ...actual, AppOverlay: () => null };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function FieldPicker({ name = "" }: { name?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger>{name}Choose field</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content>
          <input aria-label={`${name}Search fields`} />
          <button type="button">{name}Page path</button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Fixture({ open }: { open: boolean }) {
  return (
    <LayerManagerProvider>
      <button type="button" data-background="">
        Background action
      </button>
      <Drawer open={open}>
        <DrawerContent>
          <DrawerTitle>Filter</DrawerTitle>
          <DrawerDescription>Choose a filter field.</DrawerDescription>
          <FieldPicker />
        </DrawerContent>
      </Drawer>
    </LayerManagerProvider>
  );
}

async function render(element: React.ReactNode) {
  await act(async () => root.render(element));
}

function inaccessible(element: Element | null) {
  return Boolean(element?.closest('[aria-hidden="true"], [inert]'));
}

describe("Drawer floating content accessibility", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it("exposes an opened field picker while the modal still hides the background", async () => {
    await render(<Fixture open />);
    const trigger = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Choose field",
    );
    expect(trigger).toBeDefined();
    await act(async () => trigger!.click());

    const search = document.querySelector('input[aria-label="Search fields"]');
    const field = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Page path",
    );
    expect(search).not.toBeNull();
    expect(field).toBeDefined();
    expect(inaccessible(search)).toBe(false);
    expect(inaccessible(field ?? null)).toBe(false);
    expect(inaccessible(document.querySelector("[data-background]"))).toBe(
      true,
    );

    await render(<Fixture open={false} />);
    await vi.waitFor(async () => {
      await act(async () => undefined);
      expect(inaccessible(document.querySelector("[data-background]"))).toBe(
        false,
      );
    });
    await render(<Fixture open />);
    expect(inaccessible(document.querySelector("[data-background]"))).toBe(
      true,
    );
    const reopenedTrigger = Array.from(
      document.querySelectorAll("button"),
    ).find((button) => button.textContent === "Choose field");
    await act(async () => reopenedTrigger!.click());
    const reopenedSearch = document.querySelector(
      'input[aria-label="Search fields"]',
    );
    expect(reopenedSearch).not.toBeNull();
    expect(inaccessible(reopenedSearch)).toBe(false);
  });

  it("exposes floating content when reopened before the closing frame is removed", async () => {
    await render(<Fixture open />);
    const frame = document.querySelector("[data-layer-frame]");
    await render(<Fixture open={false} />);
    await render(<Fixture open />);
    expect(document.querySelector("[data-layer-frame]")).toBe(frame);
    const trigger = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Choose field",
    );
    await act(async () => trigger!.click());
    const search = document.querySelector('input[aria-label="Search fields"]');
    expect(search).not.toBeNull();
    expect(inaccessible(search)).toBe(false);
    expect(inaccessible(document.querySelector("[data-background]"))).toBe(
      true,
    );
  });

  it("keeps a lower drawer hidden until the nested drawer closes", async () => {
    function NestedFixture({ nestedOpen }: { nestedOpen: boolean }) {
      return (
        <LayerManagerProvider>
          <button type="button" data-background="">
            Background action
          </button>
          <Drawer open>
            <DrawerContent>
              <DrawerTitle>Outer filter</DrawerTitle>
              <DrawerDescription>Outer filter fields.</DrawerDescription>
              <FieldPicker name="Outer " />
              <Drawer open={nestedOpen}>
                <DrawerContent>
                  <DrawerTitle>Inner filter</DrawerTitle>
                  <DrawerDescription>Inner filter fields.</DrawerDescription>
                  <FieldPicker name="Inner " />
                </DrawerContent>
              </Drawer>
            </DrawerContent>
          </Drawer>
        </LayerManagerProvider>
      );
    }

    await render(<NestedFixture nestedOpen={false} />);
    const outerTrigger = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Outer Choose field",
    );
    await act(async () => outerTrigger!.click());
    const outerSearch = document.querySelector(
      'input[aria-label="Outer Search fields"]',
    );
    expect(outerSearch).not.toBeNull();
    expect(inaccessible(outerSearch)).toBe(false);

    await render(<NestedFixture nestedOpen />);
    const innerTrigger = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Inner Choose field",
    );
    await act(async () => innerTrigger!.click());
    const innerSearch = document.querySelector(
      'input[aria-label="Inner Search fields"]',
    );
    expect(innerSearch).not.toBeNull();
    expect(inaccessible(innerSearch)).toBe(false);
    expect(inaccessible(outerTrigger ?? null)).toBe(true);
    expect(inaccessible(document.querySelector("[data-background]"))).toBe(
      true,
    );

    await render(<NestedFixture nestedOpen={false} />);
    await vi.waitFor(async () => {
      await act(async () => undefined);
      expect(inaccessible(outerTrigger ?? null)).toBe(false);
    });
    expect(inaccessible(document.querySelector("[data-background]"))).toBe(
      true,
    );
  });
});
