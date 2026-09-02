import { act, createElement, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DashboardQueryProvider,
  useDashboardQuery,
} from "@/components/dashboard/dashboard-query-provider";
import { TimeZoneProvider } from "@/components/time-zone-provider";

function Probe() {
  const { filters, scopePreference } = useDashboardQuery();
  return createElement(
    "span",
    null,
    `${filters.root ? "filtered" : "empty"}:${scopePreference}`,
  );
}

function App({ children }: { children: ReactNode }) {
  return (
    <TimeZoneProvider>
      <DashboardQueryProvider initialScopePreference="visitor">
        {children}
      </DashboardQueryProvider>
    </TimeZoneProvider>
  );
}

function ScopeApp({ scopeKey }: { scopeKey: string }) {
  return (
    <TimeZoneProvider>
      <DashboardQueryProvider scopeKey={scopeKey}>
        <Probe />
      </DashboardQueryProvider>
    </TimeZoneProvider>
  );
}

describe("DashboardQueryProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.history.replaceState(
      null,
      "",
      "/zh/app/team/site/pages?scope=visitor&filter%5Bpage.path%5D=%2Fdocs",
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
  });

  it("hydrates the initial filter document from the browser URL", async () => {
    container.innerHTML = renderToString(createElement(App, null, <Probe />));

    await act(async () => {
      root = hydrateRoot(container, createElement(App, null, <Probe />));
      await Promise.resolve();
    });

    expect(container.textContent).toBe("filtered:visitor");
  });

  it("keeps URL filters when the initial site scope resolves", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(ScopeApp, { scopeKey: "" }));
      await Promise.resolve();
    });
    expect(container.textContent).toBe("filtered:visitor");

    await act(async () => {
      root.render(createElement(ScopeApp, { scopeKey: "site-id" }));
      await Promise.resolve();
    });

    expect(container.textContent).toBe("filtered:visitor");
  });
});
