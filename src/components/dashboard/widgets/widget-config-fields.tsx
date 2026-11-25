import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Checkbox } from "@insightflare/ui/checkbox";
import { Field, FieldLabel } from "@insightflare/ui/field";
import { Input } from "@insightflare/ui/input";
import { SelectItem } from "@insightflare/ui/select";

import type { buildTimeZoneOptions } from "@/lib/analytics/time-zone";
import type { WidgetConfig, WidgetRecord } from "@/lib/widgets/contract";

import type { widgetLabels } from "./labels";
import { FormSelect } from "./widget-form-controls";
import {
  metricLabel,
  textareaClassName,
  type WidgetSite,
  type WidgetType,
} from "./widget-manager-model";

/** Editable widget configuration: everything left of the editor preview. */
export function WidgetConfigFields({
  copy,
  config,
  onConfigChange: updateConfig,
  sites,
  selectedSiteId,
  onSiteChange: changeSite,
  editingRecord,
  timeZoneOptions,
  originText,
  onOriginsChange: updateOrigins,
  goalOptions,
  previewError,
}: {
  copy: ReturnType<typeof widgetLabels>;
  config: WidgetConfig;
  onConfigChange: (next: WidgetConfig) => void;
  sites: WidgetSite[];
  selectedSiteId: string;
  onSiteChange: (siteId: string) => void;
  editingRecord: WidgetRecord | null;
  timeZoneOptions: ReturnType<typeof buildTimeZoneOptions>;
  originText: string;
  onOriginsChange: (next: string) => void;
  goalOptions: { id: string; name: string }[];
  previewError: string | null;
}) {
  return (
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
        <p className="text-xs text-muted-foreground">{copy.titleHint}</p>
      </Field>
      <FormSelect
        id="widget-type"
        label={copy.type}
        value={config.type}
        onChange={(value) => {
          const type = value as WidgetType;
          const allowed = ["visitors", "views", "sessions"].includes(
            config.metric,
          );
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
        <SelectItem value="distribution">{copy.distributionType}</SelectItem>
        <SelectItem value="conversion">{copy.conversionType}</SelectItem>
        <SelectItem value="geo">{copy.geoType}</SelectItem>
        <SelectItem value="realtime">{copy.realtimeType}</SelectItem>
      </FormSelect>
      <div className="min-w-0">
        <AutoResizer initial duration={0.2}>
          <AutoTransition
            transitionKey={config.type === "conversion" ? "hidden" : "metric"}
            initial={false}
            duration={0.18}
            type="fade"
          >
            <div
              key={config.type === "conversion" ? "hidden" : "metric"}
              className="min-w-0"
            >
              {config.type !== "conversion" && config.type !== "realtime" ? (
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
                  <SelectItem value="visitors">{copy.visitors}</SelectItem>
                  <SelectItem value="views">{copy.views}</SelectItem>
                  <SelectItem value="sessions">{copy.sessions}</SelectItem>
                  {config.type === "metric" ? (
                    <>
                      <SelectItem value="bounces">{copy.bounces}</SelectItem>
                      <SelectItem value="bounceRate">
                        {copy.bounceRate}
                      </SelectItem>
                      <SelectItem value="avgDurationMs">
                        {copy.avgDurationMs}
                      </SelectItem>
                      <SelectItem value="viewsPerSession">
                        {copy.viewsPerSession}
                      </SelectItem>
                      <SelectItem value="events">{copy.events}</SelectItem>
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
            transitionKey={config.type === "realtime" ? "live" : "history"}
            initial={false}
            duration={0.18}
            type="fade"
          >
            {config.type === "realtime" ? (
              <div key="live" className="text-xs text-muted-foreground">
                {copy.realtimeType} · 30s
              </div>
            ) : (
              <div key="history" className="grid min-w-0 gap-4 sm:grid-cols-2">
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
                  <SelectItem value="7d">{copy.sevenDays}</SelectItem>
                  <SelectItem value="30d">{copy.thirtyDays}</SelectItem>
                </FormSelect>
                <FormSelect
                  id="widget-time-zone"
                  label={copy.timeZone}
                  value={config.timeZone}
                  onChange={(timeZone) => updateConfig({ ...config, timeZone })}
                >
                  {timeZoneOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
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
                        dimension: value as WidgetConfig["dimension"],
                      })
                    }
                  >
                    <SelectItem value="page.path">{copy.pagePath}</SelectItem>
                    <SelectItem value="source.domain">
                      {copy.sourceDomain}
                    </SelectItem>
                    <SelectItem value="geo.country">{copy.country}</SelectItem>
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
                  <SelectItem value="list">{copy.rankingList}</SelectItem>
                  <SelectItem value="bars">{copy.rankingBars}</SelectItem>
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
                    <SelectItem value="utm.source">{copy.utmSource}</SelectItem>
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
                  <SelectItem value="bars">{copy.distributionBars}</SelectItem>
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
                    <SelectItem value="badge">{copy.realtimeBadge}</SelectItem>
                    <SelectItem value="trend">{copy.realtimeTrend}</SelectItem>
                    <SelectItem value="map">{copy.realtimeMap}</SelectItem>
                    <SelectItem value="pages">{copy.realtimePages}</SelectItem>
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
                      <SelectItem value="flat">{copy.geoFlat}</SelectItem>
                      <SelectItem value="globe">{copy.geoGlobe}</SelectItem>
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
                  <SelectItem value="flat">{copy.geoFlat}</SelectItem>
                  <SelectItem value="globe">{copy.geoGlobe}</SelectItem>
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
                        trendStyle: trendStyle as WidgetConfig["trendStyle"],
                        trendMetrics:
                          trendStyle === "area" ? [] : config.trendMetrics,
                      })
                    }
                  >
                    <SelectItem value="line">{copy.trendLine}</SelectItem>
                    <SelectItem value="area">{copy.trendArea}</SelectItem>
                  </FormSelect>
                  {config.trendStyle === "line" ? (
                    <Field className="sm:col-span-2">
                      <FieldLabel>{copy.trendMetrics}</FieldLabel>
                      <div className="flex flex-wrap gap-3">
                        {(["visitors", "views", "sessions"] as const).map(
                          (metric) => (
                            <label
                              key={metric}
                              className="flex items-center gap-2 text-xs"
                            >
                              <Checkbox
                                checked={config.trendMetrics.includes(metric)}
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
                          ),
                        )}
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
                    <SelectItem value="goal">{copy.goalConversion}</SelectItem>
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
                                    (goal) => goal.id === config.goalId,
                                  ) ? (
                                    <SelectItem value={config.goalId}>
                                      {config.goalId}
                                    </SelectItem>
                                  ) : null}
                                  {goalOptions.map((goal) => (
                                    <SelectItem key={goal.id} value={goal.id}>
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
              (config.type === "ranking" && config.dimension === "page.path") ||
              (config.type === "realtime" && config.realtimeLayout === "pages")
                ? "page-paths"
                : "no-paths"
            }
            duration={0.18}
            initial={false}
            type="fade"
          >
            {(config.type === "ranking" && config.dimension === "page.path") ||
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
        <SelectItem value="restricted">{copy.restricted}</SelectItem>
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
                    onChange={(event) => updateOrigins(event.target.value)}
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
        <p className="text-sm text-destructive sm:col-span-2" role="alert">
          {previewError}
        </p>
      ) : null}
    </div>
  );
}
