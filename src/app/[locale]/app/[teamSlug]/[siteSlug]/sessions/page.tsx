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
  loadFilterOptions,
  loadSessions,
  parseDashboardFilters,
  resolveTimeWindow,
} from "@/lib/dashboard/server";
import { durationFormat, numberFormat, shortDateTime } from "@/lib/dashboard/format";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface SessionsPageProps {
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

export default async function SessionsPage({ params, searchParams }: SessionsPageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const search = await searchParams;
  const resolvedLocale = resolveLocale(locale);
  const t = getMessages(resolvedLocale);
  const window = resolveTimeWindow(search.range);
  const filters = parseDashboardFilters(search);

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  const [sessions, filterOptions] = await Promise.all([
    loadSessions(context.activeSite.id, window, filters),
    loadFilterOptions(context.activeSite.id, window),
  ]);
  const path = buildSitePath(resolvedLocale, context.activeTeam.slug, context.activeSite.slug, "sessions");

  return (
    <div className="space-y-6">
      <PageHeading
        title={t.sessions.title}
        subtitle={t.sessions.subtitle}
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
          <CardTitle>{t.sessions.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.data.length > 0 ? (
            <TopItemsChart
              valueLabel={t.common.duration}
              items={sessions.data.map((item) => ({
                label: item.sessionId.slice(0, 8),
                value: item.totalDurationMs,
              }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t.common.noData}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.sessions.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.startedAt}</TableHead>
                <TableHead>{t.common.endedAt}</TableHead>
                <TableHead className="text-right">{t.common.views}</TableHead>
                <TableHead className="text-right">{t.common.duration}</TableHead>
                <TableHead className="text-right">{t.common.page}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {t.common.noData}
                  </TableCell>
                </TableRow>
              ) : (
                sessions.data.map((item) => (
                  <TableRow key={item.sessionId}>
                    <TableCell>{shortDateTime(resolvedLocale, item.startedAt)}</TableCell>
                    <TableCell>{shortDateTime(resolvedLocale, item.endedAt)}</TableCell>
                    <TableCell className="text-right">{numberFormat(resolvedLocale, item.views)}</TableCell>
                    <TableCell className="text-right">{durationFormat(resolvedLocale, item.totalDurationMs)}</TableCell>
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
