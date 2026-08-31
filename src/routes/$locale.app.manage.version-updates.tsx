import { useEffect, useRef, useState } from "react";
import {
  RiExternalLinkLine,
  RiGitBranchLine,
  RiGitCommitLine,
  RiPriceTag3Line,
  RiRocketLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PageHeading } from "@/components/dashboard/page-heading";
import { VersionUpdateDetailsButton } from "@/components/dashboard/version-update-details-button";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { intlLocale } from "@/lib/dashboard/format";
import { type Locale, resolveLocale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { dashboardPageTitle } from "@/lib/page-title";
import {
  fetchReleaseChangelog,
  fetchReleaseIndex,
  type ReleaseIndexEntry,
} from "@/lib/release-index";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

const REPO_RELEASES_URL = "https://github.com/RavelloH/InsightFlare/releases";
const CURRENT_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
const CURRENT_COMMIT = import.meta.env.VITE_COMMIT_SHA || null;

function formatCommit(hash: string | null | undefined): string {
  const value = hash?.trim();
  if (!value) return "-";
  return value.length > 12 ? value.slice(0, 12) : value;
}

function isCommitMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = left?.trim().toLowerCase() || "";
  const normalizedRight = right?.trim().toLowerCase() || "";
  if (!normalizedLeft || !normalizedRight) return false;

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(normalizedRight) ||
    normalizedRight.startsWith(normalizedLeft)
  );
}

function normalizeVersion(value: string | null | undefined): string {
  return (value || "").trim().replace(/^v/i, "").toLowerCase();
}

function releaseDate(
  release: Pick<ReleaseIndexEntry, "publishedAt" | "createdAt">,
): string {
  return release.publishedAt ?? release.createdAt;
}

