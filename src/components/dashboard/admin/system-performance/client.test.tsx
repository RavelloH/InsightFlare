import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SystemPerformanceClient } from "@/components/dashboard/admin/system-performance/client";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import { getMessages } from "@/lib/i18n/messages";

const NOW = Date.UTC(2026, 10, 22, 6, 0);

vi.mock("@/components/dashboard/shell/dashboard-query-provider", () => ({
  useDashboardTimeWindow: () => ({
    preset: "24h",
    from: NOW - 86_400_000,
    to: NOW,
    interval: "hour",
    timeZone: "UTC",
  }),
}));
vi.mock("@/lib/dashboard-api/client/admin-service", () => ({
  requestAdminService: vi.fn(),
}));
vi.mock("@insightflare/product-ui/charts", () => ({
  LatencyPercentileChart: () => <div data-test="latency-chart" />,
}));
vi.mock("@insightflare/ui/auto-resizer", () => ({
  AutoResizer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@insightflare/ui/auto-transition", () => ({
  AutoTransition: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@insightflare/ui/drawer", () => {
  const Pass = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Drawer: ({ children, open }: { children: ReactNode; open: boolean }) => (
      <div data-test="perf-drawer" data-open={open ? "true" : "false"}>
        {children}
      </div>
    ),
    DrawerContent: Pass,
    DrawerHeader: Pass,
    DrawerTitle: Pass,
    DrawerDescription: Pass,
    DrawerScrollArea: Pass,
  };
});
vi.mock(
  "@/components/dashboard/admin/system-performance/do-diagnostic-panel",
  () => ({ DoDiagnosticPanel: () => <div>DO panel stub</div> }),
);

const messages = getMessages("zh");
const copy = messages.systemPerformance;
const mockRequest = vi.mocked(requestAdminService);
const queryId = "analytics.overview.raw.summary";

const weighted = (value: number | null, coverage = "complete") => ({
  applicable: 1,
  complete: coverage === "complete" ? 1 : 0,
  partial: coverage === "partial" ? 1 : 0,
  observed: value ?? 0,
  value,
  coverage,
  lowerBound: coverage === "partial",
});
const aggregate = {
  retainedSamples: 3,
  estimatedInvocations: 900,
  maxSampleInterval: 9,
  handlerWeight: 900,
  p50: 12,
  p95: 40,
  p99: 90,
  invocationWallMs: 18_000,
  workerD1Statements: 1800,
  doFetchCalls: 0,
  weighted: {
    d1RowsRead: weighted(2400, "partial"),
    d1SqlEngineMs: weighted(300),
    d1ApiWallMs: weighted(900),
    doFetchWallMs: weighted(null, "unavailable"),
    doSqlRowsRead: weighted(null, "unavailable"),
  },
};
const dims = {
  source: "worker",
  trigger: "request",
  routeKey: "api:/v1/analytics/overview",
  appVersion: "1.2.3",
};
const error = {
  ...dims,
  resultClass: "failure",
  category: "database",
  code: "d1_query_failed",
  operation: "d1.all",
  retainedSamples: 1,
  estimatedInvocations: 9,
  maxSampleInterval: 9,
};
const hotspot = {
  ...dims,
  queryId,
  variant: "raw.filtered",
  filterShape: "basic.cx.1.1.o1",
  filterFamily: "basic",
  granularity: "sql-template",
  owner: "src/x.ts",
  retainedSamples: 2,
  estimatedInvocations: 18,
  maxSampleInterval: 9,
  weightedValue: 720,
};
const sample = {
  ...dims,
  timestampSeconds: NOW / 1000 - 60,
  resultClass: "ok",
  category: null,
  code: null,
  operation: null,
  hotQueryId: queryId,
  variant: "raw.filtered",
  filterShape: null,
  scanQueryId: null,
  dominantPhase: "route.handler",
  details: {
    version: 2,
    errorDiagnostics: {
      version: 1,
      diagnosticId: "00000000-0000-4000-8000-000000000001",
      errors: [
        {
          category: "database",
          code: "d1_operation_failed",
          operation: "d1.all",
          name: "Error",
          message: "Missing database column",
          messageRedacted: true,
          stack: [{ file: "worker.js", line: 12, column: 3 }],
          causes: ["Operation timed out"],
          context: { queryId, variant: "raw.filtered" },
          fingerprint: "abcd0123",
          count: 2,
        },
      ],
      dropped: 1,
    },
    phases: [{ id: "route.handler", count: 1, wallMs: 31 }],
    queries: [
      {
        id: queryId,
        variant: "raw.filtered",
        granularity: "sql-template",
        count: 1,
        apiWallMs: 22,
        sqlEngineMs: 9,
        rowsRead: 480,
        rowsWritten: 0,
        attempts: 1,
        failed: false,
        coverage: {
          api: "complete",
          engine: "complete",
          rowsRead: "partial",
          rowsWritten: "complete",
          attempts: "complete",
        },
      },
    ],
    coverage: null,
    truncation: null,
  },
  filterFamily: null,
  sampleInterval: 9,
  invocationWallMs: 36,
  handlerWallMs: 31,
  httpStatus: 200,
  flags: 0,
  detailsTruncated: false,
};

