import jetBrainsMonoLatinUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";

import { WIDGET_PALETTE_CSS } from "@/lib/widgets/palette";

// Sandboxed srcDoc previews have an opaque origin and cannot fetch this font
// from the application origin. Public embeds load it from the stylesheet.
const WEBFONT_STYLE = String.raw`
@font-face {
  font-family: "JetBrains Mono Variable";
  src: url("${jetBrainsMonoLatinUrl}") format("woff2");
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
}
`;

const BASE_STYLE = String.raw`
:root {
  color-scheme: light dark;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --border: oklch(0.922 0 0);
  --primary: oklch(0.6 0.13 163);
  --destructive: oklch(0.58 0.22 27);
  font-family:
    "JetBrains Mono Variable",
    "JetBrains Mono",
    "Cascadia Mono",
    Consolas,
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    ui-monospace,
    monospace;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
:root[data-theme="light"] {
  color-scheme: light;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --border: oklch(1 0 0 / 10%);
  --primary: oklch(0.7 0.15 162);
  --destructive: oklch(0.704 0.191 22.216);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --border: oklch(1 0 0 / 10%);
    --primary: oklch(0.7 0.15 162);
  --destructive: oklch(0.704 0.191 22.216);
  }
}
* {
  box-sizing: border-box;
}
html,
body {
  width: 100%;
  min-width: 0;
  min-height: 100%;
  margin: 0;
}
body {
  color: var(--foreground);
  background: transparent;
}
button {
  color: inherit;
  font: inherit;
}
.widget {
  width: 100%;
  min-height: 100%;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--background);
  color: var(--foreground);
}
.widget__inner {
  min-height: 100%;
  padding: 0.875rem 1rem 1rem;
}
.widget__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.widget__title {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.45;
}
.widget__period {
  flex: none;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  line-height: 1.4;
  text-align: right;
}
.widget__content {
  min-height: 3.5rem;
  margin-top: 0.75rem;
}
.widget__content:empty,
.widget__status[hidden] {
  display: none;
}
.widget__value-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
}
.widget__value {
  font-size: clamp(1.75rem, 10vw, 2.25rem);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.widget__unit {
  color: var(--muted-foreground);
  font-size: 0.6875rem;
}
.widget__change {
  display: inline-flex;
  align-items: center;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.widget__change[data-direction="up"] {
  color: var(--primary);
}
.widget__change[data-direction="down"] {
  color: var(--destructive);
}
.widget__chart {
  display: block;
  width: 100%;
  height: 7.625rem;
  overflow: visible;
}
.widget__chart-grid {
  stroke: var(--border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.widget__chart-line {
  fill: none;
  stroke: var(--primary);
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.widget__chart-area {
  fill: var(--primary);
  opacity: 0.1;
}
.widget__chart-labels {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  color: var(--muted-foreground);
  font-size: 0.6875rem;
}
.widget__trend-grid {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: stretch;
  gap: 0.375rem 0.5rem;
}
.widget__axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  color: var(--muted-foreground);
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
}
.widget__list {
  display: grid;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--border);
  list-style: none;
}
.widget__row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 1rem;
  min-width: 0;
  padding: 0.4375rem 0.5rem;
  border-bottom: 1px solid var(--border);
}
.widget__row::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--widget-share, 0%);
  background: var(--muted);
  content: "";
}
.widget__row > * {
  position: relative;
}
.widget__ranked-label {
  display: flex;
  min-width: 0;
  align-items: center;
}
.widget__label.widget__path-link { color:var(--primary);text-decoration:none;text-underline-offset:3px; }
.widget__path-link:hover { text-decoration:underline; }
.widget__path-link:focus-visible { outline:2px solid var(--primary);outline-offset:2px; }
.widget__label {
  overflow: hidden;
  color: var(--foreground);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.widget__count {
  color: var(--foreground);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.widget__bar-list,.widget__distribution-list { display:grid;gap:.65rem;margin:0;padding:0;list-style:none; }
.widget__bar-labels { display:flex;align-items:center;justify-content:space-between;gap:.75rem;min-width:0;margin-bottom:.25rem; }
.widget__bar-track { width:100%;height:.375rem;background:var(--muted); }
.widget__bar-fill { height:100%;background:var(--primary);transition:width .22s ease; }
.widget__bar-number { flex:none;color:var(--muted-foreground);font-size:.6875rem;font-variant-numeric:tabular-nums; }
.widget__legend { display:flex;flex-wrap:wrap;gap:.375rem .85rem;margin:0 0 .5rem; }
.widget__legend-item { display:flex;align-items:center;gap:.375rem;color:var(--muted-foreground);font-size:.6875rem; }
.widget__legend-swatch { width:.875rem;height:.1875rem;background:var(--primary); }
.widget__secondary { margin:.5rem 0 0;color:var(--muted-foreground);font-size:.6875rem; }
.widget__value-line + .widget__secondary { margin-top:.25rem; }
.widget__value-line ~ .widget__trend-grid { margin-top:.875rem; }

.widget__donut-wrap { display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:1rem;min-width:0; }
.widget__donut-ring { display:block;flex:none;width:112px;height:112px;overflow:visible; }
.widget__donut-total { font-size:17px;font-weight:650;fill:var(--foreground);font-variant-numeric:tabular-nums; }
.widget__donut-caption { font-size:9px;fill:var(--muted-foreground); }
.widget__breakdown-legend { display:grid;flex:1 1 120px;gap:.45rem;min-width:0;margin:0;padding:0;list-style:none; }
.widget__breakdown-row { display:flex;align-items:center;justify-content:space-between;gap:.5rem;min-width:0;font-size:.6875rem; }
.widget__breakdown-name { display:inline-flex;align-items:center;gap:.4rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted-foreground); }
.widget__breakdown-name span:last-child { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.widget__breakdown-swatch { width:.5rem;height:.5rem;flex:none; }
.widget__breakdown-value { flex:none;color:var(--foreground);font-variant-numeric:tabular-nums;white-space:nowrap; }
.widget__ratio-track { display:flex;height:1rem;width:100%;overflow:hidden;background:var(--muted); }
.widget__ratio-segment { display:block;flex:none;height:100%;transition:width .25s ease-out; }
.widget__ratio-layout { display:grid;gap:.85rem;min-width:0; }
.widget__ratio-layout .widget__breakdown-legend { grid-template-columns:repeat(auto-fit,minmax(min(100%,125px),1fr));gap:.55rem 1rem; }
@media (prefers-reduced-motion:reduce) { .widget__ratio-segment { transition:none; } }

.widget__geo-map { position:relative;width:100%;height:auto;aspect-ratio:360/150;max-height:260px;min-width:0;overflow:hidden; }
.widget[data-geo-projection="globe"] .widget__geo-map { height:208px; }
.widget__geo-canvas { display:block;width:100%;height:100%;touch-action:pan-y; }
.widget__geo-tooltip { position:absolute;z-index:2;pointer-events:none;transform:translate(-50%,-100%);max-width:85%;padding:.35rem .5rem;border:1px solid var(--border);background:var(--card);color:var(--foreground);font-size:.6875rem;white-space:nowrap; }
.widget__geo-tooltip[hidden] { display:none; }


.widget[data-widget-type="realtime"] .widget__content { min-height: 0; }
.widget[data-widget-type="realtime"][data-realtime-layout="badge"] {
  display: flex; align-items: center; justify-content: center;
  border: none; min-height: 0; background: transparent;
  overflow: hidden;
}
.widget[data-widget-type="realtime"][data-realtime-layout="badge"] .widget__inner {
  padding: 0; min-height: 0; width: 100%; display: flex; justify-content: center;
}
.widget[data-widget-type="realtime"][data-realtime-layout="badge"] .widget__header { display: none; }
.widget[data-widget-type="realtime"][data-realtime-layout="badge"] .widget__content {
  margin: 0; display: flex; justify-content: center; min-height: 0;
}
.widget__realtime-badge {
  display: inline-flex; align-items: center; justify-content: center;
  gap: .42rem; padding: .43rem .85rem;
  border: 1px solid var(--border); border-radius: 0;
  background: var(--card); white-space: nowrap;
  font-size: .6875rem; font-weight: 500; line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.widget__realtime-badge .widget__realtime-number { font-size:1.125rem;font-weight:700;line-height:1.05;letter-spacing:-.04em; }
.widget__realtime-badge .widget__realtime-label { font-size:.625rem;color:var(--muted-foreground);font-weight:450; }
.widget__realtime-glyph { flex: none; width: 1rem; height: 1rem; margin-left: .1rem; color: var(--muted-foreground); }
.widget[data-stale="true"] .widget__realtime-dot { background: var(--muted-foreground); }
.widget__realtime-dot { flex: none; width: .45rem; height: .45rem; border-radius: 999px; background: var(--primary); }
.widget__realtime-number { font-variant-numeric: tabular-nums; }
.widget__realtime-trend { min-width: 0; display: grid; gap: .65rem; }
.widget__realtime-trend-top { display: flex; flex-direction: column; gap: .25rem; }
.widget__realtime-caption { font-size: .6875rem; color: var(--muted-foreground); }
.widget__realtime-large { font-size: clamp(2rem, 11vw, 2.75rem); font-weight: 640; line-height: 1.1; letter-spacing: -.04em; }
.widget__realtime-bars {
  display: flex; align-items: end; gap: clamp(2px, .6vw, 5px);
  min-width: 0; height: 88px; overflow: hidden;
  border-bottom: 1px solid var(--border);
}
.widget__realtime-bar { flex: 1 1 0; min-width: 0; background: var(--primary); opacity: .86; transition: height .3s ease-out; }
.widget__realtime-axis { display: flex; align-items: center; justify-content: space-between; color: var(--muted-foreground); font-size: .625rem; }
.widget__realtime-map-counter {
  display: flex; align-items: center; gap: .4rem; margin: 0 0 .5rem;
  font-size: .6875rem;
}
.widget__realtime-map-counter .widget__realtime-label { color: var(--muted-foreground); }
.widget__realtime-map-counter .widget__realtime-number { font-weight: 650; }
.widget__realtime-empty { margin: 0; padding: 1rem 0; text-align: center; color: var(--muted-foreground); font-size: .75rem; }
@media (prefers-reduced-motion: reduce) { .widget__realtime-bar { transition: none; } }

.widget__status {
  display: flex;
  min-height: 4rem;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  text-align: center;
}
.widget__status-content {
  display: grid;
  justify-items: center;
  gap: 0.625rem;
}
.widget__action {
  min-height: 2rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--card);
  cursor: pointer;
  font-size: 0.75rem;
}
.widget__action:hover {
  background: var(--muted);
}
.placeholder {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 1.5rem;
}
.placeholder__card {
  width: min(100%, 26rem);
  padding: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--background);
  text-align: center;
}
.placeholder__mark {
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  margin: 0 auto 1rem;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 0;
  color: var(--muted-foreground);
  font-size: 1rem;
}
.placeholder__title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
}
.placeholder__description {
  margin: 0.5rem 0 0;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  line-height: 1.6;
}
@media (max-width: 260px) {
  .widget__inner {
    padding: 0.75rem;
  }
  .widget__header {
    display: grid;
    gap: 0.25rem;
  }
  .widget__period {
    text-align: left;
  }
  .widget__row {
    gap: 0.5rem;
  }
}
`;

// Applied only after the widget switches to intrinsic height: in srcDoc
// previews, or once the embed loader script on the host page opts in.
const AUTO_HEIGHT_STYLE = String.raw`
html[data-auto-height="true"],
html[data-auto-height="true"] body,
html[data-auto-height="true"] .widget,
html[data-auto-height="true"] .widget__inner {
  min-height: 0;
}
`;

export function widgetStylesheet(options: { webfont: boolean }): string {
  return (
    (options.webfont ? WEBFONT_STYLE : "") +
    BASE_STYLE +
    AUTO_HEIGHT_STYLE +
    WIDGET_PALETTE_CSS
  );
}
