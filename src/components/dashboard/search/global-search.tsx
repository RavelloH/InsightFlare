import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DateRange } from "react-day-picker";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { Button } from "@insightflare/ui/button";
import { Calendar } from "@insightflare/ui/calendar";
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogDescription as DialogDescription,
  ResponsiveDialogTitle as DialogTitle,
} from "@insightflare/ui/responsive-dialog";
import { selectTriggerStyles } from "@insightflare/ui/select";
import {
  type RemixiconComponentType,
  RiArrowLeftLine,
  RiArrowLeftRightLine,
  RiCalendarLine,
  RiFileList3Line,
  RiFlashlightLine,
  RiGlobalLine,
  RiLineChartLine,
  RiMegaphoneLine,
  RiPulseLine,
  RiSearchLine,
  RiShareForwardLine,
  RiTeamLine,
  RiUser3Line,
} from "@remixicon/react";

import { getAnalyticsSectionIcon } from "@/components/dashboard/common/analytics-tabs";
import {
  formatDateSpan,
  toDateRange,
} from "@/components/dashboard/shell/dashboard-header-controls/range";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import { writeDashboardQueryPreferences } from "@/lib/dashboard/query-preferences";
import {
  normalizeCustomDateRange,
  resolveTimeWindow,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";
import { fetchAdminMe, type SiteData } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import {
  resolveSearchAction,
  resultMatchScore,
  type SearchCommandGroup,
  type SearchRequest,
  type SearchResult,
  SITE_OVERVIEW_METRICS,
  SITE_SEARCH_SECTIONS,
} from "@/lib/perception-search/core";
import {
  currentPerceptionScope,
  getPerceptionAuthorization,
  getPerceptionVersion,
  localPerceptionNavigation,
  localPerceptionObservations,
  type LookupKind,
  lookupPerception,
  perceptionTarget,
  recentPerceptionNavigation,
  rememberPerceptionNavigation,
  revokePerceptionSite,
  subscribePerception,
} from "@/lib/perception-search/runtime";

import {
  interpret,
  type Lookup,
  lookupFields,
  type LookupPrefix,
  lookupPrefixes,
  lookupUsesDate,
  splitPrefix,
} from "./interpret";
import {
  Highlight,
  Kbd,
  PaletteGroup,
  PaletteRow,
  TypeChip,
} from "./palette-parts";

type Copy = AppMessages["search"];
type GroupKey =
  "recent" | "teams" | "sites" | "sections" | "metrics" | "data" | "actions";
type View = "team" | "site" | null;
type PaletteItem = {
  key: string;
  icon: RemixiconComponentType;
  label: string;
  /** Plain labels are highlighted; composed lookup labels are not. */
  highlight?: boolean;
  detail?: string;
  tag?: string;
  score?: number;
  relevance?: number;
  action:
    | { type: "result"; result: SearchResult; window?: TimeWindow }
    | { type: "view"; view: View }
    | { type: "lookup"; lookup: Lookup };
};
type LookupResponse = Awaited<ReturnType<typeof lookupPerception>>;
type LookupState = {
  key: string;
  pending: boolean;
  response?: LookupResponse;
  lookup: Lookup;
};

const commandGroupKey: Record<SearchCommandGroup, GroupKey> = {
  workspace: "teams",
  team: "teams",
  site: "sites",
  metric: "metrics",
  section: "sections",
};

/** Field → chip/tag type and icon, for both local observations and server hits. */
const fieldTypes: Record<
  string,
  { type: keyof Copy["types"]; icon: RemixiconComponentType }
> = {
  "page.path": { type: "page", icon: RiFileList3Line },
  "event.name": { type: "event", icon: RiFlashlightLine },
  "referrer.domain": { type: "referrer", icon: RiShareForwardLine },
  "utm.source": { type: "campaign", icon: RiMegaphoneLine },
  "utm.medium": { type: "campaign", icon: RiMegaphoneLine },
  "utm.campaign": { type: "campaign", icon: RiMegaphoneLine },
  "client.browser": { type: "browser", icon: RiGlobalLine },
  visitor: { type: "visitor", icon: RiUser3Line },
  session: { type: "session", icon: RiPulseLine },
  "event-id": { type: "eventRecord", icon: RiFlashlightLine },
  id: { type: "id", icon: RiUser3Line },
};
const lookupField: Record<LookupKind, string> = { ...lookupFields, id: "id" };
const chipType: Record<LookupPrefix, keyof Copy["types"]> = {
  page: "page",
  event: "event",
  referrer: "referrer",
  visitor: "visitor",
  session: "session",
  "event-id": "eventRecord",
};

function targetSection(result: SearchResult) {
  const action = result.action;
  return action.type === "navigate" && action.target.kind === "site"
    ? action.target.section
    : undefined;
}

/** Position in the dashboard's own tab and metric order. */
function naturalIndex(result: SearchResult) {
  const action = result.action;
  if (action.type !== "navigate" || action.target.kind !== "site") return 0;
  const { metric, section } = action.target;
  return metric
    ? SITE_OVERVIEW_METRICS.indexOf(metric)
    : SITE_SEARCH_SECTIONS.indexOf(section);
}

function navigationIcon(result: SearchResult): RemixiconComponentType {
  if (result.group === "team" || result.group === "workspace")
    return RiTeamLine;
  if (result.group === "site") return RiGlobalLine;
  if (result.group === "metric") return RiLineChartLine;
  return getAnalyticsSectionIcon(targetSection(result) ?? "overview");
}

export function GlobalPerceptionSearch({
  locale,
  messages,
  section,
  siteDomain,
  siteName,
}: {
  locale: Locale;
  messages: AppMessages;
  section: string;
  siteDomain?: string;
  siteName?: string;
}) {
  const copy = messages.search;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<LookupPrefix>();
  const [selected, setSelected] = useState<string>();
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<View>(null);
  const [lookupState, setLookupState] = useState<LookupState>();
  const [override, setOverride] = useState<TimeWindow>();
  const [dateOpen, setDateOpen] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>();
  const [shortcut, setShortcut] = useState("Ctrl K");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const navigationController = useRef<AbortController | null>(null);
  const id = useId();
  useSyncExternalStore(subscribePerception, getPerceptionVersion, () => "0:0");
  const { window: dashboardWindow } = useDashboardQuery();
  const range = override ?? dashboardWindow;
  const auth = getPerceptionAuthorization();
  const activeSite = auth?.activeSiteId;
  const activeTeam = auth?.activeTeamId;
  const userId = auth?.userId ?? "";
  const siteAllowed = Boolean(
    activeSite && auth?.allowedSiteIds.has(activeSite),
  );
  const scope = { userId, teamId: activeTeam, siteId: activeSite };
  const actionScope = {
    userId,
    teamId: activeTeam ?? "",
    siteId: activeSite ?? "",
  };
  const scopeKey = JSON.stringify([
    userId,
    activeTeam,
    activeSite,
    siteAllowed,
  ]);
  const requestKey = JSON.stringify([
    scopeKey,
    query,
    typeFilter,
    range.from,
    range.to,
    range.timeZone,
  ]);
  const effectiveLookup =
    lookupState?.key === requestKey ? lookupState : undefined;
  useEffect(
    () => () => {
      controller.current?.abort();
      navigationController.current?.abort();
    },
    [scopeKey],
  );
  useEffect(() => () => controller.current?.abort(), [requestKey]);
  useEffect(() => {
    if (/Mac|iPhone|iPad/u.test(navigator.platform)) setShortcut("⌘ K");
  }, []);

  const contextMode = activeSite ? "site" : activeTeam ? "team" : "root";
  const placeholder =
    view === "team" || contextMode === "root"
      ? copy.placeholders.root
      : view === "site" || contextMode === "team"
        ? copy.placeholders.team
        : copy.placeholders.site;
  const showData = siteAllowed && !view;
  const parsed = showData
    ? interpret(query, section, siteDomain, typeFilter)
    : { query: query.trim(), lookups: [] as Lookup[] };
  const activeType = parsed.prefix;
  const listQuery = parsed.query;
  const hasQuery = query.trim().length > 0;
  const commandGroups: readonly SearchCommandGroup[] =
    view === "team" || contextMode === "root"
      ? ["team"]
      : view === "site" || contextMode === "team"
        ? ["site"]
        : activeType
          ? []
          : ["section", "metric"];
  const request: SearchRequest = {
    query: listQuery,
    mode: "global",
    locale,
    scope:
      view === "team"
        ? { userId }
        : view === "site"
          ? { userId, teamId: activeTeam }
          : scope,
    limit: 50,
  };

  const dateLabel = formatDateSpan(
    locale,
    range.timeZone,
    range.from,
    range.to - 1,
  );
  const navigation = commandGroups.length
    ? localPerceptionNavigation(request, commandGroups)
    : [];
  const recent =
    !view && contextMode !== "root" ? recentPerceptionNavigation(scope) : [];
  const relevance = (result: SearchResult) => {
    const recentIndex = recent.indexOf(result.key);
    return (
      (recentIndex < 0 ? 0 : 6 - recentIndex) +
      (targetSection(result) === section ? 8 : 0)
    );
  };
  const score = (result: SearchResult) => resultMatchScore(result, listQuery);
  const resultItem = (
    result: SearchResult,
    window?: TimeWindow,
    keyPrefix = "",
  ): PaletteItem => {
    const field = fieldTypes[result.subtitle ?? ""];
    return {
      key: keyPrefix + result.source + ":" + result.key,
      icon: field?.icon ?? navigationIcon(result),
      label: result.label,
      highlight: true,
      detail: result.group === "site" ? result.subtitle : undefined,
      tag: field ? copy.types[field.type] : undefined,
      score: score(result),
      relevance: relevance(result),
      action: { type: "result", result, window },
    };
  };
  const groups = new Map<GroupKey, PaletteItem[]>();
  const push = (group: GroupKey, ...items: PaletteItem[]) => {
    if (items.length)
      groups.set(group, [...(groups.get(group) ?? []), ...items]);
  };

  // Navigation: recent entries first when idle, then matching commands.
  if (!hasQuery && !activeType && recent.length) {
    const byKey = new Map(navigation.map((result) => [result.key, result]));
    push(
      "recent",
      ...recent
        .flatMap((key) => byKey.get(key) ?? [])
        .filter(
          (result) =>
            targetSection(result) !== section || result.group !== "section",
        )
        .slice(0, 4)
        .map((result) => ({
          ...resultItem(result, undefined, "recent:"),
          tag:
            copy.groups[commandGroupKey[result.group ?? "section"]] ??
            undefined,
        })),
    );
  }
  // Idle lists keep the navigation order; typed queries rank by match.
  const ranked = hasQuery
    ? [...navigation].sort(
        (a, b) => score(b) - score(a) || relevance(b) - relevance(a),
      )
    : [...navigation].sort((a, b) => naturalIndex(a) - naturalIndex(b));
  for (const group of commandGroups) {
    const matches = ranked.filter((result) => result.group === group);
    push(
      commandGroupKey[group],
      ...(hasQuery && contextMode === "site"
        ? matches.slice(0, 5)
        : matches
      ).map((result) => resultItem(result)),
    );
  }

  // Data: the lookup row, then values seen on this device, then server hits.
  const observed =
    showData && !parsed.error && (listQuery || activeType)
      ? localPerceptionObservations({ ...request, limit: 50 })
          .filter(
            (result) =>
              !activeType || result.subtitle === lookupFields[activeType],
          )
          .sort((a, b) => score(b) - score(a) || relevance(b) - relevance(a))
          .slice(0, 8)
      : [];
  const dataRows: PaletteItem[] = [];
  const lookupRow = (lookup: Lookup, retry = false): PaletteItem => ({
    key: "lookup:" + lookup.kind,
    icon: RiSearchLine,
    label: formatI18nTemplate(retry ? copy.lookup.retry : copy.lookup.value, {
      value: lookup.value,
      site: siteName ?? siteDomain ?? "",
    }),
    tag: copy.types[fieldTypes[lookupField[lookup.kind]].type],
    action: { type: "lookup", lookup },
  });
  if (showData) {
    if (effectiveLookup?.response?.failed)
      dataRows.push(lookupRow(effectiveLookup.lookup, true));
    dataRows.push(
      ...parsed.lookups
        .filter((lookup) => lookup.kind !== effectiveLookup?.lookup.kind)
        .map((lookup) => lookupRow(lookup)),
    );
  }
  const serverHits =
    showData && effectiveLookup?.response && activeTeam && activeSite
      ? effectiveLookup.response.hits
      : [];
  const serverIdentities = new Set(
    serverHits.map((hit) =>
      JSON.stringify([lookupFields[hit.kind], hit.value]),
    ),
  );
  dataRows.push(
    ...observed
      .filter(
        (result) =>
          !serverIdentities.has(
            JSON.stringify([result.subtitle, result.label]),
          ),
      )
      .map((result) => resultItem(result)),
  );
  for (const hit of serverHits) {
    const field = lookupFields[hit.kind];
    const result: SearchResult = {
      kind:
        hit.kind === "page"
          ? "page"
          : hit.kind === "referrer"
            ? "referrer"
            : "event",
      key: JSON.stringify([hit.kind, hit.value]),
      label: hit.label ?? hit.value,
      subtitle: field,
      scope: actionScope,
      source: "perception-server",
      coverage: "server-verified",
      action: {
        type: "navigate",
        target: perceptionTarget(activeTeam!, activeSite!, field, hit.value),
      },
    };
    dataRows.push({
      ...resultItem(result, lookupUsesDate(hit.kind) ? range : undefined),
      detail: hit.label && hit.label !== hit.value ? hit.value : undefined,
    });
  }
  push("data", ...dataRows);

  const viewRow = (next: View, label: string): PaletteItem => ({
    key: "view:" + next,
    icon: next ? RiArrowLeftRightLine : RiArrowLeftLine,
    label,
    action: { type: "view", view: next },
  });
  if (view) push("actions", viewRow(null, copy.actions.back));
  else if (!hasQuery && !activeType) {
    if (contextMode === "site")
      push(
        "actions",
        viewRow("site", copy.actions.switchSite),
        viewRow("team", copy.actions.switchTeam),
      );
    else if (contextMode === "team")
      push("actions", viewRow("team", copy.actions.switchTeam));
  }

  const order: GroupKey[] = hasQuery
    ? ["teams", "sites", "data", "sections", "metrics", "actions"]
    : ["recent", "teams", "sites", "sections", "metrics", "data", "actions"];
  const sections = order.flatMap((group) => {
    const items = groups.get(group);
    return items?.length ? [{ group, items }] : [];
  });
  const rows = sections.flatMap((entry) => entry.items);

  const bestResult = rows.reduce<PaletteItem | undefined>(
    (best, item) =>
      item.action.type === "result" &&
      !item.key.startsWith("recent:") &&
      (!best ||
        (item.score ?? 0) > (best.score ?? 0) ||
        (item.score === best.score &&
          (item.relevance ?? 0) > (best.relevance ?? 0)))
        ? item
        : best,
    undefined,
  );
  const preferLookup =
    parsed.prefix ||
    parsed.focused ||
    !bestResult ||
    (bestResult.score ?? 0) < 60;
  const firstLookup = rows.find((row) => row.action.type === "lookup");
  const preferred = !hasQuery
    ? rows[0]
    : !effectiveLookup && preferLookup && firstLookup
      ? firstLookup
      : bestResult;
  const active =
    rows.find((item) => item.key === selected) ?? preferred ?? rows[0];
  const activeIndex = active ? rows.indexOf(active) : -1;
  const activeId = activeIndex >= 0 ? id + "-" + activeIndex : undefined;
  useEffect(() => {
    if (open && activeId)
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeId]);

  const changeQuery = useCallback((next: string) => {
    controller.current?.abort();
    navigationController.current?.abort();
    setQuery(next);
    setSelected(undefined);
    setNotice("");
    setLookupState(undefined);
  }, []);
  const changeOpen = useCallback(
    (next: boolean) => {
      if (next) {
        changeQuery("");
        setTypeFilter(undefined);
        setView(null);
        setOverride(undefined);
      } else {
        controller.current?.abort();
        navigationController.current?.abort();
      }
      setDateOpen(false);
      setOpen(next);
    },
    [changeQuery],
  );

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
      changeOpen(!open);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [changeOpen, open]);

  async function submit(lookup: Lookup) {
    if (!currentPerceptionScope(actionScope.siteId)) return;
    controller.current?.abort();
    const pending = new AbortController();
    const started = performance.now();
    controller.current = pending;
    setLookupState({
      key: requestKey,
      pending: true,
      lookup,
      response:
        effectiveLookup?.lookup.kind === lookup.kind
          ? effectiveLookup?.response
          : undefined,
    });
    setNotice("");
    let response: LookupResponse;
    try {
      response = await lookupPerception({
        ...lookup,
        scope: actionScope,
        window: range,
        signal: pending.signal,
      });
    } catch {
      response = { hits: [], failed: true, revoked: false };
    }
    const activeScope = currentPerceptionScope(actionScope.siteId);
    if (
      pending.signal.aborted ||
      activeScope?.userId !== actionScope.userId ||
      activeScope.teamId !== actionScope.teamId
    )
      return;
    performance.measure("insightflare:search-lookup", {
      start: started,
      detail: {
        type: lookup.kind,
        resultCount: response.hits.length,
        status: response.revoked ? "revoked" : response.failed ? "error" : "ok",
      },
    });
    if (response.revoked) {
      revokePerceptionSite(actionScope.siteId);
      setNotice(copy.unavailable);
      setLookupState(undefined);
      return;
    }
    setSelected(undefined);
    setLookupState({ key: requestKey, pending: false, lookup, response });
  }

  async function navigate(result: SearchResult, foundWindow?: TimeWindow) {
    const context = getPerceptionAuthorization();
    if (!context) return;
    const action = resolveSearchAction(result, context);
    if (!action || action.type !== "navigate") {
      setNotice(copy.unavailable);
      return;
    }
    navigationController.current?.abort();
    const pending = new AbortController();
    navigationController.current = pending;
    const { teamId, siteId } = result.scope;
    try {
      if (teamId) {
        const live = await fetchAdminMe();
        if (pending.signal.aborted) return;
        const teamAllowed =
          live.user.id === context.userId &&
          live.teams.some((team) => team.id === teamId);
        if (!teamAllowed) {
          if (siteId && live.user.id === context.userId)
            revokePerceptionSite(siteId);
          setNotice(copy.unavailable);
          return;
        }
        if (siteId) {
          const sites = await requestAdminService<SiteData[]>("sites", {
            params: { teamId },
          });
          if (pending.signal.aborted) return;
          if (!sites.some((site) => site.id === siteId)) {
            revokePerceptionSite(siteId);
            setNotice(copy.unavailable);
            return;
          }
        }
      }
    } catch {
      if (!pending.signal.aborted) setNotice(copy.lookup.failed);
      return;
    }
    const latest = getPerceptionAuthorization();
    const verified = latest ? resolveSearchAction(result, latest) : null;
    if (pending.signal.aborted) return;
    if (!verified || verified.type !== "navigate") {
      setNotice(copy.unavailable);
      return;
    }
    rememberPerceptionNavigation(scope, result);
    if (foundWindow?.preset === "custom" && override) {
      writeDashboardQueryPreferences({
        range: "custom",
        interval: foundWindow.interval,
        customRange: { from: foundWindow.from, to: foundWindow.to },
      });
    }
    changeOpen(false);
    window.location.assign(verified.href);
  }

  function activate(item: PaletteItem) {
    const action = item.action;
    switch (action.type) {
      case "result":
        void navigate(action.result, action.window);
        break;
      case "lookup":
        void submit(action.lookup);
        break;
      case "view":
        setView(action.view);
        setTypeFilter(undefined);
        changeQuery("");
        input.current?.focus();
        break;
    }
  }

  function chooseType(next: LookupPrefix | undefined) {
    const { prefix, rest } = splitPrefix(query);
    setTypeFilter(next);
    if (prefix) changeQuery(rest);
    else {
      setSelected(undefined);
      setLookupState(undefined);
    }
    input.current?.focus();
  }

  const dateRelevant =
    showData && parsed.lookups.some((lookup) => lookupUsesDate(lookup.kind));
  const pendingRange = normalizeCustomDateRange(dateRange, range.timeZone);
  const dataStatus = effectiveLookup?.pending
    ? copy.lookup.searching
    : effectiveLookup?.response?.failed
      ? copy.lookup.failed
      : effectiveLookup?.response && !effectiveLookup.response.hits.length
        ? copy.lookup.noMatch
        : showData && parsed.error
          ? copy.lookup[parsed.error]
          : showData && activeType && !parsed.lookups.length
            ? copy.lookup.enterValue
            : "";
  const groupLabels: Record<GroupKey, string> = copy.groups;
  if (dataStatus && !groups.has("data")) {
    const index = hasQuery ? 2 : sections.length;
    sections.splice(Math.min(index, sections.length), 0, {
      group: "data",
      items: [],
    });
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-slot="select-trigger"
        data-size="default"
        data-placeholder=""
        className={selectTriggerStyles + " w-full"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={copy.trigger}
        aria-keyshortcuts="Control+K Meta+K"
        data-testid="perception-search-trigger"
        onClick={() => changeOpen(true)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <RiSearchLine aria-hidden="true" />
          <span>{copy.trigger}</span>
        </span>
        <span aria-hidden="true" className="text-[10px] tracking-wide">
          {shortcut}
        </span>
      </button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          desktopClassName="top-[18vh] max-w-xl translate-y-0 gap-0 p-0"
          drawerClassName="h-[80dvh] gap-0 overflow-y-auto p-0 pb-[env(safe-area-inset-bottom)]"
          showCloseButton={false}
          aria-describedby={id + "-description"}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            changeQuery("");
            trigger.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">{copy.title}</DialogTitle>
          <DialogDescription id={id + "-description"} className="sr-only">
            {copy.description}
          </DialogDescription>
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-3">
            {view ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={copy.actions.back}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => activate(viewRow(null, copy.actions.back))}
              >
                <RiArrowLeftLine className="size-4" />
              </button>
            ) : (
              <RiSearchLine
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
            )}
            <input
              autoFocus
              ref={input}
              value={query}
              aria-label={placeholder}
              aria-controls="perception-search-results"
              aria-activedescendant={activeId}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (!rows.length) return;
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setSelected(
                    rows[(activeIndex + step + rows.length) % rows.length]?.key,
                  );
                }
                if (event.key === "Enter" && active) {
                  event.preventDefault();
                  activate(active);
                }
                if (event.key === "Backspace" && !query) {
                  if (typeFilter) chooseType(undefined);
                  else if (view) activate(viewRow(null, copy.actions.back));
                }
              }}
            />
            {siteName && contextMode === "site" && !view ? (
              <span className="max-w-40 shrink-0 truncate border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                {siteName}
              </span>
            ) : null}
          </div>
          {showData ? (
            <div
              role="toolbar"
              aria-label={copy.groups.data}
              className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2"
            >
              <TypeChip
                active={!activeType}
                label={copy.types.all}
                onSelect={() => chooseType(undefined)}
              />
              {lookupPrefixes.map((prefix) => (
                <TypeChip
                  key={prefix}
                  active={activeType === prefix}
                  label={copy.types[chipType[prefix]]}
                  onSelect={() => chooseType(prefix)}
                />
              ))}
            </div>
          ) : null}
          {notice ? (
            <p
              role="alert"
              className="border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {notice}
            </p>
          ) : null}
          <AutoResizer className="w-full" duration={0.2}>
            {dateOpen ? (
              <div className="flex flex-col items-center gap-3 p-3">
                <Calendar
                  mode="range"
                  captionLayout="dropdown"
                  selected={dateRange}
                  onSelect={setDateRange}
                />
                <div className="flex w-full justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDateOpen(false);
                      input.current?.focus();
                    }}
                  >
                    {copy.range.cancel}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!pendingRange}
                    onClick={() => {
                      if (!pendingRange) return;
                      controller.current?.abort();
                      setLookupState(undefined);
                      setSelected(undefined);
                      setOverride(
                        resolveTimeWindow("custom", Date.now(), {
                          customRange: pendingRange,
                          timeZone: range.timeZone,
                        }),
                      );
                      setDateOpen(false);
                      input.current?.focus();
                    }}
                  >
                    {copy.range.apply}
                  </Button>
                </div>
              </div>
            ) : (
              <div
                id="perception-search-results"
                role="listbox"
                aria-label={copy.title}
                aria-busy={effectiveLookup?.pending || undefined}
                className="max-h-[min(26rem,45dvh)] overflow-y-auto py-1 md:max-h-[min(26rem,55vh)]"
              >
                {sections.map(({ group, items }) => (
                  <PaletteGroup
                    key={group}
                    label={groupLabels[group]}
                    status={group === "data" ? dataStatus : undefined}
                    busy={group === "data" && effectiveLookup?.pending}
                  >
                    {items.map((item) => (
                      <PaletteRow
                        key={item.key}
                        id={id + "-" + rows.indexOf(item)}
                        active={item.key === active?.key}
                        icon={item.icon}
                        label={
                          item.highlight ? (
                            <Highlight text={item.label} query={listQuery} />
                          ) : (
                            item.label
                          )
                        }
                        detail={
                          item.detail && item.highlight ? (
                            <Highlight text={item.detail} query={listQuery} />
                          ) : (
                            item.detail
                          )
                        }
                        tag={item.tag}
                        onHover={() => setSelected(item.key)}
                        onSelect={() => activate(item)}
                      />
                    ))}
                  </PaletteGroup>
                ))}
                {!rows.length && !dataStatus ? (
                  <p
                    role="status"
                    className="px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    {copy.empty}
                  </p>
                ) : null}
              </div>
            )}
          </AutoResizer>
          <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-muted-foreground">
            <span className="hidden items-center gap-1 md:flex">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="ml-0.5">{copy.keys.select}</span>
            </span>
            <span className="hidden items-center gap-1 md:flex">
              <Kbd>↵</Kbd>
              <span className="ml-0.5">{copy.keys.open}</span>
            </span>
            <span className="hidden items-center gap-1 sm:flex">
              <Kbd>Esc</Kbd>
              <span className="ml-0.5">{copy.keys.close}</span>
            </span>
            {dateRelevant ? (
              <button
                type="button"
                tabIndex={-1}
                aria-expanded={dateOpen}
                aria-label={copy.range.label + " " + dateLabel}
                className="ml-auto flex min-w-0 items-center gap-1.5 hover:text-foreground"
                onClick={() => {
                  if (!dateOpen)
                    setDateRange(
                      toDateRange(range.from, range.to - 1, range.timeZone),
                    );
                  setDateOpen(!dateOpen);
                }}
              >
                <RiCalendarLine aria-hidden="true" className="size-3.5" />
                <span className="truncate">{dateLabel}</span>
              </button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
