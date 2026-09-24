import { memo, type ReactNode, useMemo } from "react";
import type { RiRobot2Line } from "@remixicon/react";

import {
  type AsyncDimensionBreakdownLabelAppearance,
  type AsyncDimensionBreakdownRow,
} from "@/components/dashboard/common/async-dimension-breakdown-card";
import type { TabbedDataTablePage } from "@/components/dashboard/common/tabbed-data-table-card";
import { GeoPointsMapIsland } from "@/components/dashboard/geo/geo-points-map-island";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TableCell } from "@/components/ui/table";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

import {
  type BotDimensionRow,
  type BotEvent,
  type ClientDimensionTab,
  type DetectionDimensionTab,
  DIMENSION_ROW_LIMIT,
  nestedMessage,
  type NetworkDimensionTab,
  normalizeRequestObservationCategory,
  type NormalRequestEvent,
  type RequestNetworkDimensionRow,
  type RequestObservationColumnAlignment,
  type TargetDimensionTab,
} from "./model";
function compactReason(reason: string): string {
  return reason.replace(/_/g, " ");
}
export function botReasonLabel(
  copy: AppMessages["requestObservation"],
  reason: string,
): string {
  const labels: Readonly<Record<string, string>> = copy.botReasonLabels;
  return labels[reason] ?? compactReason(reason);
}
export function requestCategoryLabel(
  copy: AppMessages["requestObservation"],
  category: string,
): string {
  const normalized = normalizeRequestObservationCategory(category);
  if (normalized === "normal") {
    return nestedMessage(
      copy,
      ["normalRequests"],
      nestedMessage(
        copy,
        ["overviewLabels", "normalRequests"],
        "Normal requests",
      ),
    );
  }
  if (normalized === "suspected_bot") {
    return nestedMessage(copy, ["suspectedBotRequests"], "Suspected bots");
  }
  if (normalized === "bot") {
    return nestedMessage(copy, ["botRequests"], "Bot requests");
  }
  if (normalized === "custom_block") {
    return nestedMessage(copy, ["customBlockedRequests"], "Custom blocks");
  }
  // Unknown values are kept as neutral data labels; never reinterpret them
  // as a legacy threat level.
  return compactReason(category);
}
function botReasonCombinationLabel(
  copy: AppMessages["requestObservation"],
  value: string,
): string {
  return value
    .split(",")
    .map((reason) => reason.trim())
    .filter(Boolean)
    .map((reason) => botReasonLabel(copy, reason))
    .join(", ");
}
export function requestKindLabel(
  copy: AppMessages["requestObservation"],
  kind: string,
): string {
  const labels: Readonly<Record<string, string>> = copy.requestKindLabels;
  return labels[kind] ?? (compactReason(kind) || emptyValue(copy));
}
export function emptyValue(copy: AppMessages["requestObservation"]): string {
  return copy.emptyValue;
}
export function botScoreBucket(score: number | null): string {
  if (score === null) return "";
  if (score < 20) return "1-19";
  if (score < 40) return "20-39";
  if (score < 60) return "40-59";
  if (score < 80) return "60-79";
  return "80-99";
}
export function userAgentLengthBucket(length: number): string {
  if (!Number.isFinite(length) || length <= 0) return "";
  if (length < 80) return "1-79";
  if (length < 160) return "80-159";
  if (length < 256) return "160-255";
  if (length < 512) return "256-511";
  return "512+";
}
export function ipPrefix(ip: string): string {
  const value = ip.trim();
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;
  if (value.includes(":")) {
    const parts = value.split(":").filter(Boolean);
    if (parts.length >= 4) return `${parts.slice(0, 4).join(":")}::/64`;
  }
  return value;
}
function _valuesForDetectionTab(
  event: BotEvent,
  tab: DetectionDimensionTab,
  copy: AppMessages["requestObservation"],
): string[] {
  if (tab === "reason") {
    return event.reasons.map((reason) => botReasonLabel(copy, reason));
  }
  if (tab === "category") return [event.category];
  if (tab === "kind") return [event.kind];
  if (tab === "botScoreBucket") return [botScoreBucket(event.botScore)];
  return [event.verifiedBotCategory];
}
function _valuesForTargetTab(
  event: BotEvent,
  tab: TargetDimensionTab,
): string[] {
  if (tab === "site") {
    return [event.siteName || event.siteDomain || event.siteId];
  }
  if (tab === "hostname") return [event.hostname];
  if (tab === "pathname") return [event.pathname || "/"];
  return [event.origin];
}
function _valuesForNetworkTab(
  event: BotEvent,
  tab: NetworkDimensionTab,
): string[] {
  if (tab === "asOrganization") return [event.asOrganization];
  if (tab === "asn") return [event.asn ? `AS${event.asn}` : ""];
  if (tab === "country") return [event.country];
  if (tab === "region") return [event.region];
  if (tab === "city") return [event.city];
  return [event.colo];
}
function _valuesForClientTab(
  event: BotEvent,
  tab: ClientDimensionTab,
): string[] {
  if (tab === "ip") return [event.ip];
  if (tab === "userAgent") return [event.userAgent];
  if (tab === "userAgentLengthBucket") {
    return [userAgentLengthBucket(event.userAgentLength)];
  }
  return [ipPrefix(event.ip)];
}
function _aggregateDimensionRows(
  events: BotEvent[],
  copy: AppMessages["requestObservation"],
  resolveValues: (event: BotEvent) => string[],
): BotDimensionRow[] {
  const rowMap = new Map<
    string,
    { count: number; botCount: number; sampleEvent: BotEvent | null }
  >();

  for (const event of events) {
    const values = resolveValues(event)
      .map((value) => value.trim())
      .filter(Boolean);
    const normalizedValues = values.length > 0 ? values : [emptyValue(copy)];
    for (const value of normalizedValues) {
      const current = rowMap.get(value) ?? {
        count: 0,
        botCount: 0,
        sampleEvent: event,
      };
      current.count += 1;
      if (event.category === "bot") current.botCount += 1;
      current.sampleEvent ??= event;
      rowMap.set(value, current);
    }
  }

  return Array.from(rowMap.entries())
    .map(([label, row]) => ({
      label,
      count: row.count,
      botCount: row.botCount,
      sampleEvent: row.sampleEvent,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.botCount - left.botCount ||
        left.label.localeCompare(right.label),
    )
    .slice(0, DIMENSION_ROW_LIMIT);
}
export function formatAsn(event: BotEvent): string {
  if (!event.asn && !event.asOrganization) return "--";
  if (!event.asn) return event.asOrganization;
  if (!event.asOrganization) return `AS${event.asn}`;
  return `AS${event.asn} ${event.asOrganization}`;
}
export function formatNormalAsn(event: NormalRequestEvent): string {
  if (!event.asn && !event.asOrganization) return "--";
  if (!event.asn) return event.asOrganization;
  if (!event.asOrganization) return `AS${event.asn}`;
  return `AS${event.asn} ${event.asOrganization}`;
}
export function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  loading,
}: {
  icon: typeof RiRobot2Line;
  label: string;
  value: string;
  detail: string;
  loading: boolean;
}) {
  const contentKey = loading ? "loading" : value;

  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-[11px]" />
        </span>
        <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
          {label}
        </p>
      </div>
      <AutoResizer initial className="mt-3">
        <AutoTransition
          transitionKey={contentKey}
          initial={false}
          duration={0.2}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <div key="loading" className="flex h-7 items-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <p
              key={value}
              className="min-w-0 truncate font-mono text-xl leading-7 font-semibold text-foreground tabular-nums"
            >
              {value}
            </p>
          )}
        </AutoTransition>
      </AutoResizer>
      <p className="mt-3 min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}
