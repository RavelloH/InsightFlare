import "@/lib/browser-engine";
import "@/lib/demo/admin/durable-objects";
import "@/lib/demo/admin/system-performance";
import "@/lib/demo/admin/users";
import "@/lib/demo/analytics";
import "@/lib/demo/data/site-profiles";
import "@/lib/demo/generators/utils";
import "@/lib/demo/realtime/dimension-pickers";
import "@/lib/demo/realtime/dimension-pools";
import "@/lib/demo/realtime/fact-builder";
import "@/lib/demo/realtime/filters";
import "@/lib/demo/realtime/path-markov";
import "@/lib/demo/realtime/site-curves";
import "@/lib/demo/realtime/visitor-pool";

import { zonedParts } from "@/lib/analytics/time-zone";
import {
  type DemoSortDirection,
  parseDemoScreenSize,
} from "@/lib/demo/realtime/shared";
import type { DemoVisitFact } from "@/lib/demo/realtime/types";
import { demoOperatingSystemLabel } from "@/lib/demo/realtime/visit-helpers";
function hasValidDemoCoordinate(visit: DemoVisitFact): boolean {
  return (
    Number.isFinite(visit.latitude) &&
    Number.isFinite(visit.longitude) &&
    visit.latitude >= -90 &&
    visit.latitude <= 90 &&
    visit.longitude >= -180 &&
    visit.longitude <= 180
  );
}
export function createDemoJourneyLocationPoints(
  visits: DemoVisitFact[],
): Array<Record<string, unknown>> {
  return [...visits]
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.visitId.localeCompare(right.visitId),
    )
    .filter(hasValidDemoCoordinate)
    .map((visit) => ({
      latitude: visit.latitude,
      longitude: visit.longitude,
      timestampMs: visit.startedAt,
      country: visit.country,
      region: visit.regionName || visit.region,
      regionCode: visit.regionCode,
      city: visit.cityName || visit.city,
    }));
}
export function createDemoJourneySession(
  sessionId: string,
  visits: DemoVisitFact[],
): Record<string, unknown> | null {
  if (visits.length === 0) return null;
  const ordered = [...visits].sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.visitId.localeCompare(right.visitId),
  );
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return null;
  const endedAt = Math.max(
    ...ordered.map((visit) => visit.startedAt + Math.max(0, visit.durationMs)),
    last.startedAt,
  );
  const durationMs = ordered.reduce(
    (sum, visit) => sum + Math.max(0, visit.durationMs),
    0,
  );
  const screen = parseDemoScreenSize(first.screenSize);
  const firstGeo = ordered.find(hasValidDemoCoordinate);
  const identityVisit = latestDemoIdentityVisit(ordered);
  return {
    sessionId,
    visitorId: first.visitorId,
    userId: identityVisit?.userId ?? "",
    userName: identityVisit?.userName ?? "",
    startedAt: first.startedAt,
    endedAt,
    durationMs,
    active: endedAt > Date.now() - 5 * 60 * 1000,
    views: ordered.length,
    events: ordered.filter((visit) => visit.eventType !== "pageview").length,
    bounce: ordered.length <= 1,
    entryPath: first.pathname,
    exitPath: last.pathname,
    referrerHost: first.referrerHost,
    referrerUrl: first.referrerUrl,
    country: first.country,
    region: first.regionName || first.region,
    regionCode: first.regionCode,
    city: first.cityName || first.city,
    latitude: firstGeo?.latitude ?? null,
    longitude: firstGeo?.longitude ?? null,
    browser: first.browser,
    browserVersion: first.browserVersion,
    os: demoOperatingSystemLabel(first.osVersion),
    osVersion: first.osVersion,
    deviceType: first.deviceType,
    screenWidth: screen.screenWidth,
    screenHeight: screen.screenHeight,
  };
}
export function latestDemoIdentityVisit(
  visits: DemoVisitFact[],
): DemoVisitFact | null {
  const ordered = [...visits].sort(
    (left, right) =>
      right.startedAt - left.startedAt ||
      right.visitId.localeCompare(left.visitId),
  );
  return ordered.find((visit) => Boolean(visit.userId?.trim())) ?? null;
}
export function demoVisitsBySession(
  visits: DemoVisitFact[],
): Map<string, DemoVisitFact[]> {
  const bySession = new Map<string, DemoVisitFact[]>();
  for (const visit of visits) {
    const bucket = bySession.get(visit.sessionId) ?? [];
    bucket.push(visit);
    bySession.set(visit.sessionId, bucket);
  }
  return bySession;
}
export function createDemoJourneyEvents(
  visits: DemoVisitFact[],
  options?: { includeSessionStart?: boolean; includeSessionEnd?: boolean },
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const bySession = demoVisitsBySession(visits);

  if (options?.includeSessionStart || options?.includeSessionEnd) {
    for (const [sessionId, sessionVisits] of bySession.entries()) {
      const session = createDemoJourneySession(sessionId, sessionVisits);
      if (!session) continue;
      if (options?.includeSessionStart) {
        events.push({
          id: `session-start:${sessionId}`,
          kind: "session_start",
          eventType: "session start",
          occurredAt: session.startedAt,
          visitId: "",
          sessionId,
          visitorId: session.visitorId,
          pathname: session.entryPath,
          title: "",
          hostname: "",
          referrerHost: session.referrerHost,
          referrerUrl: session.referrerUrl,
          country: session.country,
          region: session.region,
          city: session.city,
          browser: session.browser,
          browserVersion: session.browserVersion,
          os: session.os,
          osVersion: session.osVersion,
          deviceType: session.deviceType,
          screenWidth: session.screenWidth,
          screenHeight: session.screenHeight,
          durationMs: 0,
        });
      }

      if (options?.includeSessionEnd && !session.active) {
        const sessionStartedAt = Number(session.startedAt ?? 0);
        const sessionEndedAt = Number(session.endedAt ?? sessionStartedAt);
        const lastVisit = [...sessionVisits].sort(
          (left, right) =>
            right.startedAt - left.startedAt ||
            right.visitId.localeCompare(left.visitId),
        )[0];
        if (lastVisit && Number.isFinite(sessionEndedAt)) {
          const screen = parseDemoScreenSize(lastVisit.screenSize);
          events.push({
            id: `session-leave:${sessionId}`,
            kind: "leave",
            eventType: "leave",
            occurredAt: Math.max(sessionEndedAt, sessionStartedAt),
            visitId: lastVisit.visitId,
            sessionId,
            visitorId: lastVisit.visitorId,
            pathname: session.exitPath || lastVisit.pathname,
            title: lastVisit.title,
            hostname: lastVisit.hostname,
            referrerHost: lastVisit.referrerHost,
            referrerUrl: lastVisit.referrerUrl,
            country: lastVisit.country,
            region: lastVisit.regionName || lastVisit.region,
            city: lastVisit.cityName || lastVisit.city,
            browser: lastVisit.browser,
            browserVersion: lastVisit.browserVersion,
            os: demoOperatingSystemLabel(lastVisit.osVersion),
            osVersion: lastVisit.osVersion,
            deviceType: lastVisit.deviceType,
            screenWidth: screen.screenWidth,
            screenHeight: screen.screenHeight,
            durationMs: 0,
          });
        }
      }
    }
  }

  for (const visit of visits) {
    const screen = parseDemoScreenSize(visit.screenSize);
    const base = {
      visitId: visit.visitId,
      sessionId: visit.sessionId,
      visitorId: visit.visitorId,
      pathname: visit.pathname,
      title: visit.title,
      hostname: visit.hostname,
      referrerHost: visit.referrerHost,
      referrerUrl: visit.referrerUrl,
      country: visit.country,
      region: visit.regionName || visit.region,
      city: visit.cityName || visit.city,
      browser: visit.browser,
      browserVersion: visit.browserVersion,
      os: demoOperatingSystemLabel(visit.osVersion),
      osVersion: visit.osVersion,
      deviceType: visit.deviceType,
      screenWidth: screen.screenWidth,
      screenHeight: screen.screenHeight,
      durationMs: 0,
    };
    events.push({
      ...base,
      id: visit.visitId,
      kind: "pageview",
      eventType: "pageview",
      occurredAt: visit.startedAt,
      durationMs: Math.max(0, visit.durationMs),
    });
    if (visit.eventType !== "pageview") {
      events.push({
        ...base,
        id: `${visit.visitId}:${visit.eventType}`,
        kind: "custom",
        eventType: visit.eventType,
        occurredAt: Math.min(
          visit.startedAt + 1000,
          visit.startedAt + Math.max(1000, visit.durationMs),
        ),
      });
    }
  }

  return events.sort(
    (left, right) =>
      Number(right.occurredAt ?? 0) - Number(left.occurredAt ?? 0) ||
      String(right.id ?? "").localeCompare(String(left.id ?? "")),
  );
}
export function summarizeDemoVisitedPages(
  events: Array<Record<string, unknown>>,
) {
  const pages = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "pageview") continue;
    const pathname = String(event.pathname || "/").trim() || "/";
    pages.set(pathname, (pages.get(pathname) ?? 0) + 1);
  }
  return Array.from(pages.entries())
    .map(([pathname, views]) => ({ pathname, views }))
    .sort(
      (left, right) =>
        right.views - left.views || left.pathname.localeCompare(right.pathname),
    )
    .slice(0, 50);
}
export function summarizeDemoEventDistribution(
  events: Array<Record<string, unknown>>,
) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const eventType = String(event.eventType || event.kind || "event");
    counts.set(eventType, (counts.get(eventType) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([eventType, count]) => ({ eventType, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.eventType.localeCompare(right.eventType),
    )
    .slice(0, 50);
}
export function demoReportingDateKey(
  timestampMs: number,
  timeZone: string,
): string {
  const parts = zonedParts(timestampMs, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}
export function summarizeDemoActivity(
  events: Array<Record<string, unknown>>,
  timeZone: string,
) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const occurredAt = Number(event.occurredAt ?? 0);
    if (!Number.isFinite(occurredAt) || occurredAt <= 0) continue;
    const date = demoReportingDateKey(occurredAt, timeZone);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((left, right) => left.date.localeCompare(right.date));
}
export function demoJourneyPercentile(
  values: number[],
  percentileValue: number,
): number {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}
export function demoAverageGapMs(values: number[]): number {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (sorted.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    total += sorted[index] - sorted[index - 1];
  }
  return Math.round(total / (sorted.length - 1));
}
export type DemoVisitorSortKey =
  "firstSeenAt" | "lastSeenAt" | "sessions" | "views";
export type DemoSessionSortKey = "startedAt" | "durationMs" | "views";
function parseDemoSortDirection(
  value: string | number | undefined,
): DemoSortDirection {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "asc"
    ? "asc"
    : "desc";
}
export function parseDemoVisitorSort(params: Record<string, string | number>): {
  key: DemoVisitorSortKey;
  direction: DemoSortDirection;
} {
  const key = String(params.sortBy ?? "").trim();
  if (
    key === "firstSeenAt" ||
    key === "lastSeenAt" ||
    key === "sessions" ||
    key === "views"
  ) {
    return { key, direction: parseDemoSortDirection(params.sortDir) };
  }
  return { key: "lastSeenAt", direction: "desc" };
}
export function parseDemoSessionSort(params: Record<string, string | number>): {
  key: DemoSessionSortKey;
  direction: DemoSortDirection;
} {
  const key = String(params.sortBy ?? "").trim();
  if (key === "startedAt" || key === "durationMs" || key === "views") {
    return { key, direction: parseDemoSortDirection(params.sortDir) };
  }
  return { key: "startedAt", direction: "desc" };
}
export function compareDemoNumericField(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  key: string,
  direction: DemoSortDirection,
): number {
  const diff = Number(left[key] ?? 0) - Number(right[key] ?? 0);
  return direction === "asc" ? diff : -diff;
}
