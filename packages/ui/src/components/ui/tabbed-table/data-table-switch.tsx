import type { ReactNode } from "react";

import { AutoResizer } from "../auto-resizer";
import { AutoTransition } from "../auto-transition";
import { Skeleton } from "../skeleton";
import { Spinner } from "../spinner";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "../table";
interface DataTableSwitchProps {
  loading: boolean;
  hasContent: boolean;
  loadingLabel: string;
  emptyLabel: string;
  colSpan: number;
  loadingRowCount?: number;
  header: ReactNode;
  rows: ReactNode;
  loadingRows?: ReactNode;
  footer?: ReactNode;
  contentKey?: string | number;
  animate?: boolean;
}
export function DataTableSwitch({
  loading,
  hasContent,
  loadingLabel,
  emptyLabel,
  colSpan,
  loadingRowCount,
  header,
  rows,
  loadingRows,
  footer,
  contentKey,
  animate = true,
}: DataTableSwitchProps) {
  const viewKey = String(contentKey ?? "default");
  const generatedLoadingRows = loadingRowCount ? (
    <TabbedDataTableSkeletonRows
      count={loadingRowCount}
      colSpan={colSpan}
      keyPrefix={`loading-${viewKey}`}
    />
  ) : null;
  const table = loading ? (
    <Table key={`loading-${viewKey}`}>
      <TableHeader>{header}</TableHeader>
      <TableBody>
        {loadingRows ?? generatedLoadingRows ?? (
          <TableRow>
            <TableCell
              colSpan={colSpan}
              className="h-32 text-center text-muted-foreground"
            >
              <span className="inline-flex items-center gap-2">
                <Spinner className="size-4" />
                {loadingLabel}
              </span>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  ) : hasContent ? (
    <Table key={`content-${viewKey}`}>
      <TableHeader>{header}</TableHeader>
      <TableBody>
        {rows}
        {footer}
      </TableBody>
    </Table>
  ) : (
    <Table key={`empty-${viewKey}`}>
      <TableHeader>{header}</TableHeader>
      <TableBody>
        <TableRow>
          <TableCell
            colSpan={colSpan}
            className="h-24 text-center text-muted-foreground"
          >
            {emptyLabel}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );

  if (!animate) return table;

  return (
    <AutoResizer initial>
      <AutoTransition initial>{table}</AutoTransition>
    </AutoResizer>
  );
}

interface TabbedDataTableSkeletonRowsProps {
  count: number;
  colSpan: number;
  keyPrefix: string;
  statusLabel?: string;
}

export function TabbedDataTableSkeletonRows({
  count,
  colSpan,
  keyPrefix,
  statusLabel,
}: TabbedDataTableSkeletonRowsProps) {
  return (
    <>
      {Array.from({ length: Math.max(0, count) }, (_, rowIndex) => (
        <TableRow
          key={`${keyPrefix}-${rowIndex}`}
          aria-hidden={statusLabel && rowIndex === 0 ? undefined : true}
          className="pointer-events-none hover:bg-transparent"
        >
          <TableCell className="whitespace-normal p-0 align-top">
            <div className="px-4 py-2 leading-5">
              {statusLabel && rowIndex === 0 ? (
                <span className="sr-only" role="status" aria-live="polite">
                  {statusLabel}
                </span>
              ) : null}
              <Skeleton
                aria-hidden="true"
                className={`h-5 ${rowIndex % 3 === 1 ? "w-[72%]" : "w-[58%]"}`}
              />
            </div>
          </TableCell>
          {Array.from(
            { length: Math.max(0, colSpan - 1) },
            (_, columnIndex) => (
              <TableCell key={columnIndex} className="p-0">
                <div
                  className={`flex justify-end px-2 py-2 ${columnIndex === colSpan - 2 ? "px-4" : ""}`}
                >
                  <Skeleton aria-hidden="true" className="h-4 w-14" />
                </div>
              </TableCell>
            ),
          )}
        </TableRow>
      ))}
    </>
  );
}
