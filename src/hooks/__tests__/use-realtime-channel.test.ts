import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRealtimeChannel } from "@/hooks/use-realtime-channel";
import { broadcastRealtimeMessage } from "@/lib/realtime/broadcast-store";
import {
  acquireRealtimeChannel,
  createIdleRealtimeChannelState,
  getRealtimeChannelState,
} from "@/lib/realtime/client";
import type { RealtimeChannelState } from "@/lib/realtime/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@/lib/realtime/client", () => ({
  acquireRealtimeChannel: vi.fn(),
  createIdleRealtimeChannelState: vi.fn(),
  getRealtimeChannelState: vi.fn(),
}));

const acquireRealtimeChannelMock = vi.mocked(acquireRealtimeChannel);
const createIdleRealtimeChannelStateMock = vi.mocked(
  createIdleRealtimeChannelState,
);
const getRealtimeChannelStateMock = vi.mocked(getRealtimeChannelState);

function channelState(
  status: RealtimeChannelState["status"],
  activeNow = 0,
): RealtimeChannelState {
  return {
    status,
    hasConnected: status === "connected",
    activeNow,
    visitorsLast30m: activeNow,
    viewsLast30m: activeNow * 2,
    snapshotActiveNow: null,
    events: [],
    points: [],
    visits: [],
  };
}

function Probe(props: { siteId?: string; enabled?: boolean }) {
  const state = useRealtimeChannel(props.siteId, { enabled: props.enabled });
  return createElement("span", null, `${state.status}:${state.activeNow}`);
}

function renderProbe(
  root: Root,
  props: { siteId?: string; enabled?: boolean } = {},
) {
  act(() => {
    root.render(createElement(Probe, props));
  });
}

describe("useRealtimeChannel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    (document.body as any).append(container);
    root = createRoot(container);
    createIdleRealtimeChannelStateMock.mockImplementation(() =>
      channelState("disconnected"),
    );
    getRealtimeChannelStateMock.mockImplementation((siteId?: string) =>
      siteId
        ? channelState("connected", siteId === "site-a" ? 3 : 7)
        : channelState("disconnected"),
    );
    acquireRealtimeChannelMock.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("stays idle when disabled or missing a site id", () => {
    renderProbe(root, { siteId: "site-a", enabled: false });

    expect(container.textContent).toBe("disconnected:0");
    expect(createIdleRealtimeChannelStateMock).toHaveBeenCalled();
    expect(getRealtimeChannelStateMock).not.toHaveBeenCalled();
    expect(acquireRealtimeChannelMock).not.toHaveBeenCalled();

    renderProbe(root, { enabled: true });

    expect(container.textContent).toBe("disconnected:0");
    expect(acquireRealtimeChannelMock).not.toHaveBeenCalled();
  });

  it("acquires the site channel and releases it on unmount", () => {
    const release = vi.fn();
    acquireRealtimeChannelMock.mockReturnValue(release);

    renderProbe(root, { siteId: "site-a" });

    expect(container.textContent).toBe("connected:3");
    expect(getRealtimeChannelStateMock).toHaveBeenCalledWith("site-a");
    expect(acquireRealtimeChannelMock).toHaveBeenCalledWith("site-a");

    act(() => {
      root.unmount();
    });

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the previous channel and acquires the next site when site id changes", () => {
    const releasesBySite = new Map<string, ReturnType<typeof vi.fn>[]>();
    acquireRealtimeChannelMock.mockImplementation((siteId: string) => {
      const release = vi.fn();
      releasesBySite.set(siteId, [
        ...(releasesBySite.get(siteId) || []),
        release,
      ]);
      return release;
    });

    renderProbe(root, { siteId: "site-a" });
    const activeSiteARelease = releasesBySite.get("site-a")?.at(-1);
    renderProbe(root, { siteId: "site-b" });

    expect(activeSiteARelease).toHaveBeenCalledTimes(1);
    expect(acquireRealtimeChannelMock).toHaveBeenCalledWith("site-b");
    expect(container.textContent).toBe("connected:7");

    const activeSiteBRelease = releasesBySite.get("site-b")?.at(-1);
    act(() => {
      root.unmount();
    });

    expect(activeSiteBRelease).toHaveBeenCalledTimes(1);
  });

  it("updates from broadcasts for the active site only", async () => {
    renderProbe(root, { siteId: "site-a", enabled: true });

    await act(async () => {
      await broadcastRealtimeMessage({
        siteId: "site-b",
        state: channelState("failed", 99),
      });
    });

    expect(container.textContent).toBe("connected:3");

    await act(async () => {
      await broadcastRealtimeMessage({
        siteId: "site-a",
        state: channelState("disconnected", 5),
      });
    });

    expect(container.textContent).toBe("disconnected:5");
  });

  it("ignores broadcasts when no site or channel is active", async () => {
    renderProbe(root, { enabled: true });

    await act(async () => {
      await broadcastRealtimeMessage({
        siteId: "site-a",
        state: channelState("failed", 99),
      });
    });

    expect(container.textContent).toBe("disconnected:0");

    renderProbe(root, { enabled: false, siteId: "site-a" });
    await act(async () => {
      await broadcastRealtimeMessage({
        siteId: "site-a",
        state: channelState("connected", 1),
      });
    });

    expect(container.textContent).toBe("disconnected:0");
  });

  it("resets to idle and releases when the channel is disabled", () => {
    const release = vi.fn();
    acquireRealtimeChannelMock.mockReturnValue(release);

    renderProbe(root, { siteId: "site-a", enabled: true });
    renderProbe(root, { siteId: "site-a", enabled: false });

    expect(release).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("disconnected:0");
  });
});
