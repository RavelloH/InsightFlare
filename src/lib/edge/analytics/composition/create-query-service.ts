import type { OperationResultCache } from "@/lib/edge/analytics/application/cache";
import type { QueryCostPolicy } from "@/lib/edge/analytics/application/cost";
import { TypedQueryApplicationService } from "@/lib/edge/analytics/application/service";

export function createQueryService(
  cache?: OperationResultCache,
  costPolicy?: QueryCostPolicy,
): TypedQueryApplicationService {
  return new TypedQueryApplicationService(cache, costPolicy);
}
