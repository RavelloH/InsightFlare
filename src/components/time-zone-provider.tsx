import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import {
  browserTimeZone as detectBrowserTimeZone,
  normalizeTimeZone,
  resolveReportingTimeZone,
  writeReportingTimeZoneCookie,
} from "@/lib/dashboard/time-zone";

interface TimeZoneContextValue {
  timeZone: string;
  timeZonePreference: string;
  browserTimeZone: string;
  setTimeZonePreference: (timeZone: string) => void;
}

const TimeZoneContext = createContext<TimeZoneContextValue | null>(null);
const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const [timeZonePreference, setTimeZonePreferenceState] = useState("");
  // Read the browser zone during the first client render so API consumers do
  // not briefly construct their initial windows with the UTC server fallback.
  const [browserTimeZone, setBrowserTimeZone] = useState(() =>
    typeof window === "undefined" ? "" : detectBrowserTimeZone(),
  );
  const refreshBrowserTimeZone = useCallback(() => {
    setBrowserTimeZone(detectBrowserTimeZone());
  }, []);

  useClientLayoutEffect(() => {
    refreshBrowserTimeZone();
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") refreshBrowserTimeZone();
    };
    window.addEventListener("focus", refreshBrowserTimeZone);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.removeEventListener("focus", refreshBrowserTimeZone);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [refreshBrowserTimeZone]);

  const timeZone = resolveReportingTimeZone(
    timeZonePreference,
    browserTimeZone,
  );

  useEffect(() => {
    writeReportingTimeZoneCookie(timeZone);
  }, [timeZone]);

  const setTimeZonePreference = useCallback((next: string) => {
    setTimeZonePreferenceState(normalizeTimeZone(next));
  }, []);

  const value = useMemo<TimeZoneContextValue>(
    () => ({
      timeZone,
      timeZonePreference,
      browserTimeZone,
      setTimeZonePreference,
    }),
    [browserTimeZone, setTimeZonePreference, timeZone, timeZonePreference],
  );

  return (
    <TimeZoneContext.Provider value={value}>
      {children}
    </TimeZoneContext.Provider>
  );
}

export function useReportingTimeZone(): TimeZoneContextValue {
  const context = useContext(TimeZoneContext);
  if (!context) {
    throw new Error(
      "useReportingTimeZone must be used within TimeZoneProvider",
    );
  }
  return context;
}

/** Connects an authenticated dashboard shell to the global client manager. */
export function useAccountTimeZonePreference(
  timeZone: string | null | undefined,
) {
  const { setTimeZonePreference } = useReportingTimeZone();
  useClientLayoutEffect(() => {
    setTimeZonePreference(timeZone || "");
    return () => setTimeZonePreference("");
  }, [setTimeZonePreference, timeZone]);
}
