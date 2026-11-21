import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LayerManagerProvider } from "@insightflare/ui/layer-manager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DoDiagnosticV2Panel } from "@/components/dashboard/admin/system-performance/do-diagnostic-v2";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import { systemPerformanceLabels } from "@/lib/system-performance-labels";

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

const copy = systemPerformanceLabels("zh");
const mockRequest = vi.mocked(requestAdminService);
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

async function mount() {
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
          <DoDiagnosticV2Panel
            locale="zh"
            timeZone="Asia/Shanghai"
            copy={copy}
          />
        </QueryClientProvider>
      </LayerManagerProvider>,
    );
  });
}

beforeEach(() => {
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
        requestedSites: 0,
        processedSites: 0,
        totalSites: 0,
        reachableSites: 0,
        unreachableSites: 0,
        partial: false,
        nextCursor: null,
        hasMore: false,
        sites: [],
        totals: {},
        thresholds: {},
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

describe("system performance DO diagnostics UI", () => {
  it("does not wake any Durable Object simply by opening the panel", async () => {
    await mount();
    expect(mockRequest).toHaveBeenCalledWith("teams", expect.any(Object));
    expect(
      mockRequest.mock.calls.some(([route]) => route === "do-diagnostic"),
    ).toBe(false);
    expect(host.textContent).toContain(copy.scanWarning);
  });

  it("requires a real click to begin a bounded global DO scan", async () => {
    await mount();
    const scanButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes(copy.scanAll),
    );
    expect(scanButton).toBeDefined();
    await act(async () => {
      scanButton!.click();
    });
    expect(mockRequest).toHaveBeenCalledWith("do-diagnostic", {
      params: { scope: "scan", limit: 20 },
    });
  });
});
