import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@insightflare/ui/alert-dialog";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Badge } from "@insightflare/ui/badge";
import { Button } from "@insightflare/ui/button";
import { Card, CardContent } from "@insightflare/ui/card";
import { Checkbox } from "@insightflare/ui/checkbox";
import { Field, FieldLabel } from "@insightflare/ui/field";
import { Input } from "@insightflare/ui/input";
import { Label } from "@insightflare/ui/label";
import { OverlayScrollbar } from "@insightflare/ui/overlay-scrollbar";
import { PageHeading } from "@insightflare/ui/page-heading";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@insightflare/ui/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import {
  RiAddLine,
  RiArrowRightLine,
  RiBarChartLine,
  RiCheckLine,
  RiCodeLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiFileCopyLine,
  RiGlobeLine,
  RiLineChartLine,
  RiLoader4Line,
  RiNumbersLine,
  RiPauseCircleLine,
  RiPieChartLine,
  RiPulseLine,
  RiRestartLine,
  RiSettings3Line,
} from "@remixicon/react";
import { toast } from "sonner";

import { HighlightedCode } from "@/components/code/highlighted-code";
import {
  buildTimeZoneOptions,
  supportedTimeZones,
} from "@/lib/analytics/time-zone";
import { getSessionToken } from "@/lib/auth";
import { fetchGoals } from "@/lib/dashboard/client/data/goals";
import { intlLocale } from "@/lib/dashboard/format";
import { readReportingTimeZoneFromCookie } from "@/lib/dashboard/query-preferences";
import { type Locale, SUPPORTED_LOCALES } from "@/lib/i18n/config";
import { nativeLocaleName } from "@/lib/i18n/native-locale-names";
import type {
  WidgetConfig,
  WidgetData,
  WidgetRecord,
} from "@/lib/widgets/contract";
import {
  normalizeWidgetOrigin,
  suggestedWidgetHeight,
} from "@/lib/widgets/contract";
import { renderWidgetDocument } from "@/lib/widgets/embed";

import { widgetLabels } from "./labels";
import {
  widgetTemplateConfig,
  WidgetTemplateGallery,
  type WidgetTemplateId,
} from "./widget-templates";

interface WidgetSite {
  id: string;
  name: string;
  domain: string;
}

interface WidgetsManagerProps {
  locale: Locale;
  teamId: string;
  teamName: string;
  sites: WidgetSite[];
}

type WidgetType = WidgetConfig["type"];

const widgetTypeIcons = {
  metric: RiNumbersLine,
  trend: RiLineChartLine,
  ranking: RiBarChartLine,
  distribution: RiPieChartLine,
  conversion: RiPulseLine,
  geo: RiGlobeLine,
  realtime: RiPulseLine,
} satisfies Record<WidgetType, typeof RiNumbersLine>;
type PreviewSize = "compact" | "regular" | "wide";
type ConfirmAction = "publish" | "unpublish" | "delete" | null;

interface ApiResult<T> {
  data: T;
  nextCursor?: string | null;
}

const textareaClassName =
  "flex min-h-24 w-full rounded-none border border-input bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

function defaultTimeZone(): string {
  try {
    return readReportingTimeZoneFromCookie(
      typeof document === "undefined" ? null : document.cookie,
    );
  } catch {
    return "UTC";
  }
}

function defaultAllowedOrigin(domain: string): string[] {
  const host = domain.trim();
  if (!host) return [];
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(host)
    ? host
    : `https://${host}`;
  const origin = normalizeWidgetOrigin(candidate);
  return origin ? [origin] : [];
}

