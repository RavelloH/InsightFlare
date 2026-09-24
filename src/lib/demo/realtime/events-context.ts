import { DEMO_GEO_SEGMENT_SEPARATOR } from "@/lib/demo/realtime/dimension-pools";
import type { DemoCustomEventFact } from "@/lib/demo/realtime/events-facts";
import {
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/demo/realtime/fact-builder";
import type { DemoFactDataset } from "@/lib/demo/realtime/types";
import { demoQueryStringForVisit } from "@/lib/demo/realtime/visit-helpers";
export function demoEventDimensionRows(
  dataset: DemoFactDataset,
  events: DemoCustomEventFact[],
  limit: number,
  getLabel: (event: DemoCustomEventFact) => string,
) {
  const buckets = new Map<
    string,
    { events: number; sessions: Set<string>; visitors: Set<string> }
  >();
  for (const event of events) {
    const label = String(getLabel(event) ?? "").trim();
    if (!label) continue;
    const bucket = buckets.get(label) ?? {
      events: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    bucket.events += 1;
    bucket.sessions.add(event.visit.sessionId);
    bucket.visitors.add(event.visit.visitorId);
    buckets.set(label, bucket);
  }
  return [...buckets.entries()]
    .map(([label, bucket]) => ({
      label,
      views: bucket.events,
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, bucket.sessions)),
      ),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, bucket.visitors)),
      ),
    }))
    .sort(
      (left, right) =>
        right.views - left.views ||
        right.sessions - left.sessions ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}
function demoEventGeoRows(
  dataset: DemoFactDataset,
  events: DemoCustomEventFact[],
  limit: number,
  getValue: (event: DemoCustomEventFact) => string,
  getLabel: (event: DemoCustomEventFact) => string = getValue,
) {
  const buckets = new Map<
    string,
    {
      label: string;
      events: number;
      sessions: Set<string>;
      visitors: Set<string>;
    }
  >();
  for (const event of events) {
    const value = String(getValue(event) ?? "").trim();
    if (!value) continue;
    const bucket = buckets.get(value) ?? {
      label: String(getLabel(event) ?? value).trim() || value,
      events: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    bucket.events += 1;
    bucket.sessions.add(event.visit.sessionId);
    bucket.visitors.add(event.visit.visitorId);
    buckets.set(value, bucket);
  }
  return [...buckets.entries()]
    .map(([value, bucket]) => ({
      value,
      label: bucket.label,
      views: bucket.events,
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, bucket.sessions)),
      ),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, bucket.visitors)),
      ),
    }))
    .sort(
      (left, right) =>
        right.views - left.views ||
        right.sessions - left.sessions ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}
export function demoEventContextCards(
  dataset: DemoFactDataset,
  events: DemoCustomEventFact[],
  limit: number,
) {
  return {
    page: {
      path: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.pathname,
      ),
      query: demoEventDimensionRows(dataset, events, limit, (event) =>
        demoQueryStringForVisit(event.visit),
      ),
      title: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.title,
      ),
      hostname: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.hostname,
      ),
      entry: demoEventDimensionRows(dataset, events, limit, (event) => {
        const session = dataset.sessions.get(event.visit.sessionId);
        return session?.entryPath ?? event.visit.pathname;
      }),
      exit: demoEventDimensionRows(dataset, events, limit, (event) => {
        const session = dataset.sessions.get(event.visit.sessionId);
        return session?.exitPath ?? event.visit.pathname;
      }),
    },
    source: {
      domain: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.referrerHost,
      ),
      link: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.referrerUrl,
      ),
    },
    client: {
      browser: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.browser,
      ),
      osVersion: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.osVersion,
      ),
      deviceType: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.deviceType,
      ),
      language: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.language,
      ),
      screenSize: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.screenSize,
      ),
    },
    geo: {
      country: demoEventGeoRows(
        dataset,
        events,
        limit,
        (event) => event.visit.country,
      ),
      region: demoEventGeoRows(
        dataset,
        events,
        limit,
        (event) =>
          event.visit.country ||
          event.visit.regionCode ||
          event.visit.regionName
            ? `${event.visit.country}${DEMO_GEO_SEGMENT_SEPARATOR}${event.visit.regionCode || event.visit.regionName}${DEMO_GEO_SEGMENT_SEPARATOR}${event.visit.regionName || event.visit.regionCode}`
            : "",
        (event) => event.visit.regionName || event.visit.region,
      ),
      city: demoEventGeoRows(
        dataset,
        events,
        limit,
        (event) =>
          event.visit.country ||
          event.visit.regionCode ||
          event.visit.regionName ||
          event.visit.cityName
            ? `${event.visit.country}${DEMO_GEO_SEGMENT_SEPARATOR}${event.visit.regionCode || event.visit.regionName}${DEMO_GEO_SEGMENT_SEPARATOR}${event.visit.regionName || event.visit.regionCode}${DEMO_GEO_SEGMENT_SEPARATOR}${event.visit.cityName || event.visit.city}`
            : "",
        (event) => event.visit.cityName || event.visit.city,
      ),
      continent: demoEventGeoRows(
        dataset,
        events,
        limit,
        (event) => event.visit.continent,
      ),
      timezone: demoEventGeoRows(
        dataset,
        events,
        limit,
        (event) => event.visit.timezone,
      ),
      organization: demoEventGeoRows(
        dataset,
        events,
        limit,
        (event) => event.visit.organization,
      ),
    },
  };
}
export function demoEventSummaryCards(
  dataset: DemoFactDataset,
  events: DemoCustomEventFact[],
  limit: number,
) {
  return {
    event: {
      name: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.eventName,
      ),
    },
    page: {
      path: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.pathname,
      ),
      title: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.title,
      ),
      hostname: demoEventDimensionRows(
        dataset,
        events,
        limit,
        (event) => event.visit.hostname,
      ),
    },
  };
}
