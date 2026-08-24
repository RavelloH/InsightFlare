import {
  type AnalyticsDomainError,
  assertOperationAllowed,
  type QueryContext,
  type QueryOperation,
} from "@/lib/edge/analytics/contract";

/** Plans a canonical operation against the trusted request policy. */
export function planQueryOperation(
  operation: QueryOperation,
  context: QueryContext,
): AnalyticsDomainError | null {
  return assertOperationAllowed(context, operation);
}
