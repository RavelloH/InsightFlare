import type { PaginatedCollection } from "./pagination";

export interface EventDimensionRow {
  label: string;
  views: number;
  sessions: number;
  visitors: number;
}

export interface EventGeoDimensionRow extends EventDimensionRow {
  value: string;
}

export interface EventBreakdownsData {
  pages: EventDimensionRow[];
  countries: EventDimensionRow[];
  devices: EventDimensionRow[];
  browsers: EventDimensionRow[];
}

export interface EventAnalyticsContextCardsData {
  page: {
    path: EventDimensionRow[];
    query: EventDimensionRow[];
    title: EventDimensionRow[];
    hostname: EventDimensionRow[];
    entry: EventDimensionRow[];
    exit: EventDimensionRow[];
  };
  source: {
    domain: EventDimensionRow[];
    link: EventDimensionRow[];
  };
  client: {
    browser: EventDimensionRow[];
    osVersion: EventDimensionRow[];
    deviceType: EventDimensionRow[];
    language: EventDimensionRow[];
    screenSize: EventDimensionRow[];
  };
  geo: {
    country: EventGeoDimensionRow[];
    region: EventGeoDimensionRow[];
    city: EventGeoDimensionRow[];
    continent: EventGeoDimensionRow[];
    timezone: EventGeoDimensionRow[];
    organization: EventGeoDimensionRow[];
  };
}

export interface EventAnalyticsCardsData extends EventAnalyticsContextCardsData {
  event: {
    name: EventDimensionRow[];
  };
}

export interface EventAnalyticsSummaryCardsData {
  event: {
    name: EventDimensionRow[];
  };
  page: {
    path: EventDimensionRow[];
    title: EventDimensionRow[];
    hostname: EventDimensionRow[];
  };
}

export interface EventSummaryMetrics {
  events: number;
  eventTypes: number;
  sessions: number;
  visitors: number;
  avgEventsPerSession: number;
}

export interface EventsSummaryData {
  ok: boolean;
  summary: EventSummaryMetrics;
  cards: EventAnalyticsSummaryCardsData;
}

export interface EventTrendSeries {
  key: string;
  eventName: string;
  label: string;
  events: number;
  sessions: number;
  visitors: number;
  isOther?: boolean;
}

export interface EventTrendPoint {
  bucket: number;
  timestampMs: number;
  totalEvents: number;
  eventsBySeries: Record<string, number>;
}

export interface EventsTrendData {
  ok: boolean;
  interval: "minute" | "hour" | "day" | "week" | "month";
  series: EventTrendSeries[];
  data: EventTrendPoint[];
}

export interface EventRecord {
  eventId: string;
  eventName: string;
  eventKind?: "custom_event" | "pageview" | "session_start" | "leave";
  occurredAt: number;
  receivedAt: number;
  sequence: number;
  visitId: string;
  sessionId: string;
  visitorId: string;
  pathname: string;
  title: string;
  hostname: string;
  referrerHost: string;
  country: string;
  region: string;
  city: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  nodeCount: number;
  valueCount: number;
}

export interface EventsRecordsMeta {
  pageSize: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface EventsRecordsData {
  ok: boolean;
  data: EventRecord[];
  meta: EventsRecordsMeta;
}

export interface EventTypeSummaryMetrics extends EventSummaryMetrics {
  shareOfAllEvents: number;
}

export interface EventField {
  path: string;
  valueType: "string" | "number" | "boolean" | "object" | "array" | "null";
  events: number;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  exampleValue?: string | number | boolean | null;
}

export interface EventFieldValueStat {
  value: string | number | boolean | null;
  events: number;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface EventTypeTrendPoint {
  bucket: number;
  timestampMs: number;
  events: number;
  visitors: number;
}

export interface EventTypeDetailData {
  ok: boolean;
  eventName: string;
  summary: EventTypeSummaryMetrics;
  trend: {
    data: EventTypeTrendPoint[];
  };
  breakdowns: EventBreakdownsData;
  cards: EventAnalyticsContextCardsData;
  fields: EventField[];
}

export interface EventFieldValuesData {
  ok: boolean;
  fieldPath: string;
  fieldValueType: EventField["valueType"] | "";
  data: PaginatedCollection<EventFieldValueStat>;
}

export interface EventTypeFieldsData {
  ok: boolean;
  eventName: string;
  data: PaginatedCollection<EventField>;
}

export interface EventRecordDetailData {
  ok: boolean;
  data: {
    event: EventRecord;
    context: EventRecordDetailContext;
    eventData: unknown;
  } | null;
}

export interface JourneyEventDetailData {
  ok: boolean;
  data: {
    event: EventRecord;
    context: EventRecordDetailContext;
  } | null;
}

export interface EventRecordDetailContext {
  visitId: string;
  sessionId: string;
  visitorId: string;
  userId?: string;
  userName?: string;
  pathname: string;
  queryString?: string;
  hash?: string;
  title: string;
  hostname: string;
  referrerUrl?: string;
  referrerHost: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  country: string;
  region: string;
  regionCode?: string;
  city?: string;
  continent?: string;
  latitude?: number | null;
  longitude?: number | null;
  postalCode?: string;
  metroCode?: string;
  timezone?: string;
  organization?: string;
  isEU?: boolean;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  userAgent?: string;
  language?: string;
  screenWidth?: number | null;
  screenHeight?: number | null;
  status?: string;
  startedAt?: number;
  previousVisitId?: string;
  previousVisitStartedAt?: number | null;
  lastActivityAt?: number;
  endedAt?: number | null;
  finalizedAt?: number | null;
  durationMs?: number | null;
  durationSource?: string;
  exitReason?: string;
  performance?: {
    ttfb: number | null;
    fcp: number | null;
    lcp: number | null;
    cls: number | null;
    inp: number | null;
  };
}