function response(params: Record<string, unknown>) {
  switch (params.view) {
    case "routes":
      return {
        view: "routes",
        status: "ready",
        data: { routes: [{ ...dims, ...aggregate }] },
      };
    case "errors":
      return { view: "errors", status: "ready", data: { errors: [error] } };
    case "hotspots":
      return {
        view: "hotspots",
        status: "ready",
        data: { hotspots: { [String(params.kind)]: [hotspot] } },
      };
    case "samples":
      return { view: "samples", status: "ready", data: { samples: [sample] } };
    default:
      return {
        view: "overview",
        status: "ready",
        data: {
          summary: aggregate,
          trend: [{ ...aggregate, bucket: NOW / 1000 }],
        },
      };
  }
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function waitFor(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function findRow(text: string) {
  return Array.from(
    host.querySelectorAll<HTMLTableRowElement>("tbody tr"),
  ).find((row) => row.textContent?.includes(text));
}

function findButton(text: string) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

function viewCalls(view: string) {
  return mockRequest.mock.calls
    .filter(
      ([name, options]) =>
        name === "system-performance" && options?.params?.view === view,
    )
    .map(([, options]) => options?.params as Record<string, unknown>);
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
          <SystemPerformanceClient locale="zh" messages={messages} />
        </QueryClientProvider>
      </LayerManagerProvider>,
    );
  });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW + 60_000);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("system performance page", () => {
  it("loads overview, routes and errors for the shared time window", async () => {
    await mount("");
    await waitFor(
      () => Boolean(findRow("api:/v1/analytics/overview")),
      "routes",
    );
    const [overview] = viewCalls("overview");
    expect(overview).toMatchObject({
      from: NOW - 86_400_000,
      to: NOW,
      interval: "hour",
      timeZone: "UTC",
      source: "all",
    });
    expect(viewCalls("routes")).toHaveLength(1);
    expect(viewCalls("errors")).toHaveLength(1);
    expect(viewCalls("samples")).toHaveLength(0);
    // Failure rate = 9 failures / 900 invocations; partial coverage is a lower bound.
    expect(host.textContent).toContain("1%");
    expect(host.textContent).toContain("≥ 2,400");
  });

  it("drills from a route into its slow queries and then into matching samples", async () => {
    await mount("");
    await waitFor(
      () => Boolean(findRow("api:/v1/analytics/overview")),
      "routes",
    );
    await act(async () => findRow("api:/v1/analytics/overview")!.click());
    expect(
      host
        .querySelector('[data-test="perf-drawer"]')
        ?.getAttribute("data-open"),
    ).toBe("true");
    await act(async () => findButton(copy.actions.viewHotspots)!.click());
    const params = new URLSearchParams(window.location.search);
    expect(params.get("perfTab")).toBe("hotspots");
    expect(params.get("routeKey")).toBe("api:/v1/analytics/overview");

    await waitFor(() => Boolean(findRow(queryId)), "hotspot row");
    expect(viewCalls("hotspots").at(-1)).toMatchObject({
      kind: "api-hot",
      routeKey: "api:/v1/analytics/overview",
    });
    expect(host.textContent).toContain(copy.filters.route);

    await act(async () => findRow(queryId)!.click());
    await act(async () => findButton(copy.actions.viewSamples)!.click());
    const sampleParams = new URLSearchParams(window.location.search);
    expect(sampleParams.get("perfTab")).toBe("samples");
    expect(sampleParams.get("sampleQueryId")).toBe(queryId);
    expect(sampleParams.get("sampleKind")).toBe("api-hot");
    await waitFor(() => viewCalls("samples").length > 0, "samples request");
    expect(viewCalls("samples").at(-1)).toMatchObject({
      sampleQueryId: queryId,
      sampleKind: "api-hot",
      routeKey: "api:/v1/analytics/overview",
      trigger: "request",
    });
  });

  it("opens error samples with the error code and result filters", async () => {
    await mount("?perfTab=errors");
    await waitFor(() => Boolean(findRow("d1_query_failed")), "error row");
    await act(async () => findRow("d1_query_failed")!.click());
    await act(async () => findButton(copy.actions.viewSamples)!.click());
    await waitFor(() => viewCalls("samples").length > 0, "samples request");
    expect(viewCalls("samples").at(-1)).toMatchObject({
      sampleErrorCode: "d1_query_failed",
      resultClass: "failure",
    });
  });

  it("shows sample phases and query costs in the detail drawer", async () => {
    await mount("?perfTab=samples");
    await waitFor(
      () => Boolean(findRow("api:/v1/analytics/overview")),
      "sample row",
    );
    await act(async () => findRow("api:/v1/analytics/overview")!.click());
    expect(host.textContent).toContain(copy.detail.phases);
    expect(host.textContent).toContain(copy.detail.errorDiagnostics);
    expect(host.textContent).toContain("00000000-0000-4000-8000-000000000001");
    expect(host.textContent).toContain("Missing database column");
    expect(host.textContent).toContain("worker.js:12:3");
    expect(host.textContent).toContain("Operation timed out");
    expect(host.textContent).toContain("abcd0123");
    expect(host.textContent).toContain("route.handler");
    expect(host.textContent).toContain("≥ 480");
    expect(host.textContent).toContain("×9");
  });

  it("explains missing configuration instead of rendering empty charts", async () => {
    mockRequest.mockImplementation(
      async () =>
        ({
          view: "overview",
          status: "reader_not_configured",
          data: null,
        }) as never,
    );
    await mount("");
    await waitFor(
      () =>
        host.textContent?.includes(copy.status.readerNotConfigured) === true,
      "status message",
    );
    expect(host.querySelector('[data-test="latency-chart"]')).toBeNull();
  });

  it("does not query invocation views on the Durable Objects tab", async () => {
    await mount("?perfTab=do");
    expect(host.textContent).toContain("DO panel stub");
    expect(
      mockRequest.mock.calls.some(([name]) => name === "system-performance"),
    ).toBe(false);
  });
});
