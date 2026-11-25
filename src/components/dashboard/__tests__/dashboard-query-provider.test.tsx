import { act, createElement, type ReactNode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DashboardQueryProvider,
  useDashboardQuery,
} from "@/components/dashboard/shell/dashboard-query-provider";
import { TimeZoneProvider } from "@/components/time-zone-provider";
import {
  resolveTimeWindow,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
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
function WindowProbe() {
  const { window } = useDashboardQuery();
  return <span>{window.to}</span>;
}
function WindowApp({ initialWindow }: { initialWindow: TimeWindow }) {
  return (
    <TimeZoneProvider>
      <DashboardQueryProvider initialWindow={initialWindow}>
        <WindowProbe />
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

  it("reuses the updated server window on a later route without remounting the provider", async () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const first = resolveTimeWindow("7d", Date.UTC(2026, 10, 25, 0), {
      timeZone,
    });
    const second = resolveTimeWindow("7d", Date.UTC(2026, 10, 25, 1), {
      timeZone,
      interval: first.interval,
    });
    expect(first.to).not.toBe(second.to);
    await act(async () => {
      root = createRoot(container);
      root.render(<WindowApp initialWindow={first} />);
    });
    expect(container.textContent).toBe(String(first.to));
    await act(async () => root.render(<WindowApp initialWindow={second} />));
    expect(container.textContent).toBe(String(second.to));
  });

  it("hydrates the initial filter document from the browser URL", async () => {
    container.innerHTML = renderToString(createElement(App, null, <Probe />));

    await act(async () => {
      root = hydrateRoot(container, createElement(App, null, <Probe />));
      await Promise.resolve();
    });

    expect(container.textContent).toBe("filtered:visitor");
  });

  it("clears a scope-only URL and falls back to Auto", async () => {
    window.history.replaceState(
      null,
      "",
      "/zh/app/team/site/pages?scope=visitor",
    );

    await act(async () => {
      root = createRoot(container);
      root.render(createElement(ScopeApp, { scopeKey: "site-id" }));
      await Promise.resolve();
    });

    expect(window.location.search).toBe("");
    expect(container.textContent).toBe("empty:auto");
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
