"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiArrowLeftLine, RiExternalLinkLine } from "@remixicon/react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { AutoTransition } from "@/components/ui/auto-transition";
import { fetchBrowserVersionBreakdown } from "@/lib/dashboard/client-data";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import { cn } from "@/lib/utils";
import type { BrowserVersionBreakdownData } from "@/lib/edge-client";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

/* ---------- caniuse types ---------- */

const CANIUSE_BASE = "https://caniuse.ravelloh.com";

interface CaniuseSearchEntry {
  id: string;
  title: string;
  keywords: string[];
}

interface CaniuseHotFeature {
  rank: number;
  id: string;
  title: string;
  score: number;
  usage: { fully_supported: number; partially_supported: number };
}

interface CaniuseTrendingFeature {
  id: string;
  title: string;
  type: string;
  date: string;
  usage: { fully_supported: number; partially_supported: number };
}

interface CaniuseBrowserSupport {
  id: string;
  name: string;
  browser: string;
  type: string;
  current_version: string;
  current_status: string;
  first_full_version: string | null;
  first_partial_version: string | null;
  stats: Record<string, string>;
}

interface CaniuseLink {
  url: string;
  title: string;
}

interface CaniuseFeatureDetail {
  id: string;
  title: string;
  description: string;
  spec: string;
  status: string;
  categories: string[];
  links: CaniuseLink[];
  notes: string;
  notes_by_num: Record<string, string>;
  usage: { fully_supported: number; partially_supported: number };
  support: { browsers: CaniuseBrowserSupport[] };
}

/* ---------- helpers ---------- */

function emptyBreakdown(): BrowserVersionBreakdownData {
  return { ok: true, data: [] };
}

/** Safari uses major.minor (e.g. "17.4"), others use major only. */
const MINOR_VERSION_BROWSERS = new Set(["Safari", "Mobile Safari"]);

function extractVersionKey(label: string, browserName: string): string {
  if (MINOR_VERSION_BROWSERS.has(browserName)) {
    const parts = label.split(".");
    return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0];
  }
  return label.split(".")[0];
}