function formatDateTime(locale: Locale, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function releaseStatus(
  release: Pick<ReleaseIndexEntry, "draft" | "prerelease">,
  labels: AppMessages["managementPages"]["versionUpdates"],
): { label: string; variant: "default" | "secondary" | "outline" } {
  if (release.draft) {
    return { label: labels.statusDraft, variant: "outline" };
  }

  if (release.prerelease) {
    return { label: labels.statusPrerelease, variant: "secondary" };
  }

  return { label: labels.statusStable, variant: "default" };
}

export const Route = createFileRoute("/$locale/app/manage/version-updates")({
  beforeLoad: ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.managementNav.versionUpdates,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});

function Page() {
  const { locale, messages } = Route.useRouteContext();
  const resolvedLocale = resolveLocale(locale);
  const labels = messages.managementPages.versionUpdates;
  const releasesQuery = useQuery({
    queryKey: ["dashboard", "release-index"],
    queryFn: ({ signal }) => fetchReleaseIndex(signal),
    enabled: typeof window !== "undefined",
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const releases = releasesQuery.data ?? [];
  const isLoading = releasesQuery.isPending;
  const error = releasesQuery.isError
    ? releasesQuery.error instanceof Error
      ? releasesQuery.error.message
      : "Unknown error"
    : null;
  const latestStableRelease =
    releases.find((release) => !release.draft && !release.prerelease) ??
    releases[0] ??
    null;
  const currentRelease =
    releases.find(
      (release) =>
        normalizeVersion(release.tagName) === normalizeVersion(CURRENT_VERSION),
    ) ?? null;
  const stableReleaseTags = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => release.tagName);
  const hasUpdate =
    latestStableRelease !== null &&
    normalizeVersion(latestStableRelease.tagName) !==
      normalizeVersion(CURRENT_VERSION);
  const detailLabels = {
    viewDetails: labels.viewDetails,
    detailsTitle: labels.detailsTitle,
    detailsDescription: labels.detailsDescription,
    detailsLoading: labels.detailsLoading,
    detailsEmpty: labels.detailsEmpty,
    detailsFailed: labels.detailsFailed,
    currentCommitBadge: labels.currentCommitBadge,
    openCompare: labels.openCompare,
    openCommit: labels.openCommit,
    commitCount: labels.commitCount,
  };

  return (
    <div className="space-y-4">
      <PageHeading
        title={messages.managementNav.versionUpdates}
        subtitle={labels.subtitle}
        actions={
          <Button variant="outline" asChild>
            <Link href={REPO_RELEASES_URL} target="_blank" rel="noreferrer">
              <RiExternalLinkLine />
              {labels.source}
            </Link>
          </Button>
        }
      />

      <Card className="py-0">
        <CardContent className="p-0">
          <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
            <VersionMetric
              icon={<RiPriceTag3Line className="size-[11px]" />}
              label={labels.currentVersion}
              value={`v${CURRENT_VERSION}`}
            />
            <VersionMetric
              icon={<RiRocketLine className="size-[11px]" />}
              label={labels.latestVersion}
              value={latestStableRelease?.tagName ?? "-"}
              valueClassName={hasUpdate ? "text-primary" : "text-foreground"}
            />
            <VersionMetric
              icon={<RiGitCommitLine className="size-[11px]" />}
              label={labels.currentCommit}
              value={formatCommit(CURRENT_COMMIT)}
            />
            <VersionMetric
              icon={<RiGitBranchLine className="size-[11px]" />}
              label={labels.releaseCount}
              value={isLoading ? "-" : String(releases.length)}
            />
          </div>
        </CardContent>
      </Card>

      <AutoResizer duration={0.22}>
        <AutoTransition
          initial={false}
          duration={0.2}
          transitionKey={
            isLoading
              ? "loading"
              : error
                ? "error"
                : releases.length > 0
                  ? "content"
                  : "empty"
          }
        >
          {isLoading ? (
            <Card key="loading">
              <CardContent className="flex min-h-32 items-center justify-center">
                <div
                  className="flex items-center justify-center"
                  role="status"
                  aria-label={messages.common.loading}
                >
                  <Spinner className="size-6" />
                </div>
              </CardContent>
            </Card>
          ) : error ? (
            <Card key="error">
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
                <RiGitBranchLine className="size-8 text-muted-foreground/70" />
                <p>{labels.loadFailed}</p>
                <p className="max-w-xl break-words font-mono text-xs">
                  {error}
                </p>
              </CardContent>
            </Card>
          ) : releases.length === 0 ? (
            <Card key="empty">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
                <RiGitBranchLine className="size-8 text-muted-foreground/70" />
                <p>{labels.empty}</p>
              </CardContent>
            </Card>
          ) : (
            <div key="content" className="space-y-3">
              {releases.map((release) => {
                const status = releaseStatus(release, labels);
                const isCurrent =
                  currentRelease !== null &&
                  release.tagName === currentRelease.tagName;
                const isCurrentDeployment = isCommitMatch(
                  release.targetCommitish,
                  CURRENT_COMMIT,
                );
                const releaseStableIndex = stableReleaseTags.findIndex(
                  (tagName) => tagName === release.tagName,
                );
                const previousStableTag =
                  releaseStableIndex >= 0
                    ? stableReleaseTags[releaseStableIndex + 1] || null
                    : null;
                return (
                  <Card key={release.tagName}>
                    <CardContent
                      className={cn(
                        "space-y-4 p-4 md:p-5",
                        isCurrentDeployment && "border-l-2 border-l-primary",
                      )}
                    >
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="font-mono text-xl font-semibold">
                              {release.tagName}
                            </h2>
                            <Badge variant={status.variant}>
                              {status.label}
                            </Badge>
                            {isCurrent ? (
                              <Badge variant="outline">
                                {labels.currentVersionBadge}
                              </Badge>
                            ) : null}
                            {isCurrentDeployment ? (
                              <Badge variant="outline">
                                {labels.currentCommitBadge}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {labels.publishedAt}:{" "}
                              {formatDateTime(
                                resolvedLocale,
                                releaseDate(release),
                              )}
                            </span>
                            <span>
                              {labels.author}:{" "}
                              {release.authorLogin || labels.unknown}
                            </span>
                            <span>
                              {labels.commit}:{" "}
                              <span className="font-mono">
                                {formatCommit(release.targetCommitish)}
                              </span>
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <VersionUpdateDetailsButton
                            baseTag={previousStableTag}
                            headRef={release.targetCommitish || release.tagName}
                            releaseTag={release.tagName}
                            currentCommit={CURRENT_COMMIT}
                            labels={detailLabels}
                          />
                          <Button variant="outline" asChild>
                            <Link
                              href={release.htmlUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <RiExternalLinkLine />
                              {labels.openRelease}
                            </Link>
                          </Button>
                        </div>
                      </div>

                      <div className="border-t pt-4">
                        <div className="mb-2 text-xs font-medium text-muted-foreground">
                          {labels.releaseNotes}
                        </div>
                        <LazyReleaseNotes
                          release={release}
                          locale={resolvedLocale}
                          labels={labels}
                        />
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}

function LazyReleaseNotes({
  release,
  locale,
  labels,
}: {
  release: ReleaseIndexEntry;
  locale: Locale;
  labels: AppMessages["managementPages"]["versionUpdates"];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    if (shouldLoad) return;

    const target = containerRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px", threshold: 0.01 },
    );
    observer.observe(target);

    return () => observer.disconnect();
  }, [shouldLoad]);

  const changelogQuery = useQuery({
    queryKey: ["dashboard", "release-changelog", locale, release.tagName],
    queryFn: ({ signal }) => fetchReleaseChangelog(release, locale, signal),
    enabled: shouldLoad && typeof window !== "undefined",
    staleTime: Infinity,
    retry: false,
  });

  const notesStateKey = !shouldLoad
    ? "idle"
    : changelogQuery.isPending
      ? "loading"
      : changelogQuery.isError
        ? "error"
        : "content";

  return (
    <div ref={containerRef} className="min-h-12">
      <AutoResizer duration={0.2}>
        <AutoTransition
          initial={false}
          duration={0.18}
          transitionKey={notesStateKey}
        >
          {!shouldLoad ? (
            <div key="idle" className="min-h-12" aria-hidden="true" />
          ) : changelogQuery.isPending ? (
            <div
              key="loading"
              className="flex min-h-12 items-center justify-center"
              role="status"
              aria-label={labels.detailsLoading}
            >
              <Spinner className="size-4" />
            </div>
          ) : changelogQuery.isError ? (
            <div
              key="error"
              className="whitespace-pre-wrap break-words text-sm leading-6 text-destructive"
            >
              {changelogQuery.error instanceof Error
                ? changelogQuery.error.message
                : labels.detailsFailed}
            </div>
          ) : (
            <div
              key="content"
              className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/90"
            >
              {changelogQuery.data?.trim() || labels.empty}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}

function VersionMetric({
  icon,
  label,
  value,
  valueClassName = "text-foreground",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
          {label}
        </p>
      </div>
      <AutoResizer className="mt-3 min-w-0" duration={0.18}>
        <AutoTransition initial={false} duration={0.16} transitionKey={value}>
          <p
            className={cn(
              "min-w-0 truncate font-mono text-xl leading-7 font-semibold tabular-nums",
              valueClassName,
            )}
          >
            {value}
          </p>
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}
