import type { OperationResultCache } from "@/lib/edge/analytics/application/cache";
import {
  type AnalyticsApplicationErrorHandler,
  TypedQueryApplicationService,
} from "@/lib/edge/analytics/application/service";
import {
  currentInvocationLogger,
  errorLogData,
} from "@/lib/edge/observability/logger";

const logApplicationError: AnalyticsApplicationErrorHandler = (
  error,
  operation,
) => {
  currentInvocationLogger()?.error("query.application-operation.failed", {
    operation,
    ...errorLogData(error),
  });
};

/** Wire Edge observability around the runtime-neutral query application. */
export function createAnalyticsQueryApplicationService(
  cache?: OperationResultCache,
): TypedQueryApplicationService {
  return new TypedQueryApplicationService(
    cache,
    undefined,
    logApplicationError,
  );
}
