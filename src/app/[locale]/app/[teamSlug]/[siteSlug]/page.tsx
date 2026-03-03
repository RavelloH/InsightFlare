import { notFound } from "next/navigation";
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
import {
  buildSitePath,
  getTeamSiteContext,
  loadFilterOptions,
  loadOverviewBundle,
  parseDashboardFilters,
  resolveTimeWindow,
} from "@/lib/dashboard/server";
import { durationFormat, numberFormat, percentFormat, shortDateTime } from "@/lib/dashboard/format";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface OverviewPageProps {
  params: Promise<{
    locale: string;
    teamSlug: string;
    siteSlug: string;
  }>;
  searchParams: Promise<{
    range?: string | string[];
    country?: string | string[];
    device?: string | string[];
    browser?: string | string[];
    eventType?: string | string[];
  }>;
}

function toDeltaPercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export default async function OverviewPage({ params, searchParams }: OverviewPageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const search = await searchParams;
  const resolvedLocale = resolveLocale(locale);
  const t = getMessages(resolvedLocale);
  const window = resolveTimeWindow(search.range);
  const filters = parseDashboardFilters(search);

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  const [data, filterOptions] = await Promise.all([
    loadOverviewBundle(context.activeSite.id, window, filters),
    loadFilterOptions(context.activeSite.id, window),
  ]);
  const path = buildSitePath(resolvedLocale, context.activeTeam.slug, context.activeSite.slug);
  const previous = data.previousOverview.data;

  const eventTypeItems = data.eventTypes.data.map((item) => ({
    label: item.value || t.common.unknown,
    value: item.views,
  }));

  const metrics = [
    {
      label: t.common.views,
      value: numberFormat(resolvedLocale, data.overview.data.views),
      delta: toDeltaPercent(data.overview.data.views, previous.views),
    },
    {
      label: t.common.sessions,
      value: numberFormat(resolvedLocale, data.overview.data.sessions),
      delta: toDeltaPercent(data.overview.data.sessions, previous.sessions),
    },
    {
      label: t.common.visitors,
      value: numberFormat(resolvedLocale, data.overview.data.visitors),
      delta: toDeltaPercent(data.overview.data.visitors, previous.visitors),
    },
    {
      label: t.common.bounceRate,
      value: percentFormat(resolvedLocale, data.overview.data.bounceRate),
      delta: toDeltaPercent(data.overview.data.bounceRate, previous.bounceRate),
      inverted: true,
    },
    {
      label: t.common.avgDuration,
      value: durationFormat(resolvedLocale, data.overview.data.avgDurationMs),
      delta: toDeltaPercent(data.overview.data.avgDurationMs, previous.avgDurationMs),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeading
        title={t.overview.title}
        subtitle={t.overview.subtitle}
        actions={(
          <>
            <RangeLinks pathname={path} activeRange={window.preset} messages={t} filters={filters} />
            <FilterControls
              pathname={path}
              range={window.preset}
              filters={filters}
              options={filterOptions}
              messages={t}
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

      <RealtimePanel siteId={context.activeSite.id} locale={resolvedLocale} messages={t} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t.overview.trendTitle}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {t.common.lastUpdated}: {shortDateTime(resolvedLocale, Date.now())}
          </span>
        </CardHeader>
        <CardContent>
          {data.trend.data.length > 0 ? (
            <TrendChart
              locale={resolvedLocale}
              data={data.trend.data}
              viewsLabel={t.common.views}
              sessionsLabel={t.common.sessions}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t.common.noData}</p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t.overview.engagementTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.trend.data.length > 0 ? (
              <EngagementChart
                locale={resolvedLocale}
                data={data.trend.data}
                viewsLabel={t.common.views}
                sessionsLabel={t.common.sessions}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t.common.noData}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.overview.compositionTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <DistributionDonutChart
              items={[
                { label: t.common.views, value: data.overview.data.views },
                { label: t.common.sessions, value: data.overview.data.sessions },
                { label: t.common.visitors, value: data.overview.data.visitors },
                { label: t.common.bounces, value: data.overview.data.bounces },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t.overview.eventTypesTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {eventTypeItems.length > 0 ? (
              <DistributionDonutChart items={eventTypeItems} />
            ) : (
              <p className="text-sm text-muted-foreground">{t.common.noData}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.overview.sessionDurationTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.sessions.data.length > 0 ? (
              <SessionDurationChart
                durationsMs={data.sessions.data.map((item) => item.totalDurationMs)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t.common.noData}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t.navigation.geo}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.countries.data.length > 0 ? (
              <TopItemsChart
                valueLabel={t.common.views}
                items={data.countries.data.map((item) => ({
                  label: item.value || t.common.unknown,
                  value: item.views,
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t.common.noData}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.navigation.devices}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.devices.data.length > 0 ? (
              <DistributionDonutChart
                items={data.devices.data.map((item) => ({
                  label: item.value || t.common.unknown,
                  value: item.views,
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t.common.noData}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.navigation.browsers}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.browsers.data.length > 0 ? (
              <DistributionDonutChart
                items={data.browsers.data.map((item) => ({
                  label: item.value || t.common.unknown,
                  value: item.views,
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t.common.noData}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t.overview.topPages}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.page}</TableHead>
                  <TableHead className="text-right">{t.common.views}</TableHead>
                  <TableHead className="text-right">{t.common.sessions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.pages.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {t.common.noData}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.pages.data.map((item) => (
                    <TableRow key={`${item.pathname}-${item.views}`}>
                      <TableCell className="max-w-[260px] truncate font-mono">
                        {item.pathname || "/"}
                      </TableCell>
                      <TableCell className="text-right">{numberFormat(resolvedLocale, item.views)}</TableCell>
                      <TableCell className="text-right">{numberFormat(resolvedLocale, item.sessions)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.overview.topReferrers}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.referrer}</TableHead>
                  <TableHead className="text-right">{t.common.views}</TableHead>
                  <TableHead className="text-right">{t.common.sessions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.referrers.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {t.common.noData}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.referrers.data.map((item) => (
                    <TableRow key={`${item.referrer}-${item.views}`}>
                      <TableCell className="max-w-[260px] truncate font-mono">
                        {item.referrer || t.common.unknown}
                      </TableCell>
                      <TableCell className="text-right">{numberFormat(resolvedLocale, item.views)}</TableCell>
                      <TableCell className="text-right">{numberFormat(resolvedLocale, item.sessions)}</TableCell>
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
            <CardTitle>{t.overview.recentSessions}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.startedAt}</TableHead>
                  <TableHead className="text-right">{t.common.views}</TableHead>
                  <TableHead className="text-right">{t.common.duration}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sessions.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {t.common.noData}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.sessions.data.map((session) => (
                    <TableRow key={session.sessionId}>
                      <TableCell>{shortDateTime(resolvedLocale, session.startedAt)}</TableCell>
                      <TableCell className="text-right">{numberFormat(resolvedLocale, session.views)}</TableCell>
                      <TableCell className="text-right">
                        {durationFormat(resolvedLocale, session.totalDurationMs)}
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
            <CardTitle>{t.overview.recentEvents}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.event}</TableHead>
                  <TableHead>{t.common.page}</TableHead>
                  <TableHead className="text-right">{t.common.startedAt}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.events.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {t.common.noData}
                    </TableCell>
                  </TableRow>
                ) : (
                  data.events.data.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>{event.eventType || t.common.unknown}</TableCell>
                      <TableCell className="max-w-[220px] truncate font-mono">
                        {event.pathname || "/"}
                      </TableCell>
                      <TableCell className="text-right">
                        {shortDateTime(resolvedLocale, event.eventAt)}
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
