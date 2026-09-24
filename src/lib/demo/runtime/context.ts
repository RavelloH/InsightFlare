import type { DemoSiteProfile } from "@/lib/demo/data/site-profiles";
import type { Locale } from "@/lib/i18n/config";

export type DemoRequestOptions = {
  path: string;
  method?: string;
  params?: Record<string, string | number>;
  body?: unknown;
};

export type DemoRuntimeContext = {
  path: string;
  method: string;
  params: Record<string, string | number>;
  body: unknown;
  bodyRecord: Record<string, unknown>;
  siteId: string;
  teamId: string;
  locale: Locale;
  publicSiteProfile: DemoSiteProfile | null;
};
