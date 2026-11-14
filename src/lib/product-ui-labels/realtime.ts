import type {
  RealtimeLogStreamLabels,
  RealtimeStatusLabels,
  RealtimeTrafficTrendLabels,
} from "@insightflare/product-ui/realtime";

import type { AppMessages } from "@/lib/i18n/messages";

export function buildRealtimeTrafficTrendLabels(
  messages: AppMessages,
): RealtimeTrafficTrendLabels {
  return {
    title: messages.overview.trendTitle,
    viewsLabel: messages.common.views,
    visitorsLabel: messages.common.visitors,
  };
}

export function buildRealtimeStatusLabels(
  messages: AppMessages,
): RealtimeStatusLabels {
  return {
    connected: messages.realtime.connected,
    connecting: messages.realtime.connecting,
    reconnecting: messages.realtime.reconnecting,
    failed: messages.realtime.failed,
  };
}

export function buildRealtimeLogStreamLabels(
  messages: AppMessages,
): RealtimeLogStreamLabels {
  return {
    title: messages.realtime.recentEvents,
    loading: messages.common.loading,
    empty: messages.common.noData,
    direct: messages.overview.direct,
  };
}
