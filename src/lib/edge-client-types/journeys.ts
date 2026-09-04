import type { PaginatedCollection } from "./pagination";
import type {
  JourneyPerformanceSummary,
  VisitPerformanceMetrics,
} from "./performance";

export interface VisitorsMeta {
  pageSize: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface VisitorsData {
  ok: boolean;
  data: Array<{
    visitorId: string;
    sessionId?: string;
    firstSeenAt: number;
    lastSeenAt: number;
    views: number;
    sessions: number;
    events?: number;
    country?: string;
    region?: string;
    regionCode?: string;
    city?: string;
    referrerHost?: string;
    referrerUrl?: string;
    browser?: string;
    browserVersion?: string;
    os?: string;
    osVersion?: string;
    deviceType?: string;
    screenWidth?: number | null;
    screenHeight?: number | null;
  }>;
  meta: VisitorsMeta;
}

export interface JourneySession {
  sessionId: string;
  visitorId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  active: boolean;
  views: number;
  events: number;
  bounce: boolean;
  entryPath: string;
  exitPath: string;
  referrerHost: string;
  referrerUrl: string;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
}

export interface JourneyLocationPoint {
  latitude: number;
  longitude: number;
  timestampMs: number;
  country: string;
  region?: string;
  regionCode?: string;
  city?: string;
}

export interface JourneyEvent {
  id: string;
  kind: "session_start" | "pageview" | "leave" | "custom";
  eventType: string;
  occurredAt: number;
  visitId: string;
  sessionId: string;
  visitorId: string;
  pathname: string;
  hash: string;
  title: string;
  hostname: string;
  referrerHost: string;
  referrerUrl: string;
  country: string;
  region: string;
  city: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
  durationMs: number;
  performance: VisitPerformanceMetrics;
}

export interface JourneyPageCount {
  pathname: string;
  views: number;
}

export interface JourneyEventCount {
  eventType: string;
  count: number;
}

export interface VisitorActivityDay {
  date: string;
  count: number;
}

export interface VisitorDetailData {
  ok: boolean;
  data: {
    visitor: VisitorsData["data"][number];
    metrics: {
      totalEvents: number;
      sessions: number;
      views: number;
      avgEventsPerSession: number;
      bounceRate: number;
      avgDurationMs: number;
      p90DurationMs: number;
      firstSeenAt: number;
      lastSeenAt: number;
      daysActive: number;
      conversionEvents: number;
      avgTimeBetweenSessionsMs: number;
    };
    sessions: JourneySession[];
    events: JourneyEvent[];
    visitedPages: JourneyPageCount[];
    eventDistribution: JourneyEventCount[];
    activity: VisitorActivityDay[];
    performance: JourneyPerformanceSummary;
  } | null;
}

export type JourneyEventsData = {
  ok: boolean;
  data: PaginatedCollection<JourneyEvent>;
};

export type VisitorSessionsData = {
  ok: boolean;
  data: PaginatedCollection<JourneySession>;
};

export type SessionEventsData = JourneyEventsData;

export interface SessionsMeta {
  pageSize: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SessionsData {
  ok: boolean;
  data: JourneySession[];
  meta: SessionsMeta;
}

export interface SessionDetailData {
  ok: boolean;
  data: {
    session: JourneySession;
    locationPoints: JourneyLocationPoint[];
    events: JourneyEvent[];
    visitedPages: JourneyPageCount[];
    eventDistribution: JourneyEventCount[];
    performance: JourneyPerformanceSummary;
  } | null;
}

export interface RetentionData {
  ok: boolean;
  granularity: string;
  cohorts: Array<{
    bucket: number;
    size: number;
    periods: Array<{
      index: number;
      visitors: number;
      rate: number;
    }>;
  }>;
}
