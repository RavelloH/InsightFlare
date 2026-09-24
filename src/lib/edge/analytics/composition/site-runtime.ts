import type { D1SiteQueryRuntimeOptions } from "./d1";
import { createD1SiteQueryRuntime } from "./d1";

/** Stable consumer entrypoint for the canonical site analytics runtime. */
export type SiteAnalyticsRuntimeOptions = D1SiteQueryRuntimeOptions;

export function createSiteAnalyticsRuntime(
  options: SiteAnalyticsRuntimeOptions,
) {
  return createD1SiteQueryRuntime(options);
}
