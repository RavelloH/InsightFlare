import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { DataTableSwitch } from "@insightflare/ui/data-table-switch";
import { TableCell, TableHead, TableRow } from "@insightflare/ui/table";

import type { Locale } from "@/lib/i18n/config";

import {
  categoryLabel,
  type ErrorsData,
  formatCount,
  type InvocationErrorAggregate,
  type PerformanceCopy,
  type PerformanceResponse,
} from "./model";
import { ResultBadge, rowActivation } from "./parts";

export function ErrorsView({
  locale,
  copy,
  response,
  loading,
  onSelect,
}: {
  locale: Locale;
  copy: PerformanceCopy;
  response: PerformanceResponse<ErrorsData> | undefined;
  loading: boolean;
  onSelect: (error: InvocationErrorAggregate) => void;
}) {
  const rows = response?.data?.errors ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.errors.title}</CardTitle>
        <CardDescription>{copy.errors.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTableSwitch
          loading={loading}
          hasContent={rows.length > 0}
          loadingLabel={copy.loading}
          emptyLabel={copy.errors.empty}
          colSpan={5}
          loadingRowCount={5}
          header={
            <TableRow>
              <TableHead>{copy.columns.errorCode}</TableHead>
              <TableHead>{copy.columns.result}</TableHead>
              <TableHead>{copy.columns.category}</TableHead>
              <TableHead>{copy.columns.route}</TableHead>
              <TableHead className="text-right">
                {copy.columns.invocations}
              </TableHead>
            </TableRow>
          }
          rows={rows.map((row) => (
            <TableRow
              key={`${row.code ?? ""}:${row.operation ?? ""}:${row.resultClass}:${row.routeKey}:${row.source}:${row.trigger}:${row.appVersion ?? ""}`}
              {...rowActivation(() => onSelect(row))}
            >
              <TableCell className="max-w-72">
                <div className="truncate font-mono text-xs">
                  {row.code ?? copy.emptyValue}
                </div>
                {row.operation ? (
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {row.operation}
                  </div>
                ) : null}
              </TableCell>
              <TableCell>
                <ResultBadge copy={copy} result={row.resultClass} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {categoryLabel(copy, row.category)}
              </TableCell>
              <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground">
                {row.routeKey}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCount(locale, row.estimatedInvocations)}
              </TableCell>
            </TableRow>
          ))}
        />
      </CardContent>
    </Card>
  );
}
