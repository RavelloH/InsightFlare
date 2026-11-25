/**
 * Widget lifecycle: validation and dispatch through `renderers`, data
 * loading, optional periodic refresh, and intrinsic-height reporting.
 * Appended after the core and any type fragments.
 */
export const WIDGET_CLIENT_RUNTIME = String.raw`
  var autoHeight = false, lastHeight = 0;
  function reportHeight() {
    if (!autoHeight) return;
    var height = Math.ceil(root.getBoundingClientRect().height);
    if (!Number.isFinite(height) || height < 1 || height === lastHeight) return;
    lastHeight = height;
    window.parent.postMessage(
      { type: "insightflare-widget-height", uuid: root.dataset.uuid, height: height },
      "*"
    );
  }
  function enableAutoHeight() {
    if (autoHeight || window.parent === window) return;
    autoHeight = true;
    document.documentElement.setAttribute("data-auto-height", "true");
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(reportHeight).observe(root);
    }
    window.addEventListener("resize", reportHeight);
    window.addEventListener("load", reportHeight);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(reportHeight);
    }
    requestAnimationFrame(reportHeight);
  }
  if (root.dataset.autoHeight === "true") enableAutoHeight();
  else if (root.dataset.preview !== "true" && window.parent !== window) {
    // A host page opts in by loading the InsightFlare embed loader, which
    // answers this announcement. Plain iframes keep their fixed height.
    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      var message = event.data;
      if (message && message.type === "insightflare-widget-auto-height") enableAutoHeight();
    });
    window.parent.postMessage(
      { type: "insightflare-widget-ready", uuid: root.dataset.uuid },
      "*"
    );
  }

  function mount(data) {
    if (
      !data ||
      data.type !== root.dataset.widgetType ||
      data.metric !== root.dataset.metric
    )
      throw new Error("Widget response did not match its configuration");
    if (root.dataset.widgetType === "metric" && !Number.isFinite(data.value))
      throw new Error("Invalid metric response");
    var render = renderers[data.type];
    if (typeof render !== "function") throw new Error("Unknown widget type");
    if (!incrementalRenderers[data.type]) content.replaceChildren();
    status.hidden = true;
    render(data);
    reportHeight();
  }

  if (root.dataset.preview === "true") {
    var preview = document.getElementById("widget-preview-data");
    if (preview) {
      try {
        mount(JSON.parse(preview.textContent || "null"));
      } catch (e) {
        setStatus(messages.previewDataUnavailable);
      }
    } else setStatus(messages.previewDataUnavailable);
    return;
  }

  var apiUrl =
    "/api/public/widgets/" + encodeURIComponent(root.dataset.uuid) + "/data";
  if (root.dataset.revision) {
    apiUrl += "?revision=" + encodeURIComponent(root.dataset.revision);
  }
  var loading = false, lastFetch = 0;
  function load(silent) {
    if (loading) return;
    loading = true;
    lastFetch = Date.now();
    if (!silent) setStatus(messages.loading);
    fetch(apiUrl, {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
    })
      .then(function (response) {
        if (response.status === 409) {
          setStatus(messages.configurationChanged, messages.reload, function () {
            window.location.reload();
          });
          return null;
        }
        if (response.status === 404) {
          setStatus(messages.notFound);
          return null;
        }
        if (response.status === 410) {
          setStatus(messages.unpublished);
          return null;
        }
        if (response.status === 403) {
          setStatus(messages.domainDenied);
          return null;
        }
        if (!response.ok) throw new Error("Widget request failed");
        return response.json();
      })
      .then(function (payload) {
        if (payload) {
          mount(payload.data);
          root.dataset.stale = "false";
        }
      })
      .catch(function () {
        root.dataset.stale = "true";
        // A refresh failure keeps the last successful render on screen.
        if (!content.childElementCount) {
          setStatus(messages.loadFailed, messages.retry, function () {
            load(false);
          });
        }
      })
      .finally(function () {
        loading = false;
        reportHeight();
      });
  }

  if (refreshIntervalMs > 0) {
    var inViewport = false, refreshTimer = 0;
    var shouldRefresh = function () {
      return document.visibilityState === "visible" && inViewport;
    };
    var manageRefresh = function () {
      if (!shouldRefresh()) {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = 0; }
        return;
      }
      if (!refreshTimer) refreshTimer = setInterval(function () {
        if (shouldRefresh()) load(true);
      }, refreshIntervalMs);
      if (Date.now() - lastFetch > 8000) load(Boolean(content.childElementCount));
    };
    if (typeof IntersectionObserver !== "undefined") {
      new IntersectionObserver(function (entries) {
        inViewport = entries.some(function (entry) { return entry.isIntersecting; });
        manageRefresh();
      }).observe(root);
    } else { inViewport = true; manageRefresh(); }
    document.addEventListener("visibilitychange", manageRefresh);
  } else {
    load(false);
  }
`;
