import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  useAnimationOnChartSwitch,
  useChartVisibility,
} from "@/hooks/use-chart-animation";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

class MockIntersectionObserver {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    readonly callback: (entries: Array<IntersectionObserverEntry>) => void,
    readonly options: IntersectionObserverInit,
  ) {}
}

function render(element: React.ReactNode) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("useChartVisibility", () => {
  it("does not measure visibility until its container is mounted", () => {
    const visibility = {
      current: null as ReturnType<typeof useChartVisibility> | null,
    };
    function Probe() {
      visibility.current = useChartVisibility();
      return null;
    }

    render(<Probe />);
    expect(visibility.current?.hasMeasuredVisibility).toBe(false);
  });

  it("tracks IntersectionObserver visibility and cleans up", () => {
    const observers: MockIntersectionObserver[] = [];
    class TestIntersectionObserver extends MockIntersectionObserver {
      constructor(
        callback: (entries: Array<IntersectionObserverEntry>) => void,
        options: IntersectionObserverInit,
      ) {
        super(callback, options);
        observers.push(this);
      }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    const visibility = {
      current: null as ReturnType<typeof useChartVisibility> | null,
    };
    function Probe() {
      visibility.current = useChartVisibility("0px");
      return <div ref={visibility.current.containerRef} />;
    }

    render(<Probe />);
    const observer = observers[0];
    expect(observer?.options.rootMargin).toBe("0px");
    expect(observer?.observe).toHaveBeenCalledTimes(1);
    expect(visibility.current?.hasMeasuredVisibility).toBe(false);

    act(() => {
      observer?.callback([
        {
          isIntersecting: true,
          intersectionRatio: 1,
        } as IntersectionObserverEntry,
      ]);
    });
    expect(visibility.current?.isVisible).toBe(true);
    expect(visibility.current?.hasMeasuredVisibility).toBe(true);

    act(() => {
      observer?.callback([
        {
          isIntersecting: false,
          intersectionRatio: 1,
        } as IntersectionObserverEntry,
      ]);
    });
    expect(visibility.current?.isVisible).toBe(true);

    act(() => {
      observer?.callback([]);
    });
    expect(visibility.current?.isVisible).toBe(false);

    act(() => {
      observer?.callback([
        {
          isIntersecting: false,
          intersectionRatio: 0,
        } as IntersectionObserverEntry,
      ]);
    });
    expect(visibility.current?.isVisible).toBe(false);

    act(() => root?.unmount());
    expect(observer?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("treats visibility as available without IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const visibility = {
      current: null as ReturnType<typeof useChartVisibility> | null,
    };
    function Probe() {
      visibility.current = useChartVisibility();
      return <div ref={visibility.current.containerRef} />;
    }

    render(<Probe />);
    expect(visibility.current?.isVisible).toBe(true);
    expect(visibility.current?.hasMeasuredVisibility).toBe(true);
  });
});

describe("useAnimationOnChartSwitch", () => {
  it("only enables the next data transition after visibility is measured", () => {
    let isAnimationActive = false;
    function Probe({
      switchKey,
      hasData,
      isVisible,
      hasMeasuredVisibility,
    }: {
      switchKey: string;
      hasData: boolean;
      isVisible: boolean;
      hasMeasuredVisibility: boolean;
    }) {
      isAnimationActive = useAnimationOnChartSwitch({
        switchKey,
        hasData,
        isVisible,
        hasMeasuredVisibility,
      });
      return null;
    }

    render(
      <Probe
        switchKey="first"
        hasData
        isVisible
        hasMeasuredVisibility={false}
      />,
    );
    expect(isAnimationActive).toBe(false);

    render(<Probe switchKey="first" hasData isVisible hasMeasuredVisibility />);
    expect(isAnimationActive).toBe(false);

    render(<Probe switchKey="first" hasData isVisible hasMeasuredVisibility />);
    expect(isAnimationActive).toBe(false);

    render(
      <Probe switchKey="second" hasData isVisible hasMeasuredVisibility />,
    );
    expect(isAnimationActive).toBe(true);

    render(
      <Probe
        switchKey="third"
        hasData={false}
        isVisible
        hasMeasuredVisibility
      />,
    );
    expect(isAnimationActive).toBe(false);

    render(
      <Probe
        switchKey="fourth"
        hasData
        isVisible={false}
        hasMeasuredVisibility
      />,
    );
    expect(isAnimationActive).toBe(false);
  });
});
