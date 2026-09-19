import { DetailDrawer } from "@/components/dashboard/site-pages/detail-drawer";
import type { PageDetailClientPageProps } from "@/components/dashboard/site-pages/page-detail-client-page";
import { Skeleton } from "@/components/ui/skeleton";
import dynamic from "@/lib/dynamic";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const PageDetailContent = dynamic<PageDetailClientPageProps>(
  () =>
    import("@/components/dashboard/site-pages/page-detail-client-page").then(
      (module) => module.PageDetailClientPage,
    ),
  { loading: PageDetailDrawerLoading },
);

function PageDetailDrawerLoading() {
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-44 w-full" />
      <Skeleton className="h-72 w-full" />
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
