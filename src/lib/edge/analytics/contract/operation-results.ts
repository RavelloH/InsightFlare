import type { PageResult, PaginationMeta } from "@/lib/pagination";

import type { GoalDefinition } from "./goal";
import type {
  CalendarGranularity,
  Interval,
  PerformanceMetricKey,
} from "./types";

export interface CanonicalAnalyticsTab {
  readonly label: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}

export interface CanonicalGeoAnalyticsTab extends CanonicalAnalyticsTab {
  readonly value: string;
}

export interface CanonicalEventContextCards {
  readonly page: {
    readonly path: readonly CanonicalAnalyticsTab[];
    readonly query: readonly CanonicalAnalyticsTab[];
    readonly title: readonly CanonicalAnalyticsTab[];
    readonly hostname: readonly CanonicalAnalyticsTab[];
    readonly entry: readonly CanonicalAnalyticsTab[];
    readonly exit: readonly CanonicalAnalyticsTab[];
  };
  readonly source: {
    readonly domain: readonly CanonicalAnalyticsTab[];
    readonly link: readonly CanonicalAnalyticsTab[];
  };
  readonly client: {
    readonly browser: readonly CanonicalAnalyticsTab[];
    readonly osVersion: readonly CanonicalAnalyticsTab[];
    readonly deviceType: readonly CanonicalAnalyticsTab[];
    readonly language: readonly CanonicalAnalyticsTab[];
    readonly screenSize: readonly CanonicalAnalyticsTab[];
  };
  readonly geo: {
    readonly country: readonly CanonicalGeoAnalyticsTab[];
    readonly region: readonly CanonicalGeoAnalyticsTab[];
    readonly city: readonly CanonicalGeoAnalyticsTab[];
    readonly continent: readonly CanonicalGeoAnalyticsTab[];
    readonly timezone: readonly CanonicalGeoAnalyticsTab[];
    readonly organization: readonly CanonicalGeoAnalyticsTab[];
  };
}

export interface CanonicalEventRecord {
  readonly eventId: string;
  readonly eventName: string;
  readonly occurredAt: number;
  readonly receivedAt: number;
  readonly sequence: number;
  readonly visitId: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly pathname: string;
  readonly title: string;
  readonly hostname: string;
  readonly referrerHost: string;
  readonly country: string;
  readonly region: string;
  readonly city: string;
  readonly browser: string;
  readonly browserVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly deviceType: string;
  readonly nodeCount: number;
  readonly valueCount: number;
}

export interface CanonicalEventRecordDetail extends CanonicalEventRecord {
  readonly eventKind: "custom_event";
}

export interface CanonicalEventRecordContext {
  readonly visitId: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly userId: string;
  readonly userName: string;
  readonly pathname: string;
  readonly queryString: string;
  readonly hash: string;
  readonly title: string;
  readonly hostname: string;
  readonly referrerUrl: string;
  readonly referrerHost: string;
  readonly utmSource: string;
  readonly utmMedium: string;
  readonly utmCampaign: string;
  readonly utmTerm: string;
  readonly utmContent: string;
  readonly isEU: boolean;
  readonly country: string;
  readonly region: string;
  readonly regionCode: string;
  readonly city: string;
  readonly continent: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly postalCode: string;
  readonly metroCode: string;
  readonly timezone: string;
  readonly organization: string;
  readonly browser: string;
  readonly browserVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly deviceType: string;
  readonly userAgent: string;
  readonly language: string;
  readonly screenWidth: number | null;
  readonly screenHeight: number | null;
  readonly status: string;
  readonly startedAt: number;
  readonly previousVisitId: string;
  readonly previousVisitStartedAt: number | null;
  readonly lastActivityAt: number;
  readonly endedAt: number | null;
  readonly finalizedAt: number | null;
  readonly durationMs: number | null;
  readonly durationSource: string;
  readonly exitReason: string;
  readonly performance: Readonly<Record<PerformanceMetricKey, number | null>>;
}

export interface CanonicalEventSummaryResult {
  readonly summary: {
    readonly events: number;
    readonly eventTypes: number;
    readonly sessions: number;
    readonly visitors: number;
    readonly avgEventsPerSession: number;
  };
  readonly cards: {
    readonly event: { readonly name: readonly CanonicalAnalyticsTab[] };
    readonly page: {
      readonly path: readonly CanonicalAnalyticsTab[];
      readonly title: readonly CanonicalAnalyticsTab[];
      readonly hostname: readonly CanonicalAnalyticsTab[];
    };
  };
}

