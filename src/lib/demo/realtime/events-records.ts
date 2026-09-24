import type { DemoCustomEventFact } from "@/lib/demo/realtime/events-facts";
import { demoOperatingSystemLabel } from "@/lib/demo/realtime/visit-helpers";

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
