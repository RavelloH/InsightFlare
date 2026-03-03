"use client";

import { useEffect, useState } from "react";
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
import { fetchVisitors, loadFilterOptions, type FilterOptions, emptyVisitorsData } from "@/lib/dashboard/client-data";
import { numberFormat, shortDateTime } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { VisitorsData } from "@/lib/edge-client";

interface VisitorsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

const EMPTY_FILTER_OPTIONS: FilterOptions = {
  countries: [],
  devices: [],
  browsers: [],
  eventTypes: [],
};

export function VisitorsClientPage({ locale, messages, siteId, pathname }: VisitorsClientPageProps) {
  const { range, filters, window } = useDashboardQuery();
  const [visitors, setVisitors] = useState<VisitorsData>(emptyVisitorsData());
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      fetchVisitors(siteId, window, filters).catch(() => emptyVisitorsData()),
      loadFilterOptions(siteId, window).catch(() => EMPTY_FILTER_OPTIONS),
    ])
      .then(([nextVisitors, nextFilterOptions]) => {
        if (!active) return;
        setVisitors(nextVisitors);
        setFilterOptions(nextFilterOptions);
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

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.visitors.title}
        subtitle={messages.visitors.subtitle}
      />

      <Card>
        <CardHeader>
          <CardTitle>{messages.visitors.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <ContentSwitch
            loading={loading}
            hasContent={visitors.data.length > 0}
            loadingLabel={messages.common.loading}
            emptyContent={<p>{noDataText}</p>}
          >
            <TopItemsChart
              valueLabel={messages.common.views}
              items={visitors.data.map((item) => ({
                label: item.visitorId.slice(0, 12),
                value: item.views,
              }))}
            />
          </ContentSwitch>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.visitors.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={loading}
            hasContent={visitors.data.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={5}
            header={(
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>{messages.common.startedAt}</TableHead>
                <TableHead>{messages.common.endedAt}</TableHead>
                <TableHead className="text-right">{messages.common.views}</TableHead>
                <TableHead className="text-right">{messages.common.sessions}</TableHead>
              </TableRow>
            )}
            rows={visitors.data.map((item) => (
              <TableRow key={item.visitorId}>
                <TableCell className="max-w-[220px] truncate font-mono">{item.visitorId}</TableCell>
                <TableCell>{shortDateTime(locale, item.firstSeenAt)}</TableCell>
                <TableCell>{shortDateTime(locale, item.lastSeenAt)}</TableCell>
                <TableCell className="text-right">{numberFormat(locale, item.views)}</TableCell>
                <TableCell className="text-right">{numberFormat(locale, item.sessions)}</TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
