import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChangeQuadrantChart,
  SitePulseHeatmap,
  TrafficPairBarChart,
} from "@insightflare/product-ui/charts";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
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
import { Spinner } from "@insightflare/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@insightflare/ui/table";
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiArrowUpSLine,
  RiBarChartBoxLine,
  RiFlashlightLine,
  RiHistoryLine,
  RiNotification3Line,
  RiPulseLine,
  RiSearchLine,
  RiWindow2Line,
} from "@remixicon/react";
import { useQueries, useQuery } from "@tanstack/react-query";

import {
  AnalyticsDetailsTooltipTarget,
  AnalyticsTimeTooltipProvider,
} from "@/components/dashboard/analytics-time-tooltip";
import { getAnalyticsSectionIcon } from "@/components/dashboard/common/analytics-tabs";
import { SiteBrandIcon } from "@/components/dashboard/common/site-brand-icon";
import { useDashboardQuery } from "@/components/dashboard/shell/dashboard-query-provider";
import {
  readWorkspaceSites,
  type WorkspaceSiteVisit,
} from "@/components/dashboard/shell/dashboard-shell/navigation";
import { useHydrated } from "@/hooks/use-hydrated";
import {
  durationFormat,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import { buildSitePath } from "@/lib/dashboard/paths";
import type { DashboardRootContext } from "@/lib/dashboard/server";
import {
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
  combineWorkspaceQueries,
  deriveWorkspaceData,
  NOTABLE_CHANGE_PERCENT,
  sortRows,
  type WorkspaceSiteRow,
  type WorkspaceSort,
  type WorkspaceSortDirection,
} from "./model";
import { AttentionRow, ChangeText, greeting } from "./parts";

const TEAM_LIMIT = 20;

function WorkspaceLoading({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <Spinner className="size-4" aria-label={label} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

function WorkspaceRefreshIndicator({
  loading,
  label,
}: {
  loading: boolean;
  label: string;
}) {
  return (
    <AutoTransition
      as="span"
      className="inline-flex shrink-0 items-center"
      initial={false}
      duration={0.2}
      transitionKey={loading ? "loading" : "idle"}
    >
      {loading ? <Spinner aria-label={label} /> : null}
    </AutoTransition>
  );
}

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
  const hydrated = useHydrated();
  const copy = messages.workspace;
  const { user, teams: allTeams, unreadAttentionCount = 0 } = dashboard;
  const teams = useMemo(() => allTeams.slice(0, TEAM_LIMIT), [allTeams]);
  const { window: queryWindow, range, queryReady } = useDashboardQuery();
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
        enabled: queryReady && Boolean(team.id),
      }),
    ),
    combine: combineWorkspaceQueries,
  });
  const router = useRouter();
  const { loading, fetching, data, failed } = results;
  const analyticsLoading = loading || fetching;
  const failedTeams = useMemo(
    () => teams.filter((_, index) => failed[index]),
    [teams, failed],
  );
  // useQueries combines with structural sharing, preserving the data array
  // across status-only changes. Input and sorting never rebuild time buckets.
  const { rows, siteCount, totals, bucketStarts, rowsById, changePoints } =
    useMemo(
      () => deriveWorkspaceData(teams, data, window),
      [teams, data, window],
    );
  const waitingForSites = analyticsLoading && !rows.length;

  const [visits, setVisits] = useState<WorkspaceSiteVisit[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{
    key: WorkspaceSort;
    direction: WorkspaceSortDirection;
  }>({ key: "visitors", direction: "desc" });
  const [now, setNow] = useState(0);
  useEffect(() => {
    setVisits(readWorkspaceSites(user.id));
    setNow(Date.now());
  }, [user.id]);

  const notifications = useQuery({
    queryKey: ["workspace", "attention", user.id, locale],
    queryFn: ({ signal }) =>
      fetchNotificationMessages({ unread: true, limit: 30, locale, signal }),
    enabled: hydrated,
    staleTime: 60_000,
  });
  const attention = (notifications.data?.messages ?? [])
    .filter((message) => message.requiresAttention)
    .slice(0, 5);

  const teamsById = useMemo(
    () => new Map(allTeams.map((team) => [team.id, team])),
    [allTeams],
  );
  const recent = visits.flatMap((visit) => {
    const team = teamsById.get(visit.teamId);
    return team ? [{ visit, team }] : [];
  });
  const term = search.trim().toLocaleLowerCase();
  const visibleRows = useMemo(
    () =>
      sortRows(
        term
          ? rows.filter((row) =>
              [row.site.name, row.site.domain, row.team.name].some((value) =>
                value.toLocaleLowerCase().includes(term),
              ),
            )
          : rows,
        sort.key,
        sort.direction,
      ),
    [term, rows, sort.key, sort.direction],
  );
  const siteHref = useCallback(
    (row: WorkspaceSiteRow) => buildSitePath(locale, row.team.slug, row.slug),
    [locale],
  );
  const openSite = useCallback(
    (siteId: string) => {
      const row = rowsById.get(siteId);
      if (row) navigateWithTransition(router, siteHref(row));
    },
    [rowsById, router, siteHref],
  );
  const pulseLabels = useMemo(
    () => ({
      value: messages.common.visitors,
      usual: copy.pulse.usual,
      above: copy.pulse.above,
      below: copy.pulse.below,
      versusUsual: copy.pulse.versusUsual,
    }),
    [messages.common.visitors, copy.pulse],
  );
  const quadrantLabels = useMemo(
    () => ({
      value: messages.common.visitors,
      change: copy.columns.change,
      weight: messages.common.views,
    }),
    [messages.common.visitors, messages.common.views, copy.columns.change],
  );
  const pulseRows = useMemo(
    () =>
      sortRows(rows, "visitors").map((row) => ({
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
      })),
    [rows],
  );
  const sortHead = (
    key: WorkspaceSort,
    label: string,
    className?: string,
    centered = false,
  ) => (
    <TableHead
      aria-sort={
        sort.key === key
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
      className={cn(centered ? "text-center" : "text-right", className)}
    >
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          sort.key === key ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={() =>
          setSort((previous) => ({
            key,
            direction:
              previous.key === key && previous.direction === "desc"
                ? "asc"
                : "desc",
          }))
        }
      >
        {label}
        {sort.key === key ? (
          sort.direction === "asc" ? (
            <RiArrowUpSLine className="size-3.5" aria-hidden="true" />
          ) : (
            <RiArrowDownSLine className="size-3.5" aria-hidden="true" />
          )
        ) : (
          <span
            aria-hidden="true"
            className="inline-flex flex-col leading-none text-muted-foreground"
          >
            <RiArrowUpSLine className="-mb-1 size-3.5" />
            <RiArrowDownSLine className="-mt-1 size-3.5" />
          </span>
        )}
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
      <div>
        <AutoResizer>
          <PageHeading
            title={copy.title}
            subtitle={[
              greeting(copy.greetings, now, user.name || user.username),
              formatI18nTemplate(copy.summary, {
                teams: allTeams.length,
                sites: siteCount,
              }),
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        </AutoResizer>

        <AutoResizer>
          <AutoTransition
            initial={false}
            duration={0.2}
            className={
              failedTeams.length || allTeams.length > TEAM_LIMIT
                ? "pt-4"
                : undefined
            }
            transitionKey={
              failedTeams.length || allTeams.length > TEAM_LIMIT
                ? "warning"
                : "empty"
            }
          >
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
          </AutoTransition>
        </AutoResizer>

        <AutoResizer>
          <AutoTransition
            initial={false}
            duration={0.2}
            className={recent.length ? "pt-4" : undefined}
            transitionKey={recent.length ? "recent" : "empty"}
          >
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
          </AutoTransition>
        </AutoResizer>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="inline-flex items-center gap-2">
                <RiPulseLine className="size-4" />
                {copy.pulseTitle}
                <WorkspaceRefreshIndicator
                  loading={analyticsLoading && !waitingForSites}
                  label={messages.common.loading}
                />
              </CardTitle>
              <CardDescription>{copy.pulseHint}</CardDescription>
            </CardHeader>
            <CardContent>
              <AutoResizer>
                <AutoTransition
                  initial={false}
                  duration={0.2}
                  transitionKey={
                    waitingForSites
                      ? "loading"
                      : pulseRows.length && bucketStarts.length
                        ? "pulse"
                        : "empty"
                  }
                >
                  {waitingForSites ? (
                    <WorkspaceLoading
                      label={messages.common.loading}
                      className="h-40"
                    />
                  ) : (
                    <SitePulseHeatmap
                      rows={pulseRows}
                      bucketStarts={bucketStarts}
                      locale={locale}
                      timeZone={window.timeZone}
                      interval={window.interval}
                      labels={pulseLabels}
                      emptyLabel={copy.noSites}
                      loading={fetching}
                      onRowSelect={openSite}
                    />
                  )}
                </AutoTransition>
              </AutoResizer>
            </CardContent>
          </Card>

          <Card className="gap-0 pb-0">
            <CardHeader className="pb-3">
              <CardTitle className="inline-flex items-center gap-2">
                <RiWindow2Line className="size-4" />
                {copy.allSitesTitle}
                <WorkspaceRefreshIndicator
                  loading={analyticsLoading && !waitingForSites}
                  label={messages.common.loading}
                />
              </CardTitle>
              <CardAction>
                <label className="relative block">
                  <RiSearchLine
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={search}
                    aria-label={copy.searchSites}
                    placeholder={copy.searchSites}
                    className="h-8 w-36 pl-8 text-xs sm:w-52"
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              <AutoResizer>
                <AutoTransition
                  initial={false}
                  duration={0.2}
                  transitionKey={
                    waitingForSites
                      ? "loading"
                      : visibleRows.length
                        ? "table"
                        : rows.length
                          ? "no-match"
                          : "empty"
                  }
                >
                  {waitingForSites ? (
                    <WorkspaceLoading
                      label={messages.common.loading}
                      className="min-h-24 px-4 pb-4"
                    />
                  ) : visibleRows.length ? (
                    <AnalyticsTimeTooltipProvider messages={messages}>
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
                            {sortHead(
                              "bounceRate",
                              messages.common.bounceRate,
                              "hidden lg:table-cell",
                              true,
                            )}
                            {sortHead(
                              "change",
                              copy.columns.change,
                              undefined,
                              true,
                            )}
                            <TableHead className="hidden w-28 text-center sm:table-cell xl:w-40">
                              {copy.columns.trend}
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visibleRows.map((row) => {
                            return (
                              <TableRow
                                key={row.site.id}
                                className="group cursor-pointer focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/70"
                                onClick={(event) => {
                                  if (
                                    event.defaultPrevented ||
                                    event.button !== 0 ||
                                    event.ctrlKey ||
                                    event.metaKey ||
                                    event.shiftKey ||
                                    event.altKey
                                  )
                                    return;
                                  if (
                                    event.target instanceof Element &&
                                    event.target.closest(
                                      "a,button,input,[role='button']",
                                    )
                                  )
                                    return;
                                  navigateWithTransition(router, siteHref(row));
                                }}
                              >
                                <TableCell className="max-w-0 min-w-40 pl-4">
                                  <AnalyticsDetailsTooltipTarget
                                    className="block min-w-0"
                                    locale={locale}
                                    request={{
                                      key: JSON.stringify([
                                        row.site.id,
                                        row.site.name,
                                        row.site.domain,
                                        row.team.name,
                                      ]),
                                      items: [
                                        {
                                          label: copy.columns.site,
                                          value: row.site.name,
                                          copyValue: row.site.name,
                                        },
                                        {
                                          label: messages.common.hostname,
                                          value: row.site.domain,
                                          copyValue: row.site.domain,
                                        },
                                        {
                                          label: copy.columns.team,
                                          value: row.team.name,
                                          copyValue: row.team.name,
                                        },
                                      ],
                                    }}
                                  >
                                    <Link
                                      href={siteHref(row)}
                                      className="flex min-w-0 items-center gap-2 focus-visible:outline-none"
                                    >
                                      <SiteBrandIcon
                                        siteId={row.site.id}
                                        siteName={row.site.name}
                                        domain={row.site.domain}
                                        iconSrc={row.site.iconPath}
                                      />
                                      <span className="min-w-0">
                                        <span className="block truncate font-medium">
                                          {row.site.name}
                                        </span>
                                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                          {row.site.domain}
                                        </span>
                                      </span>
                                    </Link>
                                  </AnalyticsDetailsTooltipTarget>
                                </TableCell>
                                <TableCell className="hidden max-w-32 text-muted-foreground md:table-cell">
                                  <span
                                    className="block truncate"
                                    title={row.team.name}
                                  >
                                    {row.team.name}
                                  </span>
                                </TableCell>
                                <TableCell className="text-right font-mono tabular-nums">
                                  {numberFormat(locale, row.visitors)}
                                </TableCell>
                                <TableCell className="text-right font-mono tabular-nums">
                                  {numberFormat(locale, row.views)}
                                </TableCell>
                                <TableCell className="hidden text-center font-mono tabular-nums lg:table-cell">
                                  {percentFormat(locale, row.bounceRate)}
                                </TableCell>
                                <TableCell className="text-center font-mono tabular-nums">
                                  <ChangeText value={row.visitorsChange} />
                                </TableCell>
                                <TableCell className="hidden w-28 max-w-40 px-3 sm:table-cell xl:w-40">
                                  <div className="mx-auto w-full max-w-40 overflow-hidden">
                                    <TrafficPairBarChart
                                      data={row.trend}
                                      locale={locale}
                                      timeZone={window.timeZone}
                                      interval={window.interval}
                                      range={window}
                                      viewsLabel={messages.common.views}
                                      visitorsLabel={messages.common.visitors}
                                      compact
                                      dataIsComplete
                                      maxPoints={36}
                                      className="h-4"
                                    />
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </AnalyticsTimeTooltipProvider>
                  ) : (
                    <p className="px-4 pb-6 text-xs text-muted-foreground">
                      {rows.length ? copy.noMatch : copy.noSites}
                    </p>
                  )}
                </AutoTransition>
              </AutoResizer>
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
                <WorkspaceRefreshIndicator
                  loading={notifications.isFetching && !notifications.isPending}
                  label={messages.common.loading}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <AutoResizer>
                <AutoTransition
                  initial={false}
                  duration={0.2}
                  transitionKey={
                    notifications.isPending
                      ? "loading"
                      : attention.length
                        ? "attention"
                        : "empty"
                  }
                >
                  {notifications.isPending ? (
                    <WorkspaceLoading
                      label={messages.common.loading}
                      className="min-h-16 px-4 pb-4"
                    />
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
                </AutoTransition>
              </AutoResizer>
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
                <WorkspaceRefreshIndicator
                  loading={analyticsLoading && !waitingForSites}
                  label={messages.common.loading}
                />
              </CardTitle>
              <CardDescription>
                {formatI18nTemplate(copy.changesHint, {
                  percent: NOTABLE_CHANGE_PERCENT,
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AutoResizer>
                <AutoTransition
                  initial={false}
                  duration={0.2}
                  transitionKey={
                    waitingForSites
                      ? "loading"
                      : changePoints.length
                        ? "chart"
                        : "empty"
                  }
                >
                  {waitingForSites ? (
                    <WorkspaceLoading
                      label={messages.common.loading}
                      className="h-60"
                    />
                  ) : (
                    <ChangeQuadrantChart
                      points={changePoints}
                      labels={quadrantLabels}
                      locale={locale}
                      threshold={NOTABLE_CHANGE_PERCENT}
                      onPointSelect={openSite}
                      emptyLabel={copy.noChanges}
                    />
                  )}
                </AutoTransition>
              </AutoResizer>
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
                    <dd>
                      <AutoResizer initial={false}>
                        <AutoTransition
                          transitionKey={
                            analyticsLoading
                              ? "loading"
                              : JSON.stringify([value, change])
                          }
                          initial={false}
                          duration={0.2}
                          type="fade"
                          presenceMode="wait"
                        >
                          {analyticsLoading ? (
                            <div className="flex min-h-5 items-center">
                              <Spinner
                                className="size-5"
                                aria-label={messages.common.loading}
                              />
                            </div>
                          ) : (
                            <div className="flex min-h-5 flex-wrap items-end gap-x-1.5 gap-y-1">
                              <span className="font-mono text-base leading-none tabular-nums">
                                {value}
                              </span>
                              <span className="text-[11px] leading-none">
                                <ChangeText value={change} />
                              </span>
                            </div>
                          )}
                        </AutoTransition>
                      </AutoResizer>
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
