interface BuildTrackerScriptOptions {
  siteId: string;
  isEUMode: boolean;
  trackQueryParams: boolean;
  trackHash: boolean;
  ignoreDoNotTrack: boolean;
}

export function buildTrackerScript(options: BuildTrackerScriptOptions): string {
  const siteIdLiteral = JSON.stringify(options.siteId);
  const isEUModeLiteral = options.isEUMode ? "true" : "false";
  const trackQueryParamsLiteral = options.trackQueryParams ? "true" : "false";
  const trackHashLiteral = options.trackHash ? "true" : "false";
  const ignoreDoNotTrackLiteral = options.ignoreDoNotTrack ? "true" : "false";

  return `(() => {
  "use strict";

  const SITE_ID = ${siteIdLiteral};
  const IS_EU_MODE = ${isEUModeLiteral};
  const TRACK_QUERY_PARAMS = ${trackQueryParamsLiteral};
  const TRACK_HASH = ${trackHashLiteral};
  const IGNORE_DO_NOT_TRACK = ${ignoreDoNotTrackLiteral};
  const INSTALL_KEY = "__insightflare_tracker_v3__";
  const VISITOR_KEY = "__insightflare_visitor_" + SITE_ID + "__";
  const scriptEl = document.currentScript;
  if (!scriptEl || !(scriptEl instanceof HTMLScriptElement) || !scriptEl.src) return;

  if (!IGNORE_DO_NOT_TRACK) {
    const dnt = String(navigator.doNotTrack || "").trim().toLowerCase();
    if (dnt === "1" || dnt === "yes") return;
  }

  if (window[INSTALL_KEY]) return;

  const scriptUrl = new URL(scriptEl.src);
  const collectUrl = new URL("/collect", scriptUrl.origin).toString();
  const visitorId = IS_EU_MODE ? "" : loadOrCreateVisitorId();

  function loadOrCreateVisitorId() {
    const existing = window.localStorage.getItem(VISITOR_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.localStorage.setItem(VISITOR_KEY, next);
    return next;
  }

  function routeKey(href) {
    const url = new URL(href, window.location.href);
    return [
      url.pathname || "/",
      TRACK_QUERY_PARAMS ? url.search || "" : "",
      TRACK_HASH ? url.hash || "" : "",
    ].join("|");
  }

  function pagePayloadBase(kind, href, referrerUrl, startedAt) {
    const url = new URL(href, window.location.href);
    return {
      siteId: SITE_ID,
      kind,
      visitId: currentVisit.id,
      timestamp: Date.now(),
      startedAt,
      pathname: url.pathname || "/",
      query: TRACK_QUERY_PARAMS ? url.search || "" : "",
      hash: TRACK_HASH ? url.hash || "" : "",
      hostname: url.hostname || "",
      title: document.title || "",
      language: navigator.language || "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      screenWidth: window.screen?.width ?? null,
      screenHeight: window.screen?.height ?? null,
      referrerUrl: String(referrerUrl || ""),
      visitorId,
      utmSource: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_source") || "" : "",
      utmMedium: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_medium") || "" : "",
      utmCampaign: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_campaign") || "" : "",
      utmTerm: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_term") || "" : "",
      utmContent: TRACK_QUERY_PARAMS ? url.searchParams.get("utm_content") || "" : ""
    };
  }

  function send(payload, useBeacon) {
    const body = JSON.stringify(payload);
    if (useBeacon && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(collectUrl, new Blob([body], { type: "application/json" }));
      return;
    }

    fetch(collectUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      mode: "cors",
      credentials: "omit",
      keepalive: useBeacon
    }).catch(() => {});
  }

  function startVisit(href, referrerUrl) {
    const now = Date.now();
    currentVisit = {
      id: crypto.randomUUID(),
      startedAt: now,
      href,
      routeKey: routeKey(href),
      referrerUrl,
      finalized: false
    };

    send(
      pagePayloadBase("visit_start", currentVisit.href, currentVisit.referrerUrl, currentVisit.startedAt),
      false,
    );
  }

  function finalizeVisit(exitReason, useBeacon) {
    if (!currentVisit || currentVisit.finalized) return;
    currentVisit.finalized = true;
    send(
      {
        ...pagePayloadBase("visit_finalize", currentVisit.href, currentVisit.referrerUrl, currentVisit.startedAt),
        durationMs: Math.max(0, Date.now() - currentVisit.startedAt),
        exitReason,
      },
      useBeacon,
    );
  }

  function handlePotentialRouteChange(nextHref, nextReferrerUrl) {
    const nextKey = routeKey(nextHref);
    if (!currentVisit || nextKey === currentVisit.routeKey) return;
    finalizeVisit("route_change", false);
    startVisit(nextHref, nextReferrerUrl);
  }

  function wrapHistoryMethod(methodName) {
    const original = history[methodName];
    history[methodName] = function(...args) {
      const result = original.apply(this, args);
      queueMicrotask(() => {
        handlePotentialRouteChange(window.location.href, currentVisit?.href || document.referrer || "");
      });
      return result;
    };
  }

  function track(eventName, eventData) {
    const normalizedName = String(eventName || "").trim();
    if (!normalizedName || !currentVisit) return;
    send(
      {
        ...pagePayloadBase("custom_event", currentVisit.href, currentVisit.referrerUrl, currentVisit.startedAt),
        eventId: crypto.randomUUID(),
        eventName: normalizedName,
        eventData: eventData ?? null,
      },
      false,
    );
  }

  let currentVisit = null;
  startVisit(window.location.href, document.referrer || "");

  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");
  window.addEventListener("popstate", () => {
    handlePotentialRouteChange(window.location.href, currentVisit?.href || document.referrer || "");
  });
  window.addEventListener("hashchange", () => {
    handlePotentialRouteChange(window.location.href, currentVisit?.href || document.referrer || "");
  });
  window.addEventListener("pagehide", () => {
    finalizeVisit("pagehide", true);
  });

  window[INSTALL_KEY] = {
    version: "3",
    siteId: SITE_ID,
    track
  };
  window.insightflare = {
    track
  };
})();`;
}
