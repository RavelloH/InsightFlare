import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PartialOptions } from "overlayscrollbars";
import { OverlayScrollbars } from "overlayscrollbars";

import { AppOverlay } from "@/components/ui/app-overlay";
import {
  OverlayFrame,
  useOverlayStackState,
} from "@/components/ui/layer/layer-manager";
import { LayerPortal } from "@/components/ui/layer/layer-portal";
import { shouldUseNativeScrollbars } from "@/components/ui/overlay-scrollbar";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { cn } from "@/lib/utils";
export const DETAIL_QUERY_PARAM = "detail";
const CLOSE_TRANSLATE_Y_VH = 1.12;
const CLOSE_MIN_DURATION_MS = 360;
const CLOSE_MAX_DURATION_MS = 640;
const CLOSE_TRAVEL_PX_PER_MS = 3;
const DETAIL_DRAWER_OPEN_TRANSITION =
  "transform 720ms linear(0, 0.088 5%, 0.261 10%, 0.441 15%, 0.597 20%, 0.719 25%, 0.81 30%, 0.874 35%, 0.918 40%, 0.948 45%, 0.968 50%, 0.98 55%, 0.988 60%, 0.993 65%, 0.996 70%, 0.998 75%, 0.999 80%, 0.999 85%, 1 90%, 1 95%, 1)";
