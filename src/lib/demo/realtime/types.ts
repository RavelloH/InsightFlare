// ---------------------------------------------------------------------------
//  Demo mock — shared data types
//
//  Interfaces used by the fact builder, filter parser, and handlers.
//  Keeping these in one place avoids circular imports between fact-builder,
//  filters, and handlers.
// ---------------------------------------------------------------------------

export interface DemoQueryFilters {
  filterDocument?: FilterDocument;
  /** Site identity used to synthesize an expanded Mock evaluation source. */
  siteId?: string;
  /** Optional expanded source data used only by the canonical filter evaluator. */
  historyDataset?: DemoFactDataset;
  /** Candidate entities remain bounded separately from historical evaluation. */
  candidateRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  /** Optional historical window for Core/Relation evaluation. */
  evaluationRange?: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  /** Evaluate unbounded positional and relation expressions over source coverage. */
  fullHistory?: boolean;
  reportingTimeZone?: string;
  capturedAtMs?: number;
  /** Resolved by the canonical operation registry before demo execution. */
  scope?: FilterScope;
  country?: string;
  device?: string;
  browser?: string;
  path?: string;
  query?: string;
  title?: string;
  hostname?: string;
  entry?: string;
  exit?: string;
  sourceDomain?: string;
  sourceLink?: string;
  channel?: string;
  clientBrowser?: string;
  clientOsVersion?: string;
  clientDeviceType?: string;
  clientLanguage?: string;
  clientScreenSize?: string;
  geo?: string;
  geoContinent?: string;
  geoTimezone?: string;
  geoOrganization?: string;
}

export interface ParsedDemoGeoFilter {
  country: string;
  regionCode?: string;
  regionName?: string;
  city?: string;
}

export interface DemoSessionFact {
  sessionId: string;
  visitorId: string;
  entryPath: string;
  exitPath: string;
  durationMs?: number;
  views?: number;
  events?: number;
  bounce?: boolean;
  weight: number;
}

export interface DemoVisitorFact {
  visitorId: string;
  sessions?: number;
  views?: number;
  events?: number;
  weight: number;
}

export interface DemoVisitFact {
  visitId: string;
  sessionId: string;
  visitorId: string;
  startedAt: number;
  pathname: string;
  title: string;
  hostname: string;
  referrerHost: string;
  referrerUrl: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  browser: string;
  browserVersion: string;
  osVersion: string;
  deviceType: string;
  language: string;
  screenSize: string;
  country: string;
  regionCode: string;
  regionName: string;
  region: string;
  cityName: string;
  city: string;
  continent: string;
  timezone: string;
  organization: string;
  latitude: number;
  longitude: number;
  eventType: string;
  durationMs: number;
  /** Optional stored payload used when this visit has a custom event. */
  customEventPayload?: Readonly<Record<string, unknown>>;
  screenWidth?: number | null;
  screenHeight?: number | null;
  isEU?: boolean;
  perfTtfbMs?: number | null;
  perfFcpMs?: number | null;
  perfLcpMs?: number | null;
  perfCls?: number | null;
  perfInpMs?: number | null;
  userId?: string;
  userName?: string;
}

export interface DemoFactDataset {
  from: number;
  to: number;
  viewWeight: number;
  visits: DemoVisitFact[];
  sessions: Map<string, DemoSessionFact>;
  visitors: Map<string, DemoVisitorFact>;
}

export interface DemoFilteredFacts {
  visits: DemoVisitFact[];
  sessions: Set<string>;
  visitors: Set<string>;
  visitsBySession: Map<string, number>;
}

export interface DemoDimensionRow {
  label: string;
  views: number;
  visitors: number;
  sessions: number;
}
import type { FilterDocument } from "@/lib/filter-contract";
import type { FilterScope } from "@/lib/filter-contract/scope-preference";