function faviconLabelForEvent(
  event: BotEvent | null,
  tab: TargetDimensionTab,
): string | undefined {
  if (!event) return undefined;
  if (tab === "site") return event.siteDomain || event.hostname || event.origin;
  if (tab === "hostname") return event.hostname || event.siteDomain;
  if (tab === "origin")
    return event.origin || event.hostname || event.siteDomain;
  return undefined;
}
function countryFlagAppearance(
  rawCountry: string,
  locale: Locale,
  unknownLabel: string,
): {
  label: string;
  appearance: AsyncDimensionBreakdownLabelAppearance | undefined;
} {
  const country = resolveCountryLabel(rawCountry, locale, unknownLabel);
  const flagCode = resolveCountryFlagCode(country.code, locale);
  return {
    label: country.label,
    appearance: {
      type: "leadingIcon",
      iconName: flagCode ? `flagpack:${flagCode.toLowerCase()}` : null,
    },
  };
}
function regionAppearance(
  row: BotDimensionRow,
  locale: Locale,
  unknownLabel: string,
): AsyncDimensionBreakdownLabelAppearance | undefined {
  const event = row.sampleEvent;
  if (!event) return undefined;
  const country = resolveCountryLabel(event.country, locale, unknownLabel);
  const flagCode = resolveCountryFlagCode(country.code, locale);
  const regionLabel = row.label.trim() || event.region.trim() || unknownLabel;
  const hasRegion = Boolean(event.region.trim());

  return {
    type: "geoRegion",
    countryLabel: country.label,
    countryIconName: flagCode ? `flagpack:${flagCode.toLowerCase()}` : null,
    regionLabel,
    countryCode: country.code ?? event.country,
    stateCode: event.region,
    hideRegion: !hasRegion,
  };
}
function cityAppearance(
  row: BotDimensionRow,
  locale: Locale,
  unknownLabel: string,
): AsyncDimensionBreakdownLabelAppearance | undefined {
  const event = row.sampleEvent;
  if (!event) return undefined;
  const country = resolveCountryLabel(event.country, locale, unknownLabel);
  const flagCode = resolveCountryFlagCode(country.code, locale);
  const regionLabel = event.region.trim() || unknownLabel;
  const cityLabel = row.label.trim() || event.city.trim() || unknownLabel;
  const hasRegion = Boolean(event.region.trim());
  const hasCity = Boolean(event.city.trim());

  return {
    type: "geoCity",
    countryLabel: country.label,
    countryIconName: flagCode ? `flagpack:${flagCode.toLowerCase()}` : null,
    regionLabel,
    cityLabel,
    countryCode: country.code ?? event.country,
    stateCode: event.region,
    cityNameDefault: event.city,
    hideRegion: !hasRegion,
    hideCity: !hasCity,
  };
}
function toAsyncDimensionRows(
  rows: BotDimensionRow[],
  options?: {
    targetTab?: TargetDimensionTab;
    networkTab?: NetworkDimensionTab;
    locale?: Locale;
    unknownLabel?: string;
  },
): AsyncDimensionBreakdownRow[] {
  return rows.map((row) => ({
    key: row.label,
    label:
      options?.networkTab === "country" &&
      options.locale &&
      options.unknownLabel
        ? countryFlagAppearance(row.label, options.locale, options.unknownLabel)
            .label
        : row.label,
    views: row.count,
    visitors: row.botCount,
    mono: row.label.includes("/") || row.label.includes(":"),
    labelAppearance:
      options?.targetTab && options.targetTab !== "pathname"
        ? {
            type: "favicon",
            iconLabel: faviconLabelForEvent(row.sampleEvent, options.targetTab),
          }
        : options?.networkTab === "country" &&
            options.locale &&
            options.unknownLabel
          ? countryFlagAppearance(
              row.label,
              options.locale,
              options.unknownLabel,
            ).appearance
          : options?.networkTab === "region" &&
              options.locale &&
              options.unknownLabel
            ? regionAppearance(row, options.locale, options.unknownLabel)
            : options?.networkTab === "city" &&
                options.locale &&
                options.unknownLabel
              ? cityAppearance(row, options.locale, options.unknownLabel)
              : undefined,
  }));
}
function _toAsyncNetworkDimensionRows(
  rows: RequestNetworkDimensionRow[] | undefined,
  fallbackRows: BotDimensionRow[],
  options: {
    networkTab: NetworkDimensionTab;
    locale: Locale;
    unknownLabel: string;
  },
): AsyncDimensionBreakdownRow[] {
  if (!rows) return toAsyncDimensionRows(fallbackRows, options);

  const dimensionRows = rows.map((row) => ({
    label:
      options.networkTab === "asn" && row.label
        ? `AS${row.label}`
        : row.label || options.unknownLabel,
    count: row.count,
    botCount: row.botCount,
    sampleEvent: {
      country: row.country,
      region: row.region,
      city: options.networkTab === "city" ? row.label : "",
    } as BotEvent,
  }));

  return toAsyncDimensionRows(dimensionRows, options).map((row, index) => ({
    ...row,
    key: rows[index]?.key || row.key,
  }));
}
export function toAsyncAggregatedDimensionRows(
  rows: RequestNetworkDimensionRow[],
  options?: Parameters<typeof toAsyncDimensionRows>[1] & {
    detectionTab?: DetectionDimensionTab;
    copy?: AppMessages["requestObservation"];
  },
): AsyncDimensionBreakdownRow[] {
  return toAsyncDimensionRows(
    rows.map((row) => ({
      label:
        options?.detectionTab === "reason" && options.copy
          ? botReasonCombinationLabel(options.copy, row.label)
          : options?.detectionTab === "category" && options.copy
            ? requestCategoryLabel(options.copy, row.label)
            : options?.networkTab === "asn" && row.label
              ? `AS${row.label}`
              : row.label || options?.unknownLabel || "--",
      count: row.count,
      botCount: row.botCount,
      sampleEvent: {
        country: row.country,
        region: options?.networkTab === "region" ? row.label : row.region,
        city: row.label,
        siteDomain: row.iconLabel,
        hostname: options?.targetTab === "hostname" ? row.label : "",
        origin: options?.targetTab === "origin" ? row.label : "",
      } as BotEvent,
    })),
    options,
  ).map((row, index) => ({ ...row, key: rows[index]?.key || row.key }));
}
export function asyncDimensionPage(
  items: AsyncDimensionBreakdownRow[],
  limit: number,
): TabbedDataTablePage<AsyncDimensionBreakdownRow> {
  return {
    items,
    pagination: {
      limit,
      returned: items.length,
      hasMore: false,
      nextCursor: null,
    },
  };
}
export function displayValue(
  value: string | number | null | undefined,
  empty: string,
) {
  if (value === null || value === undefined || value === "") return empty;
  return String(value);
}
export function metadataEntries(
  metadataJson: string | undefined,
): Array<[string, string]> {
  const raw = (metadataJson ?? "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [["metadata", raw]];
    }
    return Object.entries(parsed as Record<string, unknown>).map(
      ([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ],
    );
  } catch {
    return [["metadata", raw]];
  }
}
export const RequestDetailLocationMap = memo(function RequestDetailLocationMap({
  locale,
  messages,
  country,
  latitude,
  longitude,
  loading,
}: {
  locale: Locale;
  messages: AppMessages;
  country: string;
  latitude: number | null;
  longitude: number | null;
  loading: boolean;
}) {
  const hasLocation =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Number(latitude) >= -90 &&
    Number(latitude) <= 90 &&
    Number(longitude) >= -180 &&
    Number(longitude) <= 180;
  const points = useMemo(
    () =>
      hasLocation
        ? [
            {
              latitude: Number(latitude),
              longitude: Number(longitude),
              country,
            },
          ]
        : [],
    [country, hasLocation, latitude, longitude],
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
});
export const DetailItem = memo(function DetailItem({
  label,
  value,
  loading = false,
  wide = false,
  inline = false,
}: {
  label: string;
  value: ReactNode;
  loading?: boolean;
  wide?: boolean;
  inline?: boolean;
}) {
  const skeletonClassName = wide
    ? "my-1 h-3 w-[min(20rem,88%)]"
    : "my-1 h-3 w-[min(11rem,78%)]";

  return (
    <div
      className={cn(
        "min-w-0 space-y-1",
        wide && "sm:col-span-2",
        inline &&
          "grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] items-baseline gap-x-3 space-y-0",
      )}
    >
      <dt className={cn("text-muted-foreground", inline && "min-w-0 truncate")}>
        {label}
      </dt>
      <dd className={cn("min-w-0", inline && "min-h-5")}>
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
});
export function CategoryBlocks({
  category,
  label,
}: {
  category: string;
  label?: string;
}) {
  const normalized = category.trim().toLowerCase();
  const activeCount =
    normalized === "normal"
      ? 1
      : normalized === "suspected_bot"
        ? 2
        : normalized === "bot"
          ? 3
          : normalized === "custom_block"
            ? 3
            : 0;
  const activeColor =
    normalized === "normal"
      ? "bg-emerald-500"
      : normalized === "suspected_bot"
        ? "bg-amber-500"
        : normalized === "bot"
          ? "bg-red-500"
          : normalized === "custom_block"
            ? "bg-muted-foreground"
            : "";

  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={label || category || undefined}
    >
      {Array.from({ length: 3 }, (_, index) => (
        <span
          key={index}
          className={cn(
            "size-1.5 shrink-0",
            index < activeCount ? activeColor : "bg-muted-foreground/25",
          )}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
export function RequestObservationRowSkeletonContent({
  index,
  columns,
  widths,
  alignments,
}: {
  index: number;
  columns: readonly string[];
  widths: Readonly<Record<string, string>>;
  alignments: Readonly<Record<string, RequestObservationColumnAlignment>>;
}) {
  return (
    <>
      {columns.map((columnId) => (
        <TableCell
          key={`${index}:${columnId}`}
          className={cn(
            columnId === "id" && "pl-4",
            alignments[columnId] === "center" && "text-center",
            alignments[columnId] === "right" && "text-right",
          )}
        >
          {columnId === "id" ? (
            <div className="flex w-28 min-w-0 items-center gap-2">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
          ) : (
            <Skeleton
              className={cn(
                "h-4",
                widths[columnId],
                alignments[columnId] === "center" && "mx-auto",
                alignments[columnId] === "right" && "ml-auto",
              )}
            />
          )}
        </TableCell>
      ))}
    </>
  );
}
