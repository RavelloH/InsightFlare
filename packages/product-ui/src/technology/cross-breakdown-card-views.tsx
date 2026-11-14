import { type ComponentType, memo, useMemo } from "react";
import { AsyncContent as ContentSwitch } from "@insightflare/ui/async-content";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { Spinner } from "@insightflare/ui/spinner";
import { RiBarChartBoxLine } from "@remixicon/react";

import {
  StackedBreakdownBarChart,
  type StackedBreakdownBarRow,
  type StackedBreakdownBarSeries,
} from "../charts";

export interface CrossBreakdownColumn {
  readonly key: string;
  readonly displayLabel: string;
  readonly color: string;
  readonly Icon?: ComponentType<{ className?: string }>;
}

export interface CrossBreakdownRow {
  readonly key: string;
  readonly displayLabel: string;
  readonly cells: ReadonlyArray<{
    readonly key: string;
    readonly visitors: number;
  }>;
}

export interface CrossBreakdownDimension {
  readonly columns: ReadonlyArray<CrossBreakdownColumn>;
  readonly rows: ReadonlyArray<CrossBreakdownRow>;
}

export interface CrossBreakdownCardLabels {
  readonly loadingLabel: string;
  readonly emptyLabel: string;
}

export interface BrowserCrossBreakdownCardViewProps {
  readonly locale: string;
  readonly labels: CrossBreakdownCardLabels;
  readonly title: string;
  readonly dimension: CrossBreakdownDimension;
  readonly comparisonDimension?: CrossBreakdownDimension;
  readonly loading: boolean;
  readonly hydrated: boolean;
}

export interface DeviceCrossBreakdownCardViewProps {
  readonly locale: string;
  readonly labels: CrossBreakdownCardLabels;
  readonly title: string;
  readonly dimension: CrossBreakdownDimension;
  readonly comparisonDimension?: CrossBreakdownDimension;
  readonly loading: boolean;
}

export const BrowserCrossBreakdownCardView = memo(
  function BrowserCrossBreakdownCardView({
    locale,
    labels,
    title,
    dimension,
    comparisonDimension,
    loading,
    hydrated,
  }: BrowserCrossBreakdownCardViewProps) {
    const hasContent =
      (dimension.rows.length > 0 && dimension.columns.length > 0) ||
      ((comparisonDimension?.rows.length ?? 0) > 0 &&
        (comparisonDimension?.columns.length ?? 0) > 0);
    const showOverlayLoading = loading && hydrated;

    const chartSeries = useMemo<StackedBreakdownBarSeries[]>(
      () =>
        dimension.columns.map((column) => ({
          key: column.key,
          label: column.displayLabel,
          color: column.color,
          icon: column.Icon,
        })),
      [dimension.columns],
    );

    const chartRows = useMemo<StackedBreakdownBarRow[]>(
      () =>
        dimension.rows.map((row) => ({
          key: row.key,
          label: row.displayLabel,
          values: Object.fromEntries(
            row.cells.map((cell) => [cell.key, cell.visitors]),
          ),
        })),
      [dimension.rows],
    );
    const comparisonChartSeries = useMemo<
      StackedBreakdownBarSeries[] | undefined
    >(
      () =>
        comparisonDimension?.columns.map((column) => ({
          key: column.key,
          label: column.displayLabel,
          color: column.color,
          icon: column.Icon,
        })),
      [comparisonDimension?.columns],
    );
    const comparisonChartRows = useMemo<StackedBreakdownBarRow[] | undefined>(
      () =>
        comparisonDimension?.rows.map((row) => ({
          key: row.key,
          label: row.displayLabel,
          values: Object.fromEntries(
            row.cells.map((cell) => [cell.key, cell.visitors]),
          ),
        })),
      [comparisonDimension?.rows],
    );

    return (
      <Card className="h-full overflow-hidden">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiBarChartBoxLine className="size-4" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">
          <ContentSwitch
            loading={loading && !hydrated}
            hasContent={hasContent}
            loadingLabel={labels.loadingLabel}
            emptyContent={<p>{labels.emptyLabel}</p>}
            minHeightClassName="min-h-[320px]"
          >
            <div className="relative">
              <StackedBreakdownBarChart
                rows={chartRows}
                series={chartSeries}
                comparisonRows={comparisonChartRows}
                comparisonSeries={comparisonChartSeries}
                locale={locale}
                maxCategoryLabelLength={18}
                stackId="browser-cross"
                className="w-full aspect-auto"
              />

              <AutoTransition
                type="fade"
                duration={0.22}
                className="pointer-events-none absolute top-2 right-2"
              >
                {showOverlayLoading ? (
                  <span
                    key={`browser-cross-${title}-loading`}
                    className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
                  >
                    <Spinner className="size-3.5" />
                    {labels.loadingLabel}
                  </span>
                ) : (
                  <div
                    key={`browser-cross-${title}-idle`}
                    className="h-0 w-0 overflow-hidden"
                  />
                )}
              </AutoTransition>
            </div>
          </ContentSwitch>
        </CardContent>
      </Card>
    );
  },
);

export const DeviceCrossBreakdownCardView = memo(
  function DeviceCrossBreakdownCardView({
    locale,
    labels,
    title,
    dimension,
    comparisonDimension,
    loading,
  }: DeviceCrossBreakdownCardViewProps) {
    const chartRows = useMemo<StackedBreakdownBarRow[]>(
      () =>
        dimension.rows.map((row) => {
          const values = row.cells.reduce<Record<string, number>>(
            (result, cell) => {
              result[cell.key] = cell.visitors;
              return result;
            },
            {},
          );
          return { key: row.key, label: row.displayLabel, values };
        }),
      [dimension.rows],
    );
    const chartSeries = useMemo<StackedBreakdownBarSeries[]>(
      () =>
        dimension.columns.map((column) => ({
          key: column.key,
          label: column.displayLabel,
          color: column.color,
        })),
      [dimension.columns],
    );
    const comparisonChartRows = useMemo<StackedBreakdownBarRow[] | undefined>(
      () =>
        comparisonDimension?.rows.map((row) => ({
          key: row.key,
          label: row.displayLabel,
          values: row.cells.reduce<Record<string, number>>((result, cell) => {
            result[cell.key] = cell.visitors;
            return result;
          }, {}),
        })),
      [comparisonDimension?.rows],
    );
    const comparisonChartSeries = useMemo<
      StackedBreakdownBarSeries[] | undefined
    >(
      () =>
        comparisonDimension?.columns.map((column) => ({
          key: column.key,
          label: column.displayLabel,
          color: column.color,
        })),
      [comparisonDimension?.columns],
    );
    const hasContent =
      (dimension.rows.length > 0 && dimension.columns.length > 0) ||
      ((comparisonDimension?.rows.length ?? 0) > 0 &&
        (comparisonDimension?.columns.length ?? 0) > 0);

    return (
      <Card className="h-full overflow-hidden">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiBarChartBoxLine className="size-4" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">
          <ContentSwitch
            loading={loading}
            hasContent={hasContent}
            loadingLabel={labels.loadingLabel}
            emptyContent={<p>{labels.emptyLabel}</p>}
            minHeightClassName="min-h-[320px]"
          >
            <StackedBreakdownBarChart
              rows={chartRows}
              series={chartSeries}
              comparisonRows={comparisonChartRows}
              comparisonSeries={comparisonChartSeries}
              locale={locale}
              stackId={title}
              className="w-full aspect-auto"
            />
          </ContentSwitch>
        </CardContent>
      </Card>
    );
  },
);
