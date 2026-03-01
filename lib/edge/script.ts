export function buildTrackerScript(options: { isEUMode: boolean }): string {
  const isEUModeLiteral = options.isEUMode ? "true" : "false";

  return `(() => {
  "use strict";

  const IS_EU_MODE = ${isEUModeLiteral};
  const STARTED_AT = Date.now();
  const scriptEl = document.currentScript;
  const scriptUrl = new URL((scriptEl && scriptEl.src) || "/script.js", window.location.href);
  const collectUrl = new URL("/collect", scriptUrl.origin).toString();
  const siteId = scriptUrl.searchParams.get("siteId") || window.location.hostname;
  const teamId = scriptUrl.searchParams.get("teamId") || "";
  const scriptKeyVersion = scriptUrl.searchParams.get("v") || "1";

  function shortHash(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "id_" + Math.random().toString(36).slice(2) + "_" + Date.now().toString(36);
  }

  const storageSeed = shortHash(window.location.hostname + "|" + siteId + "|" + scriptKeyVersion);
  const visitorStorageKey = "__if_v_" + storageSeed;
  const sessionStorageKey = "__if_s_" + storageSeed;

  function loadOrCreate(storage, key) {
    try {
      const existed = storage.getItem(key);
      if (existed) return existed;
      const next = randomId();
      storage.setItem(key, next);
      return next;
    } catch (_error) {
      return "";
    }
  }

  let visitorId = "";
  let sessionId = "";
  if (!IS_EU_MODE) {
    visitorId = loadOrCreate(window.localStorage, visitorStorageKey);
    sessionId = loadOrCreate(window.sessionStorage, sessionStorageKey);
  }

  function payloadBase(eventType, durationMs) {
    const url = new URL(window.location.href);
    return {
      eventId: randomId(),
      eventType,
      timestamp: Date.now(),
      pathname: url.pathname || "/",
      query: url.search || "",
      hash: url.hash || "",
      hostname: window.location.hostname || "",
      title: document.title || "",
      language: navigator.language || "",
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || "",
      screenWidth: window.screen ? window.screen.width : null,
      screenHeight: window.screen ? window.screen.height : null,
      referer: document.referrer || "",
      refererDetail: document.referrer || "",
      visitorId,
      sessionId,
      durationMs,
      teamId,
      siteId,
      utmSource: url.searchParams.get("utm_source") || "",
      utmMedium: url.searchParams.get("utm_medium") || "",
      utmCampaign: url.searchParams.get("utm_campaign") || "",
      utmTerm: url.searchParams.get("utm_term") || "",
      utmContent: url.searchParams.get("utm_content") || ""
    };
  }

  function send(eventType, useBeacon) {
    const durationMs = Math.max(0, Date.now() - STARTED_AT);
    const payload = payloadBase(eventType, durationMs);
    const body = JSON.stringify(payload);

    if (useBeacon && navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(collectUrl, blob);
      return;
    }

    fetch(collectUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      mode: "cors",
      credentials: "omit",
      keepalive: useBeacon
    }).catch(() => {
      // ignore transport errors in the tracker path
    });
  }

  let lastRouteKey = window.location.pathname + window.location.search + window.location.hash;
  function onRouteChange() {
    const nextRouteKey = window.location.pathname + window.location.search + window.location.hash;
    if (nextRouteKey === lastRouteKey) return;
    lastRouteKey = nextRouteKey;
    send("route_change", false);
  }

  const originalPushState = history.pushState;
  history.pushState = function pushStateProxy() {
    const result = originalPushState.apply(this, arguments);
    queueMicrotask(onRouteChange);
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function replaceStateProxy() {
    const result = originalReplaceState.apply(this, arguments);
    queueMicrotask(onRouteChange);
    return result;
  };

  window.addEventListener("popstate", onRouteChange);
  window.addEventListener("hashchange", onRouteChange);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      send("hidden", true);
    }
  });

  window.addEventListener("pagehide", () => {
    send("unload", true);
  });

  send("pageview", false);
})();`;
}
