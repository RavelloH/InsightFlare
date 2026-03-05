"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AutoTransition } from "@/components/ui/auto-transition";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { useRealtimeChannel } from "@/hooks/use-realtime-channel";
import { intlLocale } from "@/lib/dashboard/format";
import { isRealtimeMockEnabled } from "@/lib/realtime/client";
import type { RealtimeConnectionState } from "@/lib/realtime/types";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const USE_REALTIME_MOCK = isRealtimeMockEnabled();

interface RealtimePanelProps {
  siteId: string;
  locale: Locale;
  messages: AppMessages;
}

function formatTime(locale: Locale, timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusLabel(
  locale: Locale,
  messages: AppMessages,
  status: RealtimeConnectionState,
) {
  if (status === "connected") {
    return <span key="connected">{messages.realtime.connected}</span>;
  }
  if (status === "connecting") {
    return (
      <span key="connecting" className="inline-flex items-center gap-2">
        <Spinner className="size-3.5" />
        {messages.common.loading}
      </span>
    );
  }
  if (status === "failed") {
    return <span key="failed">{locale === "zh" ? "连接失败" : "Failed"}</span>;
  }
  return <span key="disconnected">{messages.realtime.disconnected}</span>;
}

export function RealtimePanel({ siteId, locale, messages }: RealtimePanelProps) {
  const realtimeSiteId = siteId || (USE_REALTIME_MOCK ? "local-mock-site" : undefined);
  const realtime = useRealtimeChannel(realtimeSiteId, {
    enabled: Boolean(siteId) || USE_REALTIME_MOCK,
  });
  const events = useMemo(() => realtime.events.slice(0, 20), [realtime.events]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle>{messages.realtime.title}</CardTitle>
          <p className="text-xs text-muted-foreground">{messages.realtime.subtitle}</p>
        </div>
        <Badge variant={realtime.status === "connected" ? "default" : "outline"}>
          <AutoTransition className="inline-flex items-center gap-2">
            {statusLabel(locale, messages, realtime.status)}
          </AutoTransition>
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline justify-between rounded-none border border-border p-3">
          <p className="text-sm text-muted-foreground">{messages.realtime.activeNow}</p>
          <p className="text-2xl font-semibold">
            <AutoTransition initial className="inline-flex min-w-[2ch] justify-end">
              {realtime.status === "connecting" ? (
                <span key="active-loading" className="inline-flex items-center">
                  <Spinner className="size-5" />
                </span>
              ) : (
                <span key="active-value">{realtime.activeNow}</span>
              )}
            </AutoTransition>
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">{messages.realtime.recentEvents}</p>
          <AutoResizer>
            <AutoTransition>
              {events.length === 0 ? (
                <p key="events-empty" className="text-sm text-muted-foreground">
                  {messages.common.noData}
                </p>
              ) : (
                <div key="events-list" className="space-y-2">
                  {events.map((event) => (
                    <div key={event.id} className="flex items-center justify-between border-b pb-2 text-xs">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{event.eventType || messages.common.unknown}</p>
                        <p className="truncate text-muted-foreground">
                          {event.pathname || "/"} · {event.country || messages.common.unknown} · {event.browser || messages.common.unknown}
                        </p>
                      </div>
                      <p className="pl-3 text-muted-foreground">{formatTime(locale, event.eventAt)}</p>
                    </div>
                  ))}
                </div>
              )}
            </AutoTransition>
          </AutoResizer>
        </div>
      </CardContent>
    </Card>
  );
}
