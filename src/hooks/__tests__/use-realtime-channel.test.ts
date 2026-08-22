import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRealtimeChannelSelector } from "@/hooks/use-realtime-channel";
import {
  acquireRealtimeChannel,
  getRealtimeChannelSnapshot,
  subscribeRealtimeChannel,
} from "@/lib/realtime/client";
import type { RealtimeChannelState } from "@/lib/realtime/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@/lib/realtime/client", () => ({
  acquireRealtimeChannel: vi.fn(),
  getRealtimeChannelSnapshot: vi.fn(),
  subscribeRealtimeChannel: vi.fn(),
}));

const acquireRealtimeChannelMock = vi.mocked(acquireRealtimeChannel);
const getRealtimeChannelSnapshotMock = vi.mocked(getRealtimeChannelSnapshot);
const subscribeRealtimeChannelMock = vi.mocked(subscribeRealtimeChannel);

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

const selectProbeState = (state: RealtimeChannelState) => ({
  status: state.status,
  activeNow: state.activeNow,
});
const selectProbeStateAlternate = (state: RealtimeChannelState) => ({
  status: state.status,
  activeNow: state.activeNow,
});
type ProbeState = ReturnType<typeof selectProbeState>;

const areProbeStatesEqual = (left: ProbeState, right: ProbeState) =>
  left.status === right.status && left.activeNow === right.activeNow;

function Probe(props: {
  siteId?: string;
  enabled?: boolean;
  alternate?: boolean;
}) {
  const state = useRealtimeChannelSelector(
    props.siteId,
    props.alternate ? selectProbeStateAlternate : selectProbeState,
    areProbeStatesEqual,
    { enabled: props.enabled },
  );
  return createElement("span", null, `${state.status}:${state.activeNow}`);
}

function renderProbe(
  root: Root,
  props: { siteId?: string; enabled?: boolean; alternate?: boolean } = {},
) {
  act(() => {
    root.render(createElement(Probe, props));
  });
}

describe("useRealtimeChannelSelector", () => {
  let container: HTMLDivElement;
  let root: Root;
  const snapshots = new Map<string, RealtimeChannelState>();
  const listenersBySite = new Map<string, Set<() => void>>();
  let idleState: RealtimeChannelState;

  function publish(siteId: string, state: RealtimeChannelState) {
    snapshots.set(siteId, state);
    listenersBySite.get(siteId)?.forEach((listener) => listener());
  }

  beforeEach(() => {
    container = document.createElement("div");
    (document.body as any).append(container);
    root = createRoot(container);
    snapshots.clear();
    listenersBySite.clear();
    idleState = channelState("disconnected");
    snapshots.set("site-a", channelState("connected", 3));
    snapshots.set("site-b", channelState("connected", 7));
    getRealtimeChannelSnapshotMock.mockImplementation((siteId?: string) =>
      siteId ? (snapshots.get(siteId) ?? idleState) : idleState,
    );
    subscribeRealtimeChannelMock.mockImplementation((siteId, listener) => {
      if (!siteId) return vi.fn();
      const listeners = listenersBySite.get(siteId) ?? new Set();
      listeners.add(listener);
      listenersBySite.set(siteId, listeners);
      return () => listeners.delete(listener);
    });
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
    expect(getRealtimeChannelSnapshotMock).toHaveBeenCalledWith();
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
    expect(getRealtimeChannelSnapshotMock).toHaveBeenCalledWith("site-a");
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

  it("updates from channel snapshots for the active site only", () => {
    renderProbe(root, { siteId: "site-a", enabled: true });

    act(() => {
      publish("site-b", channelState("failed", 99));
    });

    expect(container.textContent).toBe("connected:3");

    act(() => {
      publish("site-a", channelState("disconnected", 5));
    });

    expect(container.textContent).toBe("disconnected:5");
  });

  it("reselects when the selector changes and reuses equal selections", () => {
    renderProbe(root, { siteId: "site-a", enabled: true });

    act(() => {
      publish("site-a", channelState("connected", 3));
    });

    expect(container.textContent).toBe("connected:3");

    renderProbe(root, {
      siteId: "site-a",
      enabled: true,
      alternate: true,
    });

    expect(container.textContent).toBe("connected:3");
  });

  it("ignores channel snapshots when no site or channel is active", () => {
    renderProbe(root, { enabled: true });

    act(() => {
      publish("site-a", channelState("failed", 99));
    });

    expect(container.textContent).toBe("disconnected:0");

    renderProbe(root, { enabled: false, siteId: "site-a" });
    act(() => {
      publish("site-a", channelState("connected", 1));
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
