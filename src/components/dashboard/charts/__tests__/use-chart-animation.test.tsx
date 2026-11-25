import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useAnimationOnChartSwitch,
  useChartVisibility,
} from "@insightflare/product-ui/charts";
import { afterEach, describe, expect, it, vi } from "vitest";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

class MockIntersectionObserver {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  readonly unobserve = vi.fn();

  constructor(
    readonly callback: (entries: Array<IntersectionObserverEntry>) => void,
    readonly options: IntersectionObserverInit,
  ) {}
}

function visibilityEntry(
  target: Element,
  isIntersecting: boolean,
  intersectionRatio: number,
): IntersectionObserverEntry {
  return {
    target,
    isIntersecting,
    intersectionRatio,
    boundingClientRect: target.getBoundingClientRect(),
    intersectionRect: target.getBoundingClientRect(),
    rootBounds: null,
    time: 0,
  };
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
    const target = observer!.observe.mock.calls[0]![0] as Element;
    expect(visibility.current?.hasMeasuredVisibility).toBe(false);

    act(() => {
      observer?.callback([visibilityEntry(target, true, 1)]);
    });
    expect(visibility.current?.isVisible).toBe(true);
    expect(visibility.current?.hasMeasuredVisibility).toBe(true);

    act(() => {
      observer?.callback([visibilityEntry(target, false, 1)]);
    });
    expect(visibility.current?.isVisible).toBe(true);

    act(() => {
      observer?.callback([]);
    });
    expect(visibility.current?.isVisible).toBe(true);

    act(() => {
      observer?.callback([visibilityEntry(target, false, 0)]);
    });
    expect(visibility.current?.isVisible).toBe(false);

    act(() => root?.unmount());
    expect(observer?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("shares observers by margin, routes entries independently and releases the last subscriber", () => {
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
    const values = new Map<string, boolean>();
    function Probe({ id, margin }: { id: string; margin: string }) {
      const visibility = useChartVisibility(margin);
      values.set(id, visibility.isVisible);
      return <div id={id} ref={visibility.containerRef} />;
    }
    const sample = (second = true, first = true) => (
      <>
        {first && <Probe key="a" id="a" margin="80px 0px" />}
        {second && <Probe key="b" id="b" margin="80px 0px" />}
        <Probe key="c" id="c" margin="0px" />
      </>
    );
    render(sample());
    expect(observers).toHaveLength(2);
    const shared = observers[0]!;
    expect(shared.observe).toHaveBeenCalledTimes(2);
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    act(() =>
      shared.callback([
        visibilityEntry(a, true, 1),
        visibilityEntry(b, false, 0),
      ]),
    );
    expect(values.get("a")).toBe(true);
    expect(values.get("b")).toBe(false);
    expect(values.get("c")).toBe(false);
    render(sample(false));
    expect(shared.unobserve).toHaveBeenCalledWith(b);
    expect(shared.disconnect).not.toHaveBeenCalled();
    render(sample(false, false));
    expect(shared.unobserve).toHaveBeenCalledWith(a);
    expect(shared.disconnect).toHaveBeenCalledTimes(1);
    render(sample());
    expect(observers).toHaveLength(3);
    expect(observers[2]?.observe).toHaveBeenCalledTimes(2);
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