function defaultConfig(locale: Locale, domain: string): WidgetConfig {
  return {
    title: "",
    type: "metric",
    metric: "visitors",
    range: "30d",
    timeZone: defaultTimeZone(),
    locale,
    theme: "auto",
    embedMode: "restricted",
    allowedOrigins: defaultAllowedOrigin(domain),
    comparison: true,
    dimension: "page.path",
    limit: 5,
    rankingStyle: "list",
    pageLinksEnabled: false,
    distributionStyle: "bars",
    trendStyle: "line",
    distributionDimension: "client.deviceType",
    trendMetrics: [],
    conversionKind: "event",
    eventName: "",
    goalId: "",
    geoProjection: "flat",
    realtimeLayout: "badge",
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function widgetRequest<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const token = await getSessionToken();
  const headers = new Headers({ accept: "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (method !== "GET" && method !== "DELETE") {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    method,
    headers,
    body:
      method === "GET" || method === "DELETE"
        ? undefined
        : JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "message" in payload
        ? String(payload.message)
        : `Widget request failed (${response.status})`;
    throw new Error(error);
  }
  return payload as T;
}

function htmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function displayType(type: WidgetType, copy: ReturnType<typeof widgetLabels>) {
  if (type === "trend") return copy.trendType;
  if (type === "ranking") return copy.rankingType;
  if (type === "distribution") return copy.distributionType;
  if (type === "conversion") return copy.conversionType;
  if (type === "geo") return copy.geoType;
  if (type === "realtime") return copy.realtimeType;
  return copy.metricType;
}

function statusLabel(
  status: WidgetRecord["status"],
  copy: ReturnType<typeof widgetLabels>,
) {
  if (status === "published") return copy.statusPublished;
  if (status === "unpublished") return copy.statusUnpublished;
  return copy.statusDraft;
}

function metricLabel(
  metric: WidgetConfig["metric"],
  copy: ReturnType<typeof widgetLabels>,
) {
  if (metric === "views") return copy.views;
  if (metric === "sessions") return copy.sessions;
  if (metric === "bounces") return copy.bounces;
  if (metric === "bounceRate") return copy.bounceRate;
  if (metric === "avgDurationMs") return copy.avgDurationMs;
  if (metric === "viewsPerSession") return copy.viewsPerSession;
  if (metric === "events") return copy.events;
  return copy.visitors;
}

function widgetParameters(
  config: WidgetConfig,
  copy: ReturnType<typeof widgetLabels>,
): string {
  if (config.type === "realtime") {
    return [
      copy.realtimeType,
      config.realtimeLayout === "badge"
        ? copy.realtimeBadge
        : config.realtimeLayout === "trend"
          ? copy.realtimeTrend
          : config.realtimeLayout === "map"
            ? config.geoProjection === "globe"
              ? copy.geoGlobe
              : copy.geoFlat
            : copy.realtimePages,
      "30s",
    ].join(" · ");
  }
  const parameters = [
    displayType(config.type, copy),
    metricLabel(config.metric, copy),
    config.range === "7d" ? copy.sevenDays : copy.thirtyDays,
  ];
  if (config.type === "ranking") {
    parameters.push(
      config.dimension === "page.path"
        ? copy.pagePath
        : config.dimension === "source.domain"
          ? copy.sourceDomain
          : copy.country,
      copy.limit + ": " + config.limit,
    );
  }
  if (config.type === "ranking" && config.rankingStyle === "bars")
    parameters.push(copy.rankingBars);
  if (config.type === "distribution") {
    parameters.push(
      config.distributionStyle === "donut"
        ? copy.distributionDonut
        : config.distributionStyle === "ratio"
          ? copy.distributionRatio
          : copy.distributionBars,
    );
    parameters.push(
      config.distributionDimension === "client.deviceType"
        ? copy.deviceType
        : config.distributionDimension === "client.browser"
          ? copy.browser
          : config.distributionDimension === "utm.source"
            ? copy.utmSource
            : copy.sourceDomain,
    );
  }
  if (config.type === "geo")
    parameters.push(
      config.geoProjection === "globe" ? copy.geoGlobe : copy.geoFlat,
    );
  if (config.type === "trend")
    parameters.push(
      config.trendStyle === "area" ? copy.trendArea : copy.trendLine,
    );
  if (config.type === "trend" && config.trendMetrics.length > 0) {
    parameters.push(
      config.trendMetrics
        .map((metric) => metricLabel(metric, copy))
        .join(" / "),
    );
  }
  if (config.type === "conversion") {
    parameters.push(
      config.conversionKind === "event"
        ? `${copy.eventConversion}: ${config.eventName}`
        : copy.goalConversion,
    );
  }
  if (config.type === "metric" && config.comparison)
    parameters.push(copy.comparison);
  return parameters.join(" · ");
}

export function WidgetsManager({ locale, teamId, sites }: WidgetsManagerProps) {
  const copy = useMemo(() => widgetLabels(locale), [locale]);
  const timeZones = useMemo(() => supportedTimeZones(), []);
  const timeZoneTimestamp = useMemo(() => Date.now(), []);

  const [previewSize, setPreviewSize] = useState<PreviewSize>("regular");
  const previewWidth =
    previewSize === "compact" ? 220 : previewSize === "wide" ? 560 : 360;
  const [records, setRecords] = useState<WidgetRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [siteFilter, setSiteFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | WidgetType>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<WidgetRecord | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const timeZoneOptions = useMemo(
    () =>
      buildTimeZoneOptions({
        locale: intlLocale(locale),
        supported: timeZones,
        selected: config?.timeZone,
        timestampMs: timeZoneTimestamp,
      }),
    [locale, timeZones, config?.timeZone, timeZoneTimestamp],
  );
  const [originText, setOriginText] = useState("");
  const [previewData, setPreviewData] = useState<WidgetData | null>(null);
  const [goalOptions, setGoalOptions] = useState<
    { id: string; name: string }[]
  >([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmTarget, setConfirmTarget] = useState<WidgetRecord | null>(null);
  const [publishConfig, setPublishConfig] = useState<WidgetConfig | null>(null);
  const [publishDisclosure, setPublishDisclosure] = useState(false);
  const [embedRecord, setEmbedRecord] = useState<WidgetRecord | null>(null);
  const [embedLanguage, setEmbedLanguage] = useState<"auto" | Locale>("auto");
  const pendingUuid = useRef<string | null>(null);
  const formRevision = useRef(0);
  const actionInFlight = useRef(false);

  const basePath = `/api/private/widgets/teams/${encodeURIComponent(teamId)}`;
  const siteById = useMemo(
    () => new Map(sites.map((site) => [site.id, site])),
    [sites],
  );
  const scopedRecords = useMemo(
    () =>
      siteFilter === "all"
        ? records
        : records.filter((record) => record.siteId === siteFilter),
    [records, siteFilter],
  );
  const visibleRecords = useMemo(
    () =>
      typeFilter === "all"
        ? scopedRecords
        : scopedRecords.filter((record) => {
            const active = record.published ?? record.draft;
            return active.type === typeFilter;
          }),
    [scopedRecords, typeFilter],
  );
  const typeOptions = [
    { id: "all", label: copy.allTypes },
    { id: "metric", label: copy.metricType },
    { id: "trend", label: copy.trendType },
    { id: "ranking", label: copy.rankingType },
    { id: "distribution", label: copy.distributionType },
    { id: "conversion", label: copy.conversionType },
    { id: "geo", label: copy.geoType },
    { id: "realtime", label: copy.realtimeType },
  ] as const;

  const loadRecords = useCallback(
    async (nextCursor?: string | null, append = false) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setListError(null);
      }
      try {
        const path = nextCursor
          ? `${basePath}?cursor=${encodeURIComponent(nextCursor)}`
          : basePath;
        const result = await widgetRequest<ApiResult<WidgetRecord[]>>(
          path,
          "GET",
        );
        setRecords((current) => {
          if (!append) return result.data;
          const byId = new Map(current.map((record) => [record.uuid, record]));
          for (const record of result.data) byId.set(record.uuid, record);
          return [...byId.values()];
        });
        setCursor(result.nextCursor ?? null);
      } catch (error) {
        setListError(errorMessage(error, copy.loadingError));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [basePath, copy.loadingError],
  );

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    if (
      !editorOpen ||
      !selectedSiteId ||
      config?.type !== "conversion" ||
      config.conversionKind !== "goal"
    )
      return;
    let alive = true;
    setGoalOptions([]);
    void fetchGoals(selectedSiteId, { limit: 100 })
      .then((result) => {
        if (alive)
          setGoalOptions(
            result.data.items.map((goal) => ({
              id: goal.id,
              name: goal.name,
            })),
          );
      })
      .catch(() => {
        if (alive) setGoalOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [editorOpen, selectedSiteId, config?.type, config?.conversionKind]);

  function openCreate(template?: WidgetTemplateId) {
    if (sites.length === 0) return;
    const site = sites[0];
    const baseline = defaultConfig(locale, site.domain);
    const initial = template
      ? widgetTemplateConfig(baseline, template)
      : baseline;
    setEditingRecord(null);
    setSelectedSiteId(site.id);
    setConfig(initial);
    formRevision.current += 1;
    setOriginText(initial.allowedOrigins.join("\n"));
    setPreviewData(null);
    setPreviewError(null);
    pendingUuid.current = null;
    setEditorOpen(true);
  }

  function openEdit(record: WidgetRecord) {
    setEditingRecord(record);
    setSelectedSiteId(record.siteId);
    setConfig({
      ...record.draft,
      allowedOrigins: [...record.draft.allowedOrigins],
    });
    formRevision.current += 1;
    setOriginText(record.draft.allowedOrigins.join("\n"));
    setPreviewData(null);
    setPreviewError(null);
    pendingUuid.current = record.uuid;
    setEditorOpen(true);
  }

  function changeSite(siteId: string) {
    setSelectedSiteId(siteId);
    if (editingRecord || !config) return;
    const site = siteById.get(siteId);
    const allowedOrigins = defaultAllowedOrigin(site?.domain ?? "");
    setOriginText(allowedOrigins.join("\n"));
    setConfig({ ...config, allowedOrigins });
    formRevision.current += 1;
    setPreviewData(null);
  }

  function updateConfig(next: WidgetConfig) {
    formRevision.current += 1;
    setConfig(next);
    setPreviewData(null);
  }

  function updateOrigins(next: string) {
    formRevision.current += 1;
    setOriginText(next);
    setPreviewData(null);
  }

  const getFormConfig = useCallback((): WidgetConfig | null => {
    if (!config || !selectedSiteId) return null;
    if (
      config.type === "conversion" &&
      (config.conversionKind === "event"
        ? config.eventName.trim().length === 0
        : config.goalId.trim().length === 0)
    )
      return null;
    const allowedOrigins = originText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((origin) => normalizeWidgetOrigin(origin));
    if (
      config.embedMode === "restricted" &&
      (allowedOrigins.length === 0 || allowedOrigins.some((origin) => !origin))
    ) {
      return null;
    }
    let timeZone = config.timeZone.trim();
    try {
      timeZone = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions()
        .timeZone;
    } catch {
      return null;
    }
    return {
      ...config,
      title: config.title.trim(),
      timeZone,
      allowedOrigins: allowedOrigins.filter((origin): origin is string =>
        Boolean(origin),
      ),
    };
  }, [config, selectedSiteId, originText, copy]);

  const loadPreview = useCallback(async () => {
    const nextConfig = getFormConfig();
    if (!nextConfig) {
      setPreviewError(
        config?.type === "conversion"
          ? copy.targetRequired
          : copy.invalidOrigins,
      );
      return;
    }
    setPreviewBusy(true);
    setPreviewError(null);
    const requestRevision = formRevision.current;
    try {
      const result = await widgetRequest<ApiResult<WidgetData>>(
        `${basePath}/preview`,
        "POST",
        { siteId: selectedSiteId, config: nextConfig },
      );
      if (requestRevision === formRevision.current) setPreviewData(result.data);
    } catch (error) {
      if (requestRevision === formRevision.current) {
        setPreviewError(errorMessage(error, copy.requestError));
        setPreviewData(null);
      }
    } finally {
      if (requestRevision === formRevision.current) setPreviewBusy(false);
    }
  }, [getFormConfig, basePath, selectedSiteId, copy]);

  useEffect(() => {
    if (!editorOpen || !config || !selectedSiteId) return;
    const timeout = setTimeout(() => void loadPreview(), 450);
    return () => clearTimeout(timeout);
  }, [editorOpen, config, selectedSiteId, originText, loadPreview]);

  async function saveDraft(): Promise<WidgetRecord | null> {
    if (actionInFlight.current) return null;
    const nextConfig = getFormConfig();
    if (!nextConfig) {
      setPreviewError(
        config?.type === "conversion" ? copy.targetRequired : copy.required,
      );
      return null;
    }
    actionInFlight.current = true;
    setBusy(true);
    try {
      let result: ApiResult<WidgetRecord>;
      if (editingRecord) {
        result = await widgetRequest<ApiResult<WidgetRecord>>(
          `${basePath}/${encodeURIComponent(editingRecord.uuid)}`,
          "PUT",
          { config: nextConfig },
        );
      } else {
        pendingUuid.current ??= crypto.randomUUID();
        result = await widgetRequest<ApiResult<WidgetRecord>>(
          basePath,
          "POST",
          {
            uuid: pendingUuid.current,
            siteId: selectedSiteId,
            config: nextConfig,
          },
        );
        setEditingRecord(result.data);
      }
      setRecords((current) => {
        const next = current.filter(
          (record) => record.uuid !== result.data.uuid,
        );
        return [result.data, ...next];
      });
      setConfig(result.data.draft);
      formRevision.current += 1;
      setOriginText(result.data.draft.allowedOrigins.join("\n"));
      return result.data;
    } catch (error) {
      setPreviewError(errorMessage(error, copy.requestError));
      return null;
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  async function askPublish() {
    const nextConfig = getFormConfig();
    if (!nextConfig) {
      setPreviewError(
        config?.type === "conversion" ? copy.targetRequired : copy.required,
      );
      return;
    }
    setConfirmTarget(editingRecord);
    setPublishConfig(nextConfig);
    setPublishDisclosure(false);
    setConfirmAction("publish");
  }

  async function performConfirmedAction() {
    const target = confirmTarget;
    const action = confirmAction;
    if (!action || actionInFlight.current) return;
    if (action !== "publish" && !target) return;
    if (action === "publish" && !publishConfig) return;
    actionInFlight.current = true;
    setBusy(true);
    try {
      if (action === "delete") {
        if (!target) return;
        await widgetRequest<unknown>(
          `${basePath}/${encodeURIComponent(target.uuid)}`,
          "DELETE",
        );
        setRecords((current) =>
          current.filter((record) => record.uuid !== target.uuid),
        );
      } else {
        let result: ApiResult<WidgetRecord>;
        if (action === "publish" && publishConfig) {
          if (target) {
            result = await widgetRequest<ApiResult<WidgetRecord>>(
              `${basePath}/${encodeURIComponent(target.uuid)}/publish`,
              "POST",
              { config: publishConfig },
            );
          } else {
            pendingUuid.current ??= crypto.randomUUID();
            result = await widgetRequest<ApiResult<WidgetRecord>>(
              basePath,
              "POST",
              {
                uuid: pendingUuid.current,
                siteId: selectedSiteId,
                config: publishConfig,
                publish: true,
              },
            );
          }
        } else {
          if (!target) return;
          result = await widgetRequest<ApiResult<WidgetRecord>>(
            `${basePath}/${encodeURIComponent(target.uuid)}/unpublish`,
            "POST",
          );
        }
        setRecords((current) => [
          result.data,
          ...current.filter((record) => record.uuid !== target?.uuid),
        ]);
        if (target && editingRecord?.uuid === target.uuid)
          setEditingRecord(result.data);
        if (action === "publish") openEmbed(result.data);
      }
      setConfirmAction(null);
      setConfirmTarget(null);
      setPublishConfig(null);
      if (action === "delete" && editingRecord?.uuid === target?.uuid) {
        setEditorOpen(false);
        setEditingRecord(null);
      }
      if (action === "publish") setEditorOpen(false);
    } catch (error) {
      toast.error(errorMessage(error, copy.requestError));
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  function startConfirm(
    action: Exclude<ConfirmAction, null>,
    record: WidgetRecord,
  ) {
    setConfirmTarget(record);
    setPublishDisclosure(false);
    setConfirmAction(action);
  }

  function openEmbed(record: WidgetRecord) {
    setEmbedLanguage("auto");
    setEmbedRecord(record);
  }

  function embedPath(record: WidgetRecord): string {
    const prefix = embedLanguage === "auto" ? "" : `/${embedLanguage}`;
    return `${prefix}/widget/${encodeURIComponent(record.uuid)}`;
  }

  function embedCode(record: WidgetRecord): string {
    const configForEmbed = record.published ?? record.draft;
    const src = `${window.location.origin}${embedPath(record)}`;
    const title =
      configForEmbed.title || displayType(configForEmbed.type, copy);
    return `<iframe src="${htmlAttribute(src)}" title="${htmlAttribute(title)}" width="100%" height="${suggestedWidgetHeight(configForEmbed)}" loading="lazy" style="border:0"></iframe>`;
  }

  async function copyEmbed(record: WidgetRecord) {
    try {
      await navigator.clipboard.writeText(embedCode(record));
      toast.success(copy.copied);
    } catch {
      toast.error(copy.requestError);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeading
        title={copy.title}
        subtitle={copy.subtitle}
        actions={
          <>
            {sites.length > 0 ? (
              <div className="w-40 sm:w-52">
                <Label htmlFor="widget-site-filter" className="sr-only">
                  {copy.listFilter}
                </Label>
                <Select value={siteFilter} onValueChange={setSiteFilter}>
                  <SelectTrigger id="widget-site-filter" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="all">{copy.allSites}</SelectItem>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <Button
              onClick={() => openCreate()}
              disabled={loading || sites.length === 0}
            >
              <RiAddLine className="size-4" aria-hidden="true" />
              {copy.create}
            </Button>
          </>
        }
      />

      <WidgetTemplateGallery
        copy={copy}
        disabled={loading || sites.length === 0}
        onSelect={openCreate}
      />

      <section
        className="min-w-0 space-y-3"
        aria-label={copy.collectionHeading}
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold">{copy.collectionHeading}</h2>
            <p className="text-xs tabular-nums text-muted-foreground">
              {scopedRecords.length} {copy.widgets}
            </p>
          </div>
          <div
            role="group"
            aria-label={copy.type}
            className="flex max-w-full flex-wrap gap-1.5"
          >
            {typeOptions.map((option) => {
              const count =
                option.id === "all"
                  ? scopedRecords.length
                  : scopedRecords.filter(
                      (record) =>
                        (record.published ?? record.draft).type === option.id,
                    ).length;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={typeFilter === option.id}
                  onClick={() => setTypeFilter(option.id)}
                  className={`inline-flex min-h-8 items-center gap-1.5 border px-2.5 text-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${typeFilter === option.id ? "border-foreground/25 bg-muted font-medium text-foreground" : "border-border bg-background text-muted-foreground"}`}
                >
                  {option.label}
                  {count > 0 ? (
                    <span className="tabular-nums opacity-60">{count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <AutoResizer className="w-full" duration={0.24}>
          {sites.length === 0 ? (
            <Card>
              <CardContent className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
                <RiLineChartLine
                  className="size-8 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="max-w-md text-sm text-muted-foreground">
                  {copy.noSites}
                </p>
              </CardContent>
            </Card>
          ) : loading ? (
            <Card>
              <CardContent className="flex min-h-44 items-center justify-center gap-2 text-sm text-muted-foreground">
                <RiLoader4Line
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
                {copy.loading}
              </CardContent>
            </Card>
          ) : listError ? (
            <Card>
              <CardContent className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-destructive">{listError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadRecords()}
                >
                  <RiRestartLine className="size-4" aria-hidden="true" />
                  {copy.retry}
                </Button>
              </CardContent>
            </Card>
          ) : visibleRecords.length === 0 ? (
            <Card>
              <CardContent className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
                <RiLineChartLine
                  className="size-8 text-muted-foreground/70"
                  aria-hidden="true"
                />
                <p className="text-sm text-muted-foreground">
                  {copy.noWidgets}
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid auto-rows-[8px] grid-flow-row-dense grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-x-4">
                {visibleRecords.map((record) => {
                  const site = siteById.get(record.siteId);
                  const activeConfig = record.published ?? record.draft;
                  const TypeIcon = widgetTypeIcons[activeConfig.type];
                  return (
                    <MasonryItem key={record.uuid}>
                      <Card className="w-full min-w-0 gap-0 py-0 transition-colors hover:border-foreground/20">
                        <CardContent className="flex w-full min-w-0 flex-col gap-2.5 p-3.5">
                          <header className="flex min-w-0 items-start gap-2.5">
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <p className="flex min-w-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
                                <TypeIcon
                                  className="size-[1em] shrink-0"
                                  aria-hidden="true"
                                />
                                <span className="truncate">
                                  {displayType(activeConfig.type, copy)}
                                  {" · "}
                                  {activeConfig.type === "realtime"
                                    ? "30s"
                                    : activeConfig.range === "7d"
                                      ? copy.sevenDays
                                      : copy.thirtyDays}
                                </span>
                              </p>
                              <h3
                                className="truncate text-[13px] font-semibold leading-5"
                                title={activeConfig.title}
                              >
                                {activeConfig.title ||
                                  displayType(activeConfig.type, copy)}
                              </h3>
                              <p
                                className="truncate text-[11px] text-muted-foreground"
                                title={site ? site.domain : undefined}
                              >
                                {site?.name ?? copy.site}
                                {site?.domain ? ` · ${site.domain}` : ""}
                              </p>
                            </div>
                            <Badge className="shrink-0" variant="secondary">
                              {statusLabel(record.status, copy)}
                            </Badge>
                          </header>
                          <div
                            className="min-w-0"
                            title={widgetParameters(activeConfig, copy)}
                          >
                            <WidgetListPreview
                              record={record}
                              basePath={basePath}
                              copy={copy}
                              locale={locale}
                              siteOrigin={
                                defaultAllowedOrigin(site?.domain ?? "")[0]
                              }
                            />
                          </div>
                          <div className="flex min-w-0 items-center gap-1 border-t pt-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(record)}
                            >
                              <RiSettings3Line
                                className="size-4"
                                aria-hidden="true"
                              />
                              {copy.edit}
                            </Button>
                            {record.status === "published" ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openEmbed(record)}
                              >
                                <RiCodeLine
                                  className="size-4"
                                  aria-hidden="true"
                                />
                                {copy.embedCode}
                              </Button>
                            ) : null}
                            <div className="ml-auto flex items-center gap-0.5">
                              {record.status === "published" ? (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={copy.unpublish}
                                  title={copy.unpublish}
                                  onClick={() =>
                                    startConfirm("unpublish", record)
                                  }
                                >
                                  <RiPauseCircleLine
                                    className="size-4"
                                    aria-hidden="true"
                                  />
                                </Button>
                              ) : null}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => startConfirm("delete", record)}
                              >
                                <RiDeleteBinLine
                                  className="size-4"
                                  aria-hidden="true"
                                />
                                {copy.delete}
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </MasonryItem>
                  );
                })}
              </div>
              {cursor ? (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingMore}
                    onClick={() => void loadRecords(cursor, true)}
                  >
                    {loadingMore ? (
                      <RiLoader4Line
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : null}
                    {copy.more}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </AutoResizer>
      </section>

      <ResponsiveDialog open={editorOpen} onOpenChange={setEditorOpen}>
        <ResponsiveDialogContent
          className="flex flex-col overflow-hidden p-0"
          desktopClassName="max-h-[min(860px,calc(100dvh-1rem))] max-w-6xl"
          drawerClassName="h-[85dvh] max-h-[85dvh]"
        >
          <div className="shrink-0 border-b p-4 sm:p-6">
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle icon={RiSettings3Line}>
                {editingRecord ? copy.edit : copy.create}
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {copy.previewHint}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
          </div>
          <ResponsiveDialogBody className="p-4 sm:p-6">
            {config ? (
              <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="grid content-start gap-4 sm:grid-cols-2">
                  <FormSelect
                    className="sm:col-span-2"
                    id="widget-site"
                    label={copy.site}
                    value={selectedSiteId}
                    disabled={Boolean(editingRecord)}
                    onChange={changeSite}
                  >
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name} · {site.domain}
                      </SelectItem>
                    ))}
                  </FormSelect>
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="widget-title">{copy.name}</FieldLabel>
                    <Input
                      id="widget-title"
                      value={config.title}
                      maxLength={120}
                      onChange={(event) =>
                        updateConfig({ ...config, title: event.target.value })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      {copy.titleHint}
                    </p>
                  </Field>
                  <FormSelect
                    id="widget-type"
                    label={copy.type}
                    value={config.type}
                    onChange={(value) => {
                      const type = value as WidgetType;
                      const allowed = [
                        "visitors",
                        "views",
                        "sessions",
                      ].includes(config.metric);
                      updateConfig({
                        ...config,
                        type,
                        realtimeLayout:
                          type === "realtime" ? "badge" : config.realtimeLayout,
                        metric:
                          type === "metric" || type === "conversion" || allowed
                            ? config.metric
                            : "visitors",
                      });
                    }}
                  >
                    <SelectItem value="metric">{copy.metricType}</SelectItem>
                    <SelectItem value="trend">{copy.trendType}</SelectItem>
                    <SelectItem value="ranking">{copy.rankingType}</SelectItem>
                    <SelectItem value="distribution">
                      {copy.distributionType}
                    </SelectItem>
                    <SelectItem value="conversion">
                      {copy.conversionType}
                    </SelectItem>
                    <SelectItem value="geo">{copy.geoType}</SelectItem>
                    <SelectItem value="realtime">
                      {copy.realtimeType}
                    </SelectItem>
                  </FormSelect>
                  <div className="min-w-0">
                    <AutoResizer initial duration={0.2}>
                      <AutoTransition
                        transitionKey={
                          config.type === "conversion" ? "hidden" : "metric"
                        }
                        initial={false}
                        duration={0.18}
                        type="fade"
                      >
                        <div
                          key={
                            config.type === "conversion" ? "hidden" : "metric"
                          }
                          className="min-w-0"
                        >
                          {config.type !== "conversion" &&
                          config.type !== "realtime" ? (
                            <FormSelect
                              id="widget-metric"
                              label={copy.metric}
                              value={config.metric}
                              onChange={(value) =>
                                updateConfig({
                                  ...config,
                                  metric: value as WidgetConfig["metric"],
                                })
                              }
                            >
                              <SelectItem value="visitors">
                                {copy.visitors}
                              </SelectItem>
                              <SelectItem value="views">
                                {copy.views}
                              </SelectItem>
                              <SelectItem value="sessions">
                                {copy.sessions}
                              </SelectItem>
                              {config.type === "metric" ? (
                                <>
                                  <SelectItem value="bounces">
                                    {copy.bounces}
                                  </SelectItem>
                                  <SelectItem value="bounceRate">
                                    {copy.bounceRate}
                                  </SelectItem>
                                  <SelectItem value="avgDurationMs">
                                    {copy.avgDurationMs}
                                  </SelectItem>
                                  <SelectItem value="viewsPerSession">
                                    {copy.viewsPerSession}
                                  </SelectItem>
                                  <SelectItem value="events">
                                    {copy.events}
                                  </SelectItem>
                                </>
                              ) : null}
                            </FormSelect>
                          ) : null}
                        </div>
                      </AutoTransition>
                    </AutoResizer>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <AutoResizer initial duration={0.2}>
                      <AutoTransition
                        transitionKey={
                          config.type === "realtime" ? "live" : "history"
                        }
                        initial={false}
                        duration={0.18}
                        type="fade"
                      >
                        {config.type === "realtime" ? (
                          <div
                            key="live"
                            className="text-xs text-muted-foreground"
                          >
                            {copy.realtimeType} · 30s
                          </div>
                        ) : (
                          <div
                            key="history"
                            className="grid min-w-0 gap-4 sm:grid-cols-2"
                          >
                            <FormSelect
                              id="widget-range"
                              label={copy.range}
                              value={config.range}
                              onChange={(value) =>
                                updateConfig({
                                  ...config,
                                  range: value as WidgetConfig["range"],
                                })
                              }
                            >
                              <SelectItem value="7d">
                                {copy.sevenDays}
                              </SelectItem>
                              <SelectItem value="30d">
                                {copy.thirtyDays}
                              </SelectItem>
                            </FormSelect>
                            <FormSelect
                              id="widget-time-zone"
                              label={copy.timeZone}
                              value={config.timeZone}
                              onChange={(timeZone) =>
                                updateConfig({ ...config, timeZone })
                              }
                            >
                              {timeZoneOptions.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </FormSelect>
                          </div>
                        )}
                      </AutoTransition>
                    </AutoResizer>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <AutoResizer initial duration={0.2}>
                      <AutoTransition
                        transitionKey={config.type}
                        initial={false}
                        duration={0.18}
                        type="fade"
                      >
                        <div
                          key={config.type}
                          className="grid min-w-0 gap-4 sm:grid-cols-2"
                        >
                          {config.type === "ranking" ? (
                            <>
                              <FormSelect
                                id="widget-dimension"
                                label={copy.dimension}
                                value={config.dimension}
                                onChange={(value) =>
                                  updateConfig({
                                    ...config,
                                    dimension:
                                      value as WidgetConfig["dimension"],
                                  })
                                }
                              >
                                <SelectItem value="page.path">
                                  {copy.pagePath}
                                </SelectItem>
                                <SelectItem value="source.domain">
                                  {copy.sourceDomain}
                                </SelectItem>
                                <SelectItem value="geo.country">
                                  {copy.country}
                                </SelectItem>
                              </FormSelect>
                              <FormSelect
                                id="widget-limit"
                                label={copy.limit}
                                value={String(config.limit)}
                                onChange={(value) =>
                                  updateConfig({
                                    ...config,
                                    limit: Number(value) as 5 | 10,
                                  })
                                }
                              >
                                <SelectItem value="5">5</SelectItem>
                                <SelectItem value="10">10</SelectItem>
                              </FormSelect>
                            </>
                          ) : null}
                          {config.type === "ranking" ? (
                            <FormSelect
                              id="widget-ranking-style"
                              label={copy.rankingStyle}
                              value={config.rankingStyle}
                              onChange={(rankingStyle) =>
                                updateConfig({
                                  ...config,
                                  rankingStyle:
                                    rankingStyle as WidgetConfig["rankingStyle"],
                                })
                              }
                            >
                              <SelectItem value="list">
                                {copy.rankingList}
                              </SelectItem>
                              <SelectItem value="bars">
                                {copy.rankingBars}
                              </SelectItem>
                            </FormSelect>
                          ) : null}
                          {config.type === "distribution" ? (
                            <>
                              <FormSelect
                                id="widget-distribution-dimension"
                                label={copy.distributionDimension}
                                value={config.distributionDimension}
                                onChange={(distributionDimension) =>
                                  updateConfig({
                                    ...config,
                                    distributionDimension:
                                      distributionDimension as WidgetConfig["distributionDimension"],
                                  })
                                }
                              >
                                <SelectItem value="client.deviceType">
                                  {copy.deviceType}
                                </SelectItem>
                                <SelectItem value="client.browser">
                                  {copy.browser}
                                </SelectItem>
                                <SelectItem value="source.domain">
                                  {copy.sourceDomain}
                                </SelectItem>
                                <SelectItem value="utm.source">
                                  {copy.utmSource}
                                </SelectItem>
                              </FormSelect>
                              <FormSelect
                                id="widget-distribution-limit"
                                label={copy.limit}
                                value={String(config.limit)}
                                onChange={(limit) =>
                                  updateConfig({
                                    ...config,
                                    limit: Number(limit) as 5 | 10,
                                  })
                                }
                              >
                                <SelectItem value="5">5</SelectItem>
                                <SelectItem value="10">10</SelectItem>
                              </FormSelect>
                            </>
                          ) : null}
                          {config.type === "distribution" ? (
                            <FormSelect
                              id="widget-distribution-style"
                              label={copy.distributionStyle}
                              value={config.distributionStyle}
                              onChange={(distributionStyle) =>
                                updateConfig({
                                  ...config,
                                  distributionStyle:
                                    distributionStyle as WidgetConfig["distributionStyle"],
                                })
                              }
                            >
                              <SelectItem value="bars">
                                {copy.distributionBars}
                              </SelectItem>
                              <SelectItem value="donut">
                                {copy.distributionDonut}
                              </SelectItem>
                              <SelectItem value="ratio">
                                {copy.distributionRatio}
                              </SelectItem>
                            </FormSelect>
                          ) : null}
                          {config.type === "realtime" ? (
                            <>
                              <FormSelect
                                id="widget-realtime-layout"
                                label={copy.realtimeLayout}
                                value={config.realtimeLayout}
                                onChange={(realtimeLayout) =>
                                  updateConfig({
                                    ...config,
                                    realtimeLayout:
                                      realtimeLayout as WidgetConfig["realtimeLayout"],
                                  })
                                }
                              >
                                <SelectItem value="badge">
                                  {copy.realtimeBadge}
                                </SelectItem>
                                <SelectItem value="trend">
                                  {copy.realtimeTrend}
                                </SelectItem>
                                <SelectItem value="map">
                                  {copy.realtimeMap}
                                </SelectItem>
                                <SelectItem value="pages">
                                  {copy.realtimePages}
                                </SelectItem>
                              </FormSelect>
                              {config.realtimeLayout === "map" ? (
                                <FormSelect
                                  id="widget-realtime-projection"
                                  label={copy.geoProjection}
                                  value={config.geoProjection}
                                  onChange={(geoProjection) =>
                                    updateConfig({
                                      ...config,
                                      geoProjection:
                                        geoProjection as WidgetConfig["geoProjection"],
                                    })
                                  }
                                >
                                  <SelectItem value="flat">
                                    {copy.geoFlat}
                                  </SelectItem>
                                  <SelectItem value="globe">
                                    {copy.geoGlobe}
                                  </SelectItem>
                                </FormSelect>
                              ) : null}
                              {config.realtimeLayout === "pages" ? (
                                <FormSelect
                                  id="widget-realtime-limit"
                                  label={copy.limit}
                                  value={String(config.limit)}
                                  onChange={(limit) =>
                                    updateConfig({
                                      ...config,
                                      limit: Number(limit) as 5 | 10,
                                    })
                                  }
                                >
                                  <SelectItem value="5">5</SelectItem>
                                  <SelectItem value="10">10</SelectItem>
                                </FormSelect>
                              ) : null}
                            </>
                          ) : null}
                          {config.type === "geo" ? (
                            <FormSelect
                              id="widget-geo-projection"
                              label={copy.geoProjection}
                              value={config.geoProjection}
                              onChange={(geoProjection) =>
                                updateConfig({
                                  ...config,
                                  geoProjection:
                                    geoProjection as WidgetConfig["geoProjection"],
                                })
                              }
                            >
                              <SelectItem value="flat">
                                {copy.geoFlat}
                              </SelectItem>
                              <SelectItem value="globe">
                                {copy.geoGlobe}
                              </SelectItem>
                            </FormSelect>
                          ) : null}
                          {config.type === "trend" ? (
                            <>
                              <FormSelect
                                id="widget-trend-style"
                                label={copy.trendStyle}
                                value={config.trendStyle}
                                onChange={(trendStyle) =>
                                  updateConfig({
                                    ...config,
                                    trendStyle:
                                      trendStyle as WidgetConfig["trendStyle"],
                                    trendMetrics:
                                      trendStyle === "area"
                                        ? []
                                        : config.trendMetrics,
                                  })
                                }
                              >
                                <SelectItem value="line">
                                  {copy.trendLine}
                                </SelectItem>
                                <SelectItem value="area">
                                  {copy.trendArea}
                                </SelectItem>
                              </FormSelect>
                              {config.trendStyle === "line" ? (
                                <Field className="sm:col-span-2">
                                  <FieldLabel>{copy.trendMetrics}</FieldLabel>
                                  <div className="flex flex-wrap gap-3">
                                    {(
                                      ["visitors", "views", "sessions"] as const
                                    ).map((metric) => (
                                      <label
                                        key={metric}
                                        className="flex items-center gap-2 text-xs"
                                      >
                                        <Checkbox
                                          checked={config.trendMetrics.includes(
                                            metric,
                                          )}
                                          onCheckedChange={(checked) => {
                                            const selected = checked
                                              ? [
                                                  ...new Set([
                                                    ...config.trendMetrics,
                                                    metric,
                                                  ]),
                                                ]
                                              : config.trendMetrics.filter(
                                                  (item) => item !== metric,
                                                );
                                            updateConfig({
                                              ...config,
                                              trendMetrics: selected,
                                            });
                                          }}
                                        />
                                        {metricLabel(metric, copy)}
                                      </label>
                                    ))}
                                  </div>
                                </Field>
                              ) : null}
                            </>
                          ) : null}
                          {config.type === "conversion" ? (
                            <>
                              <FormSelect
                                id="widget-conversion-kind"
                                label={copy.conversionKind}
                                value={config.conversionKind}
                                onChange={(conversionKind) =>
                                  updateConfig({
                                    ...config,
                                    conversionKind:
                                      conversionKind as WidgetConfig["conversionKind"],
                                  })
                                }
                              >
                                <SelectItem value="event">
                                  {copy.eventConversion}
                                </SelectItem>
                                <SelectItem value="goal">
                                  {copy.goalConversion}
                                </SelectItem>
                              </FormSelect>
                              <div className="min-w-0 sm:col-span-2">
                                <AutoResizer initial duration={0.2}>
                                  <AutoTransition
                                    transitionKey={config.conversionKind}
                                    initial={false}
                                    duration={0.18}
                                    type="fade"
                                  >
                                    <div
                                      key={config.conversionKind}
                                      className="grid min-w-0 gap-4"
                                    >
                                      {config.conversionKind === "event" ? (
                                        <Field className="sm:col-span-2">
                                          <FieldLabel htmlFor="widget-event-name">
                                            {copy.eventName}
                                          </FieldLabel>
                                          <Input
                                            id="widget-event-name"
                                            value={config.eventName}
                                            maxLength={120}
                                            placeholder="sign_up"
                                            onChange={(event) =>
                                              updateConfig({
                                                ...config,
                                                eventName: event.target.value,
                                              })
                                            }
                                          />
                                        </Field>
                                      ) : (
                                        <>
                                          {goalOptions.length > 0 ? (
                                            <FormSelect
                                              id="widget-goal-id"
                                              label={copy.goalLabel}
                                              className="sm:col-span-2"
                                              value={config.goalId}
                                              onChange={(goalId) =>
                                                updateConfig({
                                                  ...config,
                                                  goalId,
                                                })
                                              }
                                            >
                                              {config.goalId &&
                                              !goalOptions.some(
                                                (goal) =>
                                                  goal.id === config.goalId,
                                              ) ? (
                                                <SelectItem
                                                  value={config.goalId}
                                                >
                                                  {config.goalId}
                                                </SelectItem>
                                              ) : null}
                                              {goalOptions.map((goal) => (
                                                <SelectItem
                                                  key={goal.id}
                                                  value={goal.id}
                                                >
                                                  {goal.name}
                                                </SelectItem>
                                              ))}
                                            </FormSelect>
                                          ) : (
                                            <Field className="sm:col-span-2">
                                              <FieldLabel htmlFor="widget-goal-id">
                                                {copy.goalLabel}
                                              </FieldLabel>
                                              <Input
                                                id="widget-goal-id"
                                                value={config.goalId}
                                                maxLength={120}
                                                placeholder={copy.noGoals}
                                                onChange={(event) =>
                                                  updateConfig({
                                                    ...config,
                                                    goalId: event.target.value,
                                                  })
                                                }
                                              />
                                            </Field>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  </AutoTransition>
                                </AutoResizer>
                              </div>
                            </>
                          ) : null}
                          {config.type === "metric" ? (
                            <Field className="sm:col-span-2">
                              <label
                                htmlFor="widget-comparison"
                                className="flex min-h-9 items-center gap-2 text-xs font-medium"
                              >
                                <Checkbox
                                  id="widget-comparison"
                                  checked={config.comparison}
                                  onCheckedChange={(checked) =>
                                    updateConfig({
                                      ...config,
                                      comparison: checked === true,
                                    })
                                  }
                                />
                                {copy.comparison}
                              </label>
                            </Field>
                          ) : null}
                        </div>
                      </AutoTransition>
                    </AutoResizer>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <AutoResizer initial duration={0.2}>
                      <AutoTransition
                        transitionKey={
                          (config.type === "ranking" &&
                            config.dimension === "page.path") ||
                          (config.type === "realtime" &&
                            config.realtimeLayout === "pages")
                            ? "page-paths"
                            : "no-paths"
                        }
                        duration={0.18}
                        initial={false}
                        type="fade"
                      >
                        {(config.type === "ranking" &&
                          config.dimension === "page.path") ||
                        (config.type === "realtime" &&
                          config.realtimeLayout === "pages") ? (
                          <Field key="page-paths">
                            <label
                              htmlFor="widget-page-links"
                              className="flex min-h-9 items-center gap-2 text-xs font-medium"
                            >
                              <Checkbox
                                id="widget-page-links"
                                checked={config.pageLinksEnabled}
                                onCheckedChange={(checked) =>
                                  updateConfig({
                                    ...config,
                                    pageLinksEnabled: checked === true,
                                  })
                                }
                              />
                              {copy.pageLinksEnabled}
                            </label>
                            <p className="text-xs text-muted-foreground">
                              {copy.pageLinksHint}
                            </p>
                          </Field>
                        ) : (
                          <div key="no-paths" />
                        )}
                      </AutoTransition>
                    </AutoResizer>
                  </div>
                  <FormSelect
                    id="widget-theme"
                    label={copy.theme}
                    value={config.theme}
                    onChange={(value) =>
                      updateConfig({
                        ...config,
                        theme: value as WidgetConfig["theme"],
                      })
                    }
                  >
                    <SelectItem value="auto">{copy.auto}</SelectItem>
                    <SelectItem value="light">{copy.light}</SelectItem>
                    <SelectItem value="dark">{copy.dark}</SelectItem>
                  </FormSelect>
                  <FormSelect
                    id="widget-embed-mode"
                    label={copy.embedMode}
                    value={config.embedMode}
                    onChange={(value) =>
                      updateConfig({
                        ...config,
                        embedMode: value as WidgetConfig["embedMode"],
                      })
                    }
                  >
                    <SelectItem value="restricted">
                      {copy.restricted}
                    </SelectItem>
                    <SelectItem value="any">{copy.any}</SelectItem>
                  </FormSelect>
                  <div className="min-w-0 sm:col-span-2">
                    <AutoResizer initial duration={0.2}>
                      <AutoTransition
                        transitionKey={config.embedMode}
                        duration={0.18}
                        initial={false}
                        type="fade"
                      >
                        <div key={config.embedMode} className="min-w-0">
                          {config.embedMode === "restricted" ? (
                            <Field className="sm:col-span-2">
                              <FieldLabel htmlFor="widget-allowed-origins">
                                {copy.allowedOrigins}
                              </FieldLabel>
                              <textarea
                                id="widget-allowed-origins"
                                className={textareaClassName}
                                value={originText}
                                onChange={(event) =>
                                  updateOrigins(event.target.value)
                                }
                                spellCheck={false}
                              />
                              <p className="text-xs text-muted-foreground">
                                {copy.originsHint}
                              </p>
                            </Field>
                          ) : null}
                        </div>
                      </AutoTransition>
                    </AutoResizer>
                  </div>
                  {previewError ? (
                    <p
                      className="text-sm text-destructive sm:col-span-2"
                      role="alert"
                    >
                      {previewError}
                    </p>
                  ) : null}
                </div>

                <section className="min-w-0 space-y-4 border-t pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{copy.preview}</h3>
                      {previewBusy ? (
                        <RiLoader4Line
                          className="size-4 animate-spin text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                    <div className="w-44 max-w-full">
                      <FieldLabel
                        htmlFor="widget-preview-size"
                        className="sr-only"
                      >
                        {copy.preview}
                      </FieldLabel>
                      <Select
                        value={previewSize}
                        onValueChange={(value) =>
                          setPreviewSize(value as PreviewSize)
                        }
                      >
                        <SelectTrigger
                          id="widget-preview-size"
                          className="w-full"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="compact">
                            {copy.compactPreview}
                          </SelectItem>
                          <SelectItem value="regular">
                            {copy.regularPreview}
                          </SelectItem>
                          <SelectItem value="wide">
                            {copy.widePreview}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <PreviewFrame
                      title={copy.preview}
                      width={previewWidth}
                      height={suggestedWidgetHeight(config)}
                      label={copy.preview}
                      hideLabel
                      autoHeight
                      uuid={
                        editingRecord?.uuid ?? pendingUuid.current ?? "preview"
                      }
                      config={getFormConfig() ?? config}
                      data={previewData}
                      locale={locale}
                      siteOrigin={
                        defaultAllowedOrigin(
                          siteById.get(selectedSiteId)?.domain ?? "",
                        )[0]
                      }
                    />
                  </div>
                </section>
              </div>
            ) : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="shrink-0 border-t p-4 sm:p-6">
            {editingRecord ? (
              <Button
                variant="ghost"
                className="sm:mr-auto"
                onClick={() => startConfirm("delete", editingRecord)}
              >
                <RiDeleteBinLine className="size-4" aria-hidden="true" />
                {copy.delete}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => setEditorOpen(false)}
                disabled={busy}
              >
                {copy.cancel}
              </Button>
              <Button
                variant="outline"
                onClick={() => void saveDraft()}
                disabled={busy || previewBusy}
              >
                {busy ? (
                  <RiLoader4Line
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {editingRecord ? copy.update : copy.save}
              </Button>
              <Button
                onClick={() => void askPublish()}
                disabled={busy || previewBusy}
              >
                <RiArrowRightLine className="size-4" aria-hidden="true" />
                {copy.publish}
              </Button>
            </div>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirmAction(null);
            setConfirmTarget(null);
            setPublishConfig(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "publish"
                ? copy.confirmPublishTitle
                : confirmAction === "unpublish"
                  ? copy.confirmOfflineTitle
                  : copy.confirmDeleteTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "publish"
                ? copy.confirmPublishBody
                : confirmAction === "unpublish"
                  ? copy.confirmOfflineBody
                  : copy.confirmDeleteBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction === "publish" && publishConfig ? (
            <div className="space-y-3 border-y py-3 text-sm">
              {confirmTarget?.published ? (
                <PublicationSummary
                  heading={copy.currentVersion}
                  config={confirmTarget.published}
                  siteName={
                    siteById.get(confirmTarget.siteId)?.name ??
                    confirmTarget.siteId
                  }
                  copy={copy}
                />
              ) : null}
              <PublicationSummary
                heading={copy.nextVersion}
                config={publishConfig}
                siteName={siteById.get(selectedSiteId)?.name ?? selectedSiteId}
                copy={copy}
              />
            </div>
          ) : null}
          {confirmAction === "publish" ? (
            <label className="flex items-start gap-2 rounded-none border bg-muted/30 p-3 text-sm">
              <input
                type="checkbox"
                checked={publishDisclosure}
                onChange={(event) => setPublishDisclosure(event.target.checked)}
              />
              <span>{copy.embedDisclosure}</span>
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{copy.cancel}</AlertDialogCancel>
            {confirmAction === "publish" ? (
              <AlertDialogAction
                disabled={!publishDisclosure || busy}
                onClick={(event) => {
                  event.preventDefault();
                  void performConfirmedAction();
                }}
              >
                {busy ? (
                  <RiLoader4Line
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <RiCheckLine className="size-4" aria-hidden="true" />
                )}
                {busy ? copy.publishing : copy.confirmPublish}
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                disabled={busy}
                variant={confirmAction === "delete" ? "destructive" : "default"}
                onClick={(event) => {
                  event.preventDefault();
                  void performConfirmedAction();
                }}
              >
                {busy ? (
                  <RiLoader4Line
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {confirmAction === "delete" ? copy.delete : copy.unpublish}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ResponsiveDialog
        open={embedRecord !== null}
        onOpenChange={(open) => {
          if (!open) setEmbedRecord(null);
        }}
      >
        <ResponsiveDialogContent
          className="flex flex-col overflow-hidden p-0"
          desktopClassName="w-full max-w-2xl"
          drawerClassName="max-h-[85dvh]"
        >
          <div className="shrink-0 border-b p-4 sm:p-5">
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle icon={RiCodeLine}>
                {copy.embedCode}
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {copy.embedSizeGuide}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
          </div>
          <ResponsiveDialogBody className="space-y-4 p-4 sm:p-5">
            {embedRecord ? (
              <>
                <Field className="min-w-0">
                  <FieldLabel htmlFor="widget-embed-language">
                    {copy.language}
                  </FieldLabel>
                  <Select
                    value={embedLanguage}
                    onValueChange={(value) =>
                      setEmbedLanguage(value as "auto" | Locale)
                    }
                  >
                    <SelectTrigger
                      id="widget-embed-language"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{copy.auto}</SelectItem>
                      {SUPPORTED_LOCALES.map((language) => (
                        <SelectItem key={language} value={language}>
                          {nativeLocaleName(language)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    {copy.publicAddress}
                  </p>
                  <a
                    className="flex min-w-0 items-start gap-2 break-all text-sm text-primary underline-offset-4 hover:underline"
                    href={embedPath(embedRecord)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {window.location.origin}
                    {embedPath(embedRecord)}
                    <RiExternalLinkLine
                      className="size-4 shrink-0"
                      aria-hidden="true"
                    />
                  </a>
                </div>
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs font-medium">{copy.embedCode}</p>
                  <div className="min-w-0 border bg-muted/25 p-3">
                    <OverlayScrollbar
                      axis="horizontal"
                      showEdgeMasks
                      className="min-w-0 w-full text-xs leading-relaxed text-foreground"
                      contentClassName="w-max min-w-full"
                    >
                      <HighlightedCode
                        source={embedCode(embedRecord)}
                        className="font-mono whitespace-pre"
                      />
                    </OverlayScrollbar>
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold">{copy.embedDetails}</h3>
                  <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-2 text-xs">
                    <dt className="text-muted-foreground">{copy.height}</dt>
                    <dd className="tabular-nums">
                      {suggestedWidgetHeight(
                        embedRecord.published ?? embedRecord.draft,
                      )}
                      px
                    </dd>
                    <dt className="text-muted-foreground">{copy.range}</dt>
                    <dd>
                      {(embedRecord.published ?? embedRecord.draft).range ===
                      "7d"
                        ? copy.sevenDays
                        : copy.thirtyDays}
                    </dd>
                    <dt className="text-muted-foreground">{copy.timeZone}</dt>
                    <dd>
                      {(embedRecord.published ?? embedRecord.draft).timeZone}
                    </dd>
                    <dt className="text-muted-foreground">{copy.theme}</dt>
                    <dd>
                      {(embedRecord.published ?? embedRecord.draft).theme ===
                      "auto"
                        ? copy.auto
                        : (embedRecord.published ?? embedRecord.draft).theme ===
                            "light"
                          ? copy.light
                          : copy.dark}
                    </dd>
                    <dt className="text-muted-foreground">{copy.embedMode}</dt>
                    <dd>
                      {(embedRecord.published ?? embedRecord.draft)
                        .embedMode === "any"
                        ? copy.any
                        : copy.restricted}
                    </dd>
                    {(embedRecord.published ?? embedRecord.draft).embedMode ===
                    "restricted" ? (
                      <>
                        <dt className="text-muted-foreground">
                          {copy.accessOrigins}
                        </dt>
                        <dd className="break-all">
                          {(
                            embedRecord.published ?? embedRecord.draft
                          ).allowedOrigins.join(", ")}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </div>
                <p className="border-l-2 border-primary/60 bg-muted/20 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                  {copy.embedCaution}
                </p>
              </>
            ) : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="shrink-0 border-t p-4 sm:p-5">
            <Button variant="outline" onClick={() => setEmbedRecord(null)}>
              {copy.close}
            </Button>
            <Button
              disabled={!embedRecord}
              onClick={() => {
                if (embedRecord) void copyEmbed(embedRecord);
              }}
            >
              <RiFileCopyLine className="size-4" aria-hidden="true" />
              {copy.copyEmbed}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}

function FormSelect({
  id,
  label,
  value,
  onChange,
  disabled,
  className,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Field className={`min-w-0 ${className ?? ""}`}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-72">{children}</SelectContent>
      </Select>
    </Field>
  );
}

function PublicationSummary({
  heading,
  config,
  siteName,
  copy,
}: {
  heading: string;
  config: WidgetConfig;
  siteName: string;
  copy: ReturnType<typeof widgetLabels>;
}) {
  const title = config.title || displayType(config.type, copy);
  const period = config.range === "7d" ? copy.sevenDays : copy.thirtyDays;
  const origins =
    config.embedMode === "any" ? copy.any : config.allowedOrigins.join(", ");
  return (
    <section className="space-y-1.5" aria-label={heading}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <p className="font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">
        {siteName} · {displayType(config.type, copy)} ·{" "}
        {metricLabel(config.metric, copy)}
      </p>
      <p className="text-xs text-muted-foreground">
        {period} · {config.timeZone}
      </p>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>{copy.accessOrigins}</p>
        <p className="break-all">{origins}</p>
      </div>
    </section>
  );
}

const MASONRY_ROW_HEIGHT = 8;
const MASONRY_CARD_GAP = 16;

function MasonryItem({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [rowSpan, setRowSpan] = useState(1);

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => {
      const contentHeight = element.getBoundingClientRect().height;
      const next = Math.max(
        1,
        Math.ceil((contentHeight + MASONRY_CARD_GAP) / MASONRY_ROW_HEIGHT),
      );
      setRowSpan((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-w-0" style={{ gridRowEnd: `span ${rowSpan}` }}>
      <div ref={contentRef} className="min-w-0">
        {children}
      </div>
    </div>
  );
}

function WidgetListPreview({
  record,
  basePath,
  copy,
  locale,
  siteOrigin,
}: {
  record: WidgetRecord;
  basePath: string;
  copy: ReturnType<typeof widgetLabels>;
  locale: Locale;
  siteOrigin?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<WidgetData | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const config = record.published ?? record.draft;
  const height = Math.min(suggestedWidgetHeight(config), 460);

  // Only query previews when their cards approach the viewport. A team may
  // have many widgets, and each preview executes a real analytics query.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setData(null);
    setFailed(false);
    void widgetRequest<ApiResult<WidgetData>>(`${basePath}/preview`, "POST", {
      siteId: record.siteId,
      config,
    })
      .then((result) => {
        if (active) setData(result.data);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [basePath, config, record.siteId, visible, attempt]);

  return (
    <div ref={containerRef} className="min-w-0 w-full">
      <AutoResizer className="w-full" duration={0.24}>
        <AutoTransition
          transitionKey={data ? "loaded" : failed ? "failed" : "loading"}
          initial={false}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className="min-w-0 w-full"
        >
          {data ? (
            <PreviewFrame
              title={config.title || copy.preview}
              width={360}
              height={height}
              label={copy.preview}
              fluid
              hideLabel
              autoHeight
              uuid={record.uuid}
              config={config}
              data={data}
              locale={locale}
              siteOrigin={siteOrigin}
            />
          ) : (
            <div
              className="flex min-h-28 w-full items-center justify-center bg-muted/10 text-muted-foreground"
              aria-label={copy.preview}
              role="status"
            >
              {failed ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAttempt((current) => current + 1)}
                >
                  <RiRestartLine className="size-4" aria-hidden="true" />
                  {copy.retry}
                </Button>
              ) : (
                <RiLoader4Line
                  className="size-5 animate-spin"
                  aria-label={copy.loading}
                />
              )}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}

function PreviewFrame({
  title,
  width,
  height,
  label,
  uuid,
  config,
  data,
  locale,
  siteOrigin,
  fluid = false,
  hideLabel = false,
  autoHeight = false,
}: {
  title: string;
  width: number;
  height: number;
  label: string;
  uuid: string;
  config: WidgetConfig;
  data: WidgetData | null;
  locale: Locale;
  siteOrigin?: string;
  fluid?: boolean;
  hideLabel?: boolean;
  autoHeight?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const srcDoc = useMemo(
    () =>
      data
        ? renderWidgetDocument({
            uuid,
            config,
            preview: true,
            previewData: data,
            autoHeight,
            localeOverride: locale,
            siteOrigin,
          })
        : undefined,
    [uuid, config, data, autoHeight, locale, siteOrigin],
  );

  useEffect(() => {
    if (!autoHeight || !srcDoc) return;
    // Keep the last measured height until the new iframe reports its content.
    // Resetting to the type-based fallback would cause a visible height bounce.
    const onHeight = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message: unknown = event.data;
      if (!message || typeof message !== "object") return;
      if (!("type" in message) || !("height" in message)) return;
      if (message.type !== "insightflare-widget-preview-height") return;
      const nextHeight = message.height;
      if (
        typeof nextHeight !== "number" ||
        !Number.isFinite(nextHeight) ||
        nextHeight < 1 ||
        nextHeight > 2000
      )
        return;
      setMeasuredHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    };
    window.addEventListener("message", onHeight);
    return () => window.removeEventListener("message", onHeight);
  }, [autoHeight, srcDoc]);

  const isBadge =
    config.type === "realtime" && config.realtimeLayout === "badge";
  return (
    <div
      className={`${hideLabel ? "min-w-0" : "min-w-0 space-y-1.5"} ${isBadge ? "flex min-h-[152px] flex-col justify-center" : ""}`}
    >
      {hideLabel ? null : (
        <p className="text-[11px] text-muted-foreground">{label}</p>
      )}
      <AutoResizer className="w-full" duration={0.24}>
        <AutoTransition
          transitionKey={
            data
              ? `${width}:${JSON.stringify(data)}:${config.type}:${config.title}`
              : "empty"
          }
          initial={false}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className="min-w-0 w-full"
        >
          <div
            className={`mx-auto w-full overflow-hidden bg-muted/20 transition-[max-width] duration-200 ${hideLabel ? "" : "border"}`}
            style={{
              height: autoHeight
                ? (measuredHeight ?? height)
                : Math.min(height, 460),
              maxWidth: fluid ? undefined : width,
            }}
          >
            {srcDoc ? (
              <iframe
                ref={frameRef}
                title={title}
                srcDoc={srcDoc}
                sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
                className="h-full w-full border-0"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
                <RiEyeLine className="size-5" aria-hidden="true" />
                <span>{title}</span>
              </div>
            )}
          </div>
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}
