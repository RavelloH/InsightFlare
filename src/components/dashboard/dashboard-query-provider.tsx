"use client";

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

import {
  allowedIntervalsForRange,
  clampIntervalForRange,
  type CustomTimeRange,
  type DashboardFilters,
  type DashboardInterval,
  DEFAULT_RANGE_PRESET,
  finestIntervalForRange,
  type RangePreset,
  resolveRangePreset,
  resolveTimeWindow,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import {
  browserTimeZone,
  resolveReportingTimeZone,
} from "@/lib/dashboard/time-zone";

interface PersistedDashboardQueryState {
  range?: string;
  interval?: DashboardInterval;
  customRange?: CustomTimeRange | null;
  uiFilters?: DashboardFilters;
}

interface DashboardQueryContextValue {
  range: RangePreset;
  window: TimeWindow;
  filters: DashboardFilters;
  uiFilters: DashboardFilters;
  customRange: CustomTimeRange | null;
  setRange: (range: RangePreset) => void;
  setCustomRange: (range: CustomTimeRange | null) => void;
  setInterval: (interval: DashboardInterval) => void;
  setUiFilters: (filters: DashboardFilters) => void;
  clearUiFilters: () => void;
  allowedIntervals: DashboardInterval[];
  timeZone: string;
  timeZonePreference: string;
  browserTimeZone: string;
  setTimeZonePreference: (timeZone: string) => void;
  maxRangeDays?: number;
}

interface DashboardQueryProviderProps {
  children: ReactNode;
  scopeKey?: string;
  initialTimeZonePreference?: string;
  maxRangeDays?: number;
}

const STORAGE_KEY = "insightflare.dashboard.query.v2";
const EMPTY_FILTERS: DashboardFilters = {};
const DEFAULT_RANGE: RangePreset = DEFAULT_RANGE_PRESET;

const DashboardQueryContext = createContext<DashboardQueryContextValue | null>(
  null,
);

function clampFilter(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  if (normalized.length === 0) return undefined;
  const lowered = normalized.toLowerCase();
  if (lowered === "all" || lowered === "null" || lowered === "undefined") {
    return undefined;
  }
  return normalized;
}

function normalizeFilters(
  filters: DashboardFilters | undefined | null,
): DashboardFilters {
  return {
    country: clampFilter(filters?.country),
    device: clampFilter(filters?.device),
    browser: clampFilter(filters?.browser),
    path: clampFilter(filters?.path),
    query: clampFilter(filters?.query),
    title: clampFilter(filters?.title),
    hostname: clampFilter(filters?.hostname),
    entry: clampFilter(filters?.entry),
    exit: clampFilter(filters?.exit),
    sourceDomain: clampFilter(filters?.sourceDomain),
    sourceLink: clampFilter(filters?.sourceLink),
    clientBrowser: clampFilter(filters?.clientBrowser),
    clientOsVersion: clampFilter(filters?.clientOsVersion),
    clientDeviceType: clampFilter(filters?.clientDeviceType),
    clientLanguage: clampFilter(filters?.clientLanguage),
    clientScreenSize: clampFilter(filters?.clientScreenSize),
    geo: clampFilter(filters?.geo),
    geoContinent: clampFilter(filters?.geoContinent),
    geoTimezone: clampFilter(filters?.geoTimezone),
    geoOrganization: clampFilter(filters?.geoOrganization),
  };
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

function parsePersistedState(
  raw: string | null,
): PersistedDashboardQueryState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedDashboardQueryState;
    return parsed;
  } catch {
    return null;
  }
}

