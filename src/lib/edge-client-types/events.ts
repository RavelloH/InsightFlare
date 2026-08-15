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
  data: EventFieldValueStat[];
}

export interface EventRecordDetailData {
  ok: boolean;
  data: {
    event: EventRecord;
    context: {
      visitId: string;
      sessionId: string;
      visitorId: string;
      pathname: string;
      title: string;
      hostname: string;
      referrerHost: string;
      country: string;
      region: string;
      browser: string;
      browserVersion: string;
      os: string;
      osVersion: string;
      deviceType: string;
    };
    eventData: unknown;
  } | null;
}
