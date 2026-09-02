import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useReportingTimeZone } from "@/components/time-zone-provider";
import { useLiveSearchParams } from "@/lib/client-history";
import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import {
  readDashboardQueryPreferences,
  readReportingTimeZoneFromCookie,
  writeDashboardQueryPreferences,
} from "@/lib/dashboard/query-preferences";
import {
  allowedIntervalsForRange,
  clampIntervalForRange,
  type CustomTimeRange,
  type DashboardInterval,
  DEFAULT_RANGE_PRESET,
  finestIntervalForRange,
  parseFilterDocumentFromSearchParams,
  type RangePreset,
  resolveRangePreset,
  resolveTimeWindow,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import {
  analyticsFilterRegistry,
  attachFilterScopePreference,
  type FilterDocument,
  type FilterScopePreference,
  filterScopePreferenceFromDocument,
  normalizeFilterDocument,
  parseFilterScopePreference,
} from "@/lib/filter-contract";

interface DashboardQueryContextValue {
  range: RangePreset;
  window: TimeWindow;
  filters: FilterDocument;
  uiFilters: FilterDocument;
  uiFilterDsl?: string;
  scopePreference: FilterScopePreference;
  customRange: CustomTimeRange | null;
  setRange: (range: RangePreset) => void;
  setCustomRange: (range: CustomTimeRange | null) => void;
  setInterval: (interval: DashboardInterval) => void;
  setUiFilters: (filters: FilterDocument, rawDsl?: string) => void;
  setScopePreference: (preference: FilterScopePreference) => void;
  clearUiFilters: () => void;
  allowedIntervals: DashboardInterval[];
  timeZone: string;
  maxRangeDays?: number;
}

interface DashboardQueryProviderProps {
  children: ReactNode;
  scopeKey?: string;
  maxRangeDays?: number;
  initialWindow?: TimeWindow;
  initialFilters?: FilterDocument;
  initialScopePreference?: FilterScopePreference;
}

const EMPTY_FILTERS = EMPTY_DASHBOARD_FILTER_DOCUMENT;
const DEFAULT_RANGE: RangePreset = DEFAULT_RANGE_PRESET;

const DashboardQueryContext = createContext<DashboardQueryContextValue | null>(
  null,
);

function normalizeFilters(
  filters: FilterDocument | undefined | null,
): FilterDocument {
  if (!filters) return EMPTY_FILTERS;
  try {
    const normalized = normalizeFilterDocument(
      filters,
      analyticsFilterRegistry,
    );
    const scopePreference = filterScopePreferenceFromDocument(filters);
    return scopePreference
      ? attachFilterScopePreference(normalized, scopePreference)
      : normalized;
  } catch {
    return EMPTY_FILTERS;
  }
}

function readInitialScopePreference(): FilterScopePreference {
  if (typeof window === "undefined") return "auto";
  return parseFilterScopePreference(window.location.search);
}

function filterDocumentKey(filters: FilterDocument): string {
  return JSON.stringify(normalizeFilters(filters));
}

function persistedRawDsl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function normalizeCustomRange(
  range: CustomTimeRange | undefined | null,
): CustomTimeRange | null {
  if (!range) return null;
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
  if (range.from >= range.to) return null;
  return {
    from: Math.max(0, Math.floor(range.from)),
    to: Math.max(1, Math.floor(range.to)),
  };
}

function buildInitialState(
  timeZone: string,
  initialWindow?: TimeWindow,
  initialScope?: FilterScopePreference,
  initialFilters?: FilterDocument,
) {
  const scopePreference =
    initialScope ??
    filterScopePreferenceFromDocument(initialFilters) ??
    readInitialScopePreference();
  const uiFilters = attachFilterScopePreference(
    normalizeFilters(initialFilters ?? EMPTY_FILTERS),
    scopePreference,
  );
  if (initialWindow) {
    return {
      range: initialWindow.preset,
      interval: initialWindow.interval,
      customRange:
        initialWindow.preset === "custom"
          ? { from: initialWindow.from, to: initialWindow.to }
          : null,
      uiFilters,
      uiFilterDsl: undefined,
      scopePreference,
    };
  }

  if (typeof window === "undefined") {
    const initialWindow = resolveTimeWindow(DEFAULT_RANGE, Date.now(), {
      timeZone,
    });
    return {
      range: DEFAULT_RANGE as RangePreset,
      interval: initialWindow.interval as DashboardInterval,
      customRange: null as CustomTimeRange | null,
      uiFilters,
      uiFilterDsl: undefined,
      scopePreference,
    };
  }

  const persisted = readDashboardQueryPreferences(document.cookie);
  const persistedRange = resolveRangePreset(persisted.range) as RangePreset;
  const persistedCustomRange = normalizeCustomRange(persisted.customRange);
  const persistedWindow = resolveTimeWindow(persistedRange, Date.now(), {
    customRange: persistedCustomRange ?? undefined,
    interval: persisted.interval,
    timeZone,
  });

  return {
    range: persistedRange,
    interval: persistedWindow.interval,
    customRange: persistedCustomRange,
    uiFilters,
    uiFilterDsl: undefined,
    scopePreference,
  };
}

function clampCustomRangeToMaxDays(
  range: CustomTimeRange | null,
  maxRangeDays?: number,
): CustomTimeRange | null {
  if (!range || !maxRangeDays) return range;
  const maxSpan = maxRangeDays * 24 * 60 * 60 * 1000;
  if (range.to - range.from <= maxSpan) return range;
  return {
    from: Math.max(0, range.to - maxSpan),
    to: range.to,
  };
}

function clampPresetForMaxDays(
  range: RangePreset,
  maxRangeDays?: number,
): RangePreset {
  if (!maxRangeDays) return range;
  if ((range === "6m" || range === "12m") && maxRangeDays <= 90) {
    return "90d";
  }
  if (range === "thisYear" && maxRangeDays <= 90) {
    return "90d";
  }
  if (range === "all") return "12m";
  return range;
}

export function DashboardQueryProvider({
  children,
  scopeKey = "",
  maxRangeDays,
  initialWindow,
  initialFilters,
  initialScopePreference,
}: DashboardQueryProviderProps) {
  const { timeZone: managedTimeZone } = useReportingTimeZone();
  const routeSearchParams = useLiveSearchParams();
  const routeSearchParamsKey = routeSearchParams.toString();
  // During the first client render after SSR, useSyncExternalStore may still
  // use its server snapshot (an empty search string) for hydration. Capture
  // the browser URL separately so the first analytics query cannot run with
  // an empty filter document and leave its unfiltered result in the cache.
  const initialRouteSearchParamsKeyRef = useRef<string | null>(null);
  if (initialRouteSearchParamsKeyRef.current === null) {
    initialRouteSearchParamsKeyRef.current =
      typeof window === "undefined"
        ? routeSearchParamsKey
        : window.location.search;
  }
  const routeQueryDocument = useMemo(
    () =>
      parseFilterDocumentFromSearchParams(
        new URLSearchParams(routeSearchParamsKey),
      ),
    [routeSearchParamsKey],
  );
  const initialRouteQueryDocument = useMemo(
    () =>
      parseFilterDocumentFromSearchParams(
        new URLSearchParams(initialRouteSearchParamsKeyRef.current ?? ""),
      ),
    [],
  );
  const initialCookieTimeZone =
    typeof document === "undefined"
      ? managedTimeZone
      : readReportingTimeZoneFromCookie(document.cookie);
  const initialWindowRef = useRef(initialWindow);
  const [timeZone, setTimeZone] = useState(
    () => initialWindowRef.current?.timeZone ?? initialCookieTimeZone,
  );
  const [initial] = useState(() =>
    buildInitialState(
      timeZone,
      initialWindowRef.current,
      initialScopePreference,
      initialFilters ?? initialRouteQueryDocument,
    ),
  );
  const [range, setRangeState] = useState<RangePreset>(
    clampPresetForMaxDays(initial.range, maxRangeDays),
  );
  const [interval, setIntervalState] = useState<DashboardInterval>(
    initial.interval,
  );
  const [customRange, setCustomRangeState] = useState<CustomTimeRange | null>(
    clampCustomRangeToMaxDays(initial.customRange, maxRangeDays),
  );
  const [uiFilters, setUiFiltersState] = useState<FilterDocument>(
    initial.uiFilters,
  );
  const [uiFilterDsl, setUiFilterDslState] = useState<string | undefined>(
    initial.uiFilterDsl,
  );
  const [scopePreference, setScopePreferenceState] =
    useState<FilterScopePreference>(initial.scopePreference);
  const [uiFilterDslDocumentKey, setUiFilterDslDocumentKey] = useState(() =>
    initial.uiFilterDsl ? filterDocumentKey(initial.uiFilters) : undefined,
  );
  const previousScopeKeyRef = useRef(scopeKey);
  const previousRouteSearchParamsKeyRef = useRef(routeSearchParamsKey);

  useEffect(() => {
    setTimeZone(managedTimeZone);
  }, [managedTimeZone]);

  const resolvedWindow = useMemo(
    () =>
      resolveTimeWindow(
        clampPresetForMaxDays(range, maxRangeDays),
        Date.now(),
        {
          customRange: customRange || undefined,
          interval,
          timeZone,
        },
      ),
    [range, maxRangeDays, customRange, interval, timeZone],
  );
  const windowState = useMemo(() => {
    const snapshot = initialWindowRef.current;
    const initialCustomRange =
      snapshot?.preset === "custom"
        ? { from: snapshot.from, to: snapshot.to }
        : null;
    const isInitialSelection =
      snapshot &&
      range === snapshot.preset &&
      interval === snapshot.interval &&
      timeZone === snapshot.timeZone &&
      JSON.stringify(customRange) === JSON.stringify(initialCustomRange);
    return isInitialSelection ? snapshot : resolvedWindow;
  }, [customRange, interval, range, resolvedWindow, timeZone]);

  useEffect(() => {
    const clamped = clampIntervalForRange(
      interval,
      windowState.from,
      windowState.to,
    );
    if (clamped !== interval) {
      setIntervalState(clamped);
    }
  }, [interval, windowState.from, windowState.to]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    writeDashboardQueryPreferences({
      range,
      interval: windowState.interval,
      customRange,
    });
  }, [range, windowState.interval, customRange]);

  useEffect(() => {
    if (previousScopeKeyRef.current === scopeKey) return;
    const previousScopeKey = previousScopeKeyRef.current;
    previousScopeKeyRef.current = scopeKey;
    // The shell can render before its site list has resolved. Treat the
    // initial empty-to-site transition as scope initialization so URL filters
    // are not cleared after the first correctly scoped request completes.
    if (!previousScopeKey) return;
    // Site-scoped data filters are easy to carry across sites and cause empty states.
    setUiFiltersState(EMPTY_FILTERS);
    setUiFilterDslState(undefined);
    setUiFilterDslDocumentKey(undefined);
  }, [scopeKey]);

  useEffect(() => {
    if (previousRouteSearchParamsKeyRef.current === routeSearchParamsKey) {
      return;
    }
    previousRouteSearchParamsKeyRef.current = routeSearchParamsKey;

    const nextScopePreference = parseFilterScopePreference(
      new URLSearchParams(routeSearchParamsKey),
    );
    const nextFilters = attachFilterScopePreference(
      normalizeFilters(routeQueryDocument),
      nextScopePreference,
    );
    const nextDocumentKey = filterDocumentKey(nextFilters);

    setScopePreferenceState(nextScopePreference);
    setUiFiltersState(nextFilters);
    if (uiFilterDslDocumentKey !== nextDocumentKey) {
      setUiFilterDslState(undefined);
      setUiFilterDslDocumentKey(undefined);
    }
  }, [routeQueryDocument, routeSearchParamsKey, uiFilterDslDocumentKey]);

  const setRange = useCallback(
    (next: RangePreset) => {
      const clampedNext = clampPresetForMaxDays(next, maxRangeDays);
      if (next === "custom" && !customRange) {
        setRangeState(clampedNext);
        return;
      }
      const nextWindow = resolveTimeWindow(clampedNext, Date.now(), {
        customRange: customRange || undefined,
        interval: null,
        timeZone,
      });
      setRangeState(clampedNext);
      setIntervalState(finestIntervalForRange(nextWindow.from, nextWindow.to));
    },
    [customRange, maxRangeDays, timeZone],
  );

  const setCustomRange = useCallback(
    (next: CustomTimeRange | null) => {
      const normalized = clampCustomRangeToMaxDays(
        normalizeCustomRange(next),
        maxRangeDays,
      );
      setCustomRangeState(normalized);
      if (normalized) {
        setRangeState("custom");
        setIntervalState(
          finestIntervalForRange(normalized.from, normalized.to),
        );
      }
    },
    [maxRangeDays],
  );

  const setInterval = useCallback((next: DashboardInterval) => {
    setIntervalState(next);
  }, []);

  const setScopePreference = useCallback((next: FilterScopePreference) => {
    setScopePreferenceState(next);
    setUiFiltersState((current) =>
      attachFilterScopePreference(normalizeFilters(current), next),
    );
  }, []);

  const setUiFilters = useCallback(
    (next: FilterDocument, rawDsl?: string) => {
      const normalized = normalizeFilters(next);
      const nextScope =
        filterScopePreferenceFromDocument(next) ?? scopePreference;
      const scoped = attachFilterScopePreference(normalized, nextScope);
      const nextKey = filterDocumentKey(scoped);
      setUiFiltersState(scoped);
      if (rawDsl !== undefined) {
        const persisted = persistedRawDsl(rawDsl);
        setUiFilterDslState(persisted);
        setUiFilterDslDocumentKey(persisted ? nextKey : undefined);
        return;
      }
      if (uiFilterDslDocumentKey !== nextKey) {
        setUiFilterDslState(undefined);
        setUiFilterDslDocumentKey(undefined);
      }
    },
    [scopePreference, uiFilterDslDocumentKey],
  );

  const clearUiFilters = useCallback(() => {
    setUiFiltersState(
      attachFilterScopePreference(EMPTY_FILTERS, scopePreference),
    );
    setUiFilterDslState(undefined);
    setUiFilterDslDocumentKey(undefined);
  }, [scopePreference]);

  const allowedIntervals = useMemo(
    () => allowedIntervalsForRange(windowState.from, windowState.to),
    [windowState.from, windowState.to],
  );

  const contextValue = useMemo<DashboardQueryContextValue>(
    () => ({
      range,
      window: windowState,
      filters: normalizeFilters(uiFilters),
      uiFilters,
      uiFilterDsl,
      scopePreference,
      customRange,
      setRange,
      setCustomRange,
      setInterval,
      setUiFilters,
      setScopePreference,
      clearUiFilters,
      allowedIntervals,
      timeZone,
      maxRangeDays,
    }),
    [
      range,
      windowState,
      uiFilters,
      uiFilterDsl,
      scopePreference,
      customRange,
      setRange,
      setCustomRange,
      setInterval,
      setUiFilters,
      setScopePreference,
      clearUiFilters,
      allowedIntervals,
      timeZone,
      maxRangeDays,
    ],
  );

  return (
    <DashboardQueryContext.Provider value={contextValue}>
      {children}
    </DashboardQueryContext.Provider>
  );
}

function useDashboardQueryContext(): DashboardQueryContextValue {
  const context = useContext(DashboardQueryContext);
  if (!context) {
    const fallbackWindow = resolveTimeWindow(DEFAULT_RANGE);
    return {
      range: DEFAULT_RANGE,
      window: fallbackWindow,
      filters: EMPTY_FILTERS,
      uiFilters: EMPTY_FILTERS,
      uiFilterDsl: undefined,
      scopePreference: "auto",
      customRange: null,
      setRange: () => {},
      setCustomRange: () => {},
      setInterval: () => {},
      setUiFilters: () => {},
      setScopePreference: () => {},
      clearUiFilters: () => {},
      allowedIntervals: ["hour", "day", "week", "month"],
      timeZone: fallbackWindow.timeZone,
      maxRangeDays: undefined,
    };
  }
  return context;
}

export function useDashboardQuery() {
  const context = useDashboardQueryContext();
  return {
    range: context.range,
    filters: context.filters,
    window: context.window,
    scopePreference: context.scopePreference,
  };
}

export function useDashboardQueryControls() {
  return useDashboardQueryContext();
}