function buildInitialState(initialTimeZonePreference: string) {
  const timeZone = resolveReportingTimeZone(initialTimeZonePreference);
  if (typeof window === "undefined") {
    const initialWindow = resolveTimeWindow(DEFAULT_RANGE, Date.now(), {
      timeZone,
    });
    return {
      range: DEFAULT_RANGE as RangePreset,
      interval: initialWindow.interval as DashboardInterval,
      customRange: null as CustomTimeRange | null,
      uiFilters: EMPTY_FILTERS as DashboardFilters,
      timeZonePreference: initialTimeZonePreference,
    };
  }

  const persisted = parsePersistedState(
    window.localStorage.getItem(STORAGE_KEY),
  );
  if (!persisted) {
    const initialWindow = resolveTimeWindow(DEFAULT_RANGE, Date.now(), {
      timeZone,
    });
    return {
      range: DEFAULT_RANGE as RangePreset,
      interval: initialWindow.interval as DashboardInterval,
      customRange: null as CustomTimeRange | null,
      uiFilters: EMPTY_FILTERS as DashboardFilters,
      timeZonePreference: initialTimeZonePreference,
    };
  }

  const persistedRange = resolveRangePreset(persisted.range) as RangePreset;
  const persistedCustomRange = normalizeCustomRange(persisted.customRange);
  const persistedWindow = resolveTimeWindow(persistedRange, Date.now(), {
    customRange: persistedCustomRange || undefined,
    interval: persisted.interval ?? null,
    timeZone,
  });

  return {
    range: persistedRange,
    interval: persistedWindow.interval,
    customRange: persistedCustomRange,
    uiFilters: normalizeFilters(persisted.uiFilters),
    timeZonePreference: initialTimeZonePreference,
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
  if (range === "all") return "12m";
  return range;
}

export function DashboardQueryProvider({
  children,
  scopeKey = "",
  initialTimeZonePreference = "",
  maxRangeDays,
}: DashboardQueryProviderProps) {
  const initial = useMemo(
    () => buildInitialState(initialTimeZonePreference),
    [initialTimeZonePreference],
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
  const [uiFilters, setUiFiltersState] = useState<DashboardFilters>(
    initial.uiFilters,
  );
  const [timeZonePreference, setTimeZonePreferenceState] = useState(
    initial.timeZonePreference,
  );
  const [detectedBrowserTimeZone, setDetectedBrowserTimeZone] = useState("");
  const previousScopeKeyRef = useRef(scopeKey);
  const timeZone = resolveReportingTimeZone(
    timeZonePreference,
    detectedBrowserTimeZone,
  );

  const windowState = useMemo(
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

  useEffect(() => {
    setDetectedBrowserTimeZone(browserTimeZone());
  }, []);

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

    const payload: PersistedDashboardQueryState = {
      range,
      interval: windowState.interval,
      customRange,
      uiFilters: normalizeFilters(uiFilters),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [range, windowState.interval, customRange, uiFilters]);

  useEffect(() => {
    if (previousScopeKeyRef.current === scopeKey) return;
    previousScopeKeyRef.current = scopeKey;
    // Site-scoped data filters are easy to carry across sites and cause empty states.
    setUiFiltersState(EMPTY_FILTERS);
  }, [scopeKey]);

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

  const setTimeZonePreference = useCallback((next: string) => {
    setTimeZonePreferenceState(next);
  }, []);

  const setUiFilters = useCallback((next: DashboardFilters) => {
    setUiFiltersState(normalizeFilters(next));
  }, []);

  const clearUiFilters = useCallback(() => {
    setUiFiltersState(EMPTY_FILTERS);
  }, []);

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
      customRange,
      setRange,
      setCustomRange,
      setInterval,
      setUiFilters,
      clearUiFilters,
      allowedIntervals,
      timeZone,
      timeZonePreference,
      browserTimeZone: detectedBrowserTimeZone,
      setTimeZonePreference,
      maxRangeDays,
    }),
    [
      range,
      windowState,
      uiFilters,
      customRange,
      setRange,
      setCustomRange,
      setInterval,
      setUiFilters,
      clearUiFilters,
      allowedIntervals,
      timeZone,
      timeZonePreference,
      detectedBrowserTimeZone,
      setTimeZonePreference,
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
      customRange: null,
      setRange: () => {},
      setCustomRange: () => {},
      setInterval: () => {},
      setUiFilters: () => {},
      clearUiFilters: () => {},
      allowedIntervals: ["hour", "day", "week", "month"],
      timeZone: fallbackWindow.timeZone,
      timeZonePreference: "",
      browserTimeZone: "",
      setTimeZonePreference: () => {},
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
  };
}

export function useDashboardQueryControls() {
  return useDashboardQueryContext();
}
