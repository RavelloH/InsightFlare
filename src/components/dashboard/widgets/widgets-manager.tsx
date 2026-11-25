import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Badge } from "@insightflare/ui/badge";
import { Button } from "@insightflare/ui/button";
import { Card, CardContent } from "@insightflare/ui/card";
import { FieldLabel } from "@insightflare/ui/field";
import { Label } from "@insightflare/ui/label";
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
  RiCheckLine,
  RiCodeLine,
  RiDeleteBinLine,
  RiLineChartLine,
  RiLoader4Line,
  RiPauseCircleLine,
  RiRestartLine,
  RiSettings3Line,
} from "@remixicon/react";
import { toast } from "sonner";

import {
  buildTimeZoneOptions,
  supportedTimeZones,
} from "@/lib/analytics/time-zone";
import { fetchGoals } from "@/lib/dashboard/client/data/goals";
import { intlLocale } from "@/lib/dashboard/format";
import { type Locale } from "@/lib/i18n/config";
import type {
  WidgetConfig,
  WidgetData,
  WidgetRecord,
} from "@/lib/widgets/contract";
import {
  normalizeWidgetOrigin,
  suggestedWidgetHeight,
} from "@/lib/widgets/contract";

import { widgetLabels } from "./labels";
import { WidgetConfigFields } from "./widget-config-fields";
import { WidgetEmbedDialog } from "./widget-embed-dialog";
import { PublicationSummary } from "./widget-form-controls";
import { MasonryItem, WidgetListPreview } from "./widget-list-preview";
import {
  type ApiResult,
  type ConfirmAction,
  defaultAllowedOrigin,
  defaultConfig,
  displayType,
  errorMessage,
  type PreviewSize,
  statusLabel,
  widgetParameters,
  widgetRequest,
  type WidgetSite,
  type WidgetType,
  widgetTypeIcons,
} from "./widget-manager-model";
import { PreviewFrame } from "./widget-preview-frame";
import {
  widgetTemplateConfig,
  WidgetTemplateGallery,
  type WidgetTemplateId,
} from "./widget-templates";

interface WidgetsManagerProps {
  locale: Locale;
  teamId: string;
  teamName: string;
  sites: WidgetSite[];
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
    setEmbedRecord(record);
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
                <WidgetConfigFields
                  copy={copy}
                  config={config}
                  onConfigChange={updateConfig}
                  sites={sites}
                  selectedSiteId={selectedSiteId}
                  onSiteChange={changeSite}
                  editingRecord={editingRecord}
                  timeZoneOptions={timeZoneOptions}
                  originText={originText}
                  onOriginsChange={updateOrigins}
                  goalOptions={goalOptions}
                  previewError={previewError}
                />

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

      <WidgetEmbedDialog
        copy={copy}
        record={embedRecord}
        onClose={() => setEmbedRecord(null)}
      />
    </div>
  );
}
