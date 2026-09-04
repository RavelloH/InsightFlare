import type { ReactNode } from "react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface DataTableSwitchProps {
  loading: boolean;
  hasContent: boolean;
  loadingLabel: string;
  emptyLabel: string;
  colSpan: number;
  header: ReactNode;
  rows: ReactNode;
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
  header,
  rows,
  footer,
  contentKey,
  animate = true,
}: DataTableSwitchProps) {
  const table = loading ? (
    <Table key="loading">
      <TableHeader>{header}</TableHeader>
      <TableBody>
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
      </TableBody>
    </Table>
  ) : hasContent ? (
    <Table key={contentKey ?? "content"}>
      <TableHeader>{header}</TableHeader>
      <TableBody>
        {rows}
        {footer}
      </TableBody>
    </Table>
  ) : (
    <Table key="empty">
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
