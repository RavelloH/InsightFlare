import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { DataTableSwitch } from "@insightflare/ui/data-table-switch";
import { TableCell, TableHead, TableRow } from "@insightflare/ui/table";

import { shortDateTimeWithSeconds } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";

import {
  formatMs,
  type InvocationSample,
  type PerformanceCopy,
  type PerformanceResponse,
  type SamplesData,
  sourceLabel,
  triggerLabel,
} from "./model";
import { ResultBadge, rowActivation } from "./parts";

export function SamplesView({
  locale,
  timeZone,
  copy,
  response,
  loading,
  onSelect,
}: {
  locale: Locale;
  timeZone: string;
  copy: PerformanceCopy;
  response: PerformanceResponse<SamplesData> | undefined;
  loading: boolean;
  onSelect: (sample: InvocationSample) => void;
}) {
  const rows = response?.data?.samples ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.samples.title}</CardTitle>
        <CardDescription>{copy.samples.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTableSwitch
          loading={loading}
          hasContent={rows.length > 0}
          loadingLabel={copy.loading}
          emptyLabel={copy.samples.empty}
          colSpan={7}
          loadingRowCount={8}
          header={
            <TableRow>
              <TableHead>{copy.columns.time}</TableHead>
              <TableHead>{copy.columns.route}</TableHead>
              <TableHead>{copy.columns.source}</TableHead>
              <TableHead>{copy.columns.result}</TableHead>
              <TableHead>{copy.columns.dominantPhase}</TableHead>
              <TableHead className="text-right">
                {copy.columns.handler}
              </TableHead>
              <TableHead className="text-right">
                {copy.columns.duration}
              </TableHead>
            </TableRow>
          }
          rows={rows.map((row, index) => (
            <TableRow
              key={`${row.timestampSeconds}:${row.routeKey}:${index}`}
              {...rowActivation(() => onSelect(row))}
            >
              <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                {shortDateTimeWithSeconds(
                  locale,
                  row.timestampSeconds * 1000,
                  timeZone,
                )}
              </TableCell>
              <TableCell className="max-w-64 truncate font-mono text-xs">
                {row.routeKey}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {sourceLabel(copy, row.source)}
                {row.trigger !== "request"
                  ? ` · ${triggerLabel(copy, row.trigger)}`
                  : ""}
              </TableCell>
              <TableCell>
                <ResultBadge copy={copy} result={row.resultClass} />
              </TableCell>
              <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground">
                {row.dominantPhase ?? copy.emptyValue}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMs(locale, row.handlerWallMs)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {formatMs(locale, row.invocationWallMs)}
              </TableCell>
            </TableRow>
          ))}
        />
      </CardContent>
    </Card>
  );
}
