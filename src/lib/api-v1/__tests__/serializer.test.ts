import { describe, expect, it } from "vitest";

import { fromAnalyticsDomainError, toJsonPointer } from "@/lib/api-v1/errors";
import {
  serializeAnalyticsResult,
  toWireSuccess,
} from "@/lib/api-v1/serializer";
import {
  type AnalyticsDomainError,
  createQueryTime,
} from "@/lib/edge/query-contract";

describe("API v1 wire serializer", () => {
  it("uses RFC 6901 paths and stable error definitions", () => {
    expect(toJsonPointer("")).toBe("");
    expect(toJsonPointer("filter.root/a~b")).toBe("/filter/root~1a~0b");
    expect(
      fromAnalyticsDomainError({
        kind: "invalid-input",
        issues: [{ path: "filter.root", code: "invalid_filter" }],
      }),
    ).toMatchObject({
      code: "validation_failed",
      issues: [{ path: "/filter/root", code: "invalid_filter" }],
    });
  });

  it.each([
    ["invalid-cursor", "invalid_cursor"],
    ["capability-denied", "missing_scope"],
    ["not-found", "resource_not_found"],
    ["unsupported-operation", "unsupported_query"],
    ["range-not-supported", "range_unavailable"],
    ["data-unavailable", "data_unavailable"],
    ["internal", "internal_error"],
  ] as const)("maps %s domain failures to %s", (kind, code) => {
    const error =
      kind === "data-unavailable"
        ? { kind, retryable: true }
        : kind === "invalid-cursor"
          ? { kind, cursorKind: "keyset" }
          : kind === "capability-denied"
            ? { kind, capability: "analytics:read" }
            : kind === "not-found"
              ? { kind, resource: "site" }
              : kind === "unsupported-operation"
                ? { kind, operation: "overview" }
                : kind === "range-not-supported"
                  ? { kind, reason: "too-wide" }
                  : { kind, operation: "overview" };
    expect(
      fromAnalyticsDomainError(error as AnalyticsDomainError),
    ).toMatchObject({ code });
  });

  it("serializes analytics data with a single server request ID", () => {
    const response = serializeAnalyticsResult(
      {
        ok: true,
        data: { views: 3 },
        meta: {
          time: createQueryTime(1_000, 2_000, "UTC", 2_000),
          source: "raw",
          approximateVisitors: false,
        },
      },
      "server-request-id",
      "2026-08-01T00:00:00.000Z",
    );

    expect(response).toMatchObject({
      status: 200,
      headers: { "X-Request-Id": "server-request-id" },
      body: {
        data: { views: 3 },
        meta: {
          requestId: "server-request-id",
          timeRange: {
            from: "1970-01-01T00:00:01.000Z",
            to: "1970-01-01T00:00:02.000Z",
            timeZone: "UTC",
          },
          accuracy: "exact",
        },
      },
    });
  });

  it("serializes domain failures and simple success envelopes", () => {
    expect(toWireSuccess({ ok: true }, "req-1")).toEqual({
      data: { ok: true },
      meta: { requestId: "req-1" },
    });
    const response = serializeAnalyticsResult(
      { ok: false, error: { kind: "data-unavailable", retryable: true } },
      "req-error",
    );
    expect(response).toMatchObject({
      status: 503,
      body: { error: { code: "data_unavailable", retryable: true } },
    });
  });
});
