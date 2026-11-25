import { act, createElement, type ReactNode, useEffect } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DashboardQueryProvider,
  useDashboardQuery,
  useDashboardQueryControls,
  useDashboardQueryReady,
  useDashboardScopePreference,
  useDashboardTimeQuery,
  useDashboardTimeWindow,
  useDashboardTimeZone,
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

  it("isolates editable DSL and filters from unrelated read-only subscribers", async () => {
    const counts = {
      query: 0,
      window: 0,
      zone: 0,
      ready: 0,
      time: 0,
      scope: 0,
      controls: 0,
    };
    let controls!: ReturnType<typeof useDashboardQueryControls>;
    let query!: ReturnType<typeof useDashboardQuery>;
    function QueryProbe() {
      query = useDashboardQuery();
      counts.query++;
      return null;
    }
    function TimeProbe() {
      useDashboardTimeQuery();
      counts.time++;
      return null;
    }
    function WindowOnly() {
      useDashboardTimeWindow();
      counts.window++;
      return null;
    }
    function ZoneOnly() {
      useDashboardTimeZone();
      counts.zone++;
      return null;
    }
    function ReadyOnly() {
      useDashboardQueryReady();
      counts.ready++;
      return null;
    }
    function ScopeOnly() {
      useDashboardScopePreference();
      counts.scope++;
      return null;
    }
    function Controls() {
      controls = useDashboardQueryControls();
      counts.controls++;
      return null;
    }
    await act(async () => {
      root = createRoot(container);
      root.render(
        <App>
          <QueryProbe />
          <TimeProbe />
          <WindowOnly />
          <ZoneOnly />
          <ReadyOnly />
          <ScopeOnly />
          <Controls />
        </App>,
      );
    });
    expect(query.filters.root).toBeTruthy();
    const initial = { ...counts };
    const firstQuery = query;
    await act(async () =>
      controls.setUiFilters(controls.uiFilters, "page.path = /docs"),
    );
    expect(controls.uiFilterDsl).toBe("page.path = /docs");
    expect(query).toBe(firstQuery);
    expect(counts).toEqual({ ...initial, controls: initial.controls + 1 });
    const afterDsl = { ...counts };
    await act(async () => controls.clearUiFilters());
    expect(query.filters.root).toBeFalsy();
    expect(counts.query).toBeGreaterThan(afterDsl.query);
    expect(counts.window).toBe(afterDsl.window);
    expect(counts.time).toBe(afterDsl.time);
    expect(counts.ready).toBe(afterDsl.ready);
    expect(counts.zone).toBe(afterDsl.zone);
    const afterClear = { ...counts };
    const nextRange = query.range === "30d" ? "7d" : "30d";
    await act(async () => controls.setRange(nextRange));
    expect(query.range).toBe(nextRange);
    expect(counts.window).toBeGreaterThan(afterClear.window);
    expect(counts.time).toBeGreaterThan(afterClear.time);
    expect(counts.zone).toBe(afterClear.zone);
    expect(counts.ready).toBe(afterClear.ready);
    expect(counts.scope).toBe(afterClear.scope);
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

  it("does not enable a request with a stale SSR time zone", async () => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const staleZone = browserZone === "Asia/Tokyo" ? "UTC" : "Asia/Tokyo";
    const initialWindow = resolveTimeWindow("7d", Date.UTC(2026, 10, 25), {
      timeZone: staleZone,
    });
    const requested: string[] = [];
    function ReadyProbe() {
      const { window, queryReady } = useDashboardQuery();
      useEffect(() => {
        if (queryReady) requested.push(window.timeZone);
      }, [queryReady, window.timeZone]);
      return <span>{window.timeZone}</span>;
    }
    const app = (
      <TimeZoneProvider>
        <DashboardQueryProvider initialWindow={initialWindow}>
          <ReadyProbe />
        </DashboardQueryProvider>
      </TimeZoneProvider>
    );
    container.innerHTML = renderToString(app);
    await act(async () => {
      root = hydrateRoot(container, app);
    });
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((zone) => zone !== staleZone)).toBe(true);
    expect(requested.at(-1)).toBe(browserZone);
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
