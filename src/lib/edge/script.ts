interface BuildTrackerScriptOptions {
  siteId: string;
  isEUMode: boolean;
  trackQueryParams: boolean;
  trackHash: boolean;
  domainWhitelist: string[];
  pathBlacklist: string[];
  ignoreDoNotTrack: boolean;
}

export function buildTrackerScript(options: BuildTrackerScriptOptions): string {
  const isEUModeLiteral = options.isEUMode ? "true" : "false";
  const trackQueryParamsLiteral = options.trackQueryParams ? "true" : "false";
  const trackHashLiteral = options.trackHash ? "true" : "false";
  const ignoreDoNotTrackLiteral = options.ignoreDoNotTrack ? "true" : "false";
  const siteIdLiteral = JSON.stringify(options.siteId);
  const domainWhitelistLiteral = JSON.stringify(options.domainWhitelist);
  const pathBlacklistLiteral = JSON.stringify(options.pathBlacklist);

  return `(() => {
  "use strict";

  const IS_EU_MODE = ${isEUModeLiteral};
  const SITE_ID = ${siteIdLiteral};
  const TRACK_QUERY_PARAMS = ${trackQueryParamsLiteral};
  const TRACK_HASH = ${trackHashLiteral};
  const DOMAIN_WHITELIST = ${domainWhitelistLiteral};
  const PATH_BLACKLIST = ${pathBlacklistLiteral};
  const IGNORE_DO_NOT_TRACK = ${ignoreDoNotTrackLiteral};
  const ROUTE_CHANGE_DELAY_MS = 300;
  const scriptEl = document.currentScript;
  if (!scriptEl || !scriptEl.src) {
    return;
  }
  const scriptUrl = new URL(scriptEl.src);
  const collectUrl = new URL("/collect", scriptUrl.origin).toString();
  const siteId = SITE_ID;
  const scriptKeyVersion = "2";
  const TRACKER_INIT_KEY = "__if_tracker_init_state__";
  const hasRandomUUID = Boolean(window.crypto && typeof window.crypto.randomUUID === "function");

  function shortHash(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  let eventCounter = 0;

  function createEventId() {
    if (hasRandomUUID) {
      return window.crypto.randomUUID();
    }
    eventCounter += 1;
    return "if_evt_" + Date.now().toString(36) + "_" + eventCounter.toString(36);
  }

  function createStoredIdentity() {
    if (hasRandomUUID) {
      return window.crypto.randomUUID();
    }
    return "if_";
  }

  function normalizeHostRule(rule) {
    const normalized = String(rule || "")
      .trim()
      .toLowerCase()
      .replace(/^\\.+|\\.+$/g, "");
    if (!normalized || normalized.includes("*")) return "";
    return normalized;
  }

  function normalizePathRule(rule) {
    let normalized = String(rule || "").trim();
    if (!normalized) return "";
    if (!normalized.startsWith("/")) {
      normalized = "/" + normalized.replace(/^\\/+/, "");
    }
    normalized = normalized.replace(/\\/{2,}/g, "/");
    return normalized;
  }

  const normalizedDomainWhitelist = DOMAIN_WHITELIST.map(normalizeHostRule).filter(Boolean);
  const normalizedPathBlacklist = PATH_BLACKLIST.map(normalizePathRule).filter(Boolean);

  function isHostnameAllowed(hostname) {
    if (normalizedDomainWhitelist.length === 0) return true;
    const normalizedHost = String(hostname || "").trim().toLowerCase();
    if (!normalizedHost) return false;
    for (const rule of normalizedDomainWhitelist) {
      if (normalizedHost === rule) {
        return true;
      }
    }
    return false;
  }

  function matchesPathRule(pathname, rule) {
    if (!rule) return false;
    return pathname.startsWith(rule);
  }

  function isPathBlocked(pathname) {
    for (const rule of normalizedPathBlacklist) {
      if (matchesPathRule(pathname, rule)) return true;
    }
    return false;
  }

  function isDoNotTrackEnabled() {
    const normalized = String(navigator.doNotTrack || "").trim().toLowerCase();
    return normalized === "1" || normalized === "yes";
  }

  function shouldTrackLocation(href) {
    const targetUrl = href ? new URL(href, window.location.href) : new URL(window.location.href);
    const pathname = targetUrl.pathname || "/";
    if (!isHostnameAllowed(targetUrl.hostname || "")) return false;
    if (isPathBlocked(pathname)) return false;
    return true;
  }

  const storageSeed = hasRandomUUID
    ? shortHash(window.location.hostname + "|" + siteId + "|" + scriptKeyVersion)
    : "fixed";
  const visitorStorageKey = "__if_v_" + storageSeed;
  const sessionStorageKey = "__if_s_" + storageSeed;

  function loadOrCreate(storage, key) {
    const existed = storage.getItem(key);
    if (existed) return existed;
    const next = createStoredIdentity();
    storage.setItem(key, next);
    return next;
  }

  if (!IGNORE_DO_NOT_TRACK && isDoNotTrackEnabled()) {
    return;
  }

  if (!isHostnameAllowed(window.location.hostname || "")) {
    return;
  }

  const existingTracker = window[TRACKER_INIT_KEY];
  if (existingTracker) {
    return;
  }
  window[TRACKER_INIT_KEY] = {
    siteId,
    version: scriptKeyVersion,
    installedAt: Date.now()
  };

  let visitorId = "";
  let sessionId = "";
  if (!IS_EU_MODE) {
    visitorId = loadOrCreate(window.localStorage, visitorStorageKey);
    sessionId = loadOrCreate(window.sessionStorage, sessionStorageKey);
  }

  function normalizeReferrerDetail(value) {
    return String(value || "").trim();
  }

  function normalizeReferrerHost(value) {
    const referrer = normalizeReferrerDetail(value);
    if (!referrer) return "";
    try {
      return new URL(referrer, window.location.href).hostname || "";
    } catch (_error) {
      return "";
    }
  }

  function payloadBase(eventType, durationMs, href, referrerDetailOverride) {
    const url = href ? new URL(href, window.location.href) : new URL(window.location.href);
    const query = TRACK_QUERY_PARAMS ? url.search || "" : "";
    const hash = TRACK_HASH ? url.hash || "" : "";
    const refererDetail = normalizeReferrerDetail(referrerDetailOverride);
    return {
      eventId: createEventId(),
      eventType,
      timestamp: Date.now(),
      pathname: url.pathname || "/",
      query,
      hash,
      hostname: url.hostname || "",
      title: document.title || "",
      language: navigator.language || "",
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || "",
      screenWidth: window.screen ? window.screen.width : null,
      screenHeight: window.screen ? window.screen.height : null,
      referer: normalizeReferrerHost(refererDetail),
      refererDetail,
      visitorId,
      sessionId,
      durationMs,
      siteId,
      utmSource: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_source") || "" : "",
      utmMedium: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_medium") || "" : "",
      utmCampaign: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_campaign") || "" : "",
      utmTerm: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_term") || "" : "",
      utmContent: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_content") || "" : ""
    };
  }

  let routeStartedAt = Date.now();
  let activeDurationBeforePauseMs = 0;
  let activeStartedAt = document.visibilityState === "hidden" ? 0 : routeStartedAt;
  let currentViewHref = window.location.href;
  let currentViewReferrerDetail = document.referrer || "";
  let didSendUnloadForCurrentView = false;

  function send(eventType, useBeacon, options) {
    const href = options && typeof options.href === "string" ? options.href : undefined;
    if (!shouldTrackLocation(href)) return;
    const durationMsFromOptions =
      options && typeof options.durationMs === "number" && Number.isFinite(options.durationMs)
        ? options.durationMs
        : null;
    const durationMs = durationMsFromOptions === null
      ? Math.max(0, Date.now() - routeStartedAt)
      : Math.max(0, Math.floor(durationMsFromOptions));
    const referrerDetail =
      options && typeof options.referrerDetail === "string"
        ? options.referrerDetail
        : currentViewReferrerDetail;
    const payload = payloadBase(eventType, durationMs, href, referrerDetail);
    const body = JSON.stringify(payload);

    if (useBeacon) {
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

  function buildRouteKey(href) {
    const url = href ? new URL(href, window.location.href) : new URL(window.location.href);
    const parts = [url.pathname || "/"];
    if (TRACK_QUERY_PARAMS) parts.push(url.search || "");
    if (TRACK_HASH) parts.push(url.hash || "");
    return parts.join("|");
  }

  let lastRouteKey = buildRouteKey(currentViewHref);
  let routeChangeTimer = 0;
  let pendingRouteKey = "";
  let pendingRouteHref = "";

  function resetPendingRoute() {
    pendingRouteHref = "";
    pendingRouteKey = "";
  }

  function queuePendingRoute(href, routeKey) {
    pendingRouteHref = href;
    pendingRouteKey = routeKey;
  }

  function readPendingRoute() {
    const href = pendingRouteHref || window.location.href;
    const routeKey = pendingRouteKey || buildRouteKey(href);
    resetPendingRoute();
    return { href, routeKey };
  }

  function pauseActiveDuration(now) {
    if (activeStartedAt <= 0) {
      return;
    }
    const pausedAt = Number.isFinite(now) ? Math.floor(now) : Date.now();
    activeDurationBeforePauseMs += Math.max(0, pausedAt - activeStartedAt);
    activeStartedAt = 0;
  }

  function resumeActiveDuration(now) {
    if (activeStartedAt > 0) {
      return;
    }
    const resumedAt = Number.isFinite(now) ? Math.floor(now) : Date.now();
    activeStartedAt = resumedAt;
  }

  function currentViewDurationMs(now) {
    const at = Number.isFinite(now) ? Math.floor(now) : Date.now();
    const activeTail = activeStartedAt > 0 ? Math.max(0, at - activeStartedAt) : 0;
    return Math.max(0, Math.floor(activeDurationBeforePauseMs + activeTail));
  }

  function completeCurrentView(eventType, useBeacon, completedAt, forceDurationMs) {
    const endAt = Number.isFinite(completedAt) ? Math.floor(completedAt) : Date.now();
    const durationMs = typeof forceDurationMs === "number"
      ? Math.max(0, Math.floor(forceDurationMs))
      : currentViewDurationMs(endAt);
    send(eventType, useBeacon, {
      href: currentViewHref,
      referrerDetail: currentViewReferrerDetail,
      durationMs
    });
  }

  function moveToView(nextHref, startedAt) {
    const nextStartedAt = Number.isFinite(startedAt) ? Math.floor(startedAt) : Date.now();
    const previousHref = currentViewHref;
    currentViewHref = nextHref;
    currentViewReferrerDetail = previousHref;
    routeStartedAt = nextStartedAt;
    activeDurationBeforePauseMs = 0;
    activeStartedAt = document.visibilityState === "hidden" ? 0 : nextStartedAt;
    lastRouteKey = buildRouteKey(nextHref);
    didSendUnloadForCurrentView = false;
  }

  function commitRouteChange(nextHref, nextRouteKey, useBeacon) {
    if (!nextRouteKey || nextRouteKey === lastRouteKey) {
      return;
    }
    const now = Date.now();
    completeCurrentView("route_change", useBeacon, now);
    moveToView(nextHref, now);
    lastRouteKey = nextRouteKey;
  }

  function onRouteChange() {
    const nextHref = window.location.href;
    const nextRouteKey = buildRouteKey(nextHref);
    if (nextRouteKey === lastRouteKey) return;
    queuePendingRoute(nextHref, nextRouteKey);
    if (routeChangeTimer) {
      window.clearTimeout(routeChangeTimer);
    }
    routeChangeTimer = window.setTimeout(() => {
      routeChangeTimer = 0;
      const pending = readPendingRoute();
      commitRouteChange(pending.href, pending.routeKey, false);
    }, ROUTE_CHANGE_DELAY_MS);
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
  if (TRACK_HASH) {
    window.addEventListener("hashchange", onRouteChange);
  }

  function sendExitEvent(eventType) {
    if (didSendUnloadForCurrentView) {
      return;
    }
    didSendUnloadForCurrentView = true;
    const now = Date.now();
    pauseActiveDuration(now);
    const durationMs = currentViewDurationMs(now);
    completeCurrentView(eventType, true, now, durationMs);
    routeStartedAt = now;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      const now = Date.now();
      pauseActiveDuration(now);
      if (routeChangeTimer) {
        window.clearTimeout(routeChangeTimer);
        routeChangeTimer = 0;
        const pending = readPendingRoute();
        commitRouteChange(pending.href, pending.routeKey, true);
      }
      return;
    }
    if (document.visibilityState === "visible") {
      const now = Date.now();
      resumeActiveDuration(now);
    }
  });

  window.addEventListener("pagehide", () => {
    if (routeChangeTimer) {
      window.clearTimeout(routeChangeTimer);
      routeChangeTimer = 0;
      const pending = readPendingRoute();
      commitRouteChange(pending.href, pending.routeKey, true);
    }
    sendExitEvent("unload");
  });

  window.addEventListener("pageshow", () => {
    const now = Date.now();
    didSendUnloadForCurrentView = false;
    resumeActiveDuration(now);
  });

  send("pageview", false, {
    href: currentViewHref,
    referrerDetail: currentViewReferrerDetail,
    durationMs: 0
  });
})();`;
}
