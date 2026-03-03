"use client";

import { useEffect, useMemo, useState } from "react";
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
import { fetchEvents, loadFilterOptions, type FilterOptions, emptyEventsData } from "@/lib/dashboard/client-data";
import { durationFormat, shortDateTime } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { EventsData } from "@/lib/edge-client";

interface EventsClientPageProps {
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

export function EventsClientPage({ locale, messages, siteId, pathname }: EventsClientPageProps) {
  const { range, filters, window } = useDashboardQuery();
  const [events, setEvents] = useState<EventsData>(emptyEventsData());
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      fetchEvents(siteId, window, filters).catch(() => emptyEventsData()),
      loadFilterOptions(siteId, window).catch(() => EMPTY_FILTER_OPTIONS),
    ])
      .then(([nextEvents, nextFilterOptions]) => {
        if (!active) return;
        setEvents(nextEvents);
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

  const eventTypeItems = useMemo(() => {
    const eventCountMap = new Map<string, number>();
    for (const item of events.data) {
      const key = item.eventType || messages.common.unknown;
      eventCountMap.set(key, (eventCountMap.get(key) || 0) + 1);
    }
    return [...eventCountMap.entries()].map(([label, value]) => ({ label, value }));
  }, [events.data, messages.common.unknown]);

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.events.title}
        subtitle={messages.events.subtitle}
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
          <CardTitle>{messages.events.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {eventTypeItems.length > 0 ? (
            <TopItemsChart valueLabel={messages.common.event} items={eventTypeItems} />
          ) : (
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.events.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{messages.common.startedAt}</TableHead>
                <TableHead>{messages.common.event}</TableHead>
                <TableHead>{messages.common.page}</TableHead>
                <TableHead>{messages.common.location}</TableHead>
                <TableHead>{messages.common.browser}</TableHead>
                <TableHead className="text-right">{messages.common.duration}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {emptyText}
                  </TableCell>
                </TableRow>
              ) : (
                events.data.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>{shortDateTime(locale, event.eventAt)}</TableCell>
                    <TableCell>{event.eventType || messages.common.unknown}</TableCell>
                    <TableCell className="max-w-[260px] truncate font-mono">{event.pathname || "/"}</TableCell>
                    <TableCell>
                      {[event.country, event.region, event.city].filter(Boolean).join(" / ") || messages.common.unknown}
                    </TableCell>
                    <TableCell>{event.browser || messages.common.unknown}</TableCell>
                    <TableCell className="text-right">
                      {durationFormat(locale, event.durationMs)}
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
