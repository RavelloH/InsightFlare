"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeading } from "@/components/dashboard/page-heading";
import { RangeLinks } from "@/components/dashboard/range-links";
import { FilterControls } from "@/components/dashboard/filter-controls";
import { TopItemsChart } from "@/components/dashboard/top-items-chart";
import { fetchPages, loadFilterOptions, type FilterOptions, emptyPagesData } from "@/lib/dashboard/client-data";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { PagesData } from "@/lib/edge-client";

interface PagesClientPageProps {
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

export function PagesClientPage({ locale, messages, siteId, pathname }: PagesClientPageProps) {
  const { range, filters, window } = useDashboardQuery();
  const [pages, setPages] = useState<PagesData>(emptyPagesData());
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      fetchPages(siteId, window, filters).catch(() => emptyPagesData()),
      loadFilterOptions(siteId, window).catch(() => EMPTY_FILTER_OPTIONS),
    ])
      .then(([nextPages, nextFilterOptions]) => {
        if (!active) return;
        setPages(nextPages);
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

  const emptyText = loading ? messages.common.loading : messages.common.noData;

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.pages.title}
        subtitle={messages.pages.subtitle}
        actions={(
          <>
            <RangeLinks pathname={pathname} activeRange={range} messages={messages} filters={filters} />
            <FilterControls
              pathname={pathname}
              range={range}
              filters={filters}
              options={filterOptions}
              messages={messages}
            />
          </>
        )}
      />

      <Card>
        <CardHeader>
          <CardTitle>{messages.pages.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {pages.data.length > 0 ? (
            <TopItemsChart
              valueLabel={messages.common.views}
              items={pages.data.map((item) => ({
                label: item.pathname || "/",
                value: item.views,
              }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.overview.topPages}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{messages.common.page}</TableHead>
                <TableHead className="text-right">{messages.common.views}</TableHead>
                <TableHead className="text-right">{messages.common.sessions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pages.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    {emptyText}
                  </TableCell>
                </TableRow>
              ) : (
                pages.data.map((item) => (
                  <TableRow key={`${item.pathname}-${item.views}`}>
                    <TableCell className="max-w-[420px] truncate font-mono">{item.pathname || "/"}</TableCell>
                    <TableCell className="text-right">{numberFormat(locale, item.views)}</TableCell>
                    <TableCell className="text-right">{numberFormat(locale, item.sessions)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
