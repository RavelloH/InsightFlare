import { memo, type ReactNode, useCallback, useMemo } from "react";
import { Icon } from "@iconify/react";

import {
  LazyGeoCityBreadcrumbLabel,
  LazyGeoRegionBreadcrumbLabel,
} from "@/components/dashboard/lazy-geo-location-label";
import { LabelWithOptionalIcon } from "@/components/dashboard/referrer-utils";
import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableRowAdapter,
  type TabbedDataTableRowBase,
  type TabbedDataTableSortState,
  type TabbedDataTableTab,
} from "@/components/dashboard/tabbed-data-table-card";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

type NonEmptyArray<T> = readonly [T, ...T[]];
type SortKey = "views" | "visitors";

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
  mono?: boolean;
  labelAppearance?: AsyncDimensionBreakdownLabelAppearance;
}

export interface AsyncDimensionBreakdownTab<
  T extends string = string,
> extends TabbedDataTableTab<T> {
  primaryMetricLabel?: string;
}

interface AsyncDimensionBreakdownCardProps<T extends string> {
  locale: Locale;
  messages: AppMessages;
  tabs: NonEmptyArray<AsyncDimensionBreakdownTab<T>>;
  loadRows?: (
    tab: T,
    signal?: AbortSignal,
  ) => Promise<AsyncDimensionBreakdownRow[]>;
  rowsByTab?: Partial<Record<T, readonly AsyncDimensionBreakdownRow[] | null>>;
  loadingByTab?: Partial<Record<T, boolean>>;
  requestKey: string;
  className?: string;
  showVisitors?: boolean;
  secondaryMetricLabel?: string;
  emptyLabel?: string;
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
    loadRows,
    rowsByTab,
    loadingByTab,
    requestKey,
    className,
    showVisitors = true,
    secondaryMetricLabel,
    emptyLabel,
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
    const compareRows = useCallback(
      (
        left: AsyncDimensionBreakdownRow,
        right: AsyncDimensionBreakdownRow,
        { sort }: { sort: TabbedDataTableSortState<SortKey> },
      ) => {
        const primary =
          (left[sort.key] - right[sort.key]) *
          (sort.direction === "asc" ? 1 : -1);
        if (primary !== 0) return primary;
        if (right.views !== left.views) return right.views - left.views;
        if (right.visitors !== left.visitors) {
          return right.visitors - left.visitors;
        }
        return left.label.localeCompare(right.label);
      },
      [],
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
      () => (tab) => [
        {
          key: "views",
          label:
            tabs.find((item) => item.value === tab)?.primaryMetricLabel ??
            messages.common.views,
          getValue: (row) => row.views,
          format: (value) => numberFormat(locale, value),
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
      ],
      [
        locale,
        messages.common.views,
        resolvedSecondaryMetricLabel,
        showVisitors,
        tabs,
      ],
    );

    return (
      <TabbedDataTableCard<T, AsyncDimensionBreakdownRow, SortKey>
        tabs={tabs}
        columns={columns}
        requestKey={requestKey}
        rowsByTab={rowsByTab}
        loadingByTab={loadingByTab}
        loadRows={loadRows}
        normalizeRows={normalizeRows}
        rowAdapter={rowAdapter}
        compareRows={compareRows}
        labelColumnLabel={labelColumnLabel}
        sortActionLabel={(label) =>
          formatI18nTemplate(messages.common.sortBy, { label })
        }
        loadingLabel={messages.common.loading}
        emptyLabel={resolvedEmptyLabel}
        className={className}
        search={search}
        export={exportConfig}
      />
    );
  },
) as <T extends string>(
  props: AsyncDimensionBreakdownCardProps<T>,
) => ReactNode;
