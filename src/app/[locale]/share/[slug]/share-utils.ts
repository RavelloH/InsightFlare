import { notFound } from "next/navigation";

import { publicDashboardSiteId } from "@/lib/dashboard/client-request";
import { fetchPublicSite, type PublicSiteData } from "@/lib/edge-client";
import { type Locale, resolveLocale } from "@/lib/i18n/config";
import { type AppMessages, getMessages } from "@/lib/i18n/messages";

export interface ShareRouteContext {
  locale: Locale;
  messages: AppMessages;
  site: PublicSiteData;
  publicSiteId: string;
}

export function sharePath(locale: Locale, slug: string, section?: string) {
  const base = `/${locale}/share/${encodeURIComponent(slug)}`;
  return section ? `${base}/${section}` : base;
}

export async function getShareRouteContext(
  locale: string,
  slug: string,
): Promise<ShareRouteContext> {
  const resolvedLocale = resolveLocale(locale);
  try {
    const site = await fetchPublicSite(slug);
    return {
      locale: resolvedLocale,
      messages: getMessages(resolvedLocale),
      site,
      publicSiteId: publicDashboardSiteId(slug),
    };
  } catch {
    notFound();
  }
}
