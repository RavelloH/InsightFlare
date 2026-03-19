"use client";

import { useMemo, useSyncExternalStore } from "react";

const URL_STATE_CHANGE_EVENT = "insightflare:url-state-change";

function subscribeToUrlState(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleStoreChange = () => {
    onStoreChange();
  };

  window.addEventListener("popstate", handleStoreChange);
  window.addEventListener(URL_STATE_CHANGE_EVENT, handleStoreChange);

  return () => {
    window.removeEventListener("popstate", handleStoreChange);
    window.removeEventListener(URL_STATE_CHANGE_EVENT, handleStoreChange);
  };
}

function getSearchSnapshot(): string {
  if (typeof window === "undefined") return "";
  return window.location.search;
}

export function replaceUrlWithoutNavigation(target: string): void {
  if (typeof window === "undefined") return;

  const nextUrl = new URL(target, window.location.href);
  const nextLocation = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextLocation === currentLocation) return;

  window.history.replaceState(window.history.state, "", nextLocation);
  window.dispatchEvent(new Event(URL_STATE_CHANGE_EVENT));
}

export function pushUrlWithoutNavigation(target: string): void {
  if (typeof window === "undefined") return;

  const nextUrl = new URL(target, window.location.href);
  const nextLocation = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextLocation === currentLocation) return;

  window.history.pushState(window.history.state, "", nextLocation);
  window.dispatchEvent(new Event(URL_STATE_CHANGE_EVENT));
}

export function useLiveSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(
    subscribeToUrlState,
    getSearchSnapshot,
    () => "",
  );

  return useMemo(() => new URLSearchParams(search), [search]);
}
