import { useEffect, useState, useSyncExternalStore } from "react";
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
import {
  RiArrowDownSLine,
  RiArrowRightLine,
  RiSearchLine,
} from "@remixicon/react";

import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import { fetchAdminMe, type SiteData } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import {
  resolveSearchAction,
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
  const request: SearchRequest = {
    query,
    mode: "global",
    locale,
    scope: {
      userId: auth?.userId ?? "",
      teamId: auth?.activeTeamId,
      siteId: auth?.activeSiteId,
    },
    limit: 12,
  };
  // Keep the empty palette a navigation workspace. Observed values are
  // suggestions only after the user starts searching.
  const hasQuery = query.trim().length > 0;
  const matches = open
    ? hasQuery
      ? localPerceptionSearch(request)
      : localPerceptionNavigation({ ...request, limit: 50 })
    : [];
  const navigationResults = matches
    .filter((result) => result.coverage === "static-navigation")
    .sort((a, b) => {
      if (hasQuery) return 0;
      const priority = (result: SearchResult) => {
        if (result.action.type !== "navigate") return 4;
        const target = result.action.target;
        if (target.kind === "app") return 0;
        if (target.kind === "team" && target.teamId === auth?.activeTeamId)
          return 1;
        if (target.kind === "site") return 2;
        return 3;
      };
      return priority(a) - priority(b);
    });
  const observedResults = hasQuery
    ? matches.filter((result) => result.coverage !== "static-navigation")
    : [];
  const results = hasQuery
    ? [...navigationResults, ...observedResults]
    : navigationResults.slice(0, 8);
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
      setQuery("");
      setSelected(0);
      setNotice("");
      setOpen((old) => !old);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
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
        aria-label={labels.trigger}
        aria-keyshortcuts="Control+K Meta+K"
        title={labels.trigger + " (Ctrl/⌘ K)"}
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
          <span>{labels.trigger}</span>
        </span>
        <RiArrowDownSLine
          aria-hidden="true"
          className="text-muted-foreground"
        />
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
            aria-label={labels.placeholder}
            aria-controls="perception-search-results"
            aria-activedescendant={
              results.length ? "perception-item-" + activeIndex : undefined
            }
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            placeholder={labels.placeholder}
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
          <div
            id="perception-search-results"
            role="listbox"
            aria-label={labels.title}
            className="max-h-80 overflow-y-auto"
          >
            {navigationResults.length ? (
              <div
                role="group"
                aria-label={hasQuery ? labels.navigation : labels.quickAccess}
              >
                <SelectLabel>
                  {hasQuery ? labels.navigation : labels.quickAccess}
                </SelectLabel>
                {(hasQuery ? navigationResults : results).map((result, index) =>
                  option(result, index),
                )}
              </div>
            ) : null}
            {observedResults.length ? (
              <div role="group" aria-label={labels.local}>
                <SelectLabel>{labels.local}</SelectLabel>
                {observedResults.map((result, index) =>
                  option(result, navigationResults.length + index),
                )}
              </div>
            ) : null}
            {results.length === 0 ? (
              <p role="status" className="text-xs text-muted-foreground">
                {labels.empty}
              </p>
            ) : null}
          </div>
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