const CLOSE_TRANSITION_EASING = "cubic-bezier(0.38, 0.05, 0.86, 0.28)";
const STACK_LIFT_PX = 28;
const MAX_STACK_LIFT_DEPTH = 3;
const POINTER_DRAG_THRESHOLD_PX = 6;
const POINTER_GESTURE_RESET_MS = 500;
let nextDetailDrawerInstanceId = 0;
let detailDrawerBodyLockCount = 0;
let detailDrawerPreviousBodyOverflow: string | null = null;
const DETAIL_DRAWER_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "never",
    autoHideSuspend: false,
  },
} satisfies PartialOptions;
const DetailDrawerCloseContext = createContext<(() => void) | null>(null);
const DetailDrawerReadyContext = createContext(true);
interface DetailDrawerProps {
  ariaLabel: string;
  drawerKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  rootClassName?: string;
}
interface DetailModalProps {
  ariaLabel: string;
  modalKey: string;
  onClose: () => void;
  children: ReactNode;
}
interface ContentAreaBounds {
  left: number;
  width: number;
}
export function useDetailDrawerClose() {
  return useContext(DetailDrawerCloseContext);
}
export function useDetailDrawerReady() {
  return useContext(DetailDrawerReadyContext);
}
export function useDetailModalClose() {
  return useDetailDrawerClose();
}
export function useDetailModalReady() {
  return useDetailDrawerReady();
}
export function DetailDrawer({
  ariaLabel,
  drawerKey,
  open,
  onOpenChange,
  children,
  rootClassName,
}: DetailDrawerProps) {
  const [isClosing, setIsClosing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [rendered, setRendered] = useState(open);
  const [isReady, setIsReady] = useState(false);
  const [openAnimationStarted, setOpenAnimationStarted] = useState(false);
  const [isCloseInteractionDisabled, setIsCloseInteractionDisabled] =
    useState(false);
  const [contentAreaBounds, setContentAreaBounds] =
    useState<ContentAreaBounds | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const closeAnimationFrameRef = useRef<number | null>(null);
  const closeTranslateYRef = useRef(0);
  const closeDurationRef = useRef(CLOSE_MIN_DURATION_MS);
  const pointerGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const pointerGestureResetTimerRef = useRef<number | null>(null);
  const isPreparingCloseRef = useRef(false);
  const layerIdRef = useRef<string | null>(null);
  if (layerIdRef.current === null) {
    nextDetailDrawerInstanceId += 1;
    layerIdRef.current = `detail-drawer-${nextDetailDrawerInstanceId}`;
  }
  const layerId = layerIdRef.current;
  const { framesAbove, isTopmost } = useOverlayStackState(layerId);
  const stackDepth = framesAbove;
  const stackLift = -Math.min(stackDepth, MAX_STACK_LIFT_DEPTH) * STACK_LIFT_PX;

  const clearCloseAnimationPending = useCallback(() => {
    if (closeAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(closeAnimationFrameRef.current);
      closeAnimationFrameRef.current = null;
    }
  }, []);

  const getScrollElement = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return null;
    if (shouldUseNativeScrollbars()) return scrollContainer;

    return (
      OverlayScrollbars(scrollContainer)?.elements().viewport ?? scrollContainer
    );
  }, []);

  const resetScrollPosition = useCallback(() => {
    const scrollElement = getScrollElement();
    if (scrollElement) scrollElement.scrollTop = 0;
  }, [getScrollElement]);

  const triggerCloseAnimation = useCallback(() => {
    setIsCloseInteractionDisabled(true);
    closeTranslateYRef.current =
      (getScrollElement()?.scrollTop ?? 0) +
      window.innerHeight * CLOSE_TRANSLATE_Y_VH;
    closeDurationRef.current = Math.min(
      CLOSE_MAX_DURATION_MS,
      Math.max(
        CLOSE_MIN_DURATION_MS,
        Math.round(closeTranslateYRef.current / CLOSE_TRAVEL_PX_PER_MS),
      ),
    );

    if (closeAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(closeAnimationFrameRef.current);
      closeAnimationFrameRef.current = null;
    }

    closeAnimationFrameRef.current = window.requestAnimationFrame(() => {
      closeAnimationFrameRef.current = null;
      setIsClosing(true);
    });
  }, [getScrollElement]);

  const handleClose = useCallback(() => {
    if (!rendered || isClosing || isPreparingCloseRef.current) return;
    isPreparingCloseRef.current = true;
    triggerCloseAnimation();
  }, [isClosing, rendered, triggerCloseAnimation]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }

    if (rendered && !isClosing) {
      triggerCloseAnimation();
    }
  }, [isClosing, open, rendered, triggerCloseAnimation]);

  useEffect(() => {
    if (!open) return;
    setIsClosing(false);
    setIsReady(false);
    setOpenAnimationStarted(false);
    setIsCloseInteractionDisabled(false);
    isPreparingCloseRef.current = false;
    clearCloseAnimationPending();
  }, [clearCloseAnimationPending, drawerKey, open]);

  useEffect(() => {
    if (!open || !rendered || !mounted) return;

    const animationFrame = window.requestAnimationFrame(() => {
      setOpenAnimationStarted(true);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [drawerKey, mounted, open, rendered]);

  useEffect(() => {
    if (!open || !rendered || !mounted) return;

    const animationFrame = window.requestAnimationFrame(resetScrollPosition);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [drawerKey, mounted, open, rendered, resetScrollPosition]);

  useEffect(() => {
    if (!rendered || !mounted) return;

    let animationFrame: number | null = null;
    let observer: ResizeObserver | null = null;
    let observedTarget: HTMLElement | null = null;

    const scheduleUpdate = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        updateBounds();
      });
    };

    const updateBounds = () => {
      const target = document.querySelector<HTMLElement>(
        '[data-slot="sidebar-inset"]',
      );
      if (!target) {
        scheduleUpdate();
        return;
      }

      if (observedTarget !== target) {
        observer?.disconnect();
        observedTarget = target;
        observer = new ResizeObserver(scheduleUpdate);
        observer.observe(target);
      }

      const rect = target.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const nextBounds = {
        left,
        width: Math.max(0, Math.min(rect.width, window.innerWidth - left)),
      };

      setContentAreaBounds((current) => {
        if (
          current &&
          Math.abs(current.left - nextBounds.left) < 0.5 &&
          Math.abs(current.width - nextBounds.width) < 0.5
        ) {
          return current;
        }

        return nextBounds;
      });
    };

    window.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [mounted, rendered]);

  useEffect(() => {
    if (!rendered || isCloseInteractionDisabled) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!isTopmost) return;
        handleClose();
      }
    };

    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [handleClose, isCloseInteractionDisabled, isTopmost, rendered]);

  useEffect(() => {
    if (!rendered) return;

    if (detailDrawerBodyLockCount === 0) {
      detailDrawerPreviousBodyOverflow = document.body.style.overflow;
    }
    detailDrawerBodyLockCount += 1;
    document.body.style.overflow = "hidden";

    return () => {
      detailDrawerBodyLockCount = Math.max(0, detailDrawerBodyLockCount - 1);
      if (detailDrawerBodyLockCount === 0) {
        document.body.style.overflow = detailDrawerPreviousBodyOverflow ?? "";
        detailDrawerPreviousBodyOverflow = null;
      }
    };
  }, [rendered]);

  useEffect(() => {
    if (!rendered || isCloseInteractionDisabled) return;

    const clearPointerGesture = () => {
      pointerGestureRef.current = null;
      if (pointerGestureResetTimerRef.current !== null) {
        window.clearTimeout(pointerGestureResetTimerRef.current);
        pointerGestureResetTimerRef.current = null;
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      clearPointerGesture();
      pointerGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = pointerGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;
      if (
        deltaX * deltaX + deltaY * deltaY >
        POINTER_DRAG_THRESHOLD_PX * POINTER_DRAG_THRESHOLD_PX
      ) {
        gesture.moved = true;
      }
    };

    const schedulePointerGestureReset = (pointerId: number) => {
      if (pointerGestureResetTimerRef.current !== null) {
        window.clearTimeout(pointerGestureResetTimerRef.current);
      }

      pointerGestureResetTimerRef.current = window.setTimeout(() => {
        if (pointerGestureRef.current?.pointerId === pointerId) {
          pointerGestureRef.current = null;
        }
        pointerGestureResetTimerRef.current = null;
      }, POINTER_GESTURE_RESET_MS);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = pointerGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      schedulePointerGestureReset(event.pointerId);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = pointerGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      gesture.moved = true;
      schedulePointerGestureReset(event.pointerId);
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      clearPointerGesture();
    };
  }, [isCloseInteractionDisabled, rendered]);

  const handleCloseFromOutside = useCallback(() => {
    if (!isTopmost) return;
    if (pointerGestureRef.current?.moved) {
      pointerGestureRef.current = null;
      return;
    }
    pointerGestureRef.current = null;
    handleClose();
  }, [handleClose, isTopmost]);

  useEffect(() => {
    return () => {
      isPreparingCloseRef.current = false;
      clearCloseAnimationPending();
    };
  }, [clearCloseAnimationPending]);

  if (!mounted || !rendered) return null;

  const contentAreaStyle = (
    contentAreaBounds
      ? {
          left: contentAreaBounds.left,
          width: contentAreaBounds.width,
        }
      : {
          left: 0,
          width: "100vw",
        }
  ) as CSSProperties;
  const drawer = (
    <DetailDrawerCloseContext.Provider value={handleClose}>
      <DetailDrawerReadyContext.Provider value={isReady}>
        <div
          data-layer-detail-drawer=""
          data-detail-drawer-root=""
          className={cn("pointer-events-none fixed inset-0", rootClassName)}
        >
          <LayerPortal slot="backdrop">
            <AppOverlay
              className={cn(
                "bg-black/50 backdrop-blur-sm will-change-[opacity]",
                isCloseInteractionDisabled && "pointer-events-none",
              )}
              layerId={layerId}
              open={!isClosing}
              onClick={handleCloseFromOutside}
            />
          </LayerPortal>

          <LayerPortal slot="surface">
            <div
              className={cn(
                "fixed inset-y-0",
                isCloseInteractionDisabled && "pointer-events-none",
              )}
              style={contentAreaStyle}
            >
              <VerticalScrollMask
                hostRef={scrollContainerRef}
                className="pointer-events-auto h-full min-h-0"
                contentClassName="min-h-0 overscroll-contain touch-pan-y"
                scrollbarOptions={DETAIL_DRAWER_SCROLLBAR_OPTIONS}
                onClick={handleCloseFromOutside}
              >
                <div className="pointer-events-none relative mx-auto flex max-w-[1400px] items-start gap-6 px-4 pb-[4em] pt-[8em] sm:px-5 md:px-6">
                  <div
                    data-detail-drawer-stack-depth={stackDepth}
                    className="relative min-w-0 flex-1"
                  >
                    <div
                      className={cn(
                        isCloseInteractionDisabled
                          ? "pointer-events-none"
                          : "pointer-events-auto",
                        "relative min-h-[132vh] min-w-0 transform-gpu overflow-hidden rounded-sm border border-border/80 bg-background shadow-[0_-24px_70px_rgba(0,0,0,0.35)]",
                      )}
                      style={{
                        transform: isClosing
                          ? `translate3d(0, ${closeTranslateYRef.current - stackLift}px, 0)`
                          : openAnimationStarted
                            ? `translate3d(0, ${stackLift}px, 0)`
                            : "translate3d(0, 112vh, 0)",
                        transition: isClosing
                          ? `transform ${closeDurationRef.current}ms ${CLOSE_TRANSITION_EASING}`
                          : openAnimationStarted
                            ? DETAIL_DRAWER_OPEN_TRANSITION
                            : undefined,
                        willChange:
                          isClosing || !isReady ? "transform" : "auto",
                      }}
                      onTransitionEnd={(event) => {
                        if (
                          event.target !== event.currentTarget ||
                          event.propertyName !== "transform"
                        ) {
                          return;
                        }

                        if (isClosing) {
                          resetScrollPosition();
                          setRendered(false);
                          isPreparingCloseRef.current = false;
                          onOpenChange(false);
                          return;
                        }

                        setIsReady(true);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      role="dialog"
                      aria-modal="true"
                      aria-label={ariaLabel}
                    >
                      <div className="relative h-full">{children}</div>
                    </div>
                  </div>
                </div>
              </VerticalScrollMask>
            </div>
          </LayerPortal>
        </div>
      </DetailDrawerReadyContext.Provider>
    </DetailDrawerCloseContext.Provider>
  );

  return (
    <OverlayFrame id={layerId} kind="detail-drawer" open={rendered}>
      {drawer}
    </OverlayFrame>
  );
}
export function DetailModal({
  ariaLabel,
  modalKey,
  onClose,
  children,
}: DetailModalProps) {
  return (
    <DetailDrawer
      ariaLabel={ariaLabel}
      drawerKey={modalKey}
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {children}
    </DetailDrawer>
  );
}
