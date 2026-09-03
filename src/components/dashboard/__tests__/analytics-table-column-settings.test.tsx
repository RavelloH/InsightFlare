import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAnalyticsTableColumns } from "@/components/dashboard/analytics-table-column-settings";

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
});
