import { GEO_LAND_DOTS } from "@/lib/widgets/geo-data";

/**
 * Optional lightweight Canvas renderer injected only into geo widgets.
 * Reuses the website's public-domain Natural Earth dot mask. Never renders
 * an individual's coordinates: every marker is a country label anchor.
 */
export const GEO_CLIENT_FRAGMENT =
  `
  var geoLand = ${JSON.stringify(GEO_LAND_DOTS)};
` +
  String.raw`
  var geoDispose = null, geoLandPoints = null;
  // Decoded once: realtime maps re-render on every refresh.
  function decodeGeoLand() {
    if (geoLandPoints) return geoLandPoints;
    var land = geoLand;
    if (!land || land.cols !== 240 || land.rows !== 92 || typeof land.bits !== "string")
      throw new Error("Invalid world map");
    var bytes = atob(land.bits), decoded = [];
    for (var row = 0; row < land.rows; row++) {
      for (var col = 0; col < land.cols; col++) {
        var bit = row * land.cols + col;
        if (bytes.charCodeAt(bit >> 3) & (1 << (bit & 7))) {
          decoded.push([land.lonStart + col * land.step, land.latStart - row * land.step]);
        }
      }
    }
    geoLandPoints = decoded;
    return decoded;
  }
  function renderGeo(data) {
    if (geoDispose) geoDispose();
    var landPoints = decodeGeoLand();
    var points = (Array.isArray(data.points) ? data.points : []).filter(function (point) {
      return point && /^[A-Z]{2}$/.test(point.country) &&
        Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
        point.lat >= -90 && point.lat <= 90 &&
        point.lon >= -180 && point.lon <= 180 &&
        Number.isFinite(point.value) && point.value > 0;
    }).slice(0, 220).sort(function (a, b) { return b.value - a.value; });
    if (!points.length && !(data.unmapped > 0) && root.dataset.widgetType !== "realtime") { setStatus(messages.noData); return; }

    var globe = root.dataset.geoProjection === "globe";
    var wrap = document.createElement("div"); wrap.className = "widget__geo-map";
    var canvas = document.createElement("canvas"); canvas.className = "widget__geo-canvas";
    canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", messages.geoMapLabel);
    canvas.style.cursor = globe ? "grab" : "default";
    var tooltip = document.createElement("div"); tooltip.className = "widget__geo-tooltip";
    tooltip.hidden = true;
    wrap.append(canvas, tooltip);
    content.appendChild(wrap);
    var displayNames;
    try { displayNames = new Intl.DisplayNames([localeTag()], { type: "region" }); } catch(e) {}
    function countryName(code) {
      try { return displayNames ? displayNames.of(code) || code : code; } catch(e) { return code; }
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var width = 0, height = 0, dpr = 1, hitPoints = [];
    var longitude = 22, tilt = 0.18, dragging = false, dragX = 0;
    var visible = true, raf = 0, disposed = false, lastPaint = 0;
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var max = Math.max(1, ...points.map(function (p) { return p.value; }));
    function project(lon, lat) {
      if (!globe) {
        // Keep the equirectangular aspect (360 x 142 degrees), centered.
        var scale = Math.min(width / 360, height / 142);
        return {
          x: (width - 360 * scale) / 2 + (lon + 180) * scale,
          y: (height - 142 * scale) / 2 + (80 - lat) * scale,
          front: true
        };
      }
      var la = lat * Math.PI / 180, lo = (lon - longitude) * Math.PI / 180;
      var x = Math.cos(la) * Math.sin(lo), y = Math.sin(la), z = Math.cos(la) * Math.cos(lo);
      var fy = y * Math.cos(tilt) - z * Math.sin(tilt);
      var fz = y * Math.sin(tilt) + z * Math.cos(tilt);
      var radius = Math.min(width * 0.46, height * 0.46);
      return { x: width / 2 + x * radius, y: height / 2 - fy * radius, front: fz > 0 };
    }
    function paint() {
      if (disposed || !width || !height) return;
      var style = getComputedStyle(root);
      var ink = style.getPropertyValue("--muted-foreground").trim();
      var accent = style.getPropertyValue("--primary").trim();
      var border = style.getPropertyValue("--border").trim();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (globe) {
        var radius = Math.min(width * 0.46, height * 0.46);
        ctx.globalAlpha = 0.32;
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = globe ? 0.4 : 0.28;
      ctx.fillStyle = ink;
      var dotRadius = globe ? 0.8 : Math.max(0.5, Math.min(1.1, Math.min(width, height * 360 / 142) / 420));
      for (var i = 0; i < landPoints.length; i++) {
        var location = project(landPoints[i][0], landPoints[i][1]);
        if (!location.front || location.y < 0 || location.y > height) continue;
        ctx.beginPath(); ctx.arc(location.x, location.y, dotRadius, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      hitPoints = [];
      for (var j = points.length - 1; j >= 0; j--) {
        var point = points[j], position = project(point.lon, point.lat);
        if (!position.front || position.y < 0 || position.y > height) continue;
        var radiusPoint = 2.3 + 5.2 * Math.sqrt(point.value / max);
        ctx.strokeStyle = accent;
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(position.x, position.y, radiusPoint + 3, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(position.x, position.y, Math.max(2, radiusPoint * 0.65), 0, Math.PI * 2); ctx.fill();
        hitPoints.push({ x: position.x, y: position.y, point: point, radius: Math.max(10, radiusPoint + 4) });
      }
      ctx.globalAlpha = 1;
    }
    function loop(now) {
      raf = 0;
      if (!visible || disposed || reduced || !globe) return;
      if (now - lastPaint > 85) {
        longitude = (longitude + (dragging ? 0 : 0.23)) % 360;
        paint();
        lastPaint = now;
      }
      raf = requestAnimationFrame(loop);
    }
    function schedule() {
      if (!raf && visible && !reduced && globe && !disposed) raf = requestAnimationFrame(loop);
    }
    function resize() {
      width = Math.round(wrap.clientWidth);
      height = Math.round(wrap.clientHeight);
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      paint();
    }
    function local(event) {
      var bounds = canvas.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    }
    function hover(event) {
      var p = local(event), nearest = null, distance = Infinity;
      for (var i = 0; i < hitPoints.length; i++) {
        var hit = hitPoints[i];
        var d = Math.hypot(p.x - hit.x, p.y - hit.y);
        if (d < hit.radius && d < distance) { distance = d; nearest = hit; }
      }
      if (!nearest) { tooltip.hidden = true; return; }
      tooltip.textContent = countryName(nearest.point.country) + ": " + formatNumber(nearest.point.value);
      tooltip.style.left = Math.min(width - 12, Math.max(12, p.x)) + "px";
      tooltip.style.top = Math.max(4, p.y - 26) + "px";
      tooltip.hidden = false;
    }
    function down(event) {
      if (!globe) return;
      dragging = true; dragX = event.clientX;
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(event.pointerId);
    }
    function move(event) {
      if (dragging && globe) {
        longitude -= (event.clientX - dragX) * 0.55;
        dragX = event.clientX; paint();
      }
      hover(event);
    }
    function up(event) {
      dragging = false;
      canvas.style.cursor = globe ? "grab" : "default";
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    }
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", function () { tooltip.hidden = true; });
    var resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(wrap);
    var intersectObserver = new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (!visible && raf) { cancelAnimationFrame(raf); raf = 0; }
      if (visible) { paint(); schedule(); }
    });
    intersectObserver.observe(wrap);
    resize();
    // The initial canvas bitmap may be reset by layout during iframe startup.
    // Paint once more after layout, even when the map is static.
    requestAnimationFrame(paint);
    window.addEventListener("load", paint, { once: true });
    schedule();
    geoDispose = function () {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectObserver.disconnect();
    };
  }
  renderers.geo = renderGeo;
`;
