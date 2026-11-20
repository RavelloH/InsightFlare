import { useEffect, useState, useSyncExternalStore } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { Button } from "@insightflare/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@insightflare/ui/dialog";
import { Input } from "@insightflare/ui/input";
import { SelectLabel, selectTriggerStyles } from "@insightflare/ui/select";
import { RiArrowRightLine, RiSearchLine } from "@remixicon/react";

import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import { fetchAdminMe, type SiteData } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import {
  resolveSearchAction,
  type SearchCommandGroup,
  type SearchRequest,
  type SearchResult,
} from "@/lib/perception-search/core";
import {
  getPerceptionAuthorization,
  getPerceptionVersion,
  localPerceptionNavigation,
  localPerceptionSearch,
  revokePerceptionSite,
  subscribePerception,
} from "@/lib/perception-search/runtime";

import { perceptionLabels } from "./labels";

export function GlobalPerceptionSearch({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState("");
  useSyncExternalStore(subscribePerception, getPerceptionVersion, () => "0:0");
  const labels = perceptionLabels[locale];
  const auth = getPerceptionAuthorization();
  const contextMode = auth?.activeSiteId
    ? "site"
    : auth?.activeTeamId
      ? "team"
      : "root";
  const triggerLabel =
    contextMode === "site"
      ? labels.searchMetrics
      : contextMode === "team"
        ? labels.searchSites
        : labels.searchTeams;
  const request: SearchRequest = {
    query,
    mode: "global",
    locale,
    scope: {
      userId: auth?.userId ?? "",
      teamId: auth?.activeTeamId,
      siteId: auth?.activeSiteId,
    },
    limit: 50,
  };
  const hasQuery = query.trim().length > 0;
  // Keep the results mounted during the Dialog exit animation.
  const matches = hasQuery
    ? localPerceptionSearch(request)
    : localPerceptionNavigation(request);
  const groups: { id: SearchCommandGroup; label: string }[] =
    contextMode === "site"
      ? [
          { id: "metric", label: labels.metrics },
          { id: "section", label: labels.sections },
        ]
      : contextMode === "team"
        ? [{ id: "site", label: labels.sites }]
        : [{ id: "team", label: labels.teams }];
  const groupedResults = groups.map((group) => ({
    ...group,
    results: matches.filter(
      (result) =>
        result.coverage === "static-navigation" && result.group === group.id,
    ),
  }));
  const observedResults =
    contextMode === "site" && hasQuery
      ? matches.filter((result) => result.coverage === "local-observed-only")
      : [];
  const results = [
    ...groupedResults.flatMap((group) => group.results),
    ...observedResults,
  ];
  const activeIndex = Math.min(selected, Math.max(results.length - 1, 0));
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "k"
      )
        return;
      event.preventDefault();
      if (!open) {
        setQuery("");
        setSelected(0);
        setNotice("");
      }
      setOpen(!open);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [open]);
  async function execute(result: SearchResult) {
    const context = getPerceptionAuthorization();
    if (!context) return;
    const action = resolveSearchAction(result, context);
    if (!action || action.type !== "navigate") {
      setNotice(labels.unavailable);
      return;
    }
    // Only on user action: revalidate account, team and site against authorized APIs.
    // Local IndexedDB observations must never serve as proof of permission.
    if (result.scope.teamId) {
      try {
        const live = await fetchAdminMe();
        if (
          live.user.id !== context.userId ||
          !live.teams.some((team) => team.id === result.scope.teamId)
        ) {
          throw new Error("access_revoked");
        }
        if (result.scope.siteId) {
          const sites = await requestAdminService<SiteData[]>("sites", {
            params: { teamId: result.scope.teamId },
          });
          if (!sites.some((site) => site.id === result.scope.siteId))
            throw new Error("access_revoked");
        }
      } catch {
        if (result.scope.siteId) revokePerceptionSite(result.scope.siteId);
        setNotice(labels.unavailable);
        return;
      }
    }
    // Permissions may change while awaiting the authorization API.
    // Resolve the typed destination again against the latest in-memory grants.
    const latest = getPerceptionAuthorization();
    const verified = latest ? resolveSearchAction(result, latest) : null;
    if (!verified || verified.type !== "navigate") {
      setNotice(labels.unavailable);
      return;
    }
    setOpen(false);
    window.location.assign(verified.href);
  }
  const option = (result: SearchResult, index: number) => (
    <Button
      key={result.source + ":" + result.key}
      id={"perception-item-" + index}
      type="button"
      role="option"
      aria-selected={index === activeIndex}
      variant={index === activeIndex ? "secondary" : "ghost"}
      className="w-full justify-start"
      onMouseEnter={() => setSelected(index)}
      onClick={() => void execute(result)}
    >
      <span className="min-w-0 flex-1 truncate text-left">{result.label}</span>
      <span className="shrink-0 text-muted-foreground">{result.subtitle}</span>
      <RiArrowRightLine aria-hidden="true" />
    </Button>
  );

  return (
    <>
      <button
        type="button"
        data-slot="select-trigger"
        data-size="default"
        data-placeholder=""
        className={`${selectTriggerStyles} w-full`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        aria-keyshortcuts="Control+K Meta+K"
        title={triggerLabel + " (Ctrl/⌘ K)"}
        data-testid="perception-search-trigger"
        onClick={() => {
          setNotice("");
          setQuery("");
          setSelected(0);
          setOpen(true);
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <RiSearchLine aria-hidden="true" />
          <span>{triggerLabel}</span>
        </span>
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setQuery("");
            setSelected(0);
            setNotice("");
          }
        }}
      >
        <DialogContent
          className="max-w-xl"
          aria-describedby="perception-search-description"
        >
          <DialogHeader>
            <DialogTitle icon={RiSearchLine}>{labels.title}</DialogTitle>
            <DialogDescription id="perception-search-description">
              {labels.description}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={query}
            aria-label={triggerLabel}
            aria-controls="perception-search-results"
            aria-activedescendant={
              results.length ? "perception-item-" + activeIndex : undefined
            }
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            placeholder={triggerLabel}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
              setNotice("");
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((i) => Math.min(results.length - 1, i + 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((i) => Math.max(0, i - 1));
              }
              if (event.key === "Enter" && results[activeIndex]) {
                event.preventDefault();
                void execute(results[activeIndex]);
              }
            }}
          />
          <AutoResizer className="w-full" duration={0.24}>
            <div
              id="perception-search-results"
              role="listbox"
              aria-label={labels.title}
              className="max-h-80 overflow-y-auto"
            >
              {groupedResults.map((group) =>
                group.results.length ? (
                  <div key={group.id} role="group" aria-label={group.label}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.results.map((result) =>
                      option(result, results.indexOf(result)),
                    )}
                  </div>
                ) : null,
              )}
              {observedResults.length ? (
                <div role="group" aria-label={labels.local}>
                  <SelectLabel>{labels.local}</SelectLabel>
                  {observedResults.map((result) =>
                    option(result, results.indexOf(result)),
                  )}
                </div>
              ) : null}{" "}
              {results.length === 0 ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {labels.empty}
                </p>
              ) : null}
            </div>
          </AutoResizer>
          {notice ? (
            <p role="status" className="text-xs text-destructive">
              {notice}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
