import { type ReactNode, useMemo } from "react";
import { Icon } from "@iconify/react";
import {
  RiExternalLinkLine,
  RiGlobalLine,
  RiPulseLine,
} from "@remixicon/react";

import { JsonTreePanel } from "@/components/dashboard/common/json-tree";
import {
  GeoPointsMapIsland,
  type GeoPointsMapPoint,
} from "@/components/dashboard/geo/geo-points-map-island";
import { useGeoStateTranslationBundle } from "@/components/dashboard/geo/lazy-geo-location-label";
import {
  formatPathWithHash,
  resolveDeviceTypeMeta,
} from "@/components/dashboard/journeys/journey-display";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Clickable } from "@/components/ui/clickable";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { shortDateTime } from "@/lib/dashboard/format";
import {
  formatLocalizedGeoValue,
  resolveLocalizedCityName,
} from "@/lib/dashboard/geo-translation";
import {
  resolveContinentLabel,
  resolveLanguageLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type { RealtimeEvent } from "@/lib/realtime/types";
import { cn } from "@/lib/utils";

import {
  BROWSER_APPLE_ICON_KEYS,
  BROWSER_ICON_DIR,
  classifyRealtimeLogEvent,
  DomainOrUrlIcon,
  formatCoordinateValue,
  formatDetailBoolean,
  formatDetailDateTime,
  formatDetailDuration,
  formatLogTitle,
  formatOptionalDetailDateTime,
  formatRealtimePerformanceMetric,
  formatRelativeTime,
  formatTimelineTime,
  getRealtimeEventIntegrationRemainingSeconds,
  hasValidCoordinate,
  LogoIcon,
  OS_APPLE_ICON_KEYS,
  OS_ICON_DIR,
  resolveLocalizedDetailValue,
  resolveRealtimeCityLabel,
  resolveRealtimeEventDisplayData,
  resolveRealtimeRegionLabel,
  UNKNOWN_ICON_KEY,
  useRealtimeClock,
} from "./model";
function RealtimeEventDetailValue({
  icon,
  value,
  mono = false,
}: {
  icon?: ReactNode;
  value: string;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-2 break-words text-[11px] text-foreground",
        mono && "font-mono",
      )}
    >
      {icon ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 break-all">{value}</span>
    </span>
  );
}
function RealtimeDetailItem({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("space-y-1", wide && "sm:col-span-2")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{value}</dd>
    </div>
  );
}
function RealtimeVisitorHistorySection({
  locale,
  messages,
  now,
  timeZone,
  event,
  events,
  onSelect,
}: {
  locale: Locale;
  messages: AppMessages;
  now: number;
  timeZone: string;
  event: RealtimeEvent;
  events: RealtimeEvent[];
  onSelect: (event: RealtimeEvent) => void;
}) {
  const timelineEvents = useMemo(() => {
    const visitorId = event.visitorId.trim();
    if (!visitorId) return [];

    const dedupedEvents = new Map<string, RealtimeEvent>();
    for (const candidate of events) {
      if (candidate.visitorId.trim() !== visitorId || !candidate.id) {
        continue;
      }
      dedupedEvents.set(candidate.id, candidate);
    }

    return Array.from(dedupedEvents.values()).sort(
      (left, right) => left.eventAt - right.eventAt,
    );
  }, [event.visitorId, events]);
  const firstTimelineEvent = timelineEvents[0] ?? null;
  const lastTimelineEvent = timelineEvents[timelineEvents.length - 1] ?? null;
  const historyStateKey = timelineEvents.length === 0 ? "empty" : "history";

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">
            {messages.realtime.visitorHistorySection}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {messages.realtime.visitorHistorySubtitle}
          </p>
        </div>
        {firstTimelineEvent && lastTimelineEvent ? (
          <div className="min-w-0 text-right text-[10px] text-muted-foreground">
            <p>{messages.realtime.visitorHistoryRange}</p>
            <p className="font-mono text-foreground">
              {shortDateTime(locale, firstTimelineEvent.eventAt, timeZone)}
              {" – "}
              {shortDateTime(locale, lastTimelineEvent.eventAt, timeZone)}
            </p>
          </div>
        ) : null}
      </div>
      <AutoResizer initial duration={0.22}>
        <AutoTransition
          initial={false}
          duration={0.2}
          transitionKey={historyStateKey}
        >
          {timelineEvents.length === 0 ? (
            <div className="flex min-h-24 items-center justify-center border border-dashed border-foreground/25 text-[11px] text-muted-foreground">
              {messages.realtime.visitorHistoryEmpty}
            </div>
          ) : (
            <div className="space-y-0">
              {timelineEvents.map((timelineEvent, index) => {
                const isCurrentEvent = timelineEvent.id === event.id;
                const timelineEventTitle = formatLogTitle(
                  messages,
                  timelineEvent,
                  classifyRealtimeLogEvent(timelineEvent),
                );
                const timelineEventRowClassName =
                  "!grid !w-full grid-cols-[4.5rem_1.25rem_minmax(0,1fr)] items-stretch gap-3 pb-4 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring last:pb-0 sm:grid-cols-[5.5rem_1.25rem_minmax(0,1fr)]";
                const timelineEventContent = (
                  <>
                    <div className="min-w-0 pt-0.5 text-right">
                      <p className="font-mono text-[10px] text-foreground">
                        {formatTimelineTime(
                          locale,
                          timelineEvent.eventAt,
                          timeZone,
                        )}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {formatRelativeTime(locale, timelineEvent.eventAt, now)}
                      </p>
                    </div>
                    <div className="relative flex h-full justify-center">
                      {index < timelineEvents.length - 1 ? (
                        <span className="pointer-events-none absolute left-1/2 top-5 -bottom-4 w-px -translate-x-1/2 bg-foreground/30" />
                      ) : null}
                      <span
                        className={cn(
                          "relative z-10 inline-flex size-5 shrink-0 items-center justify-center border font-mono text-[10px]",
                          isCurrentEvent
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-foreground/35 bg-card text-foreground/80",
                        )}
                      >
                        {index + 1}
                      </span>
                    </div>
                    <div className="min-w-0 w-full border-b border-foreground/15 pb-3 last:border-b-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {timelineEventTitle}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {formatDetailDuration(
                          timelineEvent.durationMs,
                          messages.common.unknown,
                        )}
                        {" · "}
                        {timelineEvent.title.trim() || messages.common.unknown}
                      </p>
                    </div>
                  </>
                );

                if (isCurrentEvent) {
                  return (
                    <div
                      key={timelineEvent.id}
                      className={timelineEventRowClassName}
                    >
                      {timelineEventContent}
                    </div>
                  );
                }

                return (
                  <Clickable
                    key={timelineEvent.id}
                    className={timelineEventRowClassName}
                    onClick={() => onSelect(timelineEvent)}
                    enableHoverScale
                    hoverScale={1.01}
                    tapScale={0.985}
                    duration={0.14}
                    aria-label={timelineEventTitle}
                  >
                    {timelineEventContent}
                  </Clickable>
                );
              })}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
    </section>
  );
}
function RealtimeVisitorLocationMapSection({
  locale,
  messages,
  event,
}: {
  locale: Locale;
  messages: AppMessages;
  event: RealtimeEvent;
}) {
  const hasLocation = hasValidCoordinate(event.latitude, event.longitude);
  const points = useMemo<GeoPointsMapPoint[]>(
    () =>
      hasLocation
        ? [
            {
              latitude: Number(event.latitude),
              longitude: Number(event.longitude),
              country: String(event.country ?? ""),
            },
          ]
        : [],
    [event.country, event.latitude, event.longitude, hasLocation],
  );
  return (
    <GeoPointsMapIsland
      locale={locale}
      messages={messages}
      points={points}
      emptyLabel={messages.realtime.visitorMapUnavailable}
      heightClassName="h-[11rem] sm:h-[13rem]"
      initialZoom={0.3}
      countryHoverEnabled={false}
    />
  );
}
export function RealtimeLogEventDetailsDrawer({
  locale,
  messages,
  timeZone,
  event,
  open,
  onOpenChange,
  events,
  onSelect,
  onOpenVisitor,
  onOpenSession,
}: {
  locale: Locale;
  messages: AppMessages;
  timeZone: string;
  event: RealtimeEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: RealtimeEvent[];
  onSelect: (event: RealtimeEvent) => void;
  onOpenVisitor?: (visitorId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const now = useRealtimeClock(open && Boolean(event));
  const displayData = event
    ? resolveRealtimeEventDisplayData(locale, messages, event)
    : null;
  const regionLabel = event
    ? resolveRealtimeRegionLabel(event.region, messages)
    : "";
  const cityLabel = event ? resolveRealtimeCityLabel(event.city, messages) : "";
  const translationBundle = useGeoStateTranslationBundle({
    locale,
    countryCode: event?.country ?? "",
    stateCode: event?.regionCode ?? "",
    countryLabel: displayData?.countryLabel ?? "",
    regionLabel,
    localityLabel: cityLabel,
    enabled: open && Boolean(event),
  });

  if (!event || !displayData) return null;

  const integrationRemainingSeconds =
    getRealtimeEventIntegrationRemainingSeconds(event, now);
  const isIntegratingEvent = integrationRemainingSeconds > 0;
  const integratingEventLabel = formatI18nTemplate(
    messages.events.integratingEvent,
    { seconds: integrationRemainingSeconds },
  );

  const {
    browserIconKey,
    browserLabel,
    countryFlagCode,
    countryLabel,
    osIconKey,
    osLabel,
    sourceLabel,
  } = displayData;
  const continentLabel = resolveContinentLabel(
    event.continent,
    messages.common.unknown,
    messages.common.continentLabels,
  );
  const localizedRegionLabel =
    translationBundle?.stateName.trim() || regionLabel;
  const localizedCityLabel =
    resolveLocalizedCityName(translationBundle, cityLabel) || cityLabel;
  const languageLabel = resolveLanguageLabel(
    event.language,
    locale,
    messages.common.unknown,
  ).label;
  const deviceTypeMeta = resolveDeviceTypeMeta(
    event.deviceType,
    messages.common.deviceLabels,
    messages.common.unknown,
  );
  const DeviceTypeIcon = deviceTypeMeta.Icon;
  const unknownLabel = messages.common.unknown;
  const localizedStatus = resolveLocalizedDetailValue(
    event.status,
    messages.realtime.statusLabels,
    unknownLabel,
  );
  const localizedVisibilityState = resolveLocalizedDetailValue(
    event.visibilityState,
    messages.realtime.visibilityStateLabels,
    unknownLabel,
  );
  const eventNameLabel =
    event.eventName?.trim() ||
    (event.eventKind === "custom_event"
      ? unknownLabel
      : messages.campaigns.notSet);
  const visibilityStateLabel = event.visibilityState?.trim()
    ? localizedVisibilityState
    : messages.campaigns.notSet;
  const previousVisitStartedLabel = event.previousVisitId?.trim()
    ? formatOptionalDetailDateTime(
        locale,
        event.previousVisitStartedAt,
        timeZone,
        unknownLabel,
      )
    : messages.campaigns.notSet;
  const detailRows = [
    {
      section: "event",
      priority: 1,
      label: messages.common.id,
      value: (
        <RealtimeEventDetailValue
          value={event.id.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "event",
      priority: 2,
      label: messages.realtime.eventName,
      value: <RealtimeEventDetailValue value={eventNameLabel} />,
    },
    {
      section: "event",
      priority: 3,
      label: messages.realtime.eventTime,
      value: (
        <RealtimeEventDetailValue
          value={formatDetailDateTime(locale, event.eventAt, timeZone)}
          mono
        />
      ),
    },
    {
      section: "event",
      priority: 4,
      label: messages.realtime.receivedAt,
      value: (
        <RealtimeEventDetailValue
          value={formatOptionalDetailDateTime(
            locale,
            event.receivedAt,
            timeZone,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      section: "event",
      priority: 5,
      label: messages.realtime.eventKind,
      value: (
        <RealtimeEventDetailValue
          value={event.eventKind?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "event",
      priority: 6,
      label: messages.realtime.traceId,
      value: (
        <RealtimeEventDetailValue
          value={event.traceId?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 1,
      wide: true,
      label: messages.realtime.visitorId,
      value: (
        <RealtimeEventDetailValue
          value={event.visitorId.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 1,
      wide: true,
      label: messages.realtime.sessionId,
      value: (
        <RealtimeEventDetailValue
          value={event.sessionId.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 2,
      wide: true,
      label: messages.realtime.visitId,
      value: (
        <RealtimeEventDetailValue
          value={event.visitId.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 5,
      label: messages.realtime.startedAt,
      value: (
        <RealtimeEventDetailValue
          value={formatOptionalDetailDateTime(
            locale,
            event.startedAt,
            timeZone,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 6,
      label: messages.realtime.previousVisitStartedAt,
      value: (
        <RealtimeEventDetailValue value={previousVisitStartedLabel} mono />
      ),
    },
    {
      section: "visitor",
      priority: 3,
      label: messages.realtime.userId,
      value: (
        <RealtimeEventDetailValue
          value={event.userId?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 2,
      label: messages.realtime.userName,
      value: (
        <RealtimeEventDetailValue
          value={event.userName?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "visitor",
      priority: 10,
      label: messages.realtime.isEU,
      value: (
        <RealtimeEventDetailValue
          value={formatDetailBoolean(
            event.isEU,
            unknownLabel,
            messages.sessionDetail.yes,
            messages.sessionDetail.no,
          )}
        />
      ),
    },
    {
      section: "browsing",
      priority: 1,
      label: messages.common.title,
      value: (
        <RealtimeEventDetailValue
          value={event.title.trim() || messages.common.unknown}
        />
      ),
    },
    {
      section: "browsing",
      priority: 2,
      label: messages.common.hostname,
      value: (
        <RealtimeEventDetailValue
          value={event.hostname.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "browsing",
      priority: 3,
      wide: true,
      label: messages.common.path,
      value: (
        <RealtimeEventDetailValue
          value={formatPathWithHash(event.pathname, event.hash)}
          mono
        />
      ),
    },
    {
      section: "browsing",
      priority: 4,
      wide: true,
      label: messages.realtime.queryString,
      value: (
        <RealtimeEventDetailValue
          value={event.queryString?.trim() || messages.pages.noQuery}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 4,
      label: messages.common.browser,
      value: (
        <RealtimeEventDetailValue
          icon={
            <LogoIcon
              src={`${BROWSER_ICON_DIR}/${browserIconKey}.svg`}
              fallbackSrc={`${BROWSER_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
              invertInDark={BROWSER_APPLE_ICON_KEYS.has(browserIconKey)}
            />
          }
          value={browserLabel}
        />
      ),
    },
    {
      section: "visitor",
      priority: 5,
      label: messages.realtime.browserVersion,
      value: (
        <RealtimeEventDetailValue
          value={event.browserVersion?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 6,
      label: messages.common.operatingSystem,
      value: (
        <RealtimeEventDetailValue
          icon={
            <LogoIcon
              src={`${OS_ICON_DIR}/${osIconKey}.svg`}
              fallbackSrc={`${OS_ICON_DIR}/${UNKNOWN_ICON_KEY}.svg`}
              invertInDark={OS_APPLE_ICON_KEYS.has(osIconKey)}
            />
          }
          value={osLabel}
        />
      ),
    },
    {
      section: "visitor",
      priority: 7,
      label: messages.realtime.osVersion,
      value: (
        <RealtimeEventDetailValue
          value={event.osVersion.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 8,
      label: messages.common.deviceType,
      value: (
        <RealtimeEventDetailValue
          icon={<DeviceTypeIcon className="size-3.5 text-muted-foreground" />}
          value={deviceTypeMeta.label}
        />
      ),
    },
    {
      section: "visitor",
      priority: 9,
      wide: true,
      label: messages.realtime.userAgent,
      value: (
        <RealtimeEventDetailValue
          value={event.uaRaw?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 1,
      label: messages.common.country,
      value: (
        <RealtimeEventDetailValue
          icon={
            countryFlagCode ? (
              <Icon
                icon={`flagpack:${countryFlagCode.toLowerCase()}`}
                style={{ width: 16, height: 12 }}
                className="block shrink-0"
              />
            ) : (
              <RiGlobalLine className="size-3.5 text-muted-foreground" />
            )
          }
          value={
            event.country.trim() && event.country.trim() !== countryLabel
              ? `${countryLabel} (${event.country.trim()})`
              : countryLabel
          }
        />
      ),
    },
    {
      section: "geography",
      priority: 2,
      label: messages.common.region,
      value: (
        <RealtimeEventDetailValue
          value={formatLocalizedGeoValue(
            localizedRegionLabel,
            regionLabel,
            messages.common.unknown,
          )}
        />
      ),
    },
    {
      section: "geography",
      priority: 3,
      label: messages.common.regionCode,
      value: (
        <RealtimeEventDetailValue
          value={event.regionCode.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 7,
      label: messages.realtime.postalCode,
      value: (
        <RealtimeEventDetailValue
          value={event.postalCode?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 8,
      label: messages.realtime.metroCode,
      value: (
        <RealtimeEventDetailValue
          value={event.metroCode?.trim() || unknownLabel}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 4,
      label: messages.common.city,
      value: (
        <RealtimeEventDetailValue
          value={formatLocalizedGeoValue(
            localizedCityLabel,
            cityLabel,
            messages.common.unknown,
          )}
        />
      ),
    },
    {
      section: "geography",
      priority: 5,
      label: messages.common.continent,
      value: (
        <RealtimeEventDetailValue
          value={
            event.continent.trim() && event.continent.trim() !== continentLabel
              ? `${continentLabel} (${event.continent.trim()})`
              : continentLabel
          }
        />
      ),
    },
    {
      section: "geography",
      priority: 6,
      label: messages.common.timezone,
      value: (
        <RealtimeEventDetailValue
          value={event.timezone.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "source",
      priority: 1,
      label: messages.common.referrerHost,
      value: (
        <RealtimeEventDetailValue
          value={event.referrerHost.trim() || messages.overview.direct}
          mono
        />
      ),
    },
    {
      section: "source",
      priority: 2,
      label: messages.common.referrer,
      value: (
        <RealtimeEventDetailValue
          icon={
            <DomainOrUrlIcon
              label={sourceLabel}
              unknownLabel={messages.overview.direct}
            />
          }
          value={event.referrerUrl.trim() || sourceLabel}
          mono
        />
      ),
    },
    {
      section: "source",
      priority: 3,
      label: messages.realtime.utmSource,
      value: (
        <RealtimeEventDetailValue
          value={event.utmSource?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "source",
      priority: 4,
      label: messages.realtime.utmMedium,
      value: (
        <RealtimeEventDetailValue
          value={event.utmMedium?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "source",
      priority: 5,
      label: messages.realtime.utmCampaign,
      value: (
        <RealtimeEventDetailValue
          value={event.utmCampaign?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "source",
      priority: 6,
      label: messages.realtime.utmTerm,
      value: (
        <RealtimeEventDetailValue
          value={event.utmTerm?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "source",
      priority: 7,
      label: messages.realtime.utmContent,
      value: (
        <RealtimeEventDetailValue
          value={event.utmContent?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "visitor",
      priority: 11,
      label: messages.common.screenSize,
      value: (
        <RealtimeEventDetailValue
          value={event.screenSize.trim() || messages.common.unknown}
          mono
        />
      ),
    },
    {
      section: "visitor",
      priority: 12,
      label: messages.common.language,
      value: <RealtimeEventDetailValue value={languageLabel} mono />,
    },
    {
      section: "visitor",
      priority: 13,
      wide: true,
      label: messages.common.organization,
      value: (
        <RealtimeEventDetailValue
          value={event.organization.trim() || messages.common.unknown}
        />
      ),
    },
    {
      section: "session",
      priority: 4,
      label: messages.realtime.status,
      value: <RealtimeEventDetailValue value={localizedStatus} />,
    },
    {
      section: "session",
      priority: 3,
      label: messages.realtime.visibilityState,
      value: <RealtimeEventDetailValue value={visibilityStateLabel} />,
    },
    {
      section: "session",
      priority: 7,
      label: messages.realtime.duration,
      value: (
        <RealtimeEventDetailValue
          value={formatDetailDuration(event.durationMs, unknownLabel)}
          mono
        />
      ),
    },
    {
      section: "session",
      priority: 8,
      label: messages.realtime.durationSource,
      value: (
        <RealtimeEventDetailValue
          value={event.durationSource?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "session",
      priority: 10,
      label: messages.realtime.exitReason,
      value: (
        <RealtimeEventDetailValue
          value={event.exitReason?.trim() || messages.campaigns.notSet}
        />
      ),
    },
    {
      section: "session",
      priority: 9,
      label: messages.realtime.leaveAt,
      value: (
        <RealtimeEventDetailValue
          value={formatOptionalDetailDateTime(
            locale,
            event.leaveAt,
            timeZone,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 9,
      label: messages.common.latitude,
      value: (
        <RealtimeEventDetailValue
          value={formatCoordinateValue(event.latitude)}
          mono
        />
      ),
    },
    {
      section: "geography",
      priority: 10,
      label: messages.common.longitude,
      value: (
        <RealtimeEventDetailValue
          value={formatCoordinateValue(event.longitude)}
          mono
        />
      ),
    },
  ];
  const performanceDetailRows = [
    {
      label: messages.performance.ttfb,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "ttfb",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      label: messages.performance.fcp,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "fcp",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      label: messages.performance.lcp,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "lcp",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      label: messages.performance.cls,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "cls",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
    {
      label: messages.performance.inp,
      value: (
        <RealtimeEventDetailValue
          value={formatRealtimePerformanceMetric(
            event.performance,
            "inp",
            messages,
            unknownLabel,
          )}
          mono
        />
      ),
    },
  ];
  const sortDetailRows = (rows: typeof detailRows) =>
    rows.sort((left, right) => {
      const leftPriority = "priority" in left ? left.priority : 0;
      const rightPriority = "priority" in right ? right.priority : 0;
      return leftPriority - rightPriority;
    });
  const eventDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "event"),
  );
  const browsingDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "browsing"),
  );
  const visitorDetailRows = sortDetailRows(
    detailRows
      .filter((row) => "section" in row && row.section === "visitor")
      .filter(
        (row) =>
          row.label !== messages.realtime.userId ||
          Boolean(event.userId?.trim()),
      ),
  );
  const sessionDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "session"),
  );
  const geographyDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "geography"),
  );
  const sourceDetailRows = sortDetailRows(
    detailRows.filter((row) => "section" in row && row.section === "source"),
  );
  return (
    <Drawer direction="right" open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]">
        <DrawerHeader className="border-b">
          <div className="flex min-w-0 items-center gap-2">
            <RiPulseLine className="size-4 shrink-0 text-muted-foreground" />
            <DrawerTitle>{messages.realtime.detailsTitle}</DrawerTitle>
          </div>
          <DrawerDescription>{displayData.title}</DrawerDescription>
        </DrawerHeader>
        <DrawerScrollArea
          className="min-h-0"
          contentClassName="space-y-4 p-4 sm:p-5"
          syncKey={event.id}
        >
          <div className="space-y-5">
            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.realtime.detailsTitle}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {eventDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </dl>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">{messages.events.payload}</h3>
              <JsonTreePanel
                value={event.eventData ?? {}}
                labels={messages.events}
              />
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.realtime.browsingSection}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {browsingDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                    wide={"wide" in row ? row.wide : false}
                  />
                ))}
              </dl>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.navigation.visitors}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {visitorDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                    wide={"wide" in row ? row.wide : false}
                  />
                ))}
              </dl>
              {onOpenVisitor ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={isIntegratingEvent || !event.visitorId.trim()}
                    onClick={() => onOpenVisitor(event.visitorId)}
                  >
                    <AutoTransition
                      as="span"
                      initial={false}
                      className="inline-flex items-center gap-2"
                      duration={0.16}
                      transitionKey={
                        isIntegratingEvent ? "integrating" : "open"
                      }
                    >
                      {isIntegratingEvent ? (
                        integratingEventLabel
                      ) : (
                        <>
                          <RiExternalLinkLine data-icon="inline-start" />
                          {messages.events.openVisitor}
                        </>
                      )}
                    </AutoTransition>
                  </Button>
                </div>
              ) : null}
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.navigation.sessions}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {sessionDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                    wide={"wide" in row ? row.wide : false}
                  />
                ))}
              </dl>
              {onOpenSession ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={isIntegratingEvent || !event.sessionId.trim()}
                    onClick={() => onOpenSession(event.sessionId)}
                  >
                    <AutoTransition
                      as="span"
                      initial={false}
                      className="inline-flex items-center gap-2"
                      duration={0.16}
                      transitionKey={
                        isIntegratingEvent ? "integrating" : "open"
                      }
                    >
                      {isIntegratingEvent ? (
                        integratingEventLabel
                      ) : (
                        <>
                          <RiExternalLinkLine data-icon="inline-start" />
                          {messages.events.openSession}
                        </>
                      )}
                    </AutoTransition>
                  </Button>
                </div>
              ) : null}
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.realtime.geographySection}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {geographyDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </dl>
            </section>

            <RealtimeVisitorLocationMapSection
              locale={locale}
              messages={messages}
              event={event}
            />

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.realtime.sourceSection}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {sourceDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </dl>
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-medium">
                {messages.sessionDetail.performanceTitle}
              </h3>
              <dl className="grid gap-3 sm:grid-cols-2">
                {performanceDetailRows.map((row, index) => (
                  <RealtimeDetailItem
                    key={`${row.label}:${index}`}
                    label={row.label}
                    value={row.value}
                  />
                ))}
              </dl>
            </section>

            <Separator />

            <RealtimeVisitorHistorySection
              locale={locale}
              messages={messages}
              now={now}
              event={event}
              events={events}
              onSelect={onSelect}
              timeZone={timeZone}
            />
          </div>
        </DrawerScrollArea>
      </DrawerContent>
    </Drawer>
  );
}
