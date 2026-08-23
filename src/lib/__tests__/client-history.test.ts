import type * as ReactModule from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("client history URL helpers", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    (document.body as any).append(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/start?tab=one#top");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("replaces the current URL without navigating and dispatches a URL state change event", () => {
    const listener = vi.fn();
    window.addEventListener("insightflare:url-state-change", listener);

    replaceUrlWithoutNavigation("/next?tab=two#section");

    expect(window.location.pathname).toBe("/next");
    expect(window.location.search).toBe("?tab=two");
    expect(window.location.hash).toBe("#section");
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("insightflare:url-state-change", listener);
  });

  it("pushes the current URL without navigating and dispatches a URL state change event", () => {
    const listener = vi.fn();
    window.addEventListener("insightflare:url-state-change", listener);

    pushUrlWithoutNavigation("relative/path?q=1");

    expect(window.location.pathname).toBe("/relative/path");
    expect(window.location.search).toBe("?q=1");
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("insightflare:url-state-change", listener);
  });

  it("does not dispatch when the target URL matches the current location", () => {
    const listener = vi.fn();
    window.addEventListener("insightflare:url-state-change", listener);

    replaceUrlWithoutNavigation("/start?tab=one#top");
    pushUrlWithoutNavigation("/start?tab=one#top");

    expect(listener).not.toHaveBeenCalled();

    window.removeEventListener("insightflare:url-state-change", listener);
  });

  it("no-ops URL helpers when window is unavailable", () => {
    vi.stubGlobal("window", undefined);

    expect(() => replaceUrlWithoutNavigation("/server")).not.toThrow();
    expect(() => pushUrlWithoutNavigation("/server")).not.toThrow();
  });

  it("returns empty search params during server rendering", () => {
    vi.stubGlobal("window", undefined);

    function Probe() {
      const params = useLiveSearchParams();
      return createElement(
        "span",
        null,
        `${params.get("tab") || ""}:${params.get("page") || ""}`,
      );
    }

    expect(renderToString(createElement(Probe))).toBe("<span>:</span>");
  });

  it("uses empty client snapshots and no-op subscriptions without window", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);

    const unsubscribe = vi.fn();
    const useSyncExternalStore = vi.fn(
      (
        subscribe: (onStoreChange: () => void) => () => void,
        getSnapshot: () => string,
      ) => {
        unsubscribe.mockImplementation(subscribe(vi.fn()));
        return getSnapshot();
      },
    );

    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof ReactModule>("react");
      return {
        ...actual,
        useSyncExternalStore,
      };
    });

    const { useLiveSearchParams: useWindowlessLiveSearchParams } =
      await import("@/lib/client-history");

    function Probe() {
      const params = useWindowlessLiveSearchParams();
      return createElement("span", null, params.toString());
    }

    expect(renderToString(createElement(Probe))).toBe("<span></span>");
    expect(useSyncExternalStore).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toThrow();

    vi.doUnmock("react");
    vi.resetModules();
  });

  it("keeps useLiveSearchParams synced with history helper changes and popstate", () => {
    function Probe() {
      const params = useLiveSearchParams();
      return createElement(
        "span",
        null,
        `${params.get("tab") || ""}:${params.get("page") || ""}`,
      );
    }

    act(() => {
      root.render(createElement(Probe));
    });

    expect(container.textContent).toBe("one:");

    act(() => {
      pushUrlWithoutNavigation("/start?tab=two&page=3#top");
    });

    expect(container.textContent).toBe("two:3");

    act(() => {
      window.history.replaceState(null, "", "/start?tab=three");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(container.textContent).toBe("three:");
  });

  it("shares one pair of global listeners across live search subscribers", () => {
    function Probe() {
      useLiveSearchParams();
      return null;
    }

    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");

    act(() => {
      root.render(
        createElement("div", null, createElement(Probe), createElement(Probe)),
      );
    });

    expect(
      addEventListener.mock.calls.filter((call) => {
        const type = String(call[0]);
        return type === "popstate" || type === "insightflare:url-state-change";
      }),
    ).toHaveLength(2);

    act(() => {
      root.render(null);
    });

    expect(
      removeEventListener.mock.calls.filter((call) => {
        const type = String(call[0]);
        return type === "popstate" || type === "insightflare:url-state-change";
      }),
    ).toHaveLength(2);
  });
});
