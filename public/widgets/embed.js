/*
 * InsightFlare widget embed loader (optional).
 *
 * Load once on a page that embeds widgets to size each iframe to its content:
 *   <iframe src=".../widget/<uuid>" data-insightflare-widget ...></iframe>
 *   <script src=".../widgets/embed.js" async></script>
 *
 * Served as a static asset at a stable URL. It only talks to iframes marked
 * with data-insightflare-widget, checks both the message source window and
 * its origin, and only ever changes the iframe height.
 */
(function () {
  "use strict";
  if (window.__insightflareWidgetEmbed) return;
  window.__insightflareWidgetEmbed = true;
  var MAX_HEIGHT = 4000;
  var SELECTOR = "iframe[data-insightflare-widget]";
  function frameOrigin(frame) {
    try {
      return new URL(frame.src, window.location.href).origin;
    } catch {
      return null;
    }
  }
  function frameFor(source) {
    if (!source) return null;
    var frames = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === source) return frames[i];
    }
    return null;
  }
  function enable(frame) {
    var origin = frameOrigin(frame);
    if (!origin || origin === "null" || !frame.contentWindow) return;
    frame.contentWindow.postMessage(
      { type: "insightflare-widget-auto-height" },
      origin,
    );
  }
  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    var frame = frameFor(event.source);
    if (!frame || event.origin !== frameOrigin(frame)) return;
    if (message.type === "insightflare-widget-ready") enable(frame);
    else if (message.type === "insightflare-widget-height") {
      var height = Number(message.height);
      if (!Number.isFinite(height) || height < 1) return;
      frame.style.height = Math.min(MAX_HEIGHT, Math.ceil(height)) + "px";
    }
  });
  // Widgets that announced themselves before this script ran.
  var frames = document.querySelectorAll(SELECTOR);
  for (var i = 0; i < frames.length; i++) enable(frames[i]);
})();
