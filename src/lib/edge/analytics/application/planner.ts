import type { QueryContext } from "@/lib/edge/analytics/contract";

import type { AnalyticsServiceError } from "./errors";
import {
  analyticsOperationById,
  type AnalyticsOperationId,
} from "./operation-registry";

export type AnalyticsOperationPlan =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: AnalyticsServiceError };

export function planAnalyticsOperation(
  operation: AnalyticsOperationId,
  context: QueryContext,
): AnalyticsOperationPlan {
  const descriptor = analyticsOperationById(operation);
  if (
    !descriptor ||
    !descriptor.subjectKinds.includes(context.subject.kind) ||
    !descriptor.audiences.includes(context.policy.audience)
  ) {
    return {
      ok: false,
      error: { kind: "operation-not-allowed", operation },
    };
  }
  return { ok: true };
}
