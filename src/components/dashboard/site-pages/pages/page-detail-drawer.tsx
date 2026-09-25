import { useMemo } from "react";
import { RiCloseLine } from "@remixicon/react";

import {
  DetailDrawer,
  useDetailDrawerClose,
} from "@/components/dashboard/site-pages/common/detail-drawer";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import {
  OverviewMetricsSection,
  OverviewTrendSection,
} from "@/components/dashboard/site-pages/overview/metrics";
import type { PageDetailClientPageProps } from "@/components/dashboard/site-pages/pages/page-detail-client-page";
import { Button } from "@/components/ui/button";
import { setDashboardFilterValue } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import dynamic from "@/lib/dynamic";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const PageDetailContent = dynamic<PageDetailClientPageProps>(
  () =>
    import("@/components/dashboard/site-pages/pages/page-detail-client-page").then(
      (module) => module.PageDetailClientPage,
    ),
  { loading: PageDetailDrawerLoading },
);

function PageDetailDrawerLoading({
  locale,
  messages,
  siteId,
  pagePath,
}: PageDetailClientPageProps) {
  const drawerClose = useDetailDrawerClose();
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const detailFilters = useMemo(
    () => setDashboardFilterValue(filters, "path", pagePath),
    [filters, pagePath],
  );

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6">
      <div className="relative flex min-h-8 items-center">
        <h1 className="min-w-0 break-all pr-10 text-2xl font-semibold tracking-tight">
          {decodeUrlDisplayValue(pagePath)}
        </h1>
        {drawerClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0"
            aria-label={messages.common.close}
            onClick={drawerClose}
          >
            <RiCloseLine />
          </Button>
        ) : null}
      </div>

      <OverviewMetricsSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={detailFilters}
      />

      <OverviewTrendSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={detailFilters}
      />
    </div>
  );
}

export interface PageDetailDrawerProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
  pagePath: string;
  onOpenChange: (open: boolean) => void;
}

export function PageDetailDrawer({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
  pagePath,
  onOpenChange,
}: PageDetailDrawerProps) {
  return (
    <DetailDrawer
      ariaLabel={messages.pages.viewDetails}
      drawerKey={`page:${pagePath}`}
      open
      onOpenChange={onOpenChange}
    >
      <PageDetailContent
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        pagePath={pagePath}
        inDetailDrawer
      />
    </DetailDrawer>
  );
}
