"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { PageHeading } from "@/components/dashboard/page-heading";
import { TopItemsChart } from "@/components/dashboard/top-items-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import {
  emptyDimensionData,
  fetchEventTypes,
} from "@/lib/dashboard/client-data";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { numberFormat } from "@/lib/dashboard/format";
import type { DimensionData } from "@/lib/edge-client";

interface EventsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

interface EventTypeRow {
  label: string;
  views: number;
  sessions: number;
}

export function EventsClientPage({ locale, messages, siteId }: EventsClientPageProps) {
  const { filters, window } = useDashboardQuery();
  const [eventTypes, setEventTypes] = useState<DimensionData>(emptyDimensionData());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setEventTypes(emptyDimensionData());

    fetchEventTypes(siteId, window, filters)
      .catch(() => emptyDimensionData())
      .then((nextRows) => {
        if (!active) return;
        setEventTypes(nextRows);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    siteId,
    window.from,
    window.to,
    window.interval,
    filters.country,
    filters.device,
    filters.browser,
  ]);

  const noDataText = messages.common.noData;

  const eventTypeRows = useMemo<EventTypeRow[]>(
    () =>
      eventTypes.data.map((item) => {
        const normalized = String(item.value || "").trim();
        return {
          label: normalized.length > 0 ? normalized : messages.common.unknown,
          views: Math.max(0, Number(item.views || 0)),
          sessions: Math.max(0, Number(item.sessions || 0)),
        };
      }),
    [eventTypes.data, messages.common.unknown],
  );

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.events.title}
        subtitle={messages.events.subtitle}
      />

      <Card>
        <CardHeader>
          <CardTitle>{messages.events.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <ContentSwitch
            loading={loading}
            hasContent={eventTypeRows.length > 0}
            loadingLabel={messages.common.loading}
            emptyContent={<p>{noDataText}</p>}
          >
            <TopItemsChart
              valueLabel={messages.common.views}
              items={eventTypeRows.map((item) => ({
                label: item.label,
                value: item.views,
              }))}
            />
          </ContentSwitch>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.events.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={loading}
            hasContent={eventTypeRows.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={3}
            header={(
              <TableRow>
                <TableHead>{messages.common.event}</TableHead>
                <TableHead className="text-right">{messages.common.views}</TableHead>
                <TableHead className="text-right">{messages.common.sessions}</TableHead>
              </TableRow>
            )}
            rows={eventTypeRows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className="max-w-[320px] truncate">{row.label}</TableCell>
                <TableCell className="text-right">{numberFormat(locale, row.views)}</TableCell>
                <TableCell className="text-right">{numberFormat(locale, row.sessions)}</TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>
    </div>
  );
}

