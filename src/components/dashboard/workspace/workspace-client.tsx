import { useEffect, useMemo, useState } from "react";
import {
  ChangeQuadrantChart,
  SitePulseHeatmap,
} from "@insightflare/product-ui/charts";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { Input } from "@insightflare/ui/input";
import { PageHeading } from "@insightflare/ui/page-heading";
import { Skeleton } from "@insightflare/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@insightflare/ui/table";
import {
  RiArrowDownLine,
  RiArrowRightSLine,
  RiBarChartBoxLine,
  RiFlashlightLine,
  RiHistoryLine,
  RiNotification3Line,
  RiPulseLine,
  RiSearchLine,
  RiWindow2Line,
} from "@remixicon/react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { getAnalyticsSectionIcon } from "@/components/dashboard/common/analytics-tabs";
import { SiteBrandIcon } from "@/components/dashboard/common/site-brand-icon";
import { useDashboardQuery } from "@/components/dashboard/shell/dashboard-query-provider";
import {
  readWorkspaceSites,
  type WorkspaceSiteVisit,
} from "@/components/dashboard/shell/dashboard-shell/navigation";
import {
  durationFormat,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import { buildSitePath } from "@/lib/dashboard/paths";
import type { DashboardRootContext } from "@/lib/dashboard/server";
import {
  buildTeamSiteTrends,
  type TeamDashboardData,
  teamDashboardQueryOptions,
  type TeamDashboardSnapshot,
} from "@/lib/dashboard/team-dashboard-query";
import { fetchNotificationMessages } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { navigateWithTransition } from "@/lib/page-transition";
import Link, { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";

import {
  buildWorkspaceRows,
  buildWorkspaceTotals,
  mergeTeamTrends,
  NOTABLE_CHANGE_PERCENT,
  sortRows,
  type WorkspaceSiteRow,
  type WorkspaceSort,
} from "./model";
import { AttentionRow, ChangeText, greeting, TrendStrip } from "./parts";

const TEAM_LIMIT = 20;

export function WorkspaceClient({
  locale,
  messages,
  dashboard,
  snapshots,
}: {
  locale: Locale;
  messages: AppMessages;
  dashboard: DashboardRootContext;
  snapshots: Record<string, TeamDashboardSnapshot | null>;
}) {
  const copy = messages.workspace;
  const { user, teams: allTeams, unreadAttentionCount = 0 } = dashboard;
  const teams = allTeams.slice(0, TEAM_LIMIT);
  const { window: queryWindow, range } = useDashboardQuery();
  const window = useMemo(
    () => ({
      from: queryWindow.from,
      to: queryWindow.to,
      interval: queryWindow.interval,
      timeZone: queryWindow.timeZone,
    }),
    [
      queryWindow.from,
      queryWindow.to,
      queryWindow.interval,
      queryWindow.timeZone,
    ],
  );
  const results = useQueries({
    queries: teams.map((team) =>
      teamDashboardQueryOptions({
        teamId: team.id,
        window,
        range,
        snapshot: snapshots[team.id] ?? null,
      }),
    ),
  });
  const router = useRouter();
  const loading = results.some((result) => result.isPending);
  const fetching = results.some((result) => result.isFetching);
  const failedTeams = teams.filter((_, index) => results[index]?.isError);
  const dataByTeam = new Map<string, TeamDashboardData>();
  teams.forEach((team, index) => {
    const data = results[index]?.data?.data;
    if (data) dataByTeam.set(team.id, data);
  });
  const allData = [...dataByTeam.values()];
  const sites = allData.flatMap((data) => data.sites);
  const trendBySite = buildTeamSiteTrends(
    sites.map((site) => site.id),
    mergeTeamTrends(allData),
    window,
  );
  const rows = buildWorkspaceRows(teams, dataByTeam, trendBySite);
  const totals = buildWorkspaceTotals(sites);
  const bucketStarts = (trendBySite[sites[0]?.id ?? ""] ?? []).map(
    (point) => point.timestampMs,
  );

  const [visits, setVisits] = useState<WorkspaceSiteVisit[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<WorkspaceSort>("visitors");
  const [now, setNow] = useState(0);
  useEffect(() => {
    setVisits(readWorkspaceSites(user.id));
    setNow(Date.now());
  }, [user.id]);

  const notifications = useQuery({
    queryKey: ["workspace", "attention", user.id, locale],
    queryFn: ({ signal }) =>
      fetchNotificationMessages({ unread: true, limit: 30, locale, signal }),
    enabled: typeof globalThis.window !== "undefined",
    staleTime: 60_000,
  });
  const attention = (notifications.data?.messages ?? [])
    .filter((message) => message.requiresAttention)
    .slice(0, 5);

  const teamsById = new Map(allTeams.map((team) => [team.id, team]));
  const rowsById = new Map(rows.map((row) => [row.site.id, row]));
  const recent = visits.flatMap((visit) => {
    const team = teamsById.get(visit.teamId);
    return team ? [{ visit, team }] : [];
  });
  const term = search.trim().toLocaleLowerCase();
  const visibleRows = sortRows(
    term
      ? rows.filter((row) =>
          [row.site.name, row.site.domain, row.team.name].some((value) =>
            value.toLocaleLowerCase().includes(term),
          ),
        )
      : rows,
    sort,
  );
  const siteHref = (row: WorkspaceSiteRow) =>
    buildSitePath(locale, row.team.slug, row.slug);
  const openSite = (siteId: string) => {
    const row = rowsById.get(siteId);
    if (row) navigateWithTransition(router, siteHref(row));
  };
  const pulseRows = sortRows(rows, "visitors").map((row) => ({
    id: row.site.id,
    label: row.site.name,
    icon: (
      <SiteBrandIcon
        siteId={row.site.id}
        siteName={row.site.name}
        domain={row.site.domain}
        iconSrc={row.site.iconPath}
      />
    ),
    values: row.trend.map((point) => point.visitors),
  }));
  const sortHead = (key: WorkspaceSort, label: string) => (
    <TableHead className="text-right">
      <button
        type="button"
        aria-pressed={sort === key}
        className={cn(
          "inline-flex items-center gap-0.5 hover:text-foreground",
          sort === key && "text-foreground",
        )}
        onClick={() => setSort(key)}
      >
        {label}
        {sort === key ? <RiArrowDownLine className="size-3" /> : null}
      </button>
    </TableHead>
  );
  const totalItems = [
    [
      messages.common.visitors,
      numberFormat(locale, totals.visitors),
      totals.change.visitors,
    ],
    [
      messages.common.views,
      numberFormat(locale, totals.views),
      totals.change.views,
    ],
    [
      messages.common.sessions,
      numberFormat(locale, totals.sessions),
      totals.change.sessions,
    ],
    [
      messages.common.avgDuration,
      durationFormat(locale, totals.avgDurationMs),
      totals.change.avgDurationMs,
    ],
  ] as const;

  return (
    <div className="space-y-4">
      <PageHeading
        title={copy.title}
        subtitle={[
          greeting(copy.greetings, now, user.name || user.username),
          formatI18nTemplate(copy.summary, {
            teams: allTeams.length,
            sites: sites.length,
          }),
        ]
          .filter(Boolean)
          .join(" · ")}
      />

      {failedTeams.length || allTeams.length > TEAM_LIMIT ? (
        <p className="border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {[
            failedTeams.length
              ? formatI18nTemplate(copy.partial, {
                  teams: failedTeams.map((team) => team.name).join(", "),
                })
              : "",
            allTeams.length > TEAM_LIMIT
              ? formatI18nTemplate(copy.limited, { count: TEAM_LIMIT })
              : "",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : null}

      {recent.length ? (
        <section aria-labelledby="workspace-recent" className="space-y-2">
          <h2
            id="workspace-recent"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <RiHistoryLine className="size-3.5" />
            {copy.recentSites}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            {recent.map(({ visit, team }) => {
              const SectionIcon = getAnalyticsSectionIcon(
                visit.section || "overview",
              );
              const row = rowsById.get(visit.siteId);
              return (
                <Link
                  key={visit.siteId}
                  href={buildSitePath(
                    locale,
                    team.slug,
                    visit.siteSlug,
                    visit.section || undefined,
                  )}
                  className="group flex min-w-0 items-center gap-2.5 border border-foreground/10 bg-card px-3 py-2.5 transition-colors hover:bg-muted/50"
                >
                  {row ? (
                    <SiteBrandIcon
                      siteId={row.site.id}
                      siteName={row.site.name}
                      domain={row.site.domain}
                      iconSrc={row.site.iconPath}
                      size="md"
                    />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {visit.name}
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <SectionIcon className="size-3 shrink-0" />
                      <span className="shrink-0">
                        {messages.navigation[visit.section || "overview"]}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{team.name}</span>
                    </span>
                  </span>
                  <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <RiPulseLine className="size-4" />
                {copy.pulseTitle}
              </CardTitle>
              <CardDescription>{copy.pulseHint}</CardDescription>
            </CardHeader>
            <CardContent>
              {loading && !rows.length ? (
                <div className="space-y-1">
                  {[0, 1, 2, 3, 4].map((item) => (
                    <Skeleton key={item} className="h-6 w-full" />
                  ))}
                </div>
              ) : (
                <SitePulseHeatmap
                  rows={pulseRows}
                  bucketStarts={bucketStarts}
                  locale={locale}
                  timeZone={window.timeZone}
                  interval={window.interval}
                  labels={{
                    value: messages.common.visitors,
                    usual: copy.pulse.usual,
                    above: copy.pulse.above,
                    below: copy.pulse.below,
                    versusUsual: copy.pulse.versusUsual,
                  }}
                  emptyLabel={copy.noSites}
                  loading={fetching}
                  onRowSelect={openSite}
                />
              )}
            </CardContent>
          </Card>

          <Card className="gap-0 pb-0">
            <CardHeader className="pb-3">
              <CardTitle className="inline-flex items-center gap-2">
                <RiWindow2Line className="size-4" />
                {copy.allSitesTitle}
              </CardTitle>
              <CardAction>
                <label className="relative block">
                  <RiSearchLine
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={search}
                    aria-label={copy.searchSites}
                    placeholder={copy.searchSites}
                    className="h-7 w-44 pl-7 text-xs"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              {loading && !rows.length ? (
                <div className="space-y-2 px-4 pb-4">
                  {[0, 1, 2, 3].map((item) => (
                    <Skeleton key={item} className="h-9 w-full" />
                  ))}
                </div>
              ) : visibleRows.length ? (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">
                        {copy.columns.site}
                      </TableHead>
                      <TableHead className="hidden md:table-cell">
                        {copy.columns.team}
                      </TableHead>
                      {sortHead("visitors", messages.common.visitors)}
                      {sortHead("views", messages.common.views)}
                      <TableHead className="hidden text-right lg:table-cell">
                        {messages.common.bounceRate}
                      </TableHead>
                      {sortHead("change", copy.columns.change)}
                      <TableHead className="hidden pr-4 sm:table-cell">
                        {copy.columns.trend}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((row) => {
                      return (
                        <TableRow key={row.site.id}>
                          <TableCell className="max-w-0 min-w-40 pl-4">
                            <Link
                              href={siteHref(row)}
                              className="flex min-w-0 items-center gap-2 hover:underline"
                            >
                              <SiteBrandIcon
                                siteId={row.site.id}
                                siteName={row.site.name}
                                domain={row.site.domain}
                                iconSrc={row.site.iconPath}
                              />
                              <span className="min-w-0">
                                <span className="block truncate">
                                  {row.site.name}
                                </span>
                                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                  {row.site.domain}
                                </span>
                              </span>
                            </Link>
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground md:table-cell">
                            {row.team.name}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {numberFormat(locale, row.visitors)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {numberFormat(locale, row.views)}
                          </TableCell>
                          <TableCell className="hidden text-right font-mono tabular-nums lg:table-cell">
                            {percentFormat(locale, row.bounceRate)}
                          </TableCell>
                          <TableCell className="text-right">
                            <ChangeText value={row.visitorsChange} />
                          </TableCell>
                          <TableCell className="hidden pr-4 sm:table-cell">
                            <TrendStrip points={row.trend} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="px-4 pb-6 text-xs text-muted-foreground">
                  {rows.length ? copy.noMatch : copy.noSites}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:sticky xl:top-[4.5rem] xl:grid-cols-1">
          <Card className="gap-0 pb-0">
            <CardHeader className="pb-3">
              <CardTitle className="inline-flex items-center gap-2">
                <RiNotification3Line className="size-4" />
                {copy.attention}
                {unreadAttentionCount > 0 ? (
                  <span className="bg-primary/10 px-1.5 font-mono text-xs text-primary tabular-nums">
                    {numberFormat(locale, unreadAttentionCount)}
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {notifications.isPending ? (
                <div className="space-y-2 px-4 pb-4">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : attention.length ? (
                <ul className="divide-y border-t">
                  {attention.map((message) => (
                    <AttentionRow
                      key={message.id}
                      locale={locale}
                      message={message}
                      siteName={
                        message.siteId
                          ? rowsById.get(message.siteId)?.site.name
                          : undefined
                      }
                      now={now}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-4 pb-4 text-xs text-muted-foreground">
                  {copy.noAttention}
                </p>
              )}
              <Link
                href={`/${locale}/app/inbox`}
                className="flex h-9 items-center justify-between border-t px-4 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              >
                {copy.viewAllNotifications}
                <RiArrowRightSLine className="size-4" />
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <RiFlashlightLine className="size-4" />
                {copy.changesTitle}
              </CardTitle>
              <CardDescription>
                {formatI18nTemplate(copy.changesHint, {
                  percent: NOTABLE_CHANGE_PERCENT,
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading && !rows.length ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <ChangeQuadrantChart
                  points={rows.flatMap((row) =>
                    row.visitorsChange === null
                      ? []
                      : [
                          {
                            id: row.site.id,
                            label: row.site.name,
                            value: row.visitors,
                            change: row.visitorsChange,
                            weight: row.views,
                          },
                        ],
                  )}
                  labels={{
                    value: messages.common.visitors,
                    change: copy.columns.change,
                    weight: messages.common.views,
                  }}
                  locale={locale}
                  threshold={NOTABLE_CHANGE_PERCENT}
                  onPointSelect={openSite}
                  emptyLabel={copy.noChanges}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <RiBarChartBoxLine className="size-4" />
                {copy.totalsTitle}
              </CardTitle>
              <CardDescription>{copy.totalsHint}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
                {totalItems.map(([label, value, change]) => (
                  <div key={label} className="space-y-1.5">
                    <dt className="text-[11px] text-muted-foreground">
                      {label}
                    </dt>
                    <dd className="flex flex-wrap items-end gap-x-1.5 gap-y-1">
                      {loading && !rows.length ? (
                        <Skeleton className="h-5 w-16" />
                      ) : (
                        <>
                          <span className="font-mono text-base leading-none tabular-nums">
                            {value}
                          </span>
                          <span className="text-[11px] leading-none">
                            <ChangeText value={change} />
                          </span>
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
