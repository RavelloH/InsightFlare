import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as Motion from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof Motion>();

  function MockReorderGroup({
    children,
    values,
    onReorder,
    className,
  }: {
    children: ReactNode;
    values: readonly string[];
    onReorder: (nextOrder: string[]) => void;
    className?: string;
  }) {
    return createElement(
      "div",
      {
        "data-testid": "mock-reorder-group",
        className,
        onDoubleClick: () => onReorder([...values].reverse()),
      },
      children,
    );
  }

  function MockReorderItem({
    children,
    value,
    onDragEnd,
    className,
  }: {
    children: ReactNode;
    value: string;
    onDragEnd: () => void;
    className?: string;
  }) {
    return createElement(
      "div",
      {
        "data-testid": `mock-reorder-item-${value}`,
        className,
        onMouseUp: onDragEnd,
      },
      children,
    );
  }

  return {
    ...actual,
    Reorder: {
      ...actual.Reorder,
      Group: MockReorderGroup,
      Item: MockReorderItem,
    },
    useDragControls: () => ({ start: () => undefined }),
  };
});

import {
  AnalyticsTableColumnSettings,
  useAnalyticsTableColumns,
} from "@/components/dashboard/analytics-table-column-settings";
import { TooltipProvider } from "@/components/ui/tooltip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("useAnalyticsTableColumns", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
  });

  it("does not rehydrate the order when an equivalent column schema gets a new identity", () => {
    const storageKey = "test:analytics-table-columns";
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        order: ["id", "time", "site"],
        visible: ["id", "time", "site"],
      }),
    );

    function Probe({ revision }: { revision: number }) {
      const columns = [
        { id: "id", label: "ID", required: true },
        { id: "time", label: "Time", required: true },
        { id: "site", label: "Site", required: true },
      ] as const;
      const tableColumns = useAnalyticsTableColumns({
        storageKey,
        columns,
      });

      return createElement(
        "div",
        { "data-revision": revision },
        createElement(
          "span",
          { "data-testid": "order" },
          tableColumns.orderedIds.join(","),
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => tableColumns.setOrder(["id", "site", "time"]),
          },
          "move",
        ),
      );
    }

    act(() => root.render(createElement(Probe, { revision: 0 })));
    expect(container.querySelector('[data-testid="order"]')?.textContent).toBe(
      "id,time,site",
    );

    act(() => {
      container
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="order"]')?.textContent).toBe(
      "id,site,time",
    );

    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        order: ["id", "time", "site"],
        visible: ["id", "time", "site"],
      }),
    );
    act(() => root.render(createElement(Probe, { revision: 1 })));

    expect(container.querySelector('[data-testid="order"]')?.textContent).toBe(
      "id,site,time",
    );
  });

  it("updates visibility and resets the hook state", () => {
    const storageKey = "test:analytics-table-columns-actions";

    function Probe() {
      const tableColumns = useAnalyticsTableColumns({
        storageKey,
        columns: [
          { id: "id", label: "ID", required: true },
          { id: "time", label: "Time", required: true },
          { id: "site", label: "Site" },
        ] as const,
      });

      return createElement(
        "div",
        null,
        createElement(
          "span",
          { "data-testid": "visible" },
          tableColumns.visibleIds.join(","),
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => tableColumns.setVisible(["id", "time"]),
          },
          "hide site",
        ),
        createElement(
          "button",
          { type: "button", onClick: tableColumns.reset },
          "reset",
        ),
      );
    }

    act(() => root.render(createElement(Probe)));
    expect(
      container.querySelector('[data-testid="visible"]')?.textContent,
    ).toBe("id,time,site");

    const buttons = container.querySelectorAll("button");
    act(() =>
      buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(
      container.querySelector('[data-testid="visible"]')?.textContent,
    ).toBe("id,time");

    act(() =>
      buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(
      container.querySelector('[data-testid="visible"]')?.textContent,
    ).toBe("id,time,site");
  });

  it("commits column visibility and reordered drafts from the settings dialog", () => {
    const onOrderChange = vi.fn();
    const onVisibilityChange = vi.fn();
    const onReset = vi.fn();
    const columns = [
      { id: "id", label: "ID", required: true },
      { id: "time", label: "Time", required: true },
      { id: "site", label: "Site" },
    ] as const;
    const labels = {
      action: "Columns",
      title: "Table columns",
      description: "Choose the columns to show.",
      visible: "Visible columns",
      required: "Required",
      reset: "Reset",
      dragHint: "Drag column",
      close: "Close",
    };

    act(() =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AnalyticsTableColumnSettings, {
            columns,
            orderedIds: ["id", "time", "site"],
            visibleIds: ["id", "time", "site"],
            onOrderChange,
            onVisibilityChange,
            onReset,
            labels,
          }),
        ),
      ),
    );

    act(() => {
      container
        .querySelector('button[aria-label="Columns"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Visible columns");

    const optionalColumn = document.querySelector(
      '#analytics-table-column-site[data-slot="checkbox"]',
    );
    act(() => {
      optionalColumn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onVisibilityChange).toHaveBeenCalledWith(["id", "time"]);

    const reorderGroup = document.querySelector(
      '[data-testid="mock-reorder-group"]',
    );
    act(() => {
      reorderGroup?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
    });

    const dragHandle = document.querySelector(
      'button[aria-label="Drag column"]',
    );
    act(() => {
      dragHandle?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });

    const firstItem = document.querySelector(
      '[data-testid="mock-reorder-item-site"]',
    );
    act(() => {
      firstItem?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(onOrderChange).toHaveBeenCalledWith(["site", "time", "id"]);

    const resetButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Reset",
    );
    act(() =>
      resetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
