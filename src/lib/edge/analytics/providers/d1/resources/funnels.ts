import {
  archiveFunnelDefinition,
  createFunnelDefinition,
  queryFunnelDefinition,
  updateFunnelDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
import type { FunnelDefinitionResource } from "@/lib/edge/analytics/resources/funnels";
import type { Env } from "@/lib/edge/types";

/** D1 adapter for the source-neutral Funnel definition resource. */
export function createD1FunnelDefinitionResource(
  env: Env,
): FunnelDefinitionResource {
  return {
    get: (siteId, funnelId) => queryFunnelDefinition(env, siteId, funnelId),
    create: (siteId, name, config) =>
      createFunnelDefinition(env, siteId, name, config),
    update: (siteId, funnelId, name, config) =>
      updateFunnelDefinition(env, siteId, funnelId, name, config),
    archive: (siteId, funnelId) =>
      archiveFunnelDefinition(env, siteId, funnelId),
  };
}