function parseBaseStatus(raw: string | undefined): string {
  if (!raw) return "u";
  return raw.replace(/#\d+/g, "").replace(/[xd]/g, "").trim() || "u";
}

function supportWeight(baseStatus: string): number {
  if (baseStatus === "y") return 1;
  if (baseStatus === "a") return 0.5;
  return 0;
}

function supportColor(pct: number): string {
  if (pct >= 0.9) return "var(--color-chart-2)";
  if (pct >= 0.5) return "var(--color-chart-4)";
  return "var(--color-chart-5)";
}

/** Calculate site-specific support % for a feature given the browser data. */
function calcSitePercent(
  feature: CaniuseFeatureDetail,
  browserData: BrowserVersionBreakdownData,
): number {
  let totalViews = 0;
  let supportedViews = 0;

  for (const siteBrowser of browserData.data) {
    const caniuseBrowser = feature.support.browsers.find(
      (b) => b.browser === siteBrowser.browser,
    );

    for (const version of siteBrowser.versions) {
      if (version.isOther || version.isUnknown) continue;
      totalViews += version.views;

      if (!caniuseBrowser) continue;

      const vk = extractVersionKey(version.label, siteBrowser.browser);
      const status = caniuseBrowser.stats[vk];
      const base = parseBaseStatus(status);
      supportedViews += version.views * supportWeight(base);
    }
  }

  return totalViews > 0 ? supportedViews / totalViews : 0;
}

const SPEC_STATUS_LABELS: Record<string, string> = {
  rec: "W3C Recommendation",
  pr: "W3C Proposed Recommendation",
  cr: "W3C Candidate Recommendation",
  wd: "W3C Working Draft",
  ls: "Living Standard",
  other: "Other",
  unoff: "Unofficial",
};

/* ---------- main component ---------- */

interface CanIUseCompatCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

export function CanIUseCompatCard({
  locale,
  messages,
  siteId,
  window: tw,
  filters,
}: CanIUseCompatCardProps) {
  /* -- catalog state -- */
  const [searchIndex, setSearchIndex] = useState<CaniuseSearchEntry[]>([]);
  const [hotFeatures, setHotFeatures] = useState<CaniuseHotFeature[]>([]);
  const [trendingFeatures, setTrendingFeatures] = useState<CaniuseTrendingFeature[]>([]);
  const [indexLoading, setIndexLoading] = useState(true);

  /* -- browser data -- */
  const [browserData, setBrowserData] = useState<BrowserVersionBreakdownData>(emptyBreakdown);
  const [browserLoading, setBrowserLoading] = useState(true);

  /* -- search UI -- */
  const [query, setQuery] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);

  /* -- selected feature -- */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [featureDetail, setFeatureDetail] = useState<CaniuseFeatureDetail | null>(null);
  const [featureLoading, setFeatureLoading] = useState(false);

  /* -- preview details for default view -- */
  const [previewDetails, setPreviewDetails] = useState<Record<string, CaniuseFeatureDetail>>({});

  const m = messages.browsers;

  /* ---- fetch catalog on mount ---- */
  useEffect(() => {
    let active = true;
    setIndexLoading(true);

    Promise.all([
      fetch(CANIUSE_BASE).then((r) => r.json() as Promise<CaniuseSearchEntry[]>),
      fetch(`${CANIUSE_BASE}/hot/`).then((r) => r.json() as Promise<CaniuseHotFeature[]>),
      fetch(`${CANIUSE_BASE}/trending/`).then((r) => r.json() as Promise<CaniuseTrendingFeature[]>),
    ])
      .then(([idx, hot, trend]) => {
        if (!active) return;
        setSearchIndex(idx);
        setHotFeatures(hot);
        setTrendingFeatures(trend);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setIndexLoading(false);
      });

    return () => { active = false; };
  }, []);

  /* ---- fetch site browser data ---- */
  useEffect(() => {
    let active = true;
    setBrowserLoading(true);

    fetchBrowserVersionBreakdown(siteId, tw, filters, {
      browserLimit: 0,
      versionLimit: 0,
    })
      .catch(() => emptyBreakdown())
      .then((d) => {
        if (active) setBrowserData(d);
      })
      .finally(() => {
        if (active) setBrowserLoading(false);
      });

    return () => { active = false; };
  }, [siteId, tw.from, tw.to, filters]);

  /* ---- fetch feature detail ---- */
  useEffect(() => {
    if (!selectedId) {
      setFeatureDetail(null);
      return;
    }

    let active = true;
    setFeatureLoading(true);

    fetch(`${CANIUSE_BASE}/feature/${selectedId}/`)
      .then((r) => r.json() as Promise<CaniuseFeatureDetail>)
      .then((d) => {
        if (active) setFeatureDetail(d);
      })
      .catch(() => {
        if (active) setFeatureDetail(null);
      })
      .finally(() => {
        if (active) setFeatureLoading(false);
      });

    return () => { active = false; };
  }, [selectedId]);

  /* ---- batch-fetch preview details for default view ---- */
  useEffect(() => {
    if (hotFeatures.length === 0 && trendingFeatures.length === 0) return;

    const ids = new Set<string>();
    for (const f of hotFeatures.slice(0, 10)) ids.add(f.id);
    for (const f of trendingFeatures.slice(0, 10)) ids.add(f.id);

    let active = true;

    Promise.all(
      [...ids].map((id) =>
        fetch(`${CANIUSE_BASE}/feature/${id}/`)
          .then((r) => r.json() as Promise<CaniuseFeatureDetail>)
          .then((d) => [id, d] as const)
          .catch(() => null),
      ),
    ).then((results) => {
      if (!active) return;
      const map: Record<string, CaniuseFeatureDetail> = {};
      for (const r of results) {
        if (r) map[r[0]] = r[1];
      }
      setPreviewDetails(map);
    });

    return () => { active = false; };
  }, [hotFeatures, trendingFeatures]);

  /* ---- click outside ---- */
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* ---- search filtering ---- */
  const filteredSuggestions = useMemo(() => {
    if (query.length < 1) return [];
    const q = query.toLowerCase();
    return searchIndex
      .filter(
        (entry) =>
          entry.title.toLowerCase().includes(q) ||
          entry.keywords.some((kw) => kw.includes(q)),
      )
      .slice(0, 10);
  }, [query, searchIndex]);

  /* ---- preview site support map ---- */
  const previewSitePercent = useMemo(() => {
    if (!browserData.data.length) return {} as Record<string, number>;
    const map: Record<string, number> = {};
    for (const [id, detail] of Object.entries(previewDetails)) {
      map[id] = calcSitePercent(detail, browserData);
    }
    return map;
  }, [previewDetails, browserData]);

  /* ---- support calculation ---- */
  const siteSupport = useMemo(() => {
    if (!featureDetail || !browserData.data.length) return null;

    let totalViews = 0;
    let supportedViews = 0;
    const perBrowser: {
      browser: string;
      support: number;
      views: number;
      status: string;
      firstFullVersion: string | null;
      firstPartialVersion: string | null;
      currentVersion: string;
      type: string;
    }[] = [];

    for (const siteBrowser of browserData.data) {
      const caniuseBrowser = featureDetail.support.browsers.find(
        (b) => b.browser === siteBrowser.browser,
      );

      let browserSupported = 0;
      let browserTotal = 0;

      for (const version of siteBrowser.versions) {
        if (version.isOther || version.isUnknown) continue;
        totalViews += version.views;
        browserTotal += version.views;

        if (!caniuseBrowser) continue;

        const vk = extractVersionKey(version.label, siteBrowser.browser);
        const status = caniuseBrowser.stats[vk];
        const base = parseBaseStatus(status);
        const w = supportWeight(base);

        supportedViews += version.views * w;
        browserSupported += version.views * w;
      }

      if (caniuseBrowser) {
        perBrowser.push({
          browser: siteBrowser.browser,
          support: browserTotal > 0 ? browserSupported / browserTotal : 0,
          views: siteBrowser.views,
          status: parseBaseStatus(caniuseBrowser.current_status),
          firstFullVersion: caniuseBrowser.first_full_version,
          firstPartialVersion: caniuseBrowser.first_partial_version,
          currentVersion: caniuseBrowser.current_version,
          type: caniuseBrowser.type,
        });
      }
    }

    const sorted = perBrowser.sort((a, b) => b.views - a.views);
    const desktop = sorted.filter((b) => b.type === "desktop");
    const mobile = sorted.filter((b) => b.type !== "desktop");

    return {
      sitePercent: totalViews > 0 ? supportedViews / totalViews : 0,
      globalFullPercent: featureDetail.usage.fully_supported / 100,
      globalPartialPercent: featureDetail.usage.partially_supported / 100,
      desktop,
      mobile,
    };
  }, [featureDetail, browserData]);

  /* ---- callbacks ---- */
  const selectFeature = useCallback((id: string) => {
    setSelectedId(id);
    setQuery("");
    setDropdownOpen(false);
    setHighlightIdx(-1);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setFeatureDetail(null);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!dropdownOpen || filteredSuggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => (i + 1) % filteredSuggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => (i <= 0 ? filteredSuggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && highlightIdx >= 0) {
      e.preventDefault();
      selectFeature(filteredSuggestions[highlightIdx].id);
    } else if (e.key === "Escape") {
      setDropdownOpen(false);
    }
  }

  /* ---- status label ---- */
  function statusLabel(base: string): string {
    if (base === "y") return m.caniuseFullSupport;
    if (base === "a") return m.caniusePartialSupport;
    return m.caniuseNoSupport;
  }

  /* ---- render ---- */
  const loading = indexLoading || browserLoading;
  const hasContent = hotFeatures.length > 0 || trendingFeatures.length > 0 || !!selectedId;

  return (
    <section className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{m.caniuseTitle}</CardTitle>
          <CardDescription>{m.caniuseSubtitle}</CardDescription>
          <CardAction>
            <div ref={wrapperRef} className="relative w-56">
              <Input
                placeholder={m.caniuseSearchPlaceholder}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setDropdownOpen(true);
                  setHighlightIdx(-1);
                }}
                onFocus={() => {
                  if (query.length >= 1) setDropdownOpen(true);
                }}
                onKeyDown={handleKeyDown}
              />
              {dropdownOpen && query.length >= 1 && (
                <div className="absolute top-full left-0 z-50 mt-1 max-h-60 w-full overflow-auto border border-border bg-background shadow-lg">
                  {filteredSuggestions.length > 0 ? (
                    filteredSuggestions.map((item, i) => (
                      <button
                        key={item.id}
                        type="button"
                        className={cn(
                          "w-full px-2.5 py-1.5 text-left text-xs hover:bg-accent",
                          i === highlightIdx && "bg-accent",
                        )}
                        onMouseDown={() => selectFeature(item.id)}
                      >
                        {item.title}
                      </button>
                    ))
                  ) : (
                    <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                      {m.caniuseNoMatch}
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardAction>
        </CardHeader>

        <CardContent>
          <ContentSwitch
            loading={loading}
            hasContent={hasContent}
            loadingLabel={messages.common.loading}
            emptyContent={<p>{messages.common.noData}</p>}
            minHeightClassName="min-h-[200px]"
          >
            <AutoTransition duration={0.22}>
              {selectedId ? (
                <div key="feature-detail">
                  {featureLoading ? (
                    <div className="flex min-h-[200px] items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Spinner className="size-4" />
                      {messages.common.loading}
                    </div>
                  ) : featureDetail && siteSupport ? (
                    <div className="space-y-4">
                      {/* back button */}
                      <div className="flex justify-end">
                        <Clickable
                          onClick={clearSelection}
                          hoverScale={1.05}
                          tapScale={0.98}
                          className={cn(
                            "inline-flex h-8 items-center gap-2 rounded-none px-2 text-xs",
                            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                            "[&_svg]:size-4 [&_svg]:shrink-0",
                          )}
                        >
                        <RiArrowLeftLine />
                        <span>{m.caniuseClearSelection}</span>
                        </Clickable>
                      </div>

                      {/* header */}
                      <div className="space-y-1">
                        <h3 className="text-sm font-medium">{featureDetail.title}</h3>
                        <p className="text-xs text-muted-foreground">
                          {featureDetail.description}
                        </p>
                        {/* meta: categories + spec status */}
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {featureDetail.categories.map((cat) => (
                            <span
                              key={cat}
                              className="border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              {cat}
                            </span>
                          ))}
                          {featureDetail.status && (
                            <span className="border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {SPEC_STATUS_LABELS[featureDetail.status] ?? featureDetail.status}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* big numbers */}
                      <div className="grid grid-cols-3 gap-4">
                        <div className="border border-border p-3 text-center">
                          <div
                            className="font-mono text-2xl font-bold tabular-nums"
                            style={{ color: supportColor(siteSupport.sitePercent) }}
                          >
                            {percentFormat(locale, siteSupport.sitePercent)}
                          </div>
                          <div className="text-xs text-muted-foreground">{m.caniuseSiteSupport}</div>
                        </div>
                        <div className="border border-border p-3 text-center">
                          <div className="font-mono text-2xl font-bold tabular-nums">
                            {percentFormat(locale, siteSupport.globalFullPercent)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {m.caniuseGlobalSupport} ({m.caniuseFullSupport})
                          </div>
                        </div>
                        <div className="border border-border p-3 text-center">
                          <div className="font-mono text-2xl font-bold tabular-nums text-muted-foreground">
                            {percentFormat(locale, siteSupport.globalPartialPercent)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {m.caniuseGlobalSupport} ({m.caniusePartialSupport})
                          </div>
                        </div>
                      </div>

                      {/* per-browser table */}
                      {(siteSupport.desktop.length > 0 || siteSupport.mobile.length > 0) && (
                        <div className="grid grid-cols-[minmax(0,1fr)_max-content_max-content_max-content] items-center gap-x-3 gap-y-2">
                          {[...siteSupport.desktop, ...siteSupport.mobile].map((b) => (
                            <Fragment key={b.browser}>
                              <span className="truncate text-muted-foreground">
                                {b.browser}
                                <span className="ml-1 text-[10px] text-muted-foreground/60">
                                  v{b.currentVersion}
                                  {b.firstFullVersion && (
                                    <>, &ge;{b.firstFullVersion}</>
                                  )}
                                  {!b.firstFullVersion && b.firstPartialVersion && (
                                    <>, ~{b.firstPartialVersion}</>
                                  )}
                                </span>
                              </span>
                              <span className="text-right font-mono tabular-nums">
                                {percentFormat(locale, b.support)}
                              </span>
                              <span className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                                {numberFormat(locale, b.views)} {messages.common.views}
                              </span>
                              <span
                                className={cn(
                                  "text-right text-[11px] tabular-nums",
                                  b.status === "y" && "text-[var(--color-chart-2)]",
                                  b.status === "a" && "text-[var(--color-chart-4)]",
                                  b.status !== "y" && b.status !== "a" && "text-[var(--color-chart-5)]",
                                )}
                              >
                                {statusLabel(b.status)}
                              </span>
                            </Fragment>
                          ))}
                        </div>
                      )}

                      {/* external links */}
                      <div className="space-y-1.5 border-t border-border pt-3">
                        <a
                          href={`https://caniuse.com/#feat=${featureDetail.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <RiExternalLinkLine className="size-3 shrink-0" />
                          Can I Use
                        </a>
                        {featureDetail.spec && (
                          <a
                            href={featureDetail.spec}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <RiExternalLinkLine className="size-3 shrink-0" />
                            Spec
                          </a>
                        )}
                        {featureDetail.links?.map((link) => (
                          <a
                            key={link.url}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <RiExternalLinkLine className="size-3 shrink-0" />
                            {link.title}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div key="default-view" className="grid gap-4 md:grid-cols-2">
                  {/* hot features */}
                  <div>
                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                      {m.caniuseHotFeatures}
                    </h3>
                    <div className="grid grid-cols-[minmax(0,1fr)_max-content_max-content] gap-y-0.5">
                      {hotFeatures.slice(0, 10).map((f) => {
                        const sitePct = previewSitePercent[f.id];
                        return (
                          <Clickable
                            key={f.id}
                            onClick={() => selectFeature(f.id)}
                            hoverScale={1.02}
                            tapScale={0.98}
                            className="col-span-3 grid grid-cols-subgrid items-center gap-x-3 px-2 py-1.5 text-xs hover:bg-accent"
                          >
                            <span className="truncate text-left">{f.title}</span>
                            <span
                              className="text-right font-mono tabular-nums"
                              style={sitePct != null ? { color: supportColor(sitePct) } : undefined}
                            >
                              {sitePct != null ? percentFormat(locale, sitePct) : "–"}
                            </span>
                            <span className="text-right font-mono text-muted-foreground tabular-nums">
                              {percentFormat(locale, f.usage.fully_supported / 100)}
                            </span>
                          </Clickable>
                        );
                      })}
                    </div>
                  </div>

                  {/* trending features */}
                  <div>
                    <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                      {m.caniuseTrendingFeatures}
                    </h3>
                    <div className="grid grid-cols-[minmax(0,1fr)_max-content_max-content] gap-y-0.5">
                      {trendingFeatures.slice(0, 10).map((f) => {
                        const sitePct = previewSitePercent[f.id];
                        return (
                          <Clickable
                            key={`${f.id}-${f.date}`}
                            onClick={() => selectFeature(f.id)}
                            hoverScale={1.02}
                            tapScale={0.98}
                            className="col-span-3 grid grid-cols-subgrid items-center gap-x-3 px-2 py-1.5 text-xs hover:bg-accent"
                          >
                            <span className="truncate text-left">{f.title}</span>
                            <span
                              className="text-right font-mono tabular-nums"
                              style={sitePct != null ? { color: supportColor(sitePct) } : undefined}
                            >
                              {sitePct != null ? percentFormat(locale, sitePct) : "–"}
                            </span>
                            <span className="text-right font-mono text-muted-foreground tabular-nums">
                              {percentFormat(locale, f.usage.fully_supported / 100)}
                            </span>
                          </Clickable>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </AutoTransition>
          </ContentSwitch>
        </CardContent>
      </Card>
    </section>
  );
}
