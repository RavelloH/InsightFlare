/**
 * Self-contained realtime widget renderer. Runs inside the published iframe,
 * without React, NumberFlow, or a third-party map library.
 */
export const REALTIME_CLIENT_FRAGMENT = String.raw`
  var realtimeFrame = 0;
  function setRealtimeNumber(node, next) {
    if (!node) return;
    next = Math.max(0, Math.floor(next));
    var previous = Number(node.dataset.numberValue || "NaN");
    node.dataset.numberValue = String(next);
    if (Number.isFinite(previous) && previous === next) return;
    if (realtimeFrame) cancelAnimationFrame(realtimeFrame);
    var reduced = matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!Number.isFinite(previous) || reduced) {
      node.textContent = formatNumber(next);
      return;
    }
    var startedAt = performance.now(), duration = 350;
    function step(now) {
      var p = Math.min(1, (now - startedAt) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = formatNumber(Math.round(previous + (next - previous) * eased));
      if (p < 1) realtimeFrame = requestAnimationFrame(step);
      else realtimeFrame = 0;
    }
    realtimeFrame = requestAnimationFrame(step);
  }
  function makeRealtimeCounter(className) {
    var counter = document.createElement("div");
    counter.className = className;
    var dot = document.createElement("span");
    dot.className = "widget__realtime-dot"; dot.setAttribute("aria-hidden", "true");
    var value = document.createElement("strong"); value.className = "widget__realtime-number";
    var label = document.createElement("span");
    label.className = "widget__realtime-label"; label.textContent = messages.liveOnline;
    counter.append(dot, value, label);
    return counter;
  }
  function renderRealtime(data) {
    if (!Number.isSafeInteger(data.activeNow) || data.activeNow < 0)
      throw new Error("Invalid active visitors response");
    var layout = root.dataset.realtimeLayout;
    if (layout === "badge") {
      var badge = content.querySelector(".widget__realtime-badge");
      if (!badge) {
        badge = makeRealtimeCounter("widget__realtime-badge");
        var glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        glyph.setAttribute("class", "widget__realtime-glyph");
        glyph.setAttribute("viewBox", "0 0 20 20");
        glyph.setAttribute("fill", "none");
        glyph.setAttribute("stroke", "currentColor");
        glyph.setAttribute("stroke-width", "1.4");
        var frame = document.createElementNS(glyph.namespaceURI, "rect");
        frame.setAttribute("x", "2.5"); frame.setAttribute("y", "3.5");
        frame.setAttribute("width", "15"); frame.setAttribute("height", "13");
        var line = document.createElementNS(glyph.namespaceURI, "path");
        line.setAttribute("d", "M5 13l3.5-4 3 2.5L15 7");
        glyph.append(frame, line);
        badge.appendChild(glyph);
        content.replaceChildren(badge);
      }
      setRealtimeNumber(badge.querySelector(".widget__realtime-number"), data.activeNow);
      return;
    }
    if (layout === "trend") {
      var card = content.querySelector(".widget__realtime-trend");
      if (!card) {
        card = document.createElement("div"); card.className = "widget__realtime-trend";
        var top = document.createElement("div"); top.className = "widget__realtime-trend-top";
        var caption = document.createElement("span"); caption.className = "widget__realtime-caption";
        caption.textContent = messages.liveOnline;
        var value = document.createElement("strong"); value.className = "widget__realtime-large";
        top.append(caption, value);
        var bars = document.createElement("div"); bars.className = "widget__realtime-bars";
        bars.setAttribute("role", "img"); bars.setAttribute("aria-label", messages.last30m);
        for (var i = 0; i < 30; i++) {
          var bar = document.createElement("span"); bar.className = "widget__realtime-bar";
          bars.appendChild(bar);
        }
        var foot = document.createElement("div"); foot.className = "widget__realtime-axis";
        var left = document.createElement("span"); left.textContent = messages.last30m;
        var right = document.createElement("span"); right.textContent = messages.now;
        foot.append(left, right);
        card.append(top, bars, foot); content.replaceChildren(card);
      }
      setRealtimeNumber(card.querySelector(".widget__realtime-large"), data.activeNow);
      var points = Array.isArray(data.bars) ? data.bars.slice(-30) : [];
      var max = Math.max(1, ...points.map(function (p) { return p.visitors || 0; }));
      var elements = card.querySelectorAll(".widget__realtime-bar");
      Array.prototype.forEach.call(elements, function (bar, i) {
        var item = points[i], count = Number.isFinite(item && item.visitors) ? item.visitors : 0;
        bar.style.height = Math.max(1.8, count / max * 100) + "%";
        bar.title = formatNumber(count);
      });
      return;
    }
    if (layout === "map") {
      if (typeof geoDispose === "function") geoDispose();
      content.replaceChildren();
      // Only aggregated country-centroid points reach the public map.
      renderGeo({ points: data.points, unmapped: data.activeNow });
      var geo = content.querySelector(".widget__geo-map");
      if (geo) {
        var bubble = makeRealtimeCounter("widget__realtime-map-counter");
        setRealtimeNumber(bubble.querySelector(".widget__realtime-number"), data.activeNow);
        geo.appendChild(bubble);
      }
      return;
    }
    if (layout === "pages") {
      content.replaceChildren();
      if (!Array.isArray(data.rows) || data.rows.length === 0) {
        var empty = document.createElement("p");
        empty.className = "widget__realtime-empty";
        empty.textContent = messages.noActivePages; content.appendChild(empty);
      } else {
        renderRanking({ rows: data.rows });
      }
      return;
    }
    throw new Error("Unknown realtime Widget layout");
  }
  renderers.realtime = renderRealtime;
  // Realtime cards update counters and bars in place between refreshes.
  incrementalRenderers.realtime = true;
  refreshIntervalMs = 30000;
`;
