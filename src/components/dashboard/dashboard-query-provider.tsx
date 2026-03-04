"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  allowedIntervalsForRange,
  clampIntervalForRange,
  finestIntervalForRange,
  resolveRangePreset,
  resolveTimeWindow,
  type CustomTimeRange,
  type DashboardFilters,
  type DashboardInterval,
  type RangePreset,
  type TimeWindow,
} from "@/lib/dashboard/query-state";

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
}

interface DashboardQueryProviderProps {
  children: ReactNode;
}

const STORAGE_KEY = "insightflare.dashboard.query.v2";
const EMPTY_FILTERS: DashboardFilters = {};
const DEFAULT_RANGE: RangePreset = "7d";

const DashboardQueryContext = createContext<DashboardQueryContextValue | null>(null);

function clampFilter(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeFilters(filters: DashboardFilters | undefined | null): DashboardFilters {
  return {
    country: clampFilter(filters?.country),
    device: clampFilter(filters?.device),
    browser: clampFilter(filters?.browser),
    eventType: clampFilter(filters?.eventType),
  };
}

function normalizeCustomRange(range: CustomTimeRange | undefined | null): CustomTimeRange | null {
  if (!range) return null;
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
  if (range.from >= range.to) return null;
  return {
    from: Math.max(0, Math.floor(range.from)),
    to: Math.max(1, Math.floor(range.to)),
  };
}

function parsePersistedState(raw: string | null): PersistedDashboardQueryState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedDashboardQueryState;
    return parsed;
  } catch {
    return null;
  }
}

function buildInitialState() {
  if (typeof window === "undefined") {
    const initialWindow = resolveTimeWindow(DEFAULT_RANGE);
    return {
      range: DEFAULT_RANGE as RangePreset,
      interval: initialWindow.interval as DashboardInterval,
      customRange: null as CustomTimeRange | null,
      uiFilters: EMPTY_FILTERS as DashboardFilters,
    };
  }

  const persisted = parsePersistedState(window.localStorage.getItem(STORAGE_KEY));
  if (!persisted) {
    const initialWindow = resolveTimeWindow(DEFAULT_RANGE);
    return {
      range: DEFAULT_RANGE as RangePreset,
      interval: initialWindow.interval as DashboardInterval,
      customRange: null as CustomTimeRange | null,
      uiFilters: EMPTY_FILTERS as DashboardFilters,
    };
  }

  const persistedRange = resolveRangePreset(persisted.range) as RangePreset;
  const persistedCustomRange = normalizeCustomRange(persisted.customRange);
  const persistedWindow = resolveTimeWindow(persistedRange, Date.now(), {
    customRange: persistedCustomRange || undefined,
    interval: persisted.interval ?? null,
  });

  return {
    range: persistedRange,
    interval: persistedWindow.interval,
    customRange: persistedCustomRange,
    uiFilters: normalizeFilters(persisted.uiFilters),
  };
}

export function DashboardQueryProvider({ children }: DashboardQueryProviderProps) {
  const initial = useMemo(() => buildInitialState(), []);
  const [range, setRangeState] = useState<RangePreset>(initial.range);
  const [interval, setIntervalState] = useState<DashboardInterval>(initial.interval);
  const [customRange, setCustomRangeState] = useState<CustomTimeRange | null>(initial.customRange);
  const [uiFilters, setUiFiltersState] = useState<DashboardFilters>(initial.uiFilters);

  const windowState = useMemo(
    () =>
      resolveTimeWindow(range, Date.now(), {
        customRange: customRange || undefined,
        interval,
      }),
    [range, customRange, interval],
  );

  useEffect(() => {
    const clamped = clampIntervalForRange(interval, windowState.from, windowState.to);
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

  const setRange = useCallback((next: RangePreset) => {
    if (next === "custom" && !customRange) {
      setRangeState(next);
      return;
    }
    const nextWindow = resolveTimeWindow(next, Date.now(), {
      customRange: customRange || undefined,
      interval: null,
    });
    setRangeState(next);
    setIntervalState(finestIntervalForRange(nextWindow.from, nextWindow.to));
  }, [customRange]);

  const setCustomRange = useCallback((next: CustomTimeRange | null) => {
    const normalized = normalizeCustomRange(next);
    setCustomRangeState(normalized);
    if (normalized) {
      setRangeState("custom");
      setIntervalState(finestIntervalForRange(normalized.from, normalized.to));
    }
  }, []);

  const setInterval = useCallback((next: DashboardInterval) => {
    setIntervalState(next);
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
      filters: EMPTY_FILTERS,
      uiFilters,
      customRange,
      setRange,
      setCustomRange,
      setInterval,
      setUiFilters,
      clearUiFilters,
      allowedIntervals,
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
