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
import { fetchSessions, loadFilterOptions, type FilterOptions, emptySessionsData } from "@/lib/dashboard/client-data";
import { durationFormat, numberFormat, shortDateTime } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { SessionsData } from "@/lib/edge-client";

interface SessionsClientPageProps {
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

export function SessionsClientPage({ locale, messages, siteId, pathname }: SessionsClientPageProps) {
  const { range, filters, window } = useDashboardQuery();
  const [sessions, setSessions] = useState<SessionsData>(emptySessionsData());
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      fetchSessions(siteId, window, filters).catch(() => emptySessionsData()),
      loadFilterOptions(siteId, window).catch(() => EMPTY_FILTER_OPTIONS),
    ])
      .then(([nextSessions, nextFilterOptions]) => {
        if (!active) return;
        setSessions(nextSessions);
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
        title={messages.sessions.title}
        subtitle={messages.sessions.subtitle}
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
          <CardTitle>{messages.sessions.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.data.length > 0 ? (
            <TopItemsChart
              valueLabel={messages.common.duration}
              items={sessions.data.map((item) => ({
                label: item.sessionId.slice(0, 8),
                value: item.totalDurationMs,
              }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.sessions.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{messages.common.startedAt}</TableHead>
                <TableHead>{messages.common.endedAt}</TableHead>
                <TableHead className="text-right">{messages.common.views}</TableHead>
                <TableHead className="text-right">{messages.common.duration}</TableHead>
                <TableHead className="text-right">{messages.common.page}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {emptyText}
                  </TableCell>
                </TableRow>
              ) : (
                sessions.data.map((item) => (
                  <TableRow key={item.sessionId}>
                    <TableCell>{shortDateTime(locale, item.startedAt)}</TableCell>
                    <TableCell>{shortDateTime(locale, item.endedAt)}</TableCell>
                    <TableCell className="text-right">{numberFormat(locale, item.views)}</TableCell>
                    <TableCell className="text-right">{durationFormat(locale, item.totalDurationMs)}</TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-right">
                      {item.entryPath || "/"}
                    </TableCell>
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
