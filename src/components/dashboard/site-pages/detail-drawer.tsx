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
import { motion } from "motion/react";
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

const EXIT_DURATION_MS = 360;
const CLOSE_SCROLL_TOP_THRESHOLD = 2;
const CLOSE_SCROLL_MAX_WAIT_MS = 900;
const STACK_LIFT_PX = 28;
const MAX_STACK_LIFT_DEPTH = 3;
const POINTER_DRAG_THRESHOLD_PX = 6;
const POINTER_GESTURE_RESET_MS = 500;

let nextDetailDrawerInstanceId = 0;

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
  const [isCloseInteractionDisabled, setIsCloseInteractionDisabled] =
    useState(false);
  const [contentAreaBounds, setContentAreaBounds] =
    useState<ContentAreaBounds | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const closeAnimationFrameRef = useRef<number | null>(null);
  const closeScrollFrameRef = useRef<number | null>(null);
  const closeScrollTimeoutRef = useRef<number | null>(null);
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

  const clearCloseScrollPending = useCallback(() => {
    if (closeScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(closeScrollFrameRef.current);
      closeScrollFrameRef.current = null;
    }
    if (closeScrollTimeoutRef.current !== null) {
      window.clearTimeout(closeScrollTimeoutRef.current);
      closeScrollTimeoutRef.current = null;
    }
  }, []);

  const clearCloseAnimationPending = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
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

  const triggerCloseAnimation = useCallback(() => {
    setIsCloseInteractionDisabled(true);

    if (closeAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(closeAnimationFrameRef.current);
      closeAnimationFrameRef.current = null;
    }

    closeAnimationFrameRef.current = window.requestAnimationFrame(() => {
      closeAnimationFrameRef.current = null;
      setIsClosing(true);
    });
  }, []);

  const handleClose = useCallback(() => {
    if (!rendered || isClosing || isPreparingCloseRef.current) return;
    isPreparingCloseRef.current = true;
    setIsCloseInteractionDisabled(true);
    const scrollElement = getScrollElement();

    const getScrollTop = () => {
      if (scrollElement) return scrollElement.scrollTop;
      return window.scrollY || document.documentElement.scrollTop || 0;
    };

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearCloseScrollPending();
      triggerCloseAnimation();
    };

    if (getScrollTop() <= CLOSE_SCROLL_TOP_THRESHOLD) {
      finish();
      return;
    }

    if (scrollElement) {
      scrollElement.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    const checkReachedTop = () => {
      if (getScrollTop() <= CLOSE_SCROLL_TOP_THRESHOLD) {
        finish();
        return;
      }
      closeScrollFrameRef.current =
        window.requestAnimationFrame(checkReachedTop);
    };

    closeScrollFrameRef.current = window.requestAnimationFrame(checkReachedTop);
    closeScrollTimeoutRef.current = window.setTimeout(() => {
      finish();
    }, CLOSE_SCROLL_MAX_WAIT_MS);
  }, [
    clearCloseScrollPending,
    getScrollElement,
    isClosing,
    rendered,
    triggerCloseAnimation,
  ]);

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
    setIsCloseInteractionDisabled(false);
    isPreparingCloseRef.current = false;
    clearCloseScrollPending();
    clearCloseAnimationPending();
  }, [clearCloseAnimationPending, clearCloseScrollPending, drawerKey, open]);

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

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [handleClose, isCloseInteractionDisabled, isTopmost, rendered]);

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
    if (!isClosing) return;

    closeTimerRef.current = window.setTimeout(() => {
      setRendered(false);
      setIsClosing(false);
      setIsReady(false);
      setIsCloseInteractionDisabled(false);
      isPreparingCloseRef.current = false;
      onOpenChange(false);
    }, EXIT_DURATION_MS);

    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [isClosing, onOpenChange]);

  useEffect(() => {
    return () => {
      isPreparingCloseRef.current = false;
      clearCloseScrollPending();
      clearCloseAnimationPending();
    };
  }, [clearCloseAnimationPending, clearCloseScrollPending]);

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
              className="bg-black/50 backdrop-blur-sm"
              layerId={layerId}
              open={!isClosing}
              onClick={handleCloseFromOutside}
            />
          </LayerPortal>

          <LayerPortal slot="surface">
            <div className="fixed inset-y-0" style={contentAreaStyle}>
              <VerticalScrollMask
                hostRef={scrollContainerRef}
                className="h-full min-h-0"
                contentClassName="min-h-0 overscroll-contain"
                scrollbarOptions={DETAIL_DRAWER_SCROLLBAR_OPTIONS}
                onClick={handleCloseFromOutside}
              >
                <div className="pointer-events-none relative mx-auto flex max-w-[1400px] items-start gap-6 px-4 pb-[4em] pt-[8em] sm:px-5 md:px-6">
                  <motion.div
                    ref={contentRef}
                    initial={{
                      top: 0,
                      y: "112vh",
                    }}
                    animate={
                      isClosing
                        ? { top: 0, y: "112vh" }
                        : { top: stackLift, y: "0vh" }
                    }
                    transition={
                      isClosing
                        ? { duration: 0.36, ease: [0.38, 0.05, 0.86, 0.28] }
                        : {
                            type: "spring",
                            stiffness: 170,
                            damping: 24,
                            mass: 0.92,
                          }
                    }
                    data-detail-drawer-stack-depth={stackDepth}
                    className={cn(
                      isCloseInteractionDisabled
                        ? "pointer-events-none"
                        : "pointer-events-auto",
                      "relative min-h-[132vh] min-w-0 flex-1 transform-gpu overflow-hidden rounded-sm border border-border/80 bg-background shadow-[0_-24px_70px_rgba(0,0,0,0.35)]",
                    )}
                    style={{
                      willChange: isClosing || !isReady ? "transform" : "auto",
                    }}
                    onAnimationComplete={() => {
                      if (!isClosing) {
                        setIsReady(true);
                      }
                    }}
                    onClick={(event) => event.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                    aria-label={ariaLabel}
                  >
                    <div className="relative h-full">{children}</div>
                  </motion.div>
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
