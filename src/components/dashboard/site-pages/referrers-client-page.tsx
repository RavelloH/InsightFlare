"use client";

import { useEffect, useState } from "react";
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
import { fetchReferrers, emptyReferrersData } from "@/lib/dashboard/client-data";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { ReferrersData } from "@/lib/edge-client";

interface ReferrersClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

export function ReferrersClientPage({ locale, messages, siteId }: ReferrersClientPageProps) {
  const { filters, window } = useDashboardQuery();
  const [referrers, setReferrers] = useState<ReferrersData>(emptyReferrersData());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetchReferrers(siteId, window, filters)
      .catch(() => emptyReferrersData())
      .then((nextReferrers) => {
        if (!active) return;
        setReferrers(nextReferrers);
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

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.referrers.title}
        subtitle={messages.referrers.subtitle}
      />

      <Card>
        <CardHeader>
          <CardTitle>{messages.referrers.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <ContentSwitch
            loading={loading}
            hasContent={referrers.data.length > 0}
            loadingLabel={messages.common.loading}
            emptyContent={<p>{noDataText}</p>}
          >
            <TopItemsChart
              valueLabel={messages.common.views}
              items={referrers.data.map((item) => ({
                label: item.referrer || messages.common.unknown,
                value: item.views,
              }))}
            />
          </ContentSwitch>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{messages.overview.topReferrers}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={loading}
            hasContent={referrers.data.length > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={noDataText}
            colSpan={3}
            header={(
              <TableRow>
                <TableHead>{messages.common.referrer}</TableHead>
                <TableHead className="text-right">{messages.common.views}</TableHead>
                <TableHead className="text-right">{messages.common.sessions}</TableHead>
              </TableRow>
            )}
            rows={referrers.data.map((item) => (
              <TableRow key={`${item.referrer}-${item.views}`}>
                <TableCell className="max-w-[420px] truncate font-mono">
                  {item.referrer || messages.common.unknown}
                </TableCell>
                <TableCell className="text-right">{numberFormat(locale, item.views)}</TableCell>
                <TableCell className="text-right">{numberFormat(locale, item.sessions)}</TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>
    </div>
  );
}

