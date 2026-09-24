import { memo, type ReactNode, useCallback, useMemo } from "react";
import { Icon } from "@iconify/react";

import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableLoader,
  type TabbedDataTableRowAdapter,
  type TabbedDataTableRowBase,
  type TabbedDataTableTab,
} from "@/components/dashboard/common/tabbed-data-table-card";
import {
  LazyGeoCityBreadcrumbLabel,
  LazyGeoRegionBreadcrumbLabel,
} from "@/components/dashboard/geo/lazy-geo-location-label";
import { LabelWithOptionalIcon } from "@/components/dashboard/referrers/referrer-utils";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";
type NonEmptyArray<T> = readonly [T, ...T[]];
type SortKey = "views" | "visitors" | "reference" | "current" | "change";
export type AsyncDimensionBreakdownLabelAppearance =
  | {
      type: "favicon";
      iconLabel?: string;
    }
  | {
      type: "leadingIcon";
      iconName: string | null;
    }
  | {
      type: "geoRegion";
      countryLabel: string;
      countryIconName: string | null;
      regionLabel: string;
      countryCode: string;
      stateCode: string;
      hideRegion: boolean;
    }
  | {
      type: "geoCity";
      countryLabel: string;
      countryIconName: string | null;
      regionLabel: string;
      cityLabel: string;
      countryCode: string;
      stateCode: string;
      cityNameDefault: string;
      hideRegion: boolean;
      hideCity: boolean;
    };
export interface AsyncDimensionBreakdownRow extends TabbedDataTableRowBase {
  label: string;
  views: number;
  visitors: number;
  reference?: {
    views: number;
    visitors: number;
  };
  change?: {
    views: { absolute: number; relative: number | null };
    visitors: { absolute: number; relative: number | null };
  };
  mono?: boolean;
  labelAppearance?: AsyncDimensionBreakdownLabelAppearance;
}
export type AsyncDimensionBreakdownLoader<T extends string> =
  TabbedDataTableLoader<T, AsyncDimensionBreakdownRow, SortKey>;
export interface AsyncDimensionBreakdownTab<
  T extends string = string,
