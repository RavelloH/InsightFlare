import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DoDiagnosticPanel } from "@/components/dashboard/admin/system-performance/do-diagnostic-panel";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import { getMessages } from "@/lib/i18n/messages";

vi.mock("@insightflare/ui/auto-resizer", () => ({
  AutoResizer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@insightflare/ui/auto-transition", () => ({
  AutoTransition: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/lib/dashboard-api/client/admin-service", () => ({
  requestAdminService: vi.fn(),
}));

const copy = getMessages("zh").systemPerformance;
const mockRequest = vi.mocked(requestAdminService);
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

const thresholds = {
  staleMs: 30 * 60_000,
  timeoutMs: 12 * 3_600_000,
  hardAgedMs: 36 * 3_600_000,
  stuckFlushAttempts: 5,
};
function diagnostic(stale: number) {
  return {
    ok: true,
    snapshotAt: Date.now(),
    thresholds,
    visits: {
      total: 40,
      byStatus: {},
      open: {
        total: 12,
        stale,
        timedOut: 0,
        hardAged: 0,
        futureSkewed: 0,
        oldestStartedAt: null,
        newestActivityAt: null,
        futureMaxActivityAt: null,
      },
      dirty: { total: 3, stuck: 0, maxFlushAttempts: 1 },
    },
    customEvents: {
      total: 5,
      dirty: 1,
      stuck: 0,
      maxFlushAttempts: 0,
      oldestOccurredAt: null,
    },
    alarm: {
      scheduledAt: null,
      nextDueAt: null,
      nextDueKind: null,
      nextDueEntity: null,
    },
  };
}
const sites = [
  {
    siteId: "site-a",
    siteName: "Healthy Site",
    siteDomain: "a.example",
    ok: true,
    durationMs: 40,
    diagnostic: diagnostic(0),
  },
  {
    siteId: "site-b",
    siteName: "Stale Site",
    siteDomain: "b.example",
    ok: true,
    durationMs: 60,
    diagnostic: diagnostic(4),
  },
  {
    siteId: "site-c",
    siteName: "Down Site",
    siteDomain: "c.example",
    ok: false,
    error: "timeout",
    durationMs: 4000,
  },
];

async function mount(onViewSamples = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  await act(async () => {
    root.render(
      <LayerManagerProvider>
        <QueryClientProvider client={client}>
          <DoDiagnosticPanel
            locale="zh"
            timeZone="Asia/Shanghai"
            copy={copy}
            onViewSamples={onViewSamples}
          />
        </QueryClientProvider>
      </LayerManagerProvider>,
    );
  });
  return onViewSamples;
}

function button(text: string) {
  return Array.from(host.querySelectorAll("button")).find((item) =>
    item.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  mockRequest.mockReset();
  mockRequest.mockImplementation(async (route) => {
    if (route === "teams") return [{ id: "team-a", name: "Team A" }] as never;
    if (route === "sites")
      return [{ id: "site-a", name: "Site A", domain: "a.example" }] as never;
    if (route === "do-diagnostic")
      return {
        ok: true,
        scope: "scan",
        scanAt: Date.now(),
        generatedAt: Date.now(),
        requestedSites: 3,
        processedSites: 3,
        totalSites: 3,
        reachableSites: 2,
        unreachableSites: 1,
        partial: true,
        nextCursor: null,
        hasMore: false,
        sites,
        totals: {},
        thresholds,
        oldestOpenStartedAt: null,
        futureMaxActivityAt: null,
      } as never;
    return {} as never;
  });
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  host?.remove();
  vi.restoreAllMocks();
});

describe("Durable Object diagnostics panel", () => {
  it("does not wake any Durable Object simply by opening the panel", async () => {
    await mount();
    expect(mockRequest).toHaveBeenCalledWith("teams", expect.any(Object));
    expect(
      mockRequest.mock.calls.some(([route]) => route === "do-diagnostic"),
    ).toBe(false);
    expect(host.textContent).toContain(copy.durableObjects.idle);
  });

  it("scans in bounded batches and flags sites that need attention", async () => {
    await mount();
    await act(async () => button(copy.durableObjects.scan)!.click());
    expect(mockRequest).toHaveBeenCalledWith("do-diagnostic", {
      params: { scope: "scan", limit: 20 },
    });
    const rows = Array.from(host.querySelectorAll("tbody tr"));
    const state = (name: string) =>
      rows.find((row) => row.textContent?.includes(name))?.textContent ?? "";
    expect(state("Healthy Site")).toContain(copy.durableObjects.reachable);
    expect(state("Stale Site")).toContain(copy.durableObjects.attention);
    expect(state("Down Site")).toContain(copy.durableObjects.unreachable);

    await act(async () =>
      (
        rows.find((row) =>
          row.textContent?.includes("Stale Site"),
        ) as HTMLElement
      ).click(),
    );
    expect(host.textContent).toContain(copy.durableObjects.attention);
    expect(host.textContent).toContain("30");
  });

  it("links to Durable Object samples", async () => {
    const onViewSamples = await mount();
    await act(async () => button(copy.durableObjects.viewSamples)!.click());
    expect(onViewSamples).toHaveBeenCalledOnce();
  });
});
