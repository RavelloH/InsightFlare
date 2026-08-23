import type { AnalyticsDomainError } from "@/lib/edge/query-contract";

export type ApiV1ErrorCode =
  | "validation_failed"
  | "invalid_json"
  | "batch_child_not_allowed"
  | "payload_too_large"
  | "method_not_allowed"
  | "not_acceptable"
  | "unsupported_media_type"
  | "invalid_cursor"
  | "missing_scope"
  | "resource_not_found"
  | "conflict"
  | "unsupported_query"
  | "range_unavailable"
  | "query_too_expensive"
  | "range_too_wide"
  | "too_many_buckets"
  | "comparison_alignment_mismatch"
  | "dimension_not_supported"
  | "data_unavailable"
  | "request_cancelled"
  | "deadline_exceeded"
  | "internal_error";

export interface ApiV1ErrorDefinition {
  readonly status: number;
  readonly retryable: boolean;
  readonly message: string;
}

export const apiV1ErrorRegistry: Readonly<
  Record<ApiV1ErrorCode, ApiV1ErrorDefinition>
> = {
  validation_failed: {
    status: 400,
    retryable: false,
    message: "Request validation failed.",
  },
  invalid_json: {
    status: 400,
    retryable: false,
    message: "The request body is not valid JSON.",
  },
  batch_child_not_allowed: {
    status: 422,
    retryable: false,
    message: "A batch child is not eligible for batch execution.",
  },
  payload_too_large: {
    status: 413,
    retryable: false,
    message: "The request payload exceeds the configured size limit.",
  },
  method_not_allowed: {
    status: 405,
    retryable: false,
    message: "The HTTP method is not allowed for this route.",
  },
  not_acceptable: {
    status: 406,
    retryable: false,
    message: "The requested response media type is not acceptable.",
  },
  unsupported_media_type: {
    status: 415,
    retryable: false,
    message: "The request media type is unsupported.",
  },
  invalid_cursor: {
    status: 400,
    retryable: false,
    message: "The cursor is invalid for this query.",
  },
  missing_scope: {
    status: 403,
    retryable: false,
    message: "The API key lacks the required scope.",
  },
  resource_not_found: {
    status: 404,
    retryable: false,
    message: "Resource not found.",
  },
  conflict: {
    status: 409,
    retryable: false,
    message: "The requested resource conflicts with existing state.",
  },
  unsupported_query: {
    status: 422,
    retryable: false,
    message: "The query is not supported.",
  },
  range_unavailable: {
    status: 422,
    retryable: false,
    message: "The requested time range is unavailable.",
  },
  query_too_expensive: {
    status: 422,
    retryable: false,
    message: "The requested analytics query is too expensive.",
  },
  range_too_wide: {
    status: 422,
    retryable: false,
    message: "The requested comparison range is too wide.",
  },
  too_many_buckets: {
    status: 422,
    retryable: false,
    message: "The requested trend contains too many buckets.",
  },
  comparison_alignment_mismatch: {
    status: 422,
    retryable: false,
    message: "The comparison datasets cannot be aligned.",
  },
  dimension_not_supported: {
    status: 422,
    retryable: false,
    message: "The requested analytics dimension is not supported.",
  },
  data_unavailable: {
    status: 503,
    retryable: true,
    message: "Analytics data is temporarily unavailable.",
  },
  request_cancelled: {
    status: 499,
    retryable: false,
    message: "The request was cancelled by the client.",
  },
  deadline_exceeded: {
    status: 504,
    retryable: true,
    message: "The analytics query exceeded its deadline.",
  },
  internal_error: {
    status: 500,
    retryable: false,
    message: "An internal error occurred.",
  },
};

export interface ApiV1ErrorIssue {
  readonly path: string;
  readonly code: string;
}

export interface ApiV1WireError {
  readonly code: ApiV1ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly issues?: readonly ApiV1ErrorIssue[];
}

export function toJsonPointer(path: string): string {
  if (!path) return "";
  return `/${path
    .split(".")
    .filter(Boolean)
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

export function fromAnalyticsDomainError(
  error: AnalyticsDomainError,
): ApiV1WireError {
  if (error.kind === "invalid-input") {
    return {
      code: "validation_failed",
      message: apiV1ErrorRegistry.validation_failed.message,
      retryable: false,
      issues: error.issues.map((issue) => ({
        path: toJsonPointer(issue.path),
        code: issue.code,
      })),
    };
  }
  if (error.kind === "invalid-cursor") {
    return {
      code: "invalid_cursor",
      message: apiV1ErrorRegistry.invalid_cursor.message,
      retryable: false,
    };
  }
  if (error.kind === "capability-denied") {
    return {
      code: "missing_scope",
      message: apiV1ErrorRegistry.missing_scope.message,
      retryable: false,
    };
  }
  if (error.kind === "not-found") {
    return {
      code: "resource_not_found",
      message: apiV1ErrorRegistry.resource_not_found.message,
      retryable: false,
    };
  }
  if (error.kind === "unsupported-operation") {
    return {
      code: "unsupported_query",
      message: apiV1ErrorRegistry.unsupported_query.message,
      retryable: false,
    };
  }
  if (error.kind === "range-not-supported") {
    return {
      code: error.reason === "too-wide" ? "range_too_wide" : "too_many_buckets",
      message:
        error.reason === "too-wide"
          ? apiV1ErrorRegistry.range_too_wide.message
          : apiV1ErrorRegistry.too_many_buckets.message,
      retryable: false,
    };
  }
  if (error.kind === "comparison-alignment-mismatch") {
    return {
      code: "comparison_alignment_mismatch",
      message: apiV1ErrorRegistry.comparison_alignment_mismatch.message,
      retryable: false,
    };
  }
  if (error.kind === "dimension-not-supported") {
    return {
      code: "dimension_not_supported",
      message: apiV1ErrorRegistry.dimension_not_supported.message,
      retryable: false,
    };
  }
  if (error.kind === "data-unavailable") {
    return {
      code: "data_unavailable",
      message: apiV1ErrorRegistry.data_unavailable.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "internal_error",
    message: apiV1ErrorRegistry.internal_error.message,
    retryable: false,
  };
}
