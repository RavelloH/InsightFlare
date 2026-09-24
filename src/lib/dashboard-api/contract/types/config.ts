import type { SiteSettingsConfig } from "@/lib/site-settings";

export interface SiteConfigData {
  ok: boolean;
  data: SiteSettingsConfig;
}

export interface ScriptSnippetData {
  ok: boolean;
  data: {
    siteId: string;
    src: string;
    snippet: string;
  };
}
