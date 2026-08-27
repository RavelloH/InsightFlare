import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RiExternalLinkLine } from "@remixicon/react";

import {
  GeoPointsMapIsland,
  type GeoPointsMapPoint,
} from "@/components/dashboard/geo-points-map-island";
import {
  BrowserMeta,
  CountryRegionMeta,
  DeviceMeta,
  formatDuration,
  formatPath,
  formatScreen,
  formatShortDateTime,
  OsMeta,
  ReferrerMeta,
} from "@/components/dashboard/journey-display";
import { JsonTreePanel } from "@/components/dashboard/json-tree";
import { DetailDrawer } from "@/components/dashboard/site-pages/detail-drawer";
import {
  EVENT_RECORD_DRAWER_Z_INDEX,
  NESTED_DETAIL_DRAWER_Z_INDEX,
} from "@/components/dashboard/site-pages/floating-layer";
import { SessionDetailClientPage } from "@/components/dashboard/site-pages/session-detail-client-page";
import { VisitorDetailClientPage } from "@/components/dashboard/site-pages/visitor-detail-client-page";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ModalOverlay, overlayZIndexFor } from "@/components/ui/modal-overlay";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat } from "@/lib/dashboard/format";
import { parseGeoLocationValue } from "@/lib/dashboard/geo-location";
import type { EventRecordDetailData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

export type EventDetailDrawerKind =
  | "session_start"
  | "pageview"
  | "leave"
  | "custom";

export type EventDetailDrawerLabels = AppMessages["events"];
type EventPageCopy = EventDetailDrawerLabels;
export type EventDetailDrawerData = Omit<
  NonNullable<EventRecordDetailData["data"]>,
  "eventData"
> & {
  eventData?: unknown;
};
type EventRecordDetail = EventDetailDrawerData;

const EVENT_DETAIL_SKELETON_DATA: EventRecordDetail = {
  event: {
    eventId: "",
    eventName: "",
    occurredAt: 0,
    receivedAt: 0,
    sequence: 0,
    visitId: "",
    sessionId: "",
    visitorId: "",
    pathname: "",
    title: "",
    hostname: "",
    referrerHost: "",
    country: "",
    region: "",
    browser: "",
    browserVersion: "",
    os: "",
    osVersion: "",
    deviceType: "",
    nodeCount: 0,
    valueCount: 0,
  },
  context: {
    visitId: "",
    sessionId: "",
    visitorId: "",
    pathname: "",
    title: "",
    hostname: "",
    referrerHost: "",
    country: "",
    region: "",
    os: "",
    browser: "",
    browserVersion: "",
    osVersion: "",
    deviceType: "",
    performance: {
      ttfb: null,
      fcp: null,
      lcp: null,
      cls: null,
      inp: null,
    },
  },
  eventData: null,
};

function DetailItem({
  label,
  value,
  loading = false,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  loading?: boolean;
  wide?: boolean;
}) {
  const skeletonClassName = wide
    ? "my-1 h-3 w-[min(20rem,88%)]"
    : "my-1 h-3 w-[min(11rem,78%)]";

  return (
    <div className={cn("space-y-1", wide && "sm:col-span-2")}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <AutoResizer className="min-w-0" duration={0.2}>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : "ready"}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="flex min-h-5 min-w-0 items-center"
          >
            {loading ? (
              <Skeleton key="loading" className={skeletonClassName} />
            ) : (
              <div key="ready" className="min-h-5 min-w-0 leading-5">
                {value}
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </dd>
    </div>
  );
}

function hasValidEventCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const lat = Number(latitude);
  const lon = Number(longitude);
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function EventRecordPayloadState({
  detail,
  labels,
  loading,
}: {
  detail: EventRecordDetail;
  labels: EventPageCopy;
  loading: boolean;
}) {
  return (
    <AutoResizer className="w-full" duration={0.24}>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.22}
        type="fade"
        presenceMode="wait"
        className="w-full"
      >
        {loading ? (
          <div
            key="loading"
            className="space-y-3 border border-border/70 bg-muted/20 p-4"
          >
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-[78%]" />
            <Skeleton className="h-4 w-[62%]" />
            <Skeleton className="h-4 w-[70%]" />
            <Skeleton className="h-4 w-[48%]" />
          </div>
        ) : (
          <div key="ready" className="w-full">
            <JsonTreePanel value={detail.eventData ?? {}} labels={labels} />
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
}

function EventRecordLocationMap({
  locale,
  messages,
  context,
  loading,
}: {
  locale: Locale;
  messages: AppMessages;
  context: EventRecordDetail["context"];
  loading: boolean;
}) {
  const hasLocation = hasValidEventCoordinate(
    context.latitude,
    context.longitude,
  );
  const points = useMemo<GeoPointsMapPoint[]>(
    () =>
      hasLocation
        ? [
            {
              latitude: Number(context.latitude),
              longitude: Number(context.longitude),
              country: String(context.country ?? ""),
            },
          ]
        : [],
    [context.country, context.latitude, context.longitude, hasLocation],
  );

  return (
    <AutoResizer className="w-full" duration={0.24}>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.22}
        type="fade"
        presenceMode="wait"
        className="w-full"
      >
        {loading ? (
          <Skeleton key="loading" className="h-[11rem] w-full sm:h-[13rem]" />
        ) : (
          <div key="ready" className="w-full">
            <GeoPointsMapIsland
              locale={locale}
              messages={messages}
              points={points}
              emptyLabel={messages.realtime.visitorMapUnavailable}
              heightClassName="h-[11rem] sm:h-[13rem]"
              initialZoom={0.3}
              countryHoverEnabled={false}
              reuseMaps
            />
          </div>
        )}
      </AutoTransition>
    </AutoResizer>
  );
}

function isInsideDetailDrawer(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest("[data-detail-drawer-root]") !== null
  );
}

function formatEventDetailDateTime(
  locale: Locale,
  value: number | null | undefined,
  unknownLabel: string,
  missingLabel = unknownLabel,
): string {
  if (value === null || value === undefined) return missingLabel;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? formatShortDateTime(locale, value, undefined)
    : unknownLabel;
}

function formatEventDetailDateTimeOrAbsent(
  locale: Locale,
  value: number | null | undefined,
  hasValue: boolean,
  unknownLabel: string,
  absentLabel: string,
): string {
  return hasValue
    ? formatEventDetailDateTime(locale, value, unknownLabel)
    : absentLabel;
}

function formatEventDetailBoolean(
  value: boolean | undefined,
  messages: AppMessages,
): string {
  if (value === undefined) return messages.common.noData;
  if (typeof value !== "boolean") return messages.common.unknown;
  return value ? messages.sessionDetail.yes : messages.sessionDetail.no;
}

function formatEventDetailStatus(
  value: string | undefined,
  messages: AppMessages,
): string {
  const normalized = value?.trim() || "";
  if (!normalized) return messages.common.noData;
  const key = normalized as keyof AppMessages["realtime"]["statusLabels"];
  return key && messages.realtime.statusLabels[key]
    ? messages.realtime.statusLabels[key]
    : messages.common.unknown;
}

function formatEventDetailText(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel = missingLabel,
) {
  const normalized = value?.trim() || "";
  if (!normalized) return missingLabel;
  return ["unknown", "undefined", "null"].includes(
    normalized.toLocaleLowerCase(),
  )
    ? unknownLabel
    : normalized;
}

function formatEventDetailPath(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel: string,
): string {
  const normalized = value?.trim() || "";
  if (!normalized) return missingLabel;
  if (["unknown", "undefined", "null"].includes(normalized.toLowerCase())) {
    return unknownLabel;
  }
  return formatPath(normalized);
}

function formatEventDetailCity(
  value: string | null | undefined,
  missingLabel: string,
  unknownLabel: string,
): string {
  const normalized = value?.trim() || "";
  const parsed = parseGeoLocationValue(normalized);
  return formatEventDetailText(
    parsed?.localityName || parsed?.regionName || normalized,
    missingLabel,
    unknownLabel,
  );
}

function formatEventDetailScreen(
  width: number | null | undefined,
  height: number | null | undefined,
  unknownLabel: string,
  missingLabel = unknownLabel,
): string {
  if (width === null || width === undefined) {
    return height === null || height === undefined
      ? missingLabel
      : unknownLabel;
  }
  if (height === null || height === undefined) return unknownLabel;
  const screen = formatScreen(width, height);
  return screen === "/" ? unknownLabel : screen;
}

function formatEventDetailPerformance(
  locale: Locale,
  value: number | null | undefined,
  metric: "ttfb" | "fcp" | "lcp" | "cls" | "inp",
  unknownLabel: string,
  missingLabel = unknownLabel,
): string {
  if (value === null || value === undefined) return missingLabel;
  if (typeof value !== "number" || !Number.isFinite(value)) return unknownLabel;
  const formatted = numberFormat(locale, value);
  return metric === "cls" ? formatted : `${formatted} ms`;
}

type EventRecordNestedDetail = {
  kind: "visitor" | "session";
  id: string;
  stackKey: string;
};

export interface EventDetailDrawerProps {
  locale: Locale;
  messages: AppMessages;
  labels: EventDetailDrawerLabels;
  siteId: string;
  pathname: string;
  siteBasePath?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: EventDetailDrawerData | null;
  loading: boolean;
  error: boolean;
  eventKind?: EventDetailDrawerKind;
  zIndex?: number;
}

export function EventDetailDrawer({
  locale,
  messages,
  labels,
  siteId,
  pathname,
  siteBasePath: siteBasePathOverride,
  open,
  onOpenChange,
  detail: detailData,
  loading,
  error,
  eventKind = "custom",
  zIndex = EVENT_RECORD_DRAWER_Z_INDEX,
}: EventDetailDrawerProps) {
  const detail = detailData ?? EVENT_DETAIL_SKELETON_DATA;
  const [nestedDetails, setNestedDetails] = useState<EventRecordNestedDetail[]>(
    [],
  );
  const nestedDetailKeyRef = useRef(0);
  const basePath =
    siteBasePathOverride ??
    pathname.replace(/\/(?:events|sessions|visitors)(?:\/detail)?$/, "");
  const visitorId = detail.context.visitorId.trim();
  const sessionId = detail.context.sessionId.trim();
  const visitorPathname = `${basePath}/visitors`;
  const sessionPathname = `${basePath}/sessions`;
  const nestedDetailOpen = nestedDetails.length > 0;
  const nestedDrawerZIndex = Math.max(
    NESTED_DETAIL_DRAWER_Z_INDEX,
    zIndex + 100,
  );
  const showPayload =
    eventKind === "custom" || detailData?.event.eventKind === "custom_event";
  const missingDetailLabel = messages.common.noData;
  const unknownDetailLabel = messages.common.unknown;

  useEffect(() => {
    if (!open) setNestedDetails([]);
  }, [open]);

  const openNestedDetail = (kind: "visitor" | "session", id: string) => {
    const normalizedId = id.trim();
    if (!normalizedId) return;

    setNestedDetails((current) => {
      const topDetail = current.at(-1);
      if (topDetail?.kind === kind && topDetail.id === normalizedId) {
        return current;
      }

      nestedDetailKeyRef.current += 1;
      return [
        ...current,
        {
          kind,
          id: normalizedId,
          stackKey: `${kind}:${normalizedId}:${nestedDetailKeyRef.current}`,
        },
      ];
    });
  };

  const closeNestedDetail = (stackKey: string) => {
    setNestedDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      if (index < 0) return current;
      return current.slice(0, index);
    });
  };

  const openVisitorDetail = (nextVisitorId: string) => {
    openNestedDetail("visitor", nextVisitorId);
  };

  const openSessionDetail = (nextSessionId: string) => {
    openNestedDetail("session", nextSessionId);
  };

  const stopSideDrawerOverlayEvent = (
    event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>,
  ) => {
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
  };

  const closeSideDrawerFromOverlay = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    stopSideDrawerOverlayEvent(event);
    if (!nestedDetailOpen) onOpenChange(false);
  };

  return (
    <>
      <ModalOverlay
        data-event-record-drawer-overlay=""
        layerId="event-record-drawer"
        open={open}
        portal
        zIndex={overlayZIndexFor(zIndex)}
        onPointerDown={stopSideDrawerOverlayEvent}
        onPointerUp={stopSideDrawerOverlayEvent}
        onClick={closeSideDrawerFromOverlay}
      />
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        direction="right"
        modal={false}
      >
        <DrawerContent
          data-dashboard-floating-layer="event-record-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
          style={{ zIndex }}
          onEscapeKeyDown={(event) => {
            if (nestedDetailOpen) event.preventDefault();
          }}
          onFocusOutside={(event) => {
            if (isInsideDetailDrawer(event.detail.originalEvent.target)) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (isInsideDetailDrawer(event.detail.originalEvent.target)) {
              event.preventDefault();
            }
          }}
          onPointerDownOutside={(event) => {
            if (isInsideDetailDrawer(event.detail.originalEvent.target)) {
              event.preventDefault();
            }
          }}
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{labels.detailTitle}</DrawerTitle>
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : detailData?.event.eventName}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-5"
            >
              {loading ? (
                <Skeleton key="loading" className="h-4 w-44" />
              ) : (
                <DrawerDescription key="ready">
                  {detailData?.event.eventName || labels.detailSubtitle}
                </DrawerDescription>
              )}
            </AutoTransition>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            {error ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {labels.loadError}
              </div>
            ) : !detailData && !loading ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {labels.detailNotFound}
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{labels.detailTitle}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={labels.eventId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.event.eventId,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.eventName}
                      value={
                        <span className="break-words text-[11px]">
                          {formatEventDetailText(
                            detail.event.eventName,
                            labels.noEventName,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.occurredAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.event.occurredAt,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.receivedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.event.receivedAt,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    {showPayload ? (
                      <DetailItem
                        loading={loading}
                        label={labels.payloadFields}
                        value={
                          <span className="text-[11px]">
                            {numberFormat(locale, detail.event.nodeCount)}{" "}
                            {labels.nodes} /{" "}
                            {numberFormat(locale, detail.event.valueCount)}{" "}
                            {labels.values}
                          </span>
                        }
                      />
                    ) : null}
                  </dl>
                </section>

                {showPayload ? (
                  <>
                    <Separator />

                    <section className="space-y-3">
                      <h3 className="text-sm font-medium">{labels.payload}</h3>
                      <EventRecordPayloadState
                        detail={detail}
                        labels={labels}
                        loading={loading}
                      />
                    </section>

                    <Separator />
                  </>
                ) : null}

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.realtime.browsingSection}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={messages.common.title}
                      value={
                        <span className="break-words text-[11px]">
                          {formatEventDetailText(
                            detail.context.title,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.hostname}
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.hostname,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.path}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailPath(
                            detail.context.pathname,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.queryString}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.queryString,
                            messages.pages.noQuery,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.pages.hashTab}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.hash,
                            messages.pages.noHash,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.navigation.visitors}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.visitorId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            visitorId,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.userName}
                      value={formatEventDetailText(
                        detail.context.userName,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    {loading || detail.context.userId?.trim() ? (
                      <DetailItem
                        loading={loading}
                        label={messages.realtime.userId}
                        value={
                          <span className="break-all font-mono text-[11px]">
                            {detail.context.userId}
                          </span>
                        }
                      />
                    ) : null}
                    <DetailItem
                      loading={loading}
                      label={labels.browser}
                      value={
                        <BrowserMeta
                          browser={detail.context.browser || ""}
                          version={detail.context.browserVersion}
                          unknownLabel={unknownDetailLabel}
                          missingLabel={missingDetailLabel}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.os}
                      value={
                        <OsMeta
                          os={detail.context.os || ""}
                          version={detail.context.osVersion}
                          unknownLabel={unknownDetailLabel}
                          missingLabel={missingDetailLabel}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={labels.device}
                      value={
                        <DeviceMeta
                          deviceType={detail.context.deviceType || ""}
                          deviceLabels={messages.common.deviceLabels}
                          unknownLabel={unknownDetailLabel}
                          missingLabel={missingDetailLabel}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.userAgent}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.userAgent,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.isEU}
                      value={formatEventDetailBoolean(
                        detail.context.isEU,
                        messages,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.screenSize}
                      value={formatEventDetailScreen(
                        detail.context.screenWidth,
                        detail.context.screenHeight,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.language}
                      value={formatEventDetailText(
                        detail.context.language,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.organization}
                      wide
                      value={formatEventDetailText(
                        detail.context.organization,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={!visitorId}
                      onClick={() => openVisitorDetail(visitorId)}
                    >
                      <RiExternalLinkLine data-icon="inline-start" />
                      {labels.openVisitor}
                    </Button>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.navigation.sessions}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.sessionId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            sessionId,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.visitId}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.visitId,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.status}
                      value={formatEventDetailStatus(
                        detail.context.status,
                        messages,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.startedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.context.startedAt,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.previousVisitStartedAt}
                      value={formatEventDetailDateTimeOrAbsent(
                        locale,
                        detail.context.previousVisitStartedAt,
                        Boolean(detail.context.previousVisitId?.trim()),
                        messages.common.unknown,
                        messages.campaigns.notSet,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.endedAt}
                      value={formatEventDetailDateTime(
                        locale,
                        detail.context.endedAt,
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.duration}
                      value={
                        detail.context.durationMs === null ||
                        detail.context.durationMs === undefined
                          ? missingDetailLabel
                          : typeof detail.context.durationMs !== "number" ||
                              !Number.isFinite(detail.context.durationMs)
                            ? unknownDetailLabel
                            : formatDuration(locale, detail.context.durationMs)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.durationSource}
                      value={formatEventDetailText(
                        detail.context.durationSource,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.exitReason}
                      value={formatEventDetailText(
                        detail.context.exitReason,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={!sessionId}
                      onClick={() => openSessionDetail(sessionId)}
                    >
                      <RiExternalLinkLine data-icon="inline-start" />
                      {labels.openSession}
                    </Button>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.realtime.geographySection}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={labels.location}
                      wide
                      value={
                        <CountryRegionMeta
                          locale={locale}
                          messages={messages}
                          country={detail.context.country || ""}
                          region={detail.context.region}
                          city={detail.context.city}
                          missingLabel={missingDetailLabel}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.regionCode}
                      value={formatEventDetailText(
                        detail.context.regionCode,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.city}
                      value={formatEventDetailCity(
                        detail.context.city,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.continent}
                      value={formatEventDetailText(
                        detail.context.continent,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.timezone}
                      value={formatEventDetailText(
                        detail.context.timezone,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.postalCode}
                      value={formatEventDetailText(
                        detail.context.postalCode,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.metroCode}
                      value={formatEventDetailText(
                        detail.context.metroCode,
                        missingDetailLabel,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.latitude}
                      value={
                        detail.context.latitude === null ||
                        detail.context.latitude === undefined
                          ? missingDetailLabel
                          : typeof detail.context.latitude !== "number" ||
                              !Number.isFinite(detail.context.latitude)
                            ? unknownDetailLabel
                            : numberFormat(locale, detail.context.latitude)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.longitude}
                      value={
                        detail.context.longitude === null ||
                        detail.context.longitude === undefined
                          ? missingDetailLabel
                          : typeof detail.context.longitude !== "number" ||
                              !Number.isFinite(detail.context.longitude)
                            ? unknownDetailLabel
                            : numberFormat(locale, detail.context.longitude)
                      }
                    />
                  </dl>
                </section>

                <EventRecordLocationMap
                  locale={locale}
                  messages={messages}
                  context={detail.context}
                  loading={loading}
                />

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.realtime.sourceSection}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={labels.referrer}
                      value={
                        <ReferrerMeta
                          referrerHost={detail.context.referrerHost || ""}
                          referrerUrl={detail.context.referrerUrl}
                          directLabel={messages.overview.direct}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.sessionDetail.referrerUrl}
                      wide
                      value={
                        <span className="break-all font-mono text-[11px]">
                          {formatEventDetailText(
                            detail.context.referrerUrl,
                            missingDetailLabel,
                            unknownDetailLabel,
                          )}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmSource}
                      value={formatEventDetailText(
                        detail.context.utmSource,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmMedium}
                      value={formatEventDetailText(
                        detail.context.utmMedium,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmCampaign}
                      value={formatEventDetailText(
                        detail.context.utmCampaign,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmTerm}
                      value={formatEventDetailText(
                        detail.context.utmTerm,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.utmContent}
                      value={formatEventDetailText(
                        detail.context.utmContent,
                        messages.campaigns.notSet,
                        unknownDetailLabel,
                      )}
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">
                    {messages.sessionDetail.performanceTitle}
                  </h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={messages.performance.ttfb}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.ttfb,
                        "ttfb",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.performance.fcp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.fcp,
                        "fcp",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.performance.lcp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.lcp,
                        "lcp",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.performance.cls}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.cls,
                        "cls",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.performance.inp}
                      value={formatEventDetailPerformance(
                        locale,
                        detail.context.performance?.inp,
                        "inp",
                        unknownDetailLabel,
                        missingDetailLabel,
                      )}
                    />
                  </dl>
                </section>
              </div>
            )}
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>

      {nestedDetails.map((nestedDetail) => (
        <DetailDrawer
          key={nestedDetail.stackKey}
          ariaLabel={
            nestedDetail.kind === "visitor"
              ? messages.visitors.title
              : messages.sessionDetail.visitDetailsTitle
          }
          drawerKey={nestedDetail.stackKey}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closeNestedDetail(nestedDetail.stackKey);
          }}
          zIndex={nestedDrawerZIndex}
        >
          {nestedDetail.kind === "visitor" ? (
            <VisitorDetailClientPage
              locale={locale}
              messages={messages}
              siteId={siteId}
              pathname={visitorPathname}
              visitorId={nestedDetail.id}
              onOpenSession={openSessionDetail}
            />
          ) : (
            <SessionDetailClientPage
              locale={locale}
              messages={messages}
              siteId={siteId}
              pathname={sessionPathname}
              sessionId={nestedDetail.id}
              onOpenVisitor={openVisitorDetail}
            />
          )}
        </DetailDrawer>
      ))}
    </>
  );
}

/** Backwards-compatible name used by the events analytics page. */
export const EventRecordDetailDrawer = EventDetailDrawer;
