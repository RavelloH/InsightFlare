import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { DataTableSwitch } from "@insightflare/ui/data-table-switch";
import { TableCell, TableHead, TableRow } from "@insightflare/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@insightflare/ui/tabs";

import type { Locale } from "@/lib/i18n/config";

import {
  formatCount,
  formatHotspotValue,
  type HotspotsData,
  type InvocationHotspot,
  type PerformanceCopy,
  type PerformanceResponse,
} from "./model";
import { rowActivation } from "./parts";
import {
  PERFORMANCE_KINDS,
  type PerformanceKind,
} from "./performance-url-state";

export function HotspotsView({
  locale,
  copy,
  kind,
  onKindChange,
  response,
  loading,
  onSelect,
}: {
  locale: Locale;
  copy: PerformanceCopy;
  kind: PerformanceKind;
  onKindChange: (kind: PerformanceKind) => void;
  response: PerformanceResponse<HotspotsData> | undefined;
  loading: boolean;
  onSelect: (hotspot: InvocationHotspot) => void;
}) {
  const rows = response?.data?.hotspots?.[kind] ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.hotspots.title}</CardTitle>
        <CardDescription>
          {copy.hotspots.kindDescriptions[kind]}
        </CardDescription>
        <CardAction>
          <Tabs
            value={kind}
            onValueChange={(value) => onKindChange(value as PerformanceKind)}
          >
            <TabsList>
              {PERFORMANCE_KINDS.map((item) => (
                <TabsTrigger key={item} value={item} className="px-3">
                  {copy.hotspots.kinds[item]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        <DataTableSwitch
          loading={loading}
          hasContent={rows.length > 0}
          loadingLabel={copy.loading}
          emptyLabel={copy.hotspots.empty}
          colSpan={5}
          loadingRowCount={6}
          contentKey={kind}
          header={
            <TableRow>
              <TableHead>{copy.columns.query}</TableHead>
              <TableHead>{copy.columns.route}</TableHead>
              <TableHead className="text-right">
                {copy.columns.invocations}
              </TableHead>
              <TableHead className="text-right">{copy.columns.total}</TableHead>
              <TableHead className="text-right">
                {copy.columns.average}
              </TableHead>
            </TableRow>
          }
          rows={rows.map((row) => (
            <TableRow
              key={`${row.queryId}:${row.routeKey}:${row.appVersion ?? ""}:${row.filterShape ?? ""}:${row.variant ?? ""}`}
              {...rowActivation(() => onSelect(row))}
            >
              <TableCell className="max-w-80">
                <div className="truncate font-mono text-xs">{row.queryId}</div>
                {row.filterShape || row.variant ? (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {[row.variant, row.filterShape].filter(Boolean).join(" · ")}
                  </div>
                ) : null}
              </TableCell>
              <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground">
                {row.routeKey}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCount(locale, row.estimatedInvocations)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {formatHotspotValue(locale, kind, row.weightedValue)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {formatHotspotValue(
                  locale,
                  kind,
                  row.estimatedInvocations > 0
                    ? row.weightedValue / row.estimatedInvocations
                    : null,
                )}
              </TableCell>
            </TableRow>
          ))}
        />
      </CardContent>
    </Card>
  );
}
