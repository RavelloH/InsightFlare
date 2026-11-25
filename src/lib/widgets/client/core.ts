/**
 * Shared, framework-free renderer for every widget type. Type-specific
 * fragments (breakdown, geo, realtime) register additional renderers in the
 * `renderers` table defined at the end of this core; the runtime dispatches
 * through that table. No fragment patches this source text.
 *
 * Runs inside the widget iframe, both for public embeds and for srcDoc
 * previews. Message keys must exist in EmbedMessages (enforced by tests).
 */
export const WIDGET_CLIENT_CORE = String.raw`
  "use strict";
  var root = document.getElementById("widget");
  if (!root) return;
  var messageNode = document.getElementById("widget-messages");
  var messages = messageNode ? JSON.parse(messageNode.textContent || "{}") : {};
  var content = document.getElementById("widget-content");
  var status = document.getElementById("widget-status");
  var metricLabel = {
    visitors: messages.visitors,
    views: messages.views,
    sessions: messages.sessions,
    bounces: messages.bounces,
    bounceRate: messages.bounceRate,
    avgDurationMs: messages.avgDurationMs,
    viewsPerSession: messages.viewsPerSession,
    events: messages.events,
  };
  function localeTag() {
    return root.dataset.locale === "zh"
      ? "zh-CN"
      : root.dataset.locale === "zh-tw"
        ? "zh-TW"
        : root.dataset.locale || "en";
  }
  function paletteColor(index, count) {
    return "var(--widget-palette-" + Math.max(2,Math.min(10,count)) + "-" + (index+1) + ")";
  }
  function pathHref(rawPath) {
    if (root.dataset.pageLinksEnabled !== "true" || !root.dataset.siteOrigin) return null;
    if (typeof rawPath !== "string" || !/^\/(?!\/)/.test(rawPath) || /[\\\u0000-\u001f\u007f]/.test(rawPath)) return null;
    try {
      var url = new URL(rawPath,root.dataset.siteOrigin);
      return url.origin === root.dataset.siteOrigin ? url.href : null;
    } catch (_) { return null; }
  }
  function makePathLabel(rawPath, labelText) {
    var href = root.dataset.dimension === "page.path" || (root.dataset.widgetType === "realtime" && root.dataset.realtimeLayout === "pages")
      ? pathHref(rawPath) : null;
    var el = document.createElement(href ? "a" : "span");
    el.className = href ? "widget__label widget__path-link" : "widget__label";
    el.textContent = labelText; el.title = labelText;
    if (href) { el.href = href; el.target = "_blank"; el.rel = "noopener noreferrer"; }
    return el;
  }
  // Match the dashboard: grouped full numbers, compact only from a million.
  function formatNumber(value) {
    return new Intl.NumberFormat(
      localeTag(),
      Math.abs(value) >= 1000000
        ? { notation: "compact", maximumFractionDigits: 1 }
        : { maximumFractionDigits: 1 },
    ).format(value);
  }
  function formatDuration(value) { var seconds = Math.round(Math.max(0, value)/1000); return Math.floor(seconds/60) + ":" + String(seconds%60).padStart(2, "0"); }
  function formatDate(value) {
    return new Intl.DateTimeFormat(localeTag(), {
      month: "short",
      day: "numeric",
      timeZone: root.dataset.timeZone || "UTC",
    }).format(new Date(value));
  }
  function formatRankingLabel(label) {
    if (root.dataset.dimension !== "geo.country" || !/^[A-Z]{2}$/i.test(label))
      return label;
    try {
      return (
        new Intl.DisplayNames([localeTag()], { type: "region" }).of(
          label.toUpperCase(),
        ) || label
      );
    } catch (e) {
      return label;
    }
  }
  function setStatus(message, actionLabel, action) {
    content.replaceChildren();
    status.textContent = "";
    status.hidden = false;
    var wrap = document.createElement("div");
    wrap.className = "widget__status-content";
    var text = document.createElement("span");
    text.textContent = message;
    wrap.appendChild(text);
    if (actionLabel) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "widget__action";
      button.textContent = actionLabel;
      button.addEventListener("click", action);
      wrap.appendChild(button);
    }
    status.appendChild(wrap);
  }
  function renderMetric(data) {
    var line = document.createElement("div");
    line.className = "widget__value-line";
    var value = document.createElement("strong");
    value.className = "widget__value";
    value.textContent = data.metric === "bounceRate"
      ? new Intl.NumberFormat(localeTag(), { style: "percent", maximumFractionDigits: 1 }).format(data.value)
      : data.metric === "avgDurationMs"
        ? formatDuration(data.value)
        : data.metric === "viewsPerSession"
          ? new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 2 }).format(data.value)
          : formatNumber(data.value);
    line.appendChild(value);
    var unit = document.createElement("span");
    unit.className = "widget__unit";
    unit.textContent = metricLabel[data.metric];
    line.appendChild(unit);
    if (root.dataset.comparison === "true") {
      var change = document.createElement("span");
      change.className = "widget__change";
      change.setAttribute("aria-label", messages.percentageChange);
      if (typeof data.change === "number" && Number.isFinite(data.change)) {
        change.dataset.direction =
          data.change > 0 ? "up" : data.change < 0 ? "down" : "flat";
        change.textContent = (data.change > 0 ? "↑ " : data.change < 0 ? "↓ " : "") + new Intl.NumberFormat(localeTag(), {
          style: "percent",
          signDisplay: "exceptZero",
          maximumFractionDigits: 1,
        }).format(data.change);
      } else change.textContent = "—";
      line.appendChild(change);
    }
    content.appendChild(line);
  }
  // Rounded axis maxima keep the three tick labels short and readable.
  var NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var power = Math.pow(10, Math.floor(Math.log10(raw)));
    for (var i = 0; i < NICE_STEPS.length; i++) {
      if (raw / power <= NICE_STEPS[i] + 1e-9) return NICE_STEPS[i] * power;
    }
    return 10 * power;
  }
  // Two equal, round intervals (e.g. 0 / 600 / 1,200) for count axes.
  function countAxisMax(max) {
    return Math.max(1, Math.ceil(niceStep(max / 2))) * 2;
  }
  function rateAxisMax(max) {
    return Math.min(1, Math.max(0.02, Math.ceil(max * 50) / 50));
  }
  function formatRate(value) {
    return new Intl.NumberFormat(localeTag(), { style: "percent", maximumFractionDigits: 1 }).format(value);
  }
  // Shared frame for every line chart: y-axis ticks beside the plot, and the
  // first/last dates aligned with the plot rather than the axis column.
  function chartWithAxis(svg, high, format, firstMs, lastMs) {
    var chart = document.createElement("div");
    chart.className = "widget__trend-grid";
    var axis = document.createElement("div");
    axis.className = "widget__axis";
    axis.setAttribute("aria-hidden", "true");
    [high, high / 2, 0].forEach(function (tick) {
      var label = document.createElement("span");
      label.textContent = format(tick);
      axis.appendChild(label);
    });
    var spacer = document.createElement("span");
    var labels = document.createElement("div");
    labels.className = "widget__chart-labels";
    var start = document.createElement("span"), end = document.createElement("span");
    start.textContent = formatDate(firstMs);
    end.textContent = formatDate(lastMs);
    labels.append(start, end);
    chart.append(axis, svg, spacer, labels);
    return chart;
  }
  function renderTrend(data) {
    if (Array.isArray(data.series) && data.series.length > 1) { renderMultiTrend(data); return; }
    var points = Array.isArray(data.points)
      ? data.points.filter(function (point) {
          return (
            point &&
            Number.isFinite(point.timestampMs) &&
            Number.isFinite(point.value)
          );
        })
      : [];
    if (points.length === 0) {
      setStatus(messages.noData);
      return;
    }
    var width = 640,
      height = 176,
      pad = 6;
    var values = points.map(function (point) {
      return point.value;
    });
    var high = countAxisMax(Math.max.apply(null, values));
    var coords = points.map(function (point, index) {
      return {
        x:
          pad +
          (points.length === 1
            ? width - 2 * pad
            : (index * (width - 2 * pad)) / (points.length - 1)),
        y: height - pad - (point.value * (height - 2 * pad)) / high,
      };
    });
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "widget__chart");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    // Stretch to the card; strokes keep a constant width via CSS.
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      messages.chartDescription + ": " + metricLabel[data.metric],
    );
    [pad, height / 2, height - pad].forEach(function (position) {
      var grid = document.createElementNS(svg.namespaceURI, "line");
      grid.setAttribute("class", "widget__chart-grid");
      grid.setAttribute("x1", "0");
      grid.setAttribute("x2", String(width));
      grid.setAttribute("y1", String(position));
      grid.setAttribute("y2", String(position));
      svg.appendChild(grid);
    });
    var polyline = document.createElementNS(svg.namespaceURI, "polyline");
    polyline.setAttribute("class", "widget__chart-line");
    polyline.setAttribute(
      "points",
      coords
        .map(function (point) {
          return point.x + "," + point.y;
        })
        .join(" "),
    );
    if (root.dataset.trendStyle === "area") {
      var defs = document.createElementNS(svg.namespaceURI,"defs");
      var gradient = document.createElementNS(svg.namespaceURI,"linearGradient");
      gradient.setAttribute("id","widget-trend-area-gradient");
      gradient.setAttribute("x1","0");gradient.setAttribute("y1","0");
      gradient.setAttribute("x2","0");gradient.setAttribute("y2","1");
      var upper = document.createElementNS(svg.namespaceURI,"stop");
      upper.setAttribute("offset","0%");upper.setAttribute("stop-color","var(--primary)");
      upper.setAttribute("stop-opacity",".28");
      var lower = document.createElementNS(svg.namespaceURI,"stop");
      lower.setAttribute("offset","100%");lower.setAttribute("stop-color","var(--primary)");
      lower.setAttribute("stop-opacity",".025");
      gradient.append(upper,lower);defs.appendChild(gradient);svg.appendChild(defs);
      var area = document.createElementNS(svg.namespaceURI,"path");
      area.classList.add("widget__chart-area");
      area.setAttribute("d","M"+coords.map(function(pt){return pt.x+" "+pt.y;}).join(" L")+
        " L"+coords[coords.length-1].x+" "+(height-pad)+
        " L"+coords[0].x+" "+(height-pad)+" Z");
      // CSS fill has higher priority than SVG presentation attributes.
      area.style.fill="url(#widget-trend-area-gradient)";
      area.style.opacity="1";
      svg.appendChild(area);
    }
    svg.appendChild(polyline);
    content.appendChild(legendFor([{ label: metricLabel[data.metric], color: "var(--primary)" }]));
    content.appendChild(
      chartWithAxis(svg, high, formatNumber, points[0].timestampMs, points[points.length - 1].timestampMs),
    );
  }
  function chartSvg(points, accessor, lineColor, high) {
    var width = 640, height = 176, pad = 6;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "widget__chart");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", messages.chartDescription);
    [pad, height / 2, height - pad].forEach(function (position) {
      var grid = document.createElementNS(svg.namespaceURI, "line");
      grid.setAttribute("class", "widget__chart-grid");
      grid.setAttribute("x1", "0"); grid.setAttribute("x2", String(width));
      grid.setAttribute("y1", String(position)); grid.setAttribute("y2", String(position));
      svg.appendChild(grid);
    });
    var path = document.createElementNS(svg.namespaceURI, "polyline");
    path.setAttribute("class", "widget__chart-line");
    // The CSS .widget__chart-line stroke declaration overrides SVG presentation
    // attributes; an inline style keeps each line in sync with its legend.
    path.style.stroke = lineColor;
    path.setAttribute("points", points.map(function (point, index) {
      var x = pad + (points.length === 1 ? width - 2 * pad : index * (width - 2 * pad) / (points.length - 1));
      var y = height - pad - Math.max(0, accessor(point)) * (height - 2 * pad) / high;
      return x + "," + y;
    }).join(" "));
    svg.appendChild(path);
    return svg;
  }
  function legendFor(items) {
    var legend = document.createElement("div");
    legend.className = "widget__legend";
    items.forEach(function (entry) {
      var item = document.createElement("span");
      item.className = "widget__legend-item";
      var swatch = document.createElement("span");
      swatch.className = "widget__legend-swatch";
      swatch.style.background = entry.color;
      var name = document.createElement("span");
      name.textContent = entry.label;
      item.append(swatch, name);
      legend.appendChild(item);
    });
    return legend;
  }
  function renderMultiTrend(data) {
    var series = data.series.filter(function (item) {
      return item && Array.isArray(item.points) && item.points.length > 0 &&
        item.points.every(function (p) { return Number.isFinite(p.timestampMs) && Number.isFinite(p.value); });
    }).slice(0, 3);
    if (!series.length) { setStatus(messages.noData); return; }
    var colors = series.map(function(_, i) { return paletteColor(i, series.length); });
    var max = countAxisMax(Math.max(0, ...series.flatMap(function (s) { return s.points.map(function (p) { return p.value; }); })));
    content.appendChild(legendFor(series.map(function (item, index) {
      return { label: metricLabel[item.metric] || item.metric, color: colors[index] };
    })));
    var svg = chartSvg(series[0].points, function (p) { return p.value; }, colors[0], max);
    series.slice(1).forEach(function (item, index) {
      var second = chartSvg(item.points, function (p) { return p.value; }, colors[index + 1], max);
      var path = second.querySelector("polyline");
      if (path) svg.appendChild(path);
    });
    var firstPoints = series[0].points;
    content.appendChild(
      chartWithAxis(svg, max, formatNumber, firstPoints[0].timestampMs, firstPoints[firstPoints.length - 1].timestampMs),
    );
  }
  function renderBars(dataRows, distribution) {
    var rows = Array.isArray(dataRows) ? dataRows.filter(function (row) {
      return row && typeof row.label === "string" && Number.isFinite(row.value);
    }).slice(0, Number(root.dataset.limit) || 10) : [];
    if (!rows.length) { setStatus(messages.noData); return; }
    var max = Math.max(1, ...rows.map(function (row) { return row.value; }));
    var list = document.createElement("ol");
    list.className = distribution ? "widget__distribution-list" : "widget__bar-list";
    rows.forEach(function (row, index) {
      var li = document.createElement("li");
      var labels = document.createElement("div"); labels.className = "widget__bar-labels";
      var name = distribution ? makePathLabel("",row.label) : makePathLabel(row.label,formatRankingLabel(row.label));
      var number = document.createElement("span"); number.className = "widget__bar-number";
      number.textContent = formatNumber(row.value);
      if (distribution && Number.isFinite(row.percent)) {
        number.textContent += " · " + new Intl.NumberFormat(localeTag(), {
          style: "percent", maximumFractionDigits: 1
        }).format(Math.max(0, Math.min(1, row.percent)));
      }
      labels.append(name, number);
      var track = document.createElement("div"); track.className = "widget__bar-track";
      var fill = document.createElement("div"); fill.className = "widget__bar-fill";
      fill.style.width = Math.max(0, Math.min(100, row.value / max * 100)) + "%";
      if (distribution) fill.style.background = paletteColor(index,rows.length);
      track.appendChild(fill); li.append(labels, track); list.appendChild(li);
    });
    content.appendChild(list);
    if (distribution) {
      var note = document.createElement("p"); note.className = "widget__secondary";
      note.textContent = messages.categoryShare;
      content.appendChild(note);
    }
  }
  function renderConversion(data) {
    if (!Number.isFinite(data.value)) { setStatus(messages.noData); return; }
    var line = document.createElement("div"); line.className = "widget__value-line";
    var value = document.createElement("strong"); value.className = "widget__value";
    value.textContent = formatNumber(data.value);
    var unit = document.createElement("span"); unit.className = "widget__unit";
    unit.textContent = data.kind === "goal" ? messages.conversions : messages.events;
    line.append(value, unit); content.appendChild(line);
    if (data.kind === "goal" && typeof data.rate === "number" && Number.isFinite(data.rate)) {
      var rate = document.createElement("div"); rate.className = "widget__secondary";
      rate.textContent = messages.conversionRate + ": " + formatRate(data.rate);
      content.appendChild(rate);
    }
    var points = Array.isArray(data.points) ? data.points.filter(function (point) {
      return point && Number.isFinite(point.timestampMs) && Number.isFinite(point.value);
    }) : [];
    if (!points.length) return;
    var rates = data.kind === "goal";
    var values = points.map(function (p) {
      return rates ? (Number.isFinite(p.rate) ? p.rate : 0) : p.value;
    });
    // Goal charts plot rates (0..1) on their own percentage axis.
    var high = rates ? rateAxisMax(Math.max(0, ...values)) : countAxisMax(Math.max(0, ...values));
    var svg = chartSvg(points, function (p) {
      return rates ? (Number.isFinite(p.rate) ? p.rate : 0) : p.value;
    }, "var(--primary)", high);
    content.appendChild(
      chartWithAxis(svg, high, rates ? formatRate : formatNumber, points[0].timestampMs, points[points.length - 1].timestampMs),
    );
  }
  function renderRanking(data) {
    var rows = Array.isArray(data.rows)
      ? data.rows.filter(function (row) {
          return (
            row && typeof row.label === "string" && Number.isFinite(row.value)
          );
        })
      : [];
    if (rows.length === 0) { setStatus(messages.noData); return; }
    if (root.dataset.rankingStyle === "bars") { renderBars(rows, false); return; }
    var list = document.createElement("ol");
    list.className = "widget__list";
    var shown = rows.slice(0, Number(root.dataset.limit) || 10);
    var top = Math.max(1, ...shown.map(function (row) { return row.value; }));
    shown.forEach(function (row) {
        var item = document.createElement("li");
        item.className = "widget__row";
        // Same proportional row background as the dashboard tables.
        item.style.setProperty("--widget-share", Math.max(0, Math.min(100, row.value / top * 100)) + "%");
        var ranked = document.createElement("span");
        ranked.className = "widget__ranked-label";
        var displayLabel = formatRankingLabel(row.label);
        var label = makePathLabel(row.label,displayLabel);
        ranked.appendChild(label);
        var count = document.createElement("span");
        count.className = "widget__count";
        count.textContent = formatNumber(row.value);
        item.append(ranked, count);
        list.appendChild(item);
      });
    content.appendChild(list);
  }
  // Registry used by the runtime. Fragments may add types, mark a type as
  // incremental (it updates its own DOM instead of being re-created), or
  // request periodic refreshes.
  var renderers = {
    metric: renderMetric,
    trend: renderTrend,
    ranking: renderRanking,
    conversion: renderConversion,
  };
  var incrementalRenderers = {};
  var refreshIntervalMs = 0;
`;
