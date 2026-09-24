import type { D1TeamQueryRuntimeOptions } from "./d1";
import { createD1TeamQueryRuntime } from "./d1";

/** Stable consumer entrypoint for the canonical team analytics runtime. */
export type TeamAnalyticsRuntimeOptions = D1TeamQueryRuntimeOptions;

export function createTeamAnalyticsRuntime(
  options: TeamAnalyticsRuntimeOptions,
) {
  return createD1TeamQueryRuntime(options);
}
