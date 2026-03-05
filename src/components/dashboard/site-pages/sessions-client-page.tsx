"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { PageHeading } from "@/components/dashboard/page-heading";
import { TopItemsChart } from "@/components/dashboard/top-items-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import {
  emptyPageCardTabsData,
  fetchPageCardTabs,
  type PageCardTabsData,
} from "@/lib/dashboard/client-data";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";

interface SessionsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

interface SessionPathRow {
  label: string;
  views: number;
  sessions: number;
}

export function SessionsClientPage({ locale, messages, siteId }: SessionsClientPageProps) {
  const { filters, window } = useDashboardQuery();
  const [tabsData, setTabsData] = useState<PageCardTabsData>(emptyPageCardTabsData());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setTabsData(emptyPageCardTabsData());

    fetchPageCardTabs(siteId, window, filters)
      .catch(() => emptyPageCardTabsData())
      .then((nextTabs) => {
        if (!active) return;
        setTabsData(nextTabs);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    siteId,
    window.from,
    window.to,
    window.interval,
    filters.country,
    filters.device,
    filters.browser,
    filters.eventType,
  ]);

  const noDataText = messages.common.noData;

  const entryRows = useMemo<SessionPathRow[]>(
    () =>
      tabsData.entry.map((item) => ({
        label: String(item.label || "").trim() || "/",
        views: Math.max(0, Number(item.views || 0)),
        sessions: Math.max(0, Number(item.sessions || 0)),
      })),
    [tabsData.entry],
  );

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.sessions.title}
        subtitle={messages.sessions.subtitle}
      />

      <Card>
        <CardHeader>
          <CardTitle>{messages.common.entryPage}</CardTitle>
        </CardHeader>
        <CardContent>
          <ContentSwitch
            loading={loading}
            hasContent={entryRows.length > 0}
            loadingLabel={messages.common.loading}
            emptyContent={<p>{noDataText}</p>}
          >
            <TopItemsChart
              valueLabel={messages.common.views}
              items={entryRows.map((item) => ({
                label: item.label,
                value: item.views,
              }))}
            />
          </ContentSwitch>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.sessions.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={loading}
            hasContent={entryRows.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={3}
            header={(
              <TableRow>
                <TableHead>{messages.common.entryPage}</TableHead>
                <TableHead className="text-right">{messages.common.views}</TableHead>
                <TableHead className="text-right">{messages.common.sessions}</TableHead>
              </TableRow>
            )}
            rows={entryRows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className="max-w-[220px] truncate font-mono">{row.label}</TableCell>
                <TableCell className="text-right">{numberFormat(locale, row.views)}</TableCell>
                <TableCell className="text-right">{numberFormat(locale, row.sessions)}</TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