> extends TabbedDataTableTab<T> {
  primaryMetricLabel?: string;
}
interface AsyncDimensionBreakdownCardProps<T extends string> {
  locale: Locale;
  messages: AppMessages;
  tabs: NonEmptyArray<AsyncDimensionBreakdownTab<T>>;
  value?: T;
  onValueChange?: (value: T) => void;
  loader: TabbedDataTableLoader<T, AsyncDimensionBreakdownRow, SortKey>;
  requestKey: string;
  className?: string;
  showVisitors?: boolean;
  secondaryMetricLabel?: string;
  emptyLabel?: string;
  comparisonLabel?: string;
  comparisonCurrentLabel?: string;
  comparisonMetric?: "views" | "visitors";
}
function normalizeRows(
  rows: readonly AsyncDimensionBreakdownRow[],
): AsyncDimensionBreakdownRow[] {
  return rows.map((row, index) => ({
    ...row,
    key: row.key || `${row.label}-${index}`,
    label: String(row.label ?? "").trim(),
    views: Math.max(0, Number(row.views ?? 0)),
    visitors: Math.max(0, Number(row.visitors ?? 0)),
    reference: row.reference
      ? {
          views: Math.max(0, Number(row.reference.views ?? 0)),
          visitors: Math.max(0, Number(row.reference.visitors ?? 0)),
        }
      : undefined,
    change: row.change
      ? {
          views: {
            absolute: Number(row.change.views.absolute ?? 0),
            relative:
              row.change.views.relative === null
                ? null
                : Number(row.change.views.relative ?? 0),
          },
          visitors: {
            absolute: Number(row.change.visitors.absolute ?? 0),
            relative:
              row.change.visitors.relative === null
                ? null
                : Number(row.change.visitors.relative ?? 0),
          },
        }
      : undefined,
    mono: Boolean(row.mono),
    labelAppearance: row.labelAppearance,
  }));
}
const LabelWithLeadingIcon = memo(function LabelWithLeadingIcon({
  label,
  iconName,
}: {
  label: string;
  iconName: string | null;
}) {
  if (!iconName) {
    return <span className="break-words">{label}</span>;
  }

  const isFlag = iconName.startsWith("flagpack:");

  return (
    <span className="relative inline-block max-w-full break-words pl-6">
      <span className="pointer-events-none absolute inset-y-0 left-0 inline-flex w-4 items-center justify-center">
        {isFlag ? (
          <Icon
            icon={iconName}
            style={{
              width: 16,
              height: 12,
            }}
            className="block shrink-0"
          />
        ) : null}
      </span>
      <span className="break-words">{label}</span>
    </span>
  );
});
const AsyncDimensionRowLabel = memo(function AsyncDimensionRowLabel({
  locale,
  row,
  emptyLabel,
}: {
  locale: Locale;
  row: AsyncDimensionBreakdownRow;
  emptyLabel: string;
}) {
  const appearance = row.labelAppearance;
  const className = cn(row.mono && "font-mono");

  if (appearance?.type === "favicon") {
    return (
      <span className={className}>
        <LabelWithOptionalIcon
          label={row.label}
          iconLabel={appearance.iconLabel}
          showIcon
          unknownLabel={emptyLabel}
        />
      </span>
    );
  }

  if (appearance?.type === "leadingIcon") {
    return (
      <span className={className}>
        <LabelWithLeadingIcon
          label={row.label}
          iconName={appearance.iconName}
        />
      </span>
    );
  }

  if (appearance?.type === "geoRegion") {
    return (
      <span className={className}>
        <LazyGeoRegionBreadcrumbLabel
          locale={locale}
          countryLabel={appearance.countryLabel}
          countryIconName={appearance.countryIconName}
          regionLabel={appearance.regionLabel}
          countryCode={appearance.countryCode}
          stateCode={appearance.stateCode}
          hideRegion={appearance.hideRegion}
        />
      </span>
    );
  }

  if (appearance?.type === "geoCity") {
    return (
      <span className={className}>
        <LazyGeoCityBreadcrumbLabel
          locale={locale}
          countryLabel={appearance.countryLabel}
          countryIconName={appearance.countryIconName}
          regionLabel={appearance.regionLabel}
          cityLabel={appearance.cityLabel}
          countryCode={appearance.countryCode}
          stateCode={appearance.stateCode}
          cityNameDefault={appearance.cityNameDefault}
          hideRegion={appearance.hideRegion}
          hideCity={appearance.hideCity}
        />
      </span>
    );
  }

  return <span className={cn("break-words", className)}>{row.label}</span>;
});
export const AsyncDimensionBreakdownCard = memo(
  function AsyncDimensionBreakdownCard<T extends string>({
    locale,
    messages,
    tabs,
    value,
    onValueChange,
    loader,
    requestKey,
    className,
    showVisitors = true,
    secondaryMetricLabel,
    emptyLabel,
    comparisonLabel,
    comparisonCurrentLabel,
    comparisonMetric = "views",
  }: AsyncDimensionBreakdownCardProps<T>) {
    const resolvedEmptyLabel = emptyLabel ?? messages.common.noData;
    const resolvedSecondaryMetricLabel =
      secondaryMetricLabel ?? messages.common.visitors;
    const rowAdapter = useMemo<
      TabbedDataTableRowAdapter<AsyncDimensionBreakdownRow, T, SortKey>
    >(
      () => ({
        renderLabel: (row) => (
          <AsyncDimensionRowLabel
            locale={locale}
            row={row}
            emptyLabel={resolvedEmptyLabel}
          />
        ),
        getSearchText: (row) => row.label,
        getExportLabel: (row) => row.label,
        getClassName: () => "hover:brightness-95",
      }),
      [locale, resolvedEmptyLabel],
    );
    const labelColumnLabel = useCallback(
      (tab: TabbedDataTableTab<T>) => tab.columnLabel ?? tab.label,
      [],
    );
    const search = useMemo(
      () => ({
        actionLabel: messages.common.search,
        placeholder: (tab: TabbedDataTableTab<T>) =>
          formatI18nTemplate(messages.overview.searchInTab, {
            tab: tab.label,
          }),
      }),
      [messages.common.search, messages.overview.searchInTab],
    );
    const exportConfig = useMemo(
      () => ({
        labels: messages.common.tableExport,
      }),
      [messages.common.tableExport],
    );
    const columns = useMemo<
      (
        tab: T,
      ) => readonly TabbedDataTableColumn<
        AsyncDimensionBreakdownRow,
        SortKey,
        T
      >[]
    >(
      () => (tab) => {
        const primaryMetricLabel =
          tabs.find((item) => item.value === tab)?.primaryMetricLabel ??
          messages.common.views;

        if (comparisonLabel) {
          const comparisonMetricLabel =
            comparisonMetric === "views"
              ? primaryMetricLabel
              : resolvedSecondaryMetricLabel;

          return [
            {
              key: "reference" as const,
              label: comparisonLabel,
              getValue: (row: AsyncDimensionBreakdownRow) =>
                row.reference?.[comparisonMetric] ?? 0,
              sortValue: (row: AsyncDimensionBreakdownRow) =>
                row.reference?.[comparisonMetric] ?? 0,
              format: (value: number) => numberFormat(locale, value),
            },
            {
              key: "current" as const,
              label: comparisonCurrentLabel ?? comparisonMetricLabel,
              getValue: (row: AsyncDimensionBreakdownRow) =>
                row[comparisonMetric],
              sortValue: (row: AsyncDimensionBreakdownRow) =>
                row[comparisonMetric],
              format: (value: number) => numberFormat(locale, value),
            },
            {
              key: "change" as const,
              label: messages.common.change,
              getValue: (row: AsyncDimensionBreakdownRow) =>
                row.change?.[comparisonMetric]?.absolute ?? 0,
              sortValue: (row: AsyncDimensionBreakdownRow) =>
                row.change?.[comparisonMetric]?.relative ?? Infinity,
              format: (_value: number, row: AsyncDimensionBreakdownRow) => {
                const change = row.change?.[comparisonMetric];
                if (!change) {
                  return <span className="text-muted-foreground">—</span>;
                }
                if (change.relative === null) {
                  return (
                    <span
                      className={
                        row[comparisonMetric] > 0
                          ? "text-emerald-600"
                          : "text-muted-foreground"
                      }
                    >
                      {row[comparisonMetric] > 0 ? messages.common.new : "—"}
                    </span>
                  );
                }
                const percentage = change.relative * 100;
                return (
                  <span
                    className={
                      percentage >= 0 ? "text-emerald-600" : "text-rose-600"
                    }
                  >
                    {`${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}%`}
                  </span>
                );
              },
            },
            ...(showVisitors && comparisonMetric === "views"
              ? [
                  {
                    key: "visitors" as const,
                    label: resolvedSecondaryMetricLabel,
                    getValue: (row: AsyncDimensionBreakdownRow) => row.visitors,
                    sortValue: (row: AsyncDimensionBreakdownRow) =>
                      row.visitors,
                    format: (value: number) => numberFormat(locale, value),
                  },
                ]
              : []),
          ];
        }

        return [
          {
            key: "views" as const,
            label: primaryMetricLabel,
            getValue: (row: AsyncDimensionBreakdownRow) => row.views,
            format: (value: number) => numberFormat(locale, value),
          },
          ...(showVisitors
            ? [
                {
                  key: "visitors" as const,
                  label: resolvedSecondaryMetricLabel,
                  getValue: (row: AsyncDimensionBreakdownRow) => row.visitors,
                  format: (value: number) => numberFormat(locale, value),
                },
              ]
            : []),
        ];
      },
      [
        comparisonCurrentLabel,
        comparisonLabel,
        comparisonMetric,
        locale,
        messages.common.change,
        messages.common.new,
        messages.common.views,
        resolvedSecondaryMetricLabel,
        showVisitors,
        tabs,
      ],
    );

    return (
      <TabbedDataTableCard<T, AsyncDimensionBreakdownRow, SortKey>
        tabs={tabs}
        value={value}
        onValueChange={onValueChange}
        columns={columns}
        requestKey={requestKey}
        loader={loader}
        normalizeRows={normalizeRows}
        rowAdapter={rowAdapter}
        labelColumnLabel={labelColumnLabel}
        sortActionLabel={(label) =>
          formatI18nTemplate(messages.common.sortBy, { label })
        }
        loadingLabel={messages.common.loading}
        emptyLabel={resolvedEmptyLabel}
        className={className}
        search={search}
        export={exportConfig}
        defaultSort={
          comparisonLabel
            ? {
                key: "current",
                direction: "desc",
              }
            : undefined
        }
      />
    );
  },
) as <T extends string>(
  props: AsyncDimensionBreakdownCardProps<T>,
) => ReactNode;