export interface CanonicalEventTrendResult {
  readonly interval: CalendarGranularity;
  readonly series: readonly {
    readonly key: string;
    readonly eventName: string;
    readonly label: string;
    readonly events: number;
    readonly sessions: number;
    readonly visitors: number;
    readonly isOther?: boolean;
  }[];
  readonly data: readonly {
    readonly bucket: number;
    readonly timestampMs: number;
    readonly totalEvents: number;
    readonly eventsBySeries: Readonly<Record<string, number>>;
  }[];
}

export interface CanonicalEventTypeResult {
  readonly items: readonly CanonicalAnalyticsTab[];
  readonly pagination: PaginationMeta;
}

export interface CanonicalEventTypeDetailResult {
  readonly eventName: string;
  readonly summary: {
    readonly events: number;
    readonly eventTypes: number;
    readonly sessions: number;
    readonly visitors: number;
    readonly avgEventsPerSession: number;
    readonly shareOfAllEvents: number;
  };
  readonly trend: {
    readonly data: readonly {
      readonly bucket: number;
      readonly timestampMs: number;
      readonly events: number;
      readonly visitors: number;
    }[];
  };
  readonly breakdowns: {
    readonly pages: readonly CanonicalAnalyticsTab[];
    readonly countries: readonly CanonicalAnalyticsTab[];
    readonly devices: readonly CanonicalAnalyticsTab[];
    readonly browsers: readonly CanonicalAnalyticsTab[];
  };
  readonly cards: CanonicalEventContextCards;
}

export interface CanonicalEventField {
  readonly path: string;
  readonly valueType: string;
  readonly events: number;
  readonly occurrences: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly exampleValue: string | number | boolean | null;
}

