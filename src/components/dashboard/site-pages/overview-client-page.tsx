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
import { MetricCard } from "@/components/dashboard/metric-card";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { EngagementChart } from "@/components/dashboard/engagement-chart";
import { TopItemsChart } from "@/components/dashboard/top-items-chart";
import { DistributionDonutChart } from "@/components/dashboard/distribution-donut-chart";
import { SessionDurationChart } from "@/components/dashboard/session-duration-chart";
import { RealtimePanel } from "@/components/dashboard/realtime-panel";
import { durationFormat, numberFormat, percentFormat, shortDateTime } from "@/lib/dashboard/format";
import { loadFilterOptions, loadOverviewBundle, type FilterOptions, type OverviewBundle } from "@/lib/dashboard/client-data";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";

interface OverviewClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

function toDeltaPercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function emptyOverviewBundle(interval: "hour" | "day"): OverviewBundle {
  return {
    overview: {
      ok: true,
      data: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        bounceRate: 0,
        approximateVisitors: false,
      },
    },
    previousOverview: {
      ok: true,
      data: {
        views: 0,
        sessions: 0,
        visitors: 0,
        bounces: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        bounceRate: 0,
        approximateVisitors: false,
      },
    },
    trend: {
      ok: true,
      interval,
      data: [],
    },
    pages: { ok: true, data: [] },
    referrers: { ok: true, data: [] },
    sessions: { ok: true, data: [] },
    events: { ok: true, data: [] },
    countries: { ok: true, data: [] },
    devices: { ok: true, data: [] },
    browsers: { ok: true, data: [] },
    eventTypes: { ok: true, data: [] },
  };
}

const EMPTY_FILTER_OPTIONS: FilterOptions = {
  countries: [],
  devices: [],
  browsers: [],
  eventTypes: [],
};

