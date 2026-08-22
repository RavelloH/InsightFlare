import { useMemo, useState } from "react";
import {
  RiExternalLinkLine,
  RiGitCommitLine,
  RiListCheck2,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { Spinner } from "@/components/ui/spinner";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

export type VersionUpdateDetailsLabels = {
  viewDetails: string;
  detailsTitle: string;
  detailsDescription: string;
  detailsLoading: string;
  detailsEmpty: string;
  detailsFailed: string;
  currentCommitBadge: string;
  openCompare: string;
  openCommit: string;
  commitCount: string;
};

type CompareCommit = {
  sha: string;
  shortSha: string;
  htmlUrl: string;
  title: string;
  authorName: string;
  authoredAt: string | null;
};

type ComparePayload = {
  htmlUrl: string | null;
  status: string;
  totalCommits: number;
  commits: CompareCommit[];
};

type CompareResponse =
  | {
      ok: true;
      data: ComparePayload;
    }
  | {
      ok: false;
      message?: string;
    };

interface VersionUpdateDetailsButtonProps {
  baseTag: string | null;
  headRef: string;
  releaseTag: string;
  currentCommit: string | null;
  labels: VersionUpdateDetailsLabels;
}

function isCommitMatch(left: string, right: string | null): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right?.trim().toLowerCase() || "";
  if (!normalizedLeft || !normalizedRight) return false;

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(normalizedRight) ||
    normalizedRight.startsWith(normalizedLeft)
  );
}

export function VersionUpdateDetailsButton({
  baseTag,
  headRef,
  releaseTag,
  currentCommit,
  labels,
}: VersionUpdateDetailsButtonProps) {
  const [open, setOpen] = useState(false);
  const detailsQuery = useQuery({
    queryKey: ["dashboard", "release-compare", baseTag, headRef],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ head: headRef });
      if (baseTag) params.set("base", baseTag);

      const response = await fetch(
        `/api/private/releases/compare?${params.toString()}`,
        { method: "GET", signal },
      );
      const payload = (await response.json()) as CompareResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.ok
            ? labels.detailsFailed
            : payload.message || labels.detailsFailed,
        );
      }
      return payload.data;
    },
    enabled: typeof window !== "undefined" && open,
    retry: false,
    staleTime: Infinity,
  });
  const loading = detailsQuery.isPending;
  const details = detailsQuery.data ?? null;
  const error = detailsQuery.isError
    ? detailsQuery.error instanceof Error
      ? detailsQuery.error.message
      : labels.detailsFailed
    : null;

  const title = useMemo(() => {
    if (baseTag) return `${baseTag} -> ${releaseTag}`;
    return releaseTag;
  }, [baseTag, releaseTag]);

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
  }

  const detailStateKey = loading
    ? "loading"
    : error
      ? "error"
      : details
        ? details.commits.length > 0
          ? "details"
          : "empty"
        : "idle";

  return (
    <>
      <Button variant="outline" onClick={() => handleOpenChange(true)}>
        <RiListCheck2 />
        {labels.viewDetails}
      </Button>

      <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
        <ResponsiveDialogContent
          className="overflow-hidden"
          desktopClassName="max-h-[86svh] max-w-3xl"
          drawerClassName="overflow-hidden"
        >
          <ResponsiveDialogHeader className="pr-8">
            <ResponsiveDialogTitle icon={RiGitCommitLine}>
              {labels.detailsTitle}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {labels.detailsDescription.replace("{range}", title)}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <ResponsiveDialogBody>
            <AutoResizer className="min-h-0" initial duration={0.22}>
              <AutoTransition
                initial={false}
                duration={0.2}
                transitionKey={detailStateKey}
              >
                {loading ? (
                  <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                    <Spinner />
                    {labels.detailsLoading}
                  </div>
                ) : error ? (
                  <div className="border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                ) : details ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-y py-2 text-xs text-muted-foreground">
                      <span>
                        {labels.commitCount}: {details.totalCommits}
                      </span>
                      {details.htmlUrl ? (
                        <Button variant="ghost" size="xs" asChild>
                          <Link
                            href={details.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <RiExternalLinkLine />
                            {labels.openCompare}
                          </Link>
                        </Button>
                      ) : null}
                    </div>

                    {details.commits.length > 0 ? (
                      <div className="max-h-[56svh] overflow-y-auto pr-2">
                        <div className="space-y-2">
                          {details.commits.map((commit) => {
                            const isCurrent = isCommitMatch(
                              commit.sha,
                              currentCommit,
                            );

                            return (
                              <div
                                key={commit.sha}
                                className={cn(
                                  "border p-3 transition-colors",
                                  isCurrent
                                    ? "border-primary bg-primary/5"
                                    : "border-border",
                                )}
                              >
                                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                                  <div className="min-w-0 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <RiGitCommitLine className="size-4 text-muted-foreground" />
                                      <span className="break-words text-sm font-medium">
                                        {commit.title}
                                      </span>
                                      {isCurrent ? (
                                        <Badge variant="outline">
                                          {labels.currentCommitBadge}
                                        </Badge>
                                      ) : null}
                                    </div>
                                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                      <span className="font-mono">
                                        {commit.shortSha}
                                      </span>
                                      <span>{commit.authorName}</span>
                                      {commit.authoredAt ? (
                                        <span>{commit.authoredAt}</span>
                                      ) : null}
                                    </div>
                                  </div>
                                  <Button variant="ghost" size="xs" asChild>
                                    <Link
                                      href={commit.htmlUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      <RiExternalLinkLine />
                                      {labels.openCommit}
                                    </Link>
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="py-8 text-sm text-muted-foreground">
                        {labels.detailsEmpty}
                      </div>
                    )}
                  </div>
                ) : null}
              </AutoTransition>
            </AutoResizer>
          </ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
