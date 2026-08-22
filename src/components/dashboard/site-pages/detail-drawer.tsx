import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { PartialOptions } from "overlayscrollbars";
import { OverlayScrollbars } from "overlayscrollbars";

import {
  DETAIL_DRAWER_Z_INDEX,
  getDetailDrawerLayerSnapshot,
  hasHigherFloatingLayer,
  removeDetailDrawerLayer,
  setDetailDrawerLayer,
  subscribeDetailDrawerLayers,
} from "@/components/dashboard/site-pages/floating-layer";
import { ModalOverlay } from "@/components/ui/modal-overlay";
import {
  prepareNativeScrollbarHost,
  shouldUseNativeScrollbars,
} from "@/components/ui/overlay-scrollbar";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { cn } from "@/lib/utils";

export const DETAIL_QUERY_PARAM = "detail";

const EXIT_DURATION_MS = 360;
const CLOSE_SCROLL_TOP_THRESHOLD = 2;
const CLOSE_SCROLL_MAX_WAIT_MS = 900;
const STACK_LIFT_PX = 28;
const MAX_STACK_LIFT_DEPTH = 3;

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
  zIndex?: number;
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
  zIndex,
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
  const scrollbarRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(
    null,
  );
  const isPreparingCloseRef = useRef(false);
  const layerIdRef = useRef<string | null>(null);
  if (layerIdRef.current === null) {
    nextDetailDrawerInstanceId += 1;
    layerIdRef.current = `detail-drawer-${nextDetailDrawerInstanceId}`;
  }
  const layerId = layerIdRef.current;
  const baseLayerZIndex = zIndex ?? DETAIL_DRAWER_Z_INDEX;
  const detailDrawerLayers = useSyncExternalStore(
    subscribeDetailDrawerLayers,
    getDetailDrawerLayerSnapshot,
    getDetailDrawerLayerSnapshot,
  );
  const currentLayer = detailDrawerLayers.find((layer) => layer.id === layerId);
  const layerZIndex = currentLayer?.effectiveZIndex ?? baseLayerZIndex;
  const stackDepth = currentLayer
    ? detailDrawerLayers.filter(
        (layer) =>
          layer.id !== layerId &&
          (layer.effectiveZIndex > currentLayer.effectiveZIndex ||
            (layer.effectiveZIndex === currentLayer.effectiveZIndex &&
              layer.order > currentLayer.order)),
      ).length
    : 0;
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
      scrollbarRef.current?.elements().viewport ??
      OverlayScrollbars(scrollContainer)?.elements().viewport ??
      scrollContainer
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
    if (!rendered) return;
    setDetailDrawerLayer(layerId, baseLayerZIndex);
    return () => {
      removeDetailDrawerLayer(layerId);
    };
  }, [baseLayerZIndex, layerId, rendered]);

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
        if (hasHigherFloatingLayer(layerZIndex)) return;
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
  }, [handleClose, isCloseInteractionDisabled, layerZIndex, rendered]);

  useEffect(() => {
    if (!rendered || isCloseInteractionDisabled) return;

    let shouldSuppressClick = false;
    let clickSuppressTimer: number | null = null;

    const clearClickSuppression = () => {
      if (clickSuppressTimer !== null) {
        window.clearTimeout(clickSuppressTimer);
      }
      clickSuppressTimer = window.setTimeout(() => {
        shouldSuppressClick = false;
        clickSuppressTimer = null;
      }, 0);
    };

    const isInsideContent = (target: EventTarget | null) => {
      const content = contentRef.current;
      return target instanceof Node && Boolean(content?.contains(target));
    };

    const stopOutsideEvent = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    };

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (isInsideContent(event.target)) return;
      if (hasHigherFloatingLayer(layerZIndex)) return;
      shouldSuppressClick = true;
      clearClickSuppression();
      stopOutsideEvent(event);
      handleClose();
    };

    const handleOutsideClick = (event: MouseEvent) => {
      if (isInsideContent(event.target)) return;
      if (hasHigherFloatingLayer(layerZIndex)) return;
      if (shouldSuppressClick) {
        stopOutsideEvent(event);
        return;
      }
      stopOutsideEvent(event);
      handleClose();
    };

    window.addEventListener("pointerdown", handleOutsidePointerDown, true);
    window.addEventListener("click", handleOutsideClick, true);

    return () => {
      window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
      window.removeEventListener("click", handleOutsideClick, true);
      if (clickSuppressTimer !== null) {
        window.clearTimeout(clickSuppressTimer);
      }
    };
  }, [handleClose, isCloseInteractionDisabled, layerZIndex, rendered]);

  useEffect(() => {
    if (!mounted || !rendered) return;

    const host = scrollContainerRef.current;
    if (!host) return;
    if (prepareNativeScrollbarHost(host)) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, DETAIL_DRAWER_SCROLLBAR_OPTIONS);

    if (existing) {
      existing.options(DETAIL_DRAWER_SCROLLBAR_OPTIONS);
    }
    scrollbarRef.current = instance;

    const frame = window.requestAnimationFrame(() => {
      instance.update();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (!existing) {
        instance.destroy();
      }
      if (scrollbarRef.current === instance) {
        scrollbarRef.current = null;
      }
    };
  }, [drawerKey, mounted, rendered]);

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
  const rootStyle = { zIndex: layerZIndex } as const;

  const drawer = (
    <DetailDrawerCloseContext.Provider value={handleClose}>
      <DetailDrawerReadyContext.Provider value={isReady}>
        <div
          data-dashboard-floating-layer="detail-drawer"
          data-dashboard-floating-layer-z={layerZIndex}
          data-detail-drawer-root=""
          className={cn("fixed inset-0 z-[96]", rootClassName)}
          style={rootStyle}
        >
          <ModalOverlay
            className="z-0 bg-black/50 backdrop-blur-sm"
            layerId={layerId}
            open={!isClosing}
            zIndex={0}
            onClick={handleClose}
          />

          <div className="fixed inset-y-0 z-10" style={contentAreaStyle}>
            <VerticalScrollMask
              hostRef={scrollContainerRef}
              className="h-full min-h-0"
              contentClassName="h-full min-h-0 overscroll-contain"
              scrollbarOptions={DETAIL_DRAWER_SCROLLBAR_OPTIONS}
              onClick={handleClose}
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
        </div>
      </DetailDrawerReadyContext.Provider>
    </DetailDrawerCloseContext.Provider>
  );

  return createPortal(drawer, document.body);
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