export function OverviewClientPage({ locale, messages, siteId, pathname }: OverviewClientPageProps) {
  const { range, filters, window } = useDashboardQuery();
  const [bundle, setBundle] = useState<OverviewBundle | null>(null);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>(EMPTY_FILTER_OPTIONS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    Promise.all([
      loadOverviewBundle(siteId, window, filters),
      loadFilterOptions(siteId, window),
    ])
      .then(([nextBundle, nextFilterOptions]) => {
        if (!active) return;
        setBundle(nextBundle);
        setFilterOptions(nextFilterOptions);
      })
      .catch(() => {
        if (!active) return;
        setBundle(emptyOverviewBundle(window.interval));
        setFilterOptions(EMPTY_FILTER_OPTIONS);
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

  const data = useMemo(
    () => bundle ?? emptyOverviewBundle(window.interval),
    [bundle, window.interval],
  );

  const previous = data.previousOverview.data;
  const emptyText = loading ? messages.common.loading : messages.common.noData;

  const eventTypeItems = data.eventTypes.data.map((item) => ({
    label: item.value || messages.common.unknown,
    value: item.views,
  }));

  const metrics = [
    {
      label: messages.common.views,
      value: numberFormat(locale, data.overview.data.views),
      delta: toDeltaPercent(data.overview.data.views, previous.views),
    },
    {
      label: messages.common.sessions,
      value: numberFormat(locale, data.overview.data.sessions),
      delta: toDeltaPercent(data.overview.data.sessions, previous.sessions),
    },
    {
      label: messages.common.visitors,
      value: numberFormat(locale, data.overview.data.visitors),
      delta: toDeltaPercent(data.overview.data.visitors, previous.visitors),
    },
    {
      label: messages.common.bounceRate,
      value: percentFormat(locale, data.overview.data.bounceRate),
      delta: toDeltaPercent(data.overview.data.bounceRate, previous.bounceRate),
      inverted: true,
    },
    {
      label: messages.common.avgDuration,
      value: durationFormat(locale, data.overview.data.avgDurationMs),
      delta: toDeltaPercent(data.overview.data.avgDurationMs, previous.avgDurationMs),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.overview.title}
        subtitle={messages.overview.subtitle}
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

      <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
        {metrics.map((item) => (
          <MetricCard
            key={item.label}
            label={item.label}
            value={item.value}
            delta={item.delta}
            inverted={item.inverted}
          />
        ))}
      </section>

      <RealtimePanel siteId={siteId} locale={locale} messages={messages} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{messages.overview.trendTitle}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {messages.common.lastUpdated}: {shortDateTime(locale, Date.now())}
          </span>
        </CardHeader>
        <CardContent>
          {data.trend.data.length > 0 ? (
            <TrendChart
              locale={locale}
              data={data.trend.data}
              viewsLabel={messages.common.views}
              sessionsLabel={messages.common.sessions}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.engagementTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.trend.data.length > 0 ? (
              <EngagementChart
                locale={locale}
                data={data.trend.data}
                viewsLabel={messages.common.views}
                sessionsLabel={messages.common.sessions}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{emptyText}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.compositionTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <DistributionDonutChart
              items={[
                { label: messages.common.views, value: data.overview.data.views },
                { label: messages.common.sessions, value: data.overview.data.sessions },
                { label: messages.common.visitors, value: data.overview.data.visitors },
                { label: messages.common.bounces, value: data.overview.data.bounces },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.eventTypesTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {eventTypeItems.length > 0 ? (
              <DistributionDonutChart items={eventTypeItems} />
            ) : (
              <p className="text-sm text-muted-foreground">{emptyText}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.sessionDurationTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.sessions.data.length > 0 ? (
              <SessionDurationChart
                durationsMs={data.sessions.data.map((item) => item.totalDurationMs)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{emptyText}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{messages.navigation.geo}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.countries.data.length > 0 ? (
              <TopItemsChart
                valueLabel={messages.common.views}
                items={data.countries.data.map((item) => ({
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
            <CardTitle>{messages.navigation.devices}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.devices.data.length > 0 ? (
              <DistributionDonutChart
                items={data.devices.data.map((item) => ({
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
            <CardTitle>{messages.navigation.browsers}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.browsers.data.length > 0 ? (
              <DistributionDonutChart
                items={data.browsers.data.map((item) => ({
                  label: item.value || messages.common.unknown,
                  value: item.views,
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{emptyText}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
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
                {data.pages.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {emptyText}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.pages.data.map((item) => (
                    <TableRow key={`${item.pathname}-${item.views}`}>
                      <TableCell className="max-w-[260px] truncate font-mono">
                        {item.pathname || "/"}
                      </TableCell>
                      <TableCell className="text-right">{numberFormat(locale, item.views)}</TableCell>
                      <TableCell className="text-right">{numberFormat(locale, item.sessions)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.topReferrers}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{messages.common.referrer}</TableHead>
                  <TableHead className="text-right">{messages.common.views}</TableHead>
                  <TableHead className="text-right">{messages.common.sessions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.referrers.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {emptyText}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.referrers.data.map((item) => (
                    <TableRow key={`${item.referrer}-${item.views}`}>
                      <TableCell className="max-w-[260px] truncate font-mono">
                        {item.referrer || messages.common.unknown}
                      </TableCell>
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.recentSessions}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{messages.common.startedAt}</TableHead>
                  <TableHead className="text-right">{messages.common.views}</TableHead>
                  <TableHead className="text-right">{messages.common.duration}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sessions.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {emptyText}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.sessions.data.map((session) => (
                    <TableRow key={session.sessionId}>
                      <TableCell>{shortDateTime(locale, session.startedAt)}</TableCell>
                      <TableCell className="text-right">{numberFormat(locale, session.views)}</TableCell>
                      <TableCell className="text-right">
                        {durationFormat(locale, session.totalDurationMs)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{messages.overview.recentEvents}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{messages.common.event}</TableHead>
                  <TableHead>{messages.common.page}</TableHead>
                  <TableHead className="text-right">{messages.common.startedAt}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.events.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {emptyText}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.events.data.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>{event.eventType || messages.common.unknown}</TableCell>
                      <TableCell className="max-w-[220px] truncate font-mono">
                        {event.pathname || "/"}
                      </TableCell>
                      <TableCell className="text-right">
                        {shortDateTime(locale, event.eventAt)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
