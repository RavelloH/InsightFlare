import { afterEach, describe, expect, it, vi } from "vitest";

import type { DemoFactDatasetWorkerMessage } from "@/lib/realtime/mock/fact-dataset.worker";

const DAY_MS = 86_400_000;

interface WorkerScopeForTest {
  onmessage?: (
    event: MessageEvent<{
      type: "build";
      siteId: string;
      from: number;
      to: number;
    }>,
  ) => void;
}

describe("mock/fact-dataset.worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("posts a generated dataset for build messages", async () => {
    const postMessage =
      vi.fn<(message: DemoFactDatasetWorkerMessage) => void>();
    vi.stubGlobal("postMessage", postMessage);

    await import("../fact-dataset.worker");

    const workerScope = globalThis as unknown as WorkerScopeForTest;
    workerScope.onmessage?.({
      data: {
        type: "build",
        siteId: "demo-site-001",
        from: DAY_MS,
        to: 2 * DAY_MS,
      },
    } as MessageEvent<{
      type: "build";
      siteId: string;
      from: number;
      to: number;
    }>);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message] = postMessage.mock.calls[0] ?? [];
    expect(message?.type).toBe("ready");
    if (message?.type === "ready") {
      expect(message.dataset.visits.length).toBeGreaterThan(0);
      expect(message.dataset.sessions.size).toBeGreaterThan(0);
      expect(message.dataset.visitors.size).toBeGreaterThan(0);
    }
  });

  it("posts an error when dataset generation fails", async () => {
    const postMessage =
      vi.fn<(message: DemoFactDatasetWorkerMessage) => void>();
    vi.stubGlobal("postMessage", postMessage);

    await import("../fact-dataset.worker");

    const workerScope = globalThis as unknown as WorkerScopeForTest;
    workerScope.onmessage?.({ data: undefined } as never);

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message] = postMessage.mock.calls[0] ?? [];
    expect(message?.type).toBe("error");
    if (message?.type === "error") {
      expect(message.message).toBeTruthy();
    }
  });
});
