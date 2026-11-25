import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuTrigger,
} from "@insightflare/ui/responsive-dropdown-menu";
import {
  ResponsiveSearchablePopover,
  ResponsiveSearchablePopoverContent,
  ResponsiveSearchablePopoverTrigger,
} from "@insightflare/ui/responsive-searchable-popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@insightflare/ui/sheet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom cannot cancel native animations; use the same fallback as other UI tests.
vi.hoisted(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});

let container: HTMLDivElement;
let root: Root;

async function render(width: number, element: ReactNode) {
  vi.stubGlobal("innerWidth", width);
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  await act(async () => {
    root.render(<LayerManagerProvider>{element}</LayerManagerProvider>);
  });
}

describe("responsive overlay controls", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it.each([375, 1200])(
    "uses the appropriate menu trigger at width %i",
    async (width) => {
      await render(
        width,
        <ResponsiveDropdownMenu>
          <ResponsiveDropdownMenuTrigger>Menu</ResponsiveDropdownMenuTrigger>
          <ResponsiveDropdownMenuContent title="Menu">
            <ResponsiveDropdownMenuItem>Action</ResponsiveDropdownMenuItem>
          </ResponsiveDropdownMenuContent>
        </ResponsiveDropdownMenu>,
      );
      expect(
        container.querySelector(
          width < 768
            ? '[data-slot="drawer-trigger"]'
            : '[data-slot="dropdown-menu-trigger"]',
        ),
      ).not.toBeNull();
    },
  );

  it("renders a mobile radio menu in the overlay and closes after selection", async () => {
    const change = vi.fn();
    const close = vi.fn();
    await render(
      375,
      <ResponsiveDropdownMenu open onOpenChange={close}>
        <ResponsiveDropdownMenuTrigger>Theme</ResponsiveDropdownMenuTrigger>
        <ResponsiveDropdownMenuContent title="Theme">
          <ResponsiveDropdownMenuRadioGroup
            value="light"
            onValueChange={change}
          >
            <ResponsiveDropdownMenuRadioItem value="light">
              Light
            </ResponsiveDropdownMenuRadioItem>
            <ResponsiveDropdownMenuRadioItem value="dark">
              Dark
            </ResponsiveDropdownMenuRadioItem>
          </ResponsiveDropdownMenuRadioGroup>
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>,
    );
    const drawer = document.querySelector('[data-slot="drawer-content"]');
    expect(drawer).not.toBeNull();
    const options =
      drawer?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(options?.[0]?.getAttribute("aria-checked")).toBe("true");
    await act(async () => options?.[1]?.click());
    expect(change).toHaveBeenCalledWith("dark");
    expect(close).toHaveBeenCalledWith(false);
  });

  it("keeps a prevented mobile action open", async () => {
    const close = vi.fn();
    const action = vi.fn((event: Event) => event.preventDefault());
    await render(
      375,
      <ResponsiveDropdownMenu open onOpenChange={close}>
        <ResponsiveDropdownMenuTrigger>Account</ResponsiveDropdownMenuTrigger>
        <ResponsiveDropdownMenuContent title="Account">
          <ResponsiveDropdownMenuItem onSelect={action}>
            Sign out
          </ResponsiveDropdownMenuItem>
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>,
    );
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-slot="drawer-content"] button',
      ),
    ).find((item) => item.textContent === "Sign out");
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(action).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("closes a nested mobile menu without dismissing the sidebar sheet", async () => {
    const closeSidebar = vi.fn();
    const closeMenu = vi.fn();
    await render(
      375,
      <Sheet open onOpenChange={closeSidebar}>
        <SheetContent side="left">
          <SheetTitle>Sidebar</SheetTitle>
          <SheetDescription>Navigation</SheetDescription>
          <ResponsiveDropdownMenu defaultOpen onOpenChange={closeMenu}>
            <ResponsiveDropdownMenuTrigger>
              Appearance
            </ResponsiveDropdownMenuTrigger>
            <ResponsiveDropdownMenuContent title="Appearance">
              <ResponsiveDropdownMenuItem>Apply</ResponsiveDropdownMenuItem>
            </ResponsiveDropdownMenuContent>
          </ResponsiveDropdownMenu>
        </SheetContent>
      </Sheet>,
    );
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-slot="drawer-content"] button',
      ),
    ).find((item) => item.textContent === "Apply");
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(closeMenu).toHaveBeenCalledWith(false);
    expect(closeSidebar).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-slot="sheet-content"]'),
    ).not.toBeNull();
  });

  it("keeps keyboard focus inside a search drawer opened from a sidebar", async () => {
    await render(
      375,
      <Sheet open>
        <SheetContent side="left">
          <SheetTitle>Sidebar</SheetTitle>
          <SheetDescription>Navigation</SheetDescription>
          <ResponsiveSearchablePopover>
            <ResponsiveSearchablePopoverTrigger>
              Search
            </ResponsiveSearchablePopoverTrigger>
            <ResponsiveSearchablePopoverContent searchPlaceholder="Find field">
              <button type="button">Field</button>
            </ResponsiveSearchablePopoverContent>
          </ResponsiveSearchablePopover>
        </SheetContent>
      </Sheet>,
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-slot="drawer-trigger"]',
    )!;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    const input = document.querySelector<HTMLInputElement>(
      '[data-slot="drawer-content"] input',
    )!;
    expect(input).not.toBeNull();
    await act(async () => input.focus());
    expect(document.activeElement).toBe(input);
  });

  it("places responsive search inside a drawer on mobile", async () => {
    await render(
      375,
      <ResponsiveSearchablePopover open>
        <ResponsiveSearchablePopoverTrigger>
          Choose field
        </ResponsiveSearchablePopoverTrigger>
        <ResponsiveSearchablePopoverContent searchPlaceholder="Find field">
          <button type="button">Field</button>
        </ResponsiveSearchablePopoverContent>
      </ResponsiveSearchablePopover>,
    );
    const drawer = document.querySelector('[data-slot="drawer-content"]');
    expect(
      drawer?.querySelector('input[placeholder="Find field"]'),
    ).not.toBeNull();
  });

  it("renders the opt-in select in a mobile drawer", async () => {
    const change = vi.fn();
    await render(
      375,
      <Select responsive open value="one" onValueChange={change}>
        <SelectTrigger aria-label="Teams">
          <SelectValue />
        </SelectTrigger>
        <SelectContent drawerTitle="Teams">
          <SelectItem value="one">One</SelectItem>
          <SelectItem value="two">Two</SelectItem>
        </SelectContent>
      </Select>,
    );
    const drawer = document.querySelector('[data-slot="drawer-content"]');
    const options = drawer?.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options?.[0]?.getAttribute("aria-selected")).toBe("true");
    await act(async () => options?.[1]?.click());
    expect(change).toHaveBeenCalledWith("two");
  });
});
