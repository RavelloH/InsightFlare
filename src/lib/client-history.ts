import { useMemo, useSyncExternalStore } from "react";

const URL_STATE_CHANGE_EVENT = "insightflare:url-state-change";

const urlStateSubscribers = new Set<() => void>();
let urlStateListenersAttached = false;

function handleUrlStateChange() {
  urlStateSubscribers.forEach((subscriber) => subscriber());
}

function subscribeToUrlState(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  urlStateSubscribers.add(onStoreChange);
  if (!urlStateListenersAttached) {
    window.addEventListener("popstate", handleUrlStateChange);
    window.addEventListener(URL_STATE_CHANGE_EVENT, handleUrlStateChange);
    urlStateListenersAttached = true;
  }

  return () => {
    urlStateSubscribers.delete(onStoreChange);
    if (urlStateSubscribers.size === 0 && urlStateListenersAttached) {
      window.removeEventListener("popstate", handleUrlStateChange);
      window.removeEventListener(URL_STATE_CHANGE_EVENT, handleUrlStateChange);
      urlStateListenersAttached = false;
    }
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
