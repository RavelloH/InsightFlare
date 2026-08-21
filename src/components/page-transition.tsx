import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useRouterState } from "@tanstack/react-router";
import { OverlayScrollbars } from "overlayscrollbars";

import { shouldUseNativeScrollbars } from "@/components/ui/overlay-scrollbar";
import {
  type NavigateRequest,
  registerPageTransitionHandler,
} from "@/lib/page-transition";
import { useRouter } from "@/lib/router";

interface PageTransitionProps {
  children: React.ReactNode;
}

function isDashboardDetailRoute(pathname: string): boolean {
  return /\/(?:visitors|sessions)\/detail(?:\/|$)/.test(pathname);
}

function scrollPageToTop(behavior: ScrollBehavior) {
  const dashboardScrollContainer = document.querySelector<HTMLElement>(
    "[data-dashboard-scroll-container]",
  );

  if (dashboardScrollContainer) {
    const scrollTarget =
      (shouldUseNativeScrollbars()
        ? null
        : OverlayScrollbars(dashboardScrollContainer)?.elements().viewport) ??
      dashboardScrollContainer;

    scrollTarget.scrollTo({
      top: 0,
      behavior,
    });
    return;
  }

  window.scrollTo({
    top: 0,
    behavior,
  });
}

export function PageTransition({ children }: PageTransitionProps) {
  const EXIT_DURATION_MS = 280;
  const ENTER_DURATION_MS = 320;
  const resolvedLocation = useRouterState({
    select: (state) => state.resolvedLocation ?? state.location,
  });
  const routerStatus = useRouterState({ select: (state) => state.status });
  const pathname = resolvedLocation.pathname;
  const router = useRouter();
  const reduceMotion = useRef(false);
  const exitingRef = useRef(false);
  const navigationStartedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<NavigateRequest | null>(null);
  const previousPathnameRef = useRef(pathname);
  const [isReady, setIsReady] = useState(false);
  const [transitionState, setTransitionState] = useState<
    "idle" | "enter" | "exit"
  >("idle");
  const routeKey = `${resolvedLocation.pathname}${resolvedLocation.searchStr}${resolvedLocation.hash}`;

  const finishExit = useCallback(() => {
    if (!exitingRef.current) return;
    if (settleTimeoutRef.current) {
      clearTimeout(settleTimeoutRef.current);
      settleTimeoutRef.current = null;
    }
    if (enterTimeoutRef.current) {
      clearTimeout(enterTimeoutRef.current);
      enterTimeoutRef.current = null;
    }
    exitingRef.current = false;
    navigationStartedRef.current = false;
    pendingRef.current = null;
    if (reduceMotion.current) {
      setTransitionState("idle");
      return;
    }
    setTransitionState("enter");
    enterTimeoutRef.current = setTimeout(() => {
      setTransitionState("idle");
      enterTimeoutRef.current = null;
    }, ENTER_DURATION_MS);
  }, []);

  const performNavigation = useCallback(
    (request: NavigateRequest) => {
      if (request.replace) {
        router.replace(request.href, { scroll: request.scroll });
        return;
      }
      router.push(request.href, { scroll: request.scroll });
    },
    [router],
  );

  const startExit = useCallback(
    (request: NavigateRequest) => {
      let currentUrl: URL;
      let nextUrl: URL;
      try {
        currentUrl = new URL(window.location.href);
        nextUrl = new URL(request.href, window.location.href);
      } catch {
        performNavigation(request);
        return;
      }

      if (
        nextUrl.origin === currentUrl.origin &&
        nextUrl.pathname === currentUrl.pathname
      ) {
        performNavigation(request);
        return;
      }

      const current = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
      const destination = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
      if (destination === current) return;

      if (reduceMotion.current) {
        performNavigation(request);
        return;
      }

      if (exitingRef.current) return;
      exitingRef.current = true;
      pendingRef.current = request;
      if (router.preload) {
        void router.preload(request.href).catch(() => undefined);
      }
      setTransitionState("exit");

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        const next = pendingRef.current;
        if (!next) return;
        navigationStartedRef.current = true;
        performNavigation(next);
        // URL changes can complete before a route-key/router-status update is
        // observable (for example after a redirect). Always restore the view.
        settleTimeoutRef.current = setTimeout(finishExit, ENTER_DURATION_MS);
      }, EXIT_DURATION_MS);
    },
    [finishExit, performNavigation],
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reduceMotion.current = media.matches;
    };

    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const unregister = registerPageTransitionHandler((request) =>
      startExit(request),
    );
    setIsReady(true);
    return unregister;
  }, [startExit]);

  useEffect(() => {
    if (!exitingRef.current) return;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    finishExit();
  }, [finishExit, routeKey]);

  useEffect(() => {
    if (
      routerStatus === "idle" &&
      navigationStartedRef.current &&
      exitingRef.current
    ) {
      // A redirect, cancelled navigation, or same-route resolution may not
      // change the resolved location. Do not leave the outgoing view hidden.
      finishExit();
    }
  }, [finishExit, routerStatus]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (enterTimeoutRef.current) {
        clearTimeout(enterTimeoutRef.current);
        enterTimeoutRef.current = null;
      }
      if (settleTimeoutRef.current) {
        clearTimeout(settleTimeoutRef.current);
        settleTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const previousPathname = previousPathnameRef.current;
    previousPathnameRef.current = pathname;
    if (
      isDashboardDetailRoute(previousPathname) ||
      isDashboardDetailRoute(pathname)
    ) {
      return;
    }

    scrollPageToTop(reduceMotion.current ? "auto" : "smooth");
  }, [pathname]);

  return (
    <div
      data-page-transition
      data-page-transition-ready={isReady || undefined}
      data-transition={transitionState}
    >
      {children}
    </div>
  );
}
