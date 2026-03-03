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
import { DistributionDonutChart } from "@/components/dashboard/distribution-donut-chart";
import {
  buildSitePath,
  getTeamSiteContext,
  loadDevices,
  loadFilterOptions,
  parseDashboardFilters,
  resolveTimeWindow,
} from "@/lib/dashboard/server";
import { numberFormat } from "@/lib/dashboard/format";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

interface DevicesPageProps {
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

export default async function DevicesPage({ params, searchParams }: DevicesPageProps) {
  const { locale, teamSlug, siteSlug } = await params;
  const search = await searchParams;
  const resolvedLocale = resolveLocale(locale);
  const t = getMessages(resolvedLocale);
  const window = resolveTimeWindow(search.range);
  const filters = parseDashboardFilters(search);

  const context = await getTeamSiteContext(teamSlug, siteSlug);
  if (!context) notFound();

  const [devices, filterOptions] = await Promise.all([
    loadDevices(context.activeSite.id, window, filters),
    loadFilterOptions(context.activeSite.id, window),
  ]);
  const path = buildSitePath(resolvedLocale, context.activeTeam.slug, context.activeSite.slug, "devices");

  return (
    <div className="space-y-6">
      <PageHeading
        title={t.devices.title}
        subtitle={t.devices.subtitle}
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
          <CardTitle>{t.devices.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {devices.data.length > 0 ? (
            <DistributionDonutChart
              items={devices.data.map((item) => ({
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
          <CardTitle>{t.devices.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.device}</TableHead>
                <TableHead className="text-right">{t.common.views}</TableHead>
                <TableHead className="text-right">{t.common.sessions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    {t.common.noData}
                  </TableCell>
                </TableRow>
              ) : (
                devices.data.map((item) => (
                  <TableRow key={`${item.value}-${item.views}`}>
                    <TableCell>{item.value || t.common.unknown}</TableCell>
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
  );
}
