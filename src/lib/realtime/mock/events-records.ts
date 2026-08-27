import type { DemoCustomEventFact } from "@/lib/realtime/mock/events-facts";
import { demoOperatingSystemLabel } from "@/lib/realtime/mock/visit-helpers";

export function demoEventRecordFromFact(event: DemoCustomEventFact) {
  const visit = event.visit;
  return {
    eventId: event.eventId,
    eventName: event.eventName,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    sequence: event.sequence,
    visitId: visit.visitId,
    sessionId: visit.sessionId,
    visitorId: visit.visitorId,
    pathname: visit.pathname,
    title: visit.title,
    hostname: visit.hostname,
    referrerHost: visit.referrerHost,
    country: visit.country,
    region: visit.regionName || visit.region,
    city: visit.cityName || visit.city,
    browser: visit.browser,
    browserVersion: visit.browserVersion,
    os: demoOperatingSystemLabel(visit.osVersion),
    osVersion: visit.osVersion,
    deviceType: visit.deviceType,
    nodeCount: 18,
    valueCount: 13,
  };
}
