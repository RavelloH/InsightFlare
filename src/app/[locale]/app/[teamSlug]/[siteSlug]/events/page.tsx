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
import { TopItemsChart } from "@/components/dashboard/top-items-chart";
import {
  buildSitePath,
  getTeamSiteContext,
  loadEvents,
  loadFilterOptions,
  parseDashboardFilters,
  resolveTimeWindow,
} from "@/lib/dashboard/server";
import { durationFormat, shortDateTime } from "@/lib/dashboard/format";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface EventsPageProps {
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

export default async function EventsPage({ params, searchParams }: EventsPageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const search = await searchParams;
  const resolvedLocale = resolveLocale(locale);
  const t = getMessages(resolvedLocale);
  const window = resolveTimeWindow(search.range);
  const filters = parseDashboardFilters(search);

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  const [events, filterOptions] = await Promise.all([
    loadEvents(context.activeSite.id, window, filters),
    loadFilterOptions(context.activeSite.id, window),
  ]);
  const path = buildSitePath(resolvedLocale, context.activeTeam.slug, context.activeSite.slug, "events");

  const eventCountMap = new Map<string, number>();
  for (const item of events.data) {
    const key = item.eventType || t.common.unknown;
    eventCountMap.set(key, (eventCountMap.get(key) || 0) + 1);
  }
  const eventTypeItems = [...eventCountMap.entries()].map(([label, value]) => ({ label, value }));

  return (
    <div className="space-y-6">
      <PageHeading
        title={t.events.title}
        subtitle={t.events.subtitle}
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

      <Card>
        <CardHeader>
          <CardTitle>{t.events.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {eventTypeItems.length > 0 ? (
            <TopItemsChart valueLabel={t.common.event} items={eventTypeItems} />
          ) : (
            <p className="text-sm text-muted-foreground">{t.common.noData}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.events.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.startedAt}</TableHead>
                <TableHead>{t.common.event}</TableHead>
                <TableHead>{t.common.page}</TableHead>
                <TableHead>{t.common.location}</TableHead>
                <TableHead>{t.common.browser}</TableHead>
                <TableHead className="text-right">{t.common.duration}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {t.common.noData}
                  </TableCell>
                </TableRow>
              ) : (
                events.data.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>{shortDateTime(resolvedLocale, event.eventAt)}</TableCell>
                    <TableCell>{event.eventType || t.common.unknown}</TableCell>
                    <TableCell className="max-w-[260px] truncate font-mono">{event.pathname || "/"}</TableCell>
                    <TableCell>
                      {[event.country, event.region, event.city].filter(Boolean).join(" / ") || t.common.unknown}
                    </TableCell>
                    <TableCell>{event.browser || t.common.unknown}</TableCell>
                    <TableCell className="text-right">
                      {durationFormat(resolvedLocale, event.durationMs)}
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
