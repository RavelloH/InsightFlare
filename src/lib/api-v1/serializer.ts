import {
  apiV1ErrorRegistry,
  type ApiV1WireError,
  fromAnalyticsDomainError,
} from "@/lib/api-v1/errors";
import type {
  AnalyticsResult,
  QueryResultMeta,
} from "@/lib/edge/query-contract";

export interface ApiV1ResponseMeta {
  readonly requestId: string;
}

export interface ApiV1AnalyticsResponseMeta extends ApiV1ResponseMeta {
  readonly generatedAt: string;
  readonly timeRange: {
    readonly from: string;
    readonly to: string;
    readonly timeZone: string;
  };
  readonly source: QueryResultMeta["source"];
  readonly accuracy: "exact" | "approximate";
}

export type ApiV1SuccessEnvelope<T> = {
  readonly data: T;
  readonly meta: ApiV1ResponseMeta;
};

export type ApiV1AnalyticsSuccessEnvelope<T> = {
  readonly data: T;
  readonly meta: ApiV1AnalyticsResponseMeta;
};

export type ApiV1ErrorEnvelope = {
  readonly error: ApiV1WireError;
  readonly meta: ApiV1ResponseMeta;
};

export interface SerializedApiV1Response<T> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body:
    | ApiV1SuccessEnvelope<T>
    | ApiV1AnalyticsSuccessEnvelope<T>
    | ApiV1ErrorEnvelope;
}

export function apiV1JsonHeaders(
  requestId: string,
): Readonly<Record<string, string>> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  };
}

export function toWireSuccess<T>(
  data: T,
  requestId: string,
): ApiV1SuccessEnvelope<T> {
  return { data, meta: { requestId } };
}

export function serializeAnalyticsResult<T>(
  result: AnalyticsResult<T>,
  requestId: string,
  generatedAt = new Date().toISOString(),
): SerializedApiV1Response<T> {
  if (!result.ok) {
    const error = fromAnalyticsDomainError(result.error);
    return {
      status: apiV1ErrorRegistry[error.code].status,
      headers: apiV1JsonHeaders(requestId),
      body: { error, meta: { requestId } },
    };
  }
  return {
    status: 200,
    headers: apiV1JsonHeaders(requestId),
    body: {
      data: result.data,
      meta: {
        requestId,
        generatedAt,
        timeRange: {
          from: new Date(result.meta.time.range.startMs).toISOString(),
          to: new Date(result.meta.time.range.endExclusiveMs).toISOString(),
          timeZone: result.meta.time.reportingTimeZone,
        },
        source: result.meta.source,
        accuracy: result.meta.approximateVisitors ? "approximate" : "exact",
      },
    },
  };
}
