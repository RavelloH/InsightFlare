import type { ReactNode } from "react";
import {
  AnalyticsDataTable as ProductAnalyticsDataTable,
  type AnalyticsDataTableProps as ProductAnalyticsDataTableProps,
} from "@insightflare/product-ui/tables";

import { AnalyticsTimeTooltipProvider } from "@/components/dashboard/analytics-time-tooltip";
import type { AppMessages } from "@/lib/i18n/messages";

export type {
  AnalyticsDataTableRow,
  AnalyticsDataTableProps as ProductAnalyticsDataTableProps,
} from "@insightflare/product-ui/tables";

export interface AnalyticsDataTableProps<
  TRow,
> extends ProductAnalyticsDataTableProps<TRow> {
  enableTimeTooltips?: boolean;
  messages?: AppMessages;
}

/** App adapter for localized analytics-time tooltips around the package table. */
export function AnalyticsDataTable<TRow>({
  enableTimeTooltips = false,
  messages,
  ...tableProps
}: AnalyticsDataTableProps<TRow>) {
  const table = <ProductAnalyticsDataTable {...tableProps} />;
  const content: ReactNode =
    enableTimeTooltips && messages ? (
      <AnalyticsTimeTooltipProvider messages={messages}>
        {table}
      </AnalyticsTimeTooltipProvider>
    ) : (
      table
    );

  return content;
}
