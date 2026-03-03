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
import { DistributionDonutChart } from "@/components/dashboard/distribution-donut-chart";
import { fetchBrowsers, loadFilterOptions, type FilterOptions, emptyDimensionData } from "@/lib/dashboard/client-data";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { DimensionData } from "@/lib/edge-client";

interface BrowsersClientPageProps {
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

export function BrowsersClientPage({ locale, messages, siteId, pathname }: BrowsersClientPageProps) {
  const { range, filters, window } = useDashboardQuery();
  const [browsers, setBrowsers] = useState<DimensionData>(emptyDimensionData());
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      fetchBrowsers(siteId, window, filters).catch(() => emptyDimensionData()),
      loadFilterOptions(siteId, window).catch(() => EMPTY_FILTER_OPTIONS),
    ])
      .then(([nextBrowsers, nextFilterOptions]) => {
        if (!active) return;
        setBrowsers(nextBrowsers);
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
        title={messages.browsers.title}
        subtitle={messages.browsers.subtitle}
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
          <CardTitle>{messages.browsers.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {browsers.data.length > 0 ? (
            <DistributionDonutChart
              items={browsers.data.map((item) => ({
                label: item.value || messages.common.unknown,
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
          <CardTitle>{messages.browsers.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{messages.common.browser}</TableHead>
                <TableHead className="text-right">{messages.common.views}</TableHead>
                <TableHead className="text-right">{messages.common.sessions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {browsers.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    {emptyText}
                  </TableCell>
                </TableRow>
              ) : (
                browsers.data.map((item) => (
                  <TableRow key={`${item.value}-${item.views}`}>
                    <TableCell>{item.value || messages.common.unknown}</TableCell>
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
