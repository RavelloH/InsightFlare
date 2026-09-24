import type { FunnelConfigV2 } from "@/lib/edge/analytics/contract/funnel-config";
import type { FunnelDefinition } from "@/lib/edge/analytics/contract/types";

/** Source-neutral application boundary for persisted Funnel definitions. */
export interface FunnelDefinitionResource {
  get(siteId: string, funnelId: string): Promise<FunnelDefinition | null>;
  create(
    siteId: string,
    name: string,
    config: FunnelConfigV2,
  ): Promise<FunnelDefinition>;
  update(
    siteId: string,
    funnelId: string,
    name: string,
    config: FunnelConfigV2,
  ): Promise<FunnelDefinition>;
  archive(siteId: string, funnelId: string): Promise<void>;
}
