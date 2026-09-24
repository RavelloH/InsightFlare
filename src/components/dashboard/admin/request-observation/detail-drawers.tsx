import { useMemo } from "react";

import { CountryRegionMeta } from "@/components/dashboard/journeys/journey-display";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat, shortDateTimeWithSeconds } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import {
  botReasonLabel,
  botScoreBucket,
  CategoryBlocks,
  DetailItem,
  displayValue,
  formatAsn,
  formatNormalAsn,
  ipPrefix,
  metadataEntries,
  requestCategoryLabel,
  RequestDetailLocationMap,
  requestKindLabel,
  userAgentLengthBucket,
} from "./helpers";
import {
  BOT_EVENT_DETAIL_SKELETON_DATA,
  type BotEvent,
  latencyFormat,
  NORMAL_REQUEST_DETAIL_SKELETON_DATA,
  type NormalRequestEvent,
  requestObservationDetailId,
  requestObservationUiLabels,
} from "./model";
export function BotRequestDetailDrawer({
  locale,
  messages,
  copy,
  previewEvent,
  detailEvent,
  loading,
  error,
  open,
  onOpenChange,
}: {
  locale: Locale;
  messages: AppMessages;
  copy: AppMessages["requestObservation"];
  previewEvent: BotEvent | null;
  detailEvent: BotEvent | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ui = useMemo(
    () => requestObservationUiLabels(locale, copy),
    [copy, locale],
  );
  const empty = copy.emptyValue;
  const preview = detailEvent ?? previewEvent;
  const event = preview ?? BOT_EVENT_DETAIL_SKELETON_DATA;
  const hasEvent = Boolean(preview);
  const metadata = event ? metadataEntries(event.metadataJson) : [];
  const requestMethod =
    event.requestMethod ||
    metadata.find(([key]) => key === "requestMethod")?.[1] ||
    "";
  const eventId = event ? event.traceId || event.rayId : "";
  const subtitle = eventId || ui.detailSubtitle;

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange} direction="right">
        <DrawerContent
          data-dashboard-floating-layer="request-observation-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
          onFocusOutside={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{ui.detailTitle}</DrawerTitle>
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : subtitle}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-5"
            >
              {loading ? (
                <Skeleton key="loading" className="h-4 w-44" />
              ) : (
                <DrawerDescription key="ready">{subtitle}</DrawerDescription>
              )}
            </AutoTransition>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            {error ? (
              <div className="flex h-64 items-center justify-center text-center text-sm text-muted-foreground">
                {error}
              </div>
            ) : !hasEvent && !loading ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {copy.noData}
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{ui.detailTitle}</h3>
                  <AutoResizer className="w-full" duration={0.2}>
                    <AutoTransition
                      initial={false}
                      transitionKey={loading ? "loading" : "ready"}
                      duration={0.18}
                      type="fade"
                      presenceMode="wait"
                      className="w-full"
                    >
                      {loading ? (
                        <div
                          key="loading"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <Skeleton className="h-5 w-20" />
                          <Skeleton className="h-5 w-28" />
                          <Skeleton className="h-4 w-32" />
                        </div>
                      ) : (
                        <div
                          key="ready"
                          className="flex flex-wrap items-center gap-2"
                        >
                          <Badge variant="outline">
                            {event.disposition === "blocked"
                              ? ui.blocked
                              : event.disposition === "included"
                                ? ui.included
                                : empty}
                          </Badge>
                          <Badge variant="outline">
                            <CategoryBlocks
                              category={event.category}
                              label={
                                event.category
                                  ? requestCategoryLabel(copy, event.category)
                                  : empty
                              }
                            />
                          </Badge>
                          {event.reasons.map((reason) => (
                            <Badge key={reason} variant="outline">
                              {botReasonLabel(copy, reason)}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </AutoTransition>
                  </AutoResizer>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={copy.time}
                      value={shortDateTimeWithSeconds(locale, event.receivedAt)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.kind}
                      value={displayValue(event.kind, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.botScoreBucket}
                      value={botScoreBucket(event.botScore)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.botScore}
                      value={
                        event.botScore === null ||
                        !Number.isFinite(event.botScore)
                          ? empty
                          : numberFormat(locale, event.botScore)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.verifiedBotCategory}
                      value={displayValue(event.verifiedBotCategory, empty)}
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.request}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={copy.site}
                      value={
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {displayValue(event.siteName, empty)}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {displayValue(
                              event.siteDomain || event.siteId,
                              empty,
                            )}
                          </div>
                        </div>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.siteId}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.siteId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.normalDetail.requestMethod}
                      value={displayValue(requestMethod, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.origin}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.origin, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.hostname}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.hostname, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.pathname}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.pathname || "/", empty)}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.edge}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.location}
                      value={
                        <CountryRegionMeta
                          locale={locale}
                          messages={messages}
                          country={event.country || ""}
                          region={event.region}
                          city={event.city}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.colo}
                      value={displayValue(event.colo, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.network}
                      value={displayValue(formatAsn(event), empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.continent}
                      value={displayValue(event.continent, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.latitude}
                      value={
                        event.latitude === null ||
                        !Number.isFinite(event.latitude)
                          ? empty
                          : numberFormat(locale, event.latitude)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.longitude}
                      value={
                        event.longitude === null ||
                        !Number.isFinite(event.longitude)
                          ? empty
                          : numberFormat(locale, event.longitude)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.ip}
                      value={
                        <span className="font-mono">
                          {displayValue(event.ip, empty)}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <RequestDetailLocationMap
                  locale={locale}
                  messages={messages}
                  country={event.country || ""}
                  latitude={event.latitude}
                  longitude={event.longitude}
                  loading={loading}
                />

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.client}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={copy.userAgentLengthBucket}
                      value={
                        event.userAgentLength
                          ? userAgentLengthBucket(event.userAgentLength)
                          : empty
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.userAgentLength}
                      value={
                        event.userAgentLength > 0
                          ? numberFormat(locale, event.userAgentLength)
                          : empty
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.ipPrefix}
                      value={ipPrefix(event.ip)}
                    />
                  </dl>
                  <div className="space-y-1">
                    <div className="text-muted-foreground">
                      {copy.fullUserAgent}
                    </div>
                    <div className="break-all rounded-none border bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
                      {displayValue(event.userAgent, empty)}
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.identifiers}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      wide
                      label="Trace ID"
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.traceId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label="Ray ID"
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.rayId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.country}
                      value={displayValue(event.country, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.asn}
                      value={displayValue(
                        event.asn ? `AS${event.asn}` : "",
                        empty,
                      )}
                    />
                  </dl>
                </section>

                {metadata.length > 0 ? (
                  <>
                    <Separator />
                    <section className="space-y-3">
                      <h3 className="text-sm font-medium">{copy.metadata}</h3>
                      <dl className="grid gap-3">
                        {metadata.map(([key, value]) => (
                          <DetailItem
                            key={key}
                            loading={loading}
                            inline
                            label={key}
                            value={
                              <span className="break-all font-mono text-xs text-muted-foreground">
                                {displayValue(value, empty)}
                              </span>
                            }
                          />
                        ))}
                      </dl>
                    </section>
                  </>
                ) : null}
              </div>
            )}
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>
    </>
  );
}
export function NormalRequestDetailDrawer({
  locale,
  messages,
  copy,
  previewEvent,
  detailEvent,
  loading,
  error,
  open,
  onOpenChange,
}: {
  locale: Locale;
  messages: AppMessages;
  copy: AppMessages["requestObservation"];
  previewEvent: NormalRequestEvent | null;
  detailEvent: NormalRequestEvent | null;
  loading: boolean;
  error: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ui = requestObservationUiLabels(locale, copy);
  const empty = copy.emptyValue;
  const preview = detailEvent ?? previewEvent;
  const event = preview ?? NORMAL_REQUEST_DETAIL_SKELETON_DATA;
  const hasEvent = Boolean(preview);
  const eventId = preview ? requestObservationDetailId(preview) : "";
  const title = ui.detailTitle;
  const subtitle = eventId || ui.detailSubtitle;
  const requestMethodLabel = copy.normalDetail.requestMethod;
  const edgeLatencyLabel = copy.normalDetail.edgeLatency;
  const eventAtLabel = copy.normalDetail.eventAt;
  const receivedAtLabel = copy.normalDetail.receivedAt;
  const continentLabel = copy.normalDetail.continent;
  const metadata = event ? metadataEntries(event.metadataJson) : [];

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange} direction="right">
        <DrawerContent
          data-dashboard-floating-layer="request-observation-normal-drawer"
          className="!w-full !max-w-none sm:!w-[min(58vw,34rem)]"
          overlayClassName="hidden"
          onFocusOutside={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
        >
          <DrawerHeader className="border-b">
            <DrawerTitle>{title}</DrawerTitle>
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : eventId || "ready"}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-5"
            >
              {loading ? (
                <Skeleton key="loading" className="h-4 w-44" />
              ) : (
                <DrawerDescription key="ready">{subtitle}</DrawerDescription>
              )}
            </AutoTransition>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="p-4">
            {error ? (
              <div className="flex h-64 items-center justify-center text-center text-sm text-muted-foreground">
                {error}
              </div>
            ) : !hasEvent && !loading ? (
              <div className="flex h-64 items-center justify-center text-muted-foreground">
                {copy.noData}
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{title}</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {event.disposition === "blocked"
                        ? ui.blocked
                        : event.disposition === "included"
                          ? ui.included
                          : empty}
                    </Badge>
                    <Badge variant="outline">
                      {event.category
                        ? requestCategoryLabel(copy, event.category)
                        : empty}
                    </Badge>
                  </div>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={receivedAtLabel}
                      value={shortDateTimeWithSeconds(locale, event.receivedAt)}
                    />
                    <DetailItem
                      loading={loading}
                      label={eventAtLabel}
                      value={shortDateTimeWithSeconds(locale, event.eventAt)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.kind}
                      value={requestKindLabel(copy, event.kind)}
                    />
                    <DetailItem
                      loading={loading}
                      label={requestMethodLabel}
                      value={displayValue(event.requestMethod, empty)}
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.request}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={copy.site}
                      value={
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {displayValue(event.siteName, empty)}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {displayValue(
                              event.siteDomain || event.siteId,
                              empty,
                            )}
                          </div>
                        </div>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.realtime.siteId}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.siteId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.origin}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.origin, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.hostname}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.hostname, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.pathname}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.pathname || "/", empty)}
                        </span>
                      }
                    />
                  </dl>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.edge}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={edgeLatencyLabel}
                      value={latencyFormat(locale, copy, event.edgeLatencyMs)}
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.location}
                      value={
                        <CountryRegionMeta
                          locale={locale}
                          messages={messages}
                          country={event.country || ""}
                          region={event.region}
                          city={event.city}
                        />
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.colo}
                      value={displayValue(event.colo, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.network}
                      value={displayValue(formatNormalAsn(event), empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.latitude}
                      value={
                        event.latitude === null ||
                        !Number.isFinite(event.latitude)
                          ? empty
                          : numberFormat(locale, event.latitude)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={messages.common.longitude}
                      value={
                        event.longitude === null ||
                        !Number.isFinite(event.longitude)
                          ? empty
                          : numberFormat(locale, event.longitude)
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={continentLabel}
                      value={displayValue(event.continent, empty)}
                    />
                  </dl>
                </section>

                <RequestDetailLocationMap
                  locale={locale}
                  messages={messages}
                  country={event.country || ""}
                  latitude={event.latitude}
                  longitude={event.longitude}
                  loading={loading}
                />

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.client}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      label={copy.userAgentLengthBucket}
                      value={
                        event.userAgentLength
                          ? userAgentLengthBucket(event.userAgentLength)
                          : empty
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.userAgentLength}
                      value={
                        event.userAgentLength > 0
                          ? numberFormat(locale, event.userAgentLength)
                          : empty
                      }
                    />
                  </dl>
                  <div className="space-y-1">
                    <div className="text-muted-foreground">
                      {copy.fullUserAgent}
                    </div>
                    <div className="break-all rounded-none border bg-muted/30 p-3 font-mono text-xs text-muted-foreground">
                      {displayValue(event.userAgent, empty)}
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h3 className="text-sm font-medium">{copy.identifiers}</h3>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <DetailItem
                      loading={loading}
                      wide
                      label={copy.id}
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(eventId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label="Trace ID"
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.traceId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      wide
                      label="Ray ID"
                      value={
                        <span className="break-all font-mono text-xs">
                          {displayValue(event.rayId, empty)}
                        </span>
                      }
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.country}
                      value={displayValue(event.country, empty)}
                    />
                    <DetailItem
                      loading={loading}
                      label={copy.asn}
                      value={displayValue(
                        event.asn ? `AS${event.asn}` : "",
                        empty,
                      )}
                    />
                  </dl>
                </section>

                {metadata.length > 0 ? (
                  <>
                    <Separator />
                    <section className="space-y-3">
                      <h3 className="text-sm font-medium">{copy.metadata}</h3>
                      <dl className="grid gap-3">
                        {metadata.map(([key, value]) => (
                          <DetailItem
                            key={key}
                            loading={loading}
                            inline
                            label={key}
                            value={
                              <span className="break-all font-mono text-xs text-muted-foreground">
                                {displayValue(value, empty)}
                              </span>
                            }
                          />
                        ))}
                      </dl>
                    </section>
                  </>
                ) : null}
              </div>
            )}
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>
    </>
  );
}
