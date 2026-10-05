import type { CSSProperties, MouseEvent, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { LayerPortal } from "@insightflare/ui/layer-portal";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@insightflare/ui/tooltip";

import { cn } from "../utils/cn";

type TooltipSide = "left" | "right";

interface TooltipRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface ActiveTooltip {
  content: ReactNode;
  contentKey?: string;
  rect: TooltipRect;
  side: TooltipSide;
  target: HTMLElement;
}

interface AnalyticsTooltipContextValue {
  groupId: string;
  show: (
    target: HTMLElement,
    content: ReactNode,
    contentKey: string | undefined,
    clientX: number,
  ) => void;
  hide: () => void;
  cancelHide: () => void;
}

const AnalyticsTooltipContext =
  createContext<AnalyticsTooltipContextValue | null>(null);
const TOOLTIP_HIDE_DELAY_MS = 120;

function getTooltipRect(target: HTMLElement): TooltipRect | null {
  if (!target.isConnected) return null;
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
}

function getTooltipSide(clientX: number): TooltipSide {
  return clientX < window.innerWidth / 2 ? "right" : "left";
}

function areRectsEqual(left: TooltipRect, right: TooltipRect): boolean {
  return (
    left.height === right.height &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width
  );
}

function isElement(value: EventTarget | null): value is Element {
  return value instanceof Element;
}

export function AnalyticsTooltipProvider({
  children,
  retentionMode = "table-column",
}: {
  children: ReactNode;
  retentionMode?: "table-column" | "target";
}) {
  const groupId = useId();
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const [content, setContent] = useState<ActiveTooltip | null>(null);
  const activeRef = useRef<ActiveTooltip | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const pointerMoveFrameRef = useRef<number | null>(null);
  const latestPointerMoveRef = useRef<{
    eventTarget: EventTarget | null;
    clientX: number;
    clientY: number;
  } | null>(null);
  const shouldAnimatePositionRef = useRef(false);
  const tooltipContentRef = useRef<HTMLDivElement | null>(null);

  activeRef.current = active;

  const updateActive = useCallback(
    (
      target: HTMLElement,
      nextContent: ReactNode,
      contentKey: string | undefined,
      clientX: number,
    ) => {
      const rect = getTooltipRect(target);
      if (!rect) return;
      const nextSide = getTooltipSide(clientX);
      const current = activeRef.current;
      if (
        current?.target === target &&
        current.contentKey === contentKey &&
        current.content === nextContent &&
        current.side === nextSide &&
        areRectsEqual(current.rect, rect)
      ) {
        return;
      }
      shouldAnimatePositionRef.current = current !== null;
      const next = {
        content: nextContent,
        contentKey,
        rect,
        side: nextSide,
        target,
      } satisfies ActiveTooltip;
      activeRef.current = next;
      setContent(next);
      setActive(next);
    },
    [],
  );

  const hide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    activeRef.current = null;
    setActive(null);
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      hide();
    }, TOOLTIP_HIDE_DELAY_MS);
  }, [hide]);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const show = useCallback(
    (
      target: HTMLElement,
      nextContent: ReactNode,
      contentKey: string | undefined,
      clientX: number,
    ) => {
      cancelHide();
      updateActive(target, nextContent, contentKey, clientX);
    },
    [cancelHide, updateActive],
  );

  const isWithinRetentionZone = useCallback(
    (eventTarget: EventTarget | null, clientX: number, clientY: number) => {
      const current = activeRef.current;
      if (!current) return false;

      if (
        isElement(eventTarget) &&
        (eventTarget.closest(`[data-analytics-tooltip-group="${groupId}"]`) ||
          eventTarget.closest("[data-analytics-tooltip-content]"))
      ) {
        return true;
      }

      const cell = current.target.closest<HTMLTableCellElement>("td");
      if (retentionMode === "target") return false;

      const table = cell?.closest<HTMLTableElement>("table");
      const body = table?.tBodies[0];
      if (!cell || !body) return false;

      const cellRect = cell.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      return (
        clientX >= cellRect.left &&
        clientX <= cellRect.right &&
        clientY >= bodyRect.top &&
        clientY <= bodyRect.bottom
      );
    },
    [groupId, retentionMode],
  );

  const isActive = active !== null;

  useEffect(() => {
    if (!isActive) return;

    const processPointerMove = () => {
      pointerMoveFrameRef.current = null;
      const latest = latestPointerMoveRef.current;
      if (!latest) return;

      if (
        isWithinRetentionZone(
          latest.eventTarget,
          latest.clientX,
          latest.clientY,
        )
      ) {
        cancelHide();
      } else {
        scheduleHide();
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (
        isElement(event.target) &&
        (event.target.closest(`[data-analytics-tooltip-group="${groupId}"]`) ||
          event.target.closest("[data-analytics-tooltip-content]"))
      ) {
        latestPointerMoveRef.current = null;
        cancelHide();
        return;
      }

      latestPointerMoveRef.current = {
        eventTarget: event.target,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      if (pointerMoveFrameRef.current !== null) return;
      pointerMoveFrameRef.current =
        window.requestAnimationFrame(processPointerMove);
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove, true);
      latestPointerMoveRef.current = null;
      if (pointerMoveFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerMoveFrameRef.current);
        pointerMoveFrameRef.current = null;
      }
    };
  }, [cancelHide, groupId, isActive, isWithinRetentionZone, scheduleHide]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  const contextValue = useMemo<AnalyticsTooltipContextValue>(
    () => ({
      cancelHide,
      groupId,
      hide: scheduleHide,
      show,
    }),
    [cancelHide, groupId, scheduleHide, show],
  );

  const anchor = active ?? content;
  const anchorStyle: CSSProperties | undefined = anchor
    ? {
        height: anchor.rect.height,
        left: anchor.rect.left,
        top: anchor.rect.top,
        width: anchor.rect.width,
      }
    : undefined;

  useLayoutEffect(() => {
    const wrapper = tooltipContentRef.current?.parentElement;
    if (!wrapper) return;
    wrapper.style.transition =
      shouldAnimatePositionRef.current && active !== null
        ? "transform 160ms ease-out"
        : "none";
  }, [active]);

  return (
    <AnalyticsTooltipContext.Provider value={contextValue}>
      <TooltipProvider>
        {children}
        <Tooltip
          open={active !== null}
          onOpenChange={(open) => !open && scheduleHide()}
        >
          <LayerPortal slot="floating">
            <TooltipTrigger asChild>
              <span
                aria-hidden="true"
                className="pointer-events-none fixed opacity-0"
                style={anchorStyle}
              />
            </TooltipTrigger>
          </LayerPortal>
          {content ? (
            <TooltipContent
              ref={tooltipContentRef}
              className="max-w-none"
              side={content.side}
              sideOffset={8}
              align="center"
              data-analytics-tooltip-content=""
              onPointerEnter={cancelHide}
              onPointerLeave={scheduleHide}
              updatePositionStrategy="always"
            >
              <AutoResizer animateWidth className="min-w-0" duration={0.16}>
                {content.content}
              </AutoResizer>
            </TooltipContent>
          ) : null}
        </Tooltip>
      </TooltipProvider>
    </AnalyticsTooltipContext.Provider>
  );
}

export function AnalyticsTooltipTarget({
  children,
  className,
  content,
  contentKey,
}: {
  children: ReactNode;
  className?: string;
  content: ReactNode;
  contentKey?: string;
}) {
  const context = useContext(AnalyticsTooltipContext);

  if (!context) return <>{children}</>;

  const showTooltip = (event: MouseEvent<HTMLSpanElement>) => {
    context.show(event.currentTarget, content, contentKey, event.clientX);
  };

  const handleEnter = (event: MouseEvent<HTMLSpanElement>) => {
    context.cancelHide();
    showTooltip(event);
  };

  const handleLeave = (event: MouseEvent<HTMLSpanElement>) => {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof HTMLElement &&
      relatedTarget.closest(
        `[data-analytics-tooltip-group="${context.groupId}"]`,
      )
    ) {
      return;
    }
    context.hide();
  };

  return (
    <span
      className={cn(className)}
      data-analytics-tooltip-group={context.groupId}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onMouseMove={showTooltip}
    >
      {children}
    </span>
  );
}
