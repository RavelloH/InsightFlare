import type { AnalyticsOperationId } from "./operation-registry";

export type AnalyticsServiceError =
  | { readonly kind: "deadline-exceeded" }
  | { readonly kind: "request-cancelled" }
  | { readonly kind: "query-cost-exceeded"; readonly cost: number }
  | {
      readonly kind: "operation-not-allowed";
      readonly operation: AnalyticsOperationId;
    };

export type AnalyticsServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AnalyticsServiceError };
