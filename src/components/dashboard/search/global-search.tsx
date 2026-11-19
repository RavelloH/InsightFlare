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
import { RiArrowRightLine, RiSearchLine } from "@remixicon/react";

import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import { fetchAdminMe, type SiteData } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import {
  resolveSearchAction,
  searchExplicit,
  type SearchRequest,
  type SearchResult,
} from "@/lib/perception-search/core";
import {
  getPerceptionAuthorization,
  getPerceptionVersion,
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
  // Always synchronous. No debounce and no implicit server request.
  const results = open ? localPerceptionSearch(request) : [];
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
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={labels.trigger}
        title={labels.trigger + " (Ctrl/⌘ K)"}
        data-testid="perception-search-trigger"
        onClick={() => {
          setNotice("");
          setQuery("");
          setSelected(0);
          setOpen(true);
        }}
      >
        <RiSearchLine aria-hidden="true" />
      </Button>
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
          className="w-[min(94vw,36rem)] max-w-xl p-4"
          aria-describedby="perception-search-description"
        >
          <DialogHeader>
            <DialogTitle>{labels.title}</DialogTitle>
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
            className="max-h-[min(45vh,22rem)] overflow-y-auto"
          >
            {results.map((result, index) => (
              <button
                key={result.source + ":" + result.key}
                id={"perception-item-" + index}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setSelected(index)}
                onClick={() => void execute(result)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">{result.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {result.coverage === "static-navigation"
                    ? labels.navigation
                    : labels.local}
                </span>
                <RiArrowRightLine
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </button>
            ))}
            {results.length === 0 ? (
              <p
                role="status"
                className="px-2 py-3 text-xs text-muted-foreground"
              >
                {labels.empty}
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between border-t pt-2">
            <span className="text-xs text-muted-foreground">{notice}</span>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                void searchExplicit(
                  {
                    ...request,
                    mode: "explicit-fulltext",
                    userInitiated: true,
                  },
                  [],
                ).then((result) => {
                  if (result.status === "unavailable")
                    setNotice(labels.fulltextUnavailable);
                });
              }}
            >
              {labels.fulltext}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