export interface CanonicalEventFieldValue {
  readonly value: string | number | boolean | null;
  readonly events: number;
  readonly occurrences: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface CanonicalJourneyPerformanceMetric {
  readonly avg: number | null;
  readonly p75: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly samples: number;
}
export type CanonicalJourneyPerformance = Readonly<
  Record<PerformanceMetricKey, CanonicalJourneyPerformanceMetric>
>;
export interface CanonicalJourneyEvent {
  readonly id: string;
  readonly kind: "session_start" | "pageview" | "leave" | "custom";
  readonly eventType: string;
  readonly occurredAt: number;
  readonly visitId: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly pathname: string;
  readonly hash: string;
  readonly title: string;
  readonly hostname: string;
  readonly referrerHost: string;
  readonly referrerUrl: string;
  readonly country: string;
  readonly region: string;
  readonly city: string;
  readonly browser: string;
  readonly browserVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly deviceType: string;
  readonly screenWidth: number | null;
  readonly screenHeight: number | null;
  readonly durationMs: number;
  readonly performance: Readonly<Record<PerformanceMetricKey, number | null>>;
}
export interface CanonicalVisitor {
  readonly visitorId: string;
  readonly userId: string;
  readonly userName: string;
  readonly sessionId?: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly views: number;
  readonly sessions: number;
  readonly events?: number;
  readonly country?: string;
  readonly region?: string;
  readonly regionCode?: string;
  readonly city?: string;
  readonly referrerHost?: string;
  readonly referrerUrl?: string;
  readonly browser?: string;
  readonly browserVersion?: string;
  readonly os?: string;
  readonly osVersion?: string;
  readonly deviceType?: string;
  readonly screenWidth?: number | null;
  readonly screenHeight?: number | null;
}
export interface CanonicalSession {
  readonly sessionId: string;
  readonly visitorId: string;
  readonly userId: string;
  readonly userName: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly active: boolean;
  readonly views: number;
  readonly events: number;
  readonly bounce: boolean;
  readonly entryPath: string;
  readonly exitPath: string;
  readonly referrerHost: string;
  readonly referrerUrl: string;
  readonly country: string;
  readonly region: string;
  readonly regionCode: string;
  readonly city: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly browser: string;
  readonly browserVersion: string;
  readonly os: string;
  readonly osVersion: string;
  readonly deviceType: string;
  readonly screenWidth: number | null;
  readonly screenHeight: number | null;
  readonly performance: Readonly<Record<PerformanceMetricKey, number | null>>;
}
export interface CanonicalVisitorDetailResult {
  readonly visitor: CanonicalVisitor;
  readonly metrics: {
    readonly totalEvents: number;
    readonly sessions: number;
    readonly views: number;
    readonly avgEventsPerSession: number;
    readonly bounceRate: number;
    readonly avgDurationMs: number;
    readonly p90DurationMs: number | null;
    readonly firstSeenAt: number;
    readonly lastSeenAt: number;
    readonly daysActive: number;
    readonly conversionEvents: number;
    readonly avgTimeBetweenSessionsMs: number;
  };
  readonly visitedPages: readonly {
    readonly pathname: string;
    readonly views: number;
  }[];
  readonly eventDistribution: readonly {
    readonly eventType: string;
    readonly count: number;
  }[];
  readonly activity: readonly {
    readonly date: string;
    readonly count: number;
  }[];
  readonly performance: CanonicalJourneyPerformance;
}
export interface CanonicalSessionDetailResult {
  readonly session: CanonicalSession;
  readonly locationPoints: readonly {
    readonly latitude: number;
    readonly longitude: number;
    readonly timestampMs: number;
    readonly country: string;
    readonly region: string;
    readonly regionCode: string;
    readonly city: string;
    readonly pointCount: number;
  }[];
  readonly visitedPages: readonly {
    readonly pathname: string;
    readonly views: number;
  }[];
  readonly eventDistribution: readonly {
    readonly eventType: string;
    readonly count: number;
  }[];
  readonly performance: CanonicalJourneyPerformance;
}

export interface CanonicalGoalMetricSummary {
  readonly total: number;
  readonly converted: number;
  readonly conversionRate: number;
}
export interface CanonicalGoalSummaryResult {
  readonly goal: GoalDefinition;
  readonly summary: {
    readonly sessions: CanonicalGoalMetricSummary;
    readonly visitors: CanonicalGoalMetricSummary;
  };
}
export interface CanonicalGoalTimeseriesResult {
  readonly goal: GoalDefinition;
  readonly interval: Interval;
  readonly timeseries: readonly {
    readonly timestampMs: number;
    readonly sessions: CanonicalGoalMetricSummary;
    readonly visitors: CanonicalGoalMetricSummary;
  }[];
}

export type CanonicalEventRecordPage = PageResult<CanonicalEventRecord>;
export type CanonicalJourneyEventPage = PageResult<CanonicalJourneyEvent>;
export type CanonicalJourneySessionPage = PageResult<CanonicalSession>;
export type CanonicalJourneyVisitorPage = PageResult<CanonicalVisitor>;
export type CanonicalEventFieldPage = PageResult<CanonicalEventField>;
export type CanonicalEventFieldValuePage = PageResult<CanonicalEventFieldValue>;
export type CanonicalEventRecordDetailResult = {
  readonly event: CanonicalEventRecordDetail;
  readonly context: CanonicalEventRecordContext;
  readonly eventData: unknown;
} | null;
export type CanonicalJourneyEventDetailResult = {
  readonly event: {
    readonly eventId: string;
    readonly eventName: string;
    readonly eventKind: "pageview" | "session_start" | "leave" | "custom";
    readonly occurredAt: number;
    readonly receivedAt: number;
    readonly sequence: number;
    readonly visitId: string;
    readonly sessionId: string;
    readonly visitorId: string;
    readonly pathname: string;
    readonly title: string;
    readonly hostname: string;
    readonly referrerHost: string;
    readonly country: string;
    readonly region: string;
    readonly browser: string;
    readonly browserVersion: string;
    readonly os: string;
    readonly osVersion: string;
    readonly deviceType: string;
    readonly nodeCount: number;
    readonly valueCount: number;
  };
  readonly context: CanonicalEventRecordContext;
} | null;
export type CanonicalEventTypesPage = CanonicalEventTypeResult;
export type CanonicalEventRecordPageResult = CanonicalEventRecordPage;
export type CanonicalEventFieldValuesResult = {
  readonly eventName: string | undefined;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly data: CanonicalEventFieldValuePage;
};
export type CanonicalEventFieldsResult = {
  readonly eventName: string | undefined;
  readonly data: CanonicalEventFieldPage;
};
export type CanonicalEventContextResult = {
  readonly eventName: string;
  readonly cards: CanonicalEventContextCards;
};
