import type { QueryResultMeta } from "@/lib/edge/analytics/contract";
import type { AnalyticsDomainError } from "@/lib/edge/analytics/contract";

import type { AnalyticsOperationId } from "./operation-registry";

export class AnalyticsProviderDomainError extends Error {
  constructor(readonly domainError: AnalyticsDomainError) {
    super(domainError.kind);
    this.name = "AnalyticsProviderDomainError";
  }
}

export type AnalyticsServiceError =
  | { readonly kind: "deadline-exceeded" }
  | { readonly kind: "request-cancelled" }
  | { readonly kind: "query-cost-exceeded"; readonly cost: number }
  | {
      readonly kind: "invalid-input";
      readonly issues: readonly {
        readonly path: string;
        readonly code: string;
      }[];
    }
  | { readonly kind: "invalid-cursor"; readonly cursorKind: string }
  | {
      readonly kind: "operation-not-allowed";
      readonly operation: AnalyticsOperationId;
    }
  | {
      readonly kind: "domain-error";
      readonly error: AnalyticsDomainError;
    };

export type AnalyticsServiceResult<T> =
  | { readonly ok: true; readonly value: T; readonly meta?: QueryResultMeta }
  | { readonly ok: false; readonly error: AnalyticsServiceError };
