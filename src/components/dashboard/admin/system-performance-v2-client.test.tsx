import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SystemPerformanceV2Client } from "@/components/dashboard/admin/system-performance-v2-client";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import { systemPerformanceLabels } from "@/lib/system-performance-labels";

vi.mock("@/components/dashboard/shell/dashboard-query-provider", () => ({
  useDashboardQueryControls: () => ({ timeZone: "UTC" }),
}));
vi.mock("@/lib/dashboard-api/client/admin-service", () => ({
  requestAdminService: vi.fn(),
}));
vi.mock("@insightflare/ui/auto-resizer", () => ({
  AutoResizer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@insightflare/ui/auto-transition", () => ({
  AutoTransition: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@insightflare/ui/drawer", () => ({
  Drawer: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-test="perf-drawer" data-open={open ? "true" : "false"}>
      <button onClick={() => onOpenChange(false)}>Close test drawer</button>
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DrawerHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DrawerTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DrawerDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DrawerScrollArea: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock(
  "@/components/dashboard/admin/system-performance/do-diagnostic-v2",
  () => ({
    DoDiagnosticV2Panel: () => <div>DO live stub</div>,
  }),
);

const labels = systemPerformanceLabels("zh");
const mockRequest = vi.mocked(requestAdminService);
const queryId = "analytics.overview.raw.summary";
const route = {
  source: "worker",
  trigger: "request",
  routeKey: "api:/collect",
  appVersion: "1.2.3",
  estimatedInvocations: 9,
  p95: 20,
};
const hotspot = {
  ...route,
  queryId,
  filterShape: "basic.c1.0.0.o0",
  weightedValue: 10,
  estimatedInvocations: 9,
};
const error = {
  ...route,
  code: "d1_query_failed",
  category: "database",
  operation: "d1.all",
  resultClass: "failure",
};
const sample = {
  ...route,
  timestampSeconds: 1790000000,
  sampleInterval: 9,
  invocationWallMs: 12,
  handlerWallMs: 3,
  hotQueryId: queryId,
  details: {
    phases: [{ id: "route.handler", wallMs: 3 }],
    queries: [
      {
        id: queryId,
        variant: "raw.filtered",
        apiWallMs: 4,
        sqlEngineMs: 1,
        rowsRead: 24,
        coverage: {
          api: "complete",
          engine: "complete",
          rowsRead: "partial",
        },
      },
    ],
  },
};
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

function response(params: Record<string, unknown>) {
  if (params.view === "routes")
    return {
      view: "routes",
      status: "ready",
      data: { routes: [route] },
    };
  if (params.view === "hotspots")
    return {
      view: "hotspots",
      status: "ready",
      data: {
        hotspots: {
          scan: [hotspot],
          "api-hot": [hotspot],
          "sql-engine-fallback": [hotspot],
        },
      },
    };
  if (params.view === "errors")
    return {
      view: "errors",
      status: "ready",
      data: { errors: [error] },
    };
  if (params.view === "samples")
    return {
      view: "samples",
      status: "ready",
      data: { samples: [sample] },
    };
  return {
    view: "overview",
    status: "ready",
    data: {
      summary: {
        estimatedInvocations: 9,
        handlerP95Ms: 20,
        retainedSamples: 1,
        weighted: {
          d1RowsRead: {
            value: 24,
            observed: 24,
            coverage: "partial",
            lowerBound: true,
          },
        },
      },
      trend: [],
    },
  };
}
async function mount(search: string) {
  window.history.replaceState(
    null,
    "",
    "/zh/app/manage/system-performance" + search,
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  root = createRoot(host);
  await act(async () => {
    root.render(
      <LayerManagerProvider>
        <QueryClientProvider client={client}>
          <SystemPerformanceV2Client
            locale="zh"
            messages={{ common: { loading: "Loading" } } as never}
          />
        </QueryClientProvider>
      </LayerManagerProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}
function tableAction(
  label: string,
  matches: (button: HTMLButtonElement) => boolean = () => true,
) {
  return Array.from(
    host.querySelectorAll<HTMLButtonElement>("table button"),
  ).find((button) => button.textContent?.includes(label) && matches(button));
}

// The admin request may already have started while React Query is still waiting
// for the response. Poll the rendered table rather than relying on an 80ms sleep,
// which is not reliable under Linux CI coverage instrumentation.
async function waitForTableAction(
  label: string,
  matches?: (button: HTMLButtonElement) => boolean,
): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const button = tableAction(label, matches);
    if (button) return button;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw new Error(`Timed out waiting for table action "${label}"`);
}
beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation(async (name, options) =>
    name === "system-performance"
      ? (response((options?.params ?? {}) as Record<string, unknown>) as never)
      : ({} as never),
  );
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  host?.remove();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("system performance v2 investigation UI regression", () => {
  it("restores URL-selected 6h scan/version and opens matching primary-query samples", async () => {
    // Reproduce the real asynchronous gap between requesting retained samples
    // and rendering their table. The old fixed-delay test failed in CI here.
    mockRequest.mockImplementation(async (name, options) => {
      if (name !== "system-performance") return {} as never;
      const params = (options?.params ?? {}) as Record<string, unknown>;
      if (params.view === "samples") {
        await new Promise((resolve) => setTimeout(resolve, 160));
      }
      return response(params) as never;
    });
    await mount(
      "?perfTab=hotspots&hotspotKind=scan&perfRange=6h&routeKey=api%3A%2Fcollect&appVersion=1.2.3",
    );
    const hotCall = mockRequest.mock.calls.find(
      ([name, options]) =>
        name === "system-performance" && options?.params?.view === "hotspots",
    );
    expect(hotCall?.[1]?.params).toMatchObject({
      view: "hotspots",
      kind: "scan",
      source: "all",
      routeKey: "api:/collect",
      appVersion: "1.2.3",
    });
    const window = hotCall?.[1]?.params as {
      from: number;
      to: number;
      interval: string;
    };
    expect(window.to - window.from).toBe(6 * 3_600_000);
    expect(window.interval).toBe("hour");
    const showSamples = await waitForTableAction(labels.showSamples);
    await act(async () => {
      showSamples.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    const params = new URLSearchParams(globalThis.window.location.search);
    expect(params.get("perfTab")).toBe("samples");
    expect(params.get("sampleQueryId")).toBe(queryId);
    expect(params.get("sampleKind")).toBe("scan");
    expect(
      mockRequest.mock.calls.some(
        ([name, options]) =>
          name === "system-performance" &&
          options?.params?.view === "samples" &&
          options.params.sampleKind === "scan" &&
          options.params.sampleQueryId === queryId,
      ),
    ).toBe(true);
    const sampleInspect = await waitForTableAction(
      labels.inspect,
      (button) => button.closest("tr")?.textContent?.includes("12 ms") === true,
    );
    await act(async () => {
      sampleInspect.click();
    });
    expect(host.textContent).toContain("route.handler");
    expect(host.textContent).toContain("≥24");
    const drawer = host.querySelector('[data-test="perf-drawer"]')!;
    expect(drawer.getAttribute("data-open")).toBe("true");
    await act(async () => {
      (drawer.querySelector("button") as HTMLButtonElement).click();
    });
    expect(drawer.getAttribute("data-open")).toBe("false");
    expect(drawer.textContent).toContain("route.handler"); // Exit animation retains content.
  });
  it("supports route and error investigation with strict related-sample filters", async () => {
    await mount("?perfTab=overview&perfRange=1h");
    expect(host.textContent).toContain("≥24");
    const routeSamples = await waitForTableAction(labels.showSamples);
    await act(async () => {
      routeSamples.click();
    });
    expect(new URLSearchParams(window.location.search).get("perfTab")).toBe(
      "samples",
    );
    expect(
      mockRequest.mock.calls.some(
        ([name, options]) =>
          name === "system-performance" &&
          options?.params?.view === "samples" &&
          options.params.routeKey === "api:/collect",
      ),
    ).toBe(true);
    await act(async () => {
      const errorsButton = Array.from(host.querySelectorAll("nav button")).find(
        (b) => b.textContent?.includes(labels.errors),
      ) as HTMLButtonElement;
      errorsButton.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(new URLSearchParams(window.location.search).get("perfTab")).toBe(
      "errors",
    );
    const errorSamples = await waitForTableAction(labels.showSamples);
    await act(async () => {
      errorSamples.click();
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("sampleErrorCode")).toBe("d1_query_failed");
    expect(params.get("sampleResult")).toBe("failure");
    expect(
      mockRequest.mock.calls.some(
        ([name, options]) =>
          name === "system-performance" &&
          options?.params?.view === "samples" &&
          options.params.sampleErrorCode === "d1_query_failed" &&
          options.params.resultClass === "failure",
      ),
    ).toBe(true);
  });
});
