import type {
  EventMetricLabels,
  EventTrendCardLabels,
} from "@insightflare/product-ui/events";

import type { AppMessages } from "@/lib/i18n/messages";

export function buildEventMetricLabels(
  messages: AppMessages,
): EventMetricLabels {
  const events = messages.events;
  return {
    totalEvents: events.totalEvents,
    shareOfAllEvents: events.shareOfAllEvents,
    detailSubtitle: events.detailSubtitle,
    eventTypes: events.eventTypes,
    breakdownTitle: events.breakdownTitle,
    sessions: events.sessions,
    avgEventsPerSession: events.avgEventsPerSession,
    visitors: events.visitors,
    recordsTitle: events.recordsTitle,
  };
}

export function buildEventTrendCardLabels(
  messages: AppMessages,
): EventTrendCardLabels {
  return {
    title: messages.events.trendTitle,
    other: messages.events.other,
    empty: messages.events.empty,
    totalEvents: messages.events.totalEvents,
    cumulative: messages.common.cumulativeEvents,
    currentPeriod: messages.dashboardHeader.compareCurrentPeriod,
  };
}
