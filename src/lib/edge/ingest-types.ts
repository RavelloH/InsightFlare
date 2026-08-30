import type { SqlBinding, VisitBindingRow } from "./ingest-sql";
import type { NormalizedIngestRecord, NormalizedVisitContext } from "./types";

export interface StoredOpenVisit extends NormalizedVisitContext {
  lastActivityAt: number;
}

export interface VisitRow {
  visitId: string;
  status: string;
  siteId: string;
  visitorId: string;
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  pathname: string;
  queryString: string;
  hashFragment: string;
  hostname: string;
  title: string;
  referrerUrl: string;
  referrerHost: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  isEU: number;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  latitude: number | null;
  longitude: number | null;
  postalCode: string;
  metroCode: string;
  timezone: string;
  asOrganization: string;
  uaRaw: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
  language: string;
  userId: string;
  userName: string;
  perfTtfbMs: number | null;
  perfFcpMs: number | null;
  perfLcpMs: number | null;
  perfCls: number | null;
  perfInpMs: number | null;
}

export interface BufferedVisitRow extends VisitRow, VisitBindingRow {
  hiddenAt?: number | null;
  endedAt: number | null;
  finalizedAt: number | null;
  durationMs: number | null;
  durationSource: string;
  exitReason: string;
  dirty: number;
  flushAttempts: number;
  lastFlushError?: string | null;
  nextDueAt?: number | null;
  flushDueAt?: number | null;
  bufferRevision?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BufferedCustomEventRow {
  eventId: string;
  siteId: string;
  visitId: string;
  occurredAt: number;
  receivedAt: number;
  sequence: number;
  eventName: string;
  eventDataJson: string;
  userId: string;
  dirty: number;
  flushAttempts: number;
  lastFlushError?: string | null;
  nextDueAt?: number | null;
  flushDueAt?: number | null;
  bufferRevision?: number;
  createdAt: number;
}

export interface BufferedCustomEventInput {
  eventId: string;
  siteId: string;
  visitId: string;
  occurredAt: number;
  receivedAt: number;
  sequence: number;
  eventName: string;
  eventDataJson: string;
  userId: string;
}

export interface RecentVisitorSession {
  sessionId: string;
  visitId?: string;
  status?: string;
  routeMatch?: number;
  startedAt: number;
  lastActivityAt: number;
}

export type DictionaryKind = "name" | "key" | "path";

export interface NormalizeResult {
  record: NormalizedIngestRecord | null;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface SqlReader {
  sqlAll<T>(query: string, ...bindings: SqlBinding[]): T[];
  sqlOne<T>(query: string, ...bindings: SqlBinding[]): T | null;
}

export interface SqlWriter extends SqlReader {
  sqlRun(query: string, ...bindings: SqlBinding[]): number;
}
