import { type RefObject, useEffect } from "react";

import { registerSkeletonInteraction } from "./skeleton-interaction";

const ROW_SELECTOR = "tr[data-skeleton-motion]";
const VISIBLE_ATTRIBUTE = "data-skeleton-visible";

/**
 * Keep the skeleton geometry in the document. Only the decorative shimmer is
 * enhanced, after commit, and only on rows that actually intersect the viewport.
 */
export function observeSkeletonRows(table: HTMLTableElement): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};

  const observed = new Set<Element>();
  const pending = new Set<Element>();
  let cancelIdle: (() => void) | undefined;
  let disposed = false;
  let unregisterInteraction: (() => void) | undefined;

  const schedule = () => {
    if (disposed || cancelIdle || pending.size === 0) return;
    const run = () => {
      cancelIdle = undefined;
      if (disposed) return;
      for (const row of pending) {
        if (observed.has(row) && table.contains(row)) {
          row.setAttribute(VISIBLE_ATTRIBUTE, "true");
        }
      }
      pending.clear();
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback((deadline) => {
        cancelIdle = undefined;
        if (deadline.timeRemaining() < 5) {
          schedule();
          return;
        }
        run();
      });
      cancelIdle = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(run, 80);
      cancelIdle = () => window.clearTimeout(id);
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      if (disposed) return;
      for (const { target, isIntersecting } of entries) {
        if (!observed.has(target)) continue;
        if (isIntersecting) {
          pending.add(target);
        } else {
          pending.delete(target);
          target.setAttribute(VISIBLE_ATTRIBUTE, "false");
        }
      }
      schedule();
    },
    { threshold: 0.01 },
  );

  const reconcile = () => {
    if (disposed) return;
    const rows = new Set(table.querySelectorAll(ROW_SELECTOR));
    for (const row of observed) {
      if (!rows.has(row)) {
        observer.unobserve(row);
        observed.delete(row);
        pending.delete(row);
        row.removeAttribute(VISIBLE_ATTRIBUTE);
      }
    }
    for (const row of rows) {
      if (observed.has(row)) continue;
      observed.add(row);
      observer.observe(row);
    }
    if (observed.size > 0 && !unregisterInteraction) {
      unregisterInteraction = registerSkeletonInteraction(table);
    } else if (observed.size === 0 && unregisterInteraction) {
      unregisterInteraction();
      unregisterInteraction = undefined;
    }
  };
  // The table body's presence transition may mount the next page of rows
  // after this effect. Watch structural changes only, never animated styles.
  const mutations =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(reconcile);
  mutations?.observe(table, { childList: true, subtree: true });
  reconcile();

  return () => {
    disposed = true;
    unregisterInteraction?.();
    cancelIdle?.();
    observer.disconnect();
    mutations?.disconnect();
    for (const row of observed) row.removeAttribute(VISIBLE_ATTRIBUTE);
    pending.clear();
    observed.clear();
  };
}

export function useSkeletonRowMotion(
  table: RefObject<HTMLTableElement | null>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || !table.current) return;
    return observeSkeletonRows(table.current);
  }, [table, enabled]);
}
