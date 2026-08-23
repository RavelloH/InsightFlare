import { executeBoundedBatch } from "@/lib/api-v1/batch-scheduler";
import {
  type TypedBatchItem,
  type TypedBatchRequest,
} from "@/lib/api-v1/dto/batch";
import { calculateQueryCost } from "@/lib/api-v1/query-cost";
import {
  API_V1_BATCH_BODY_MAX_BYTES,
  API_V1_BATCH_ITEM_BODY_MAX_BYTES,
  readBoundedBody,
} from "@/lib/api-v1/request-budget";
import {
  apiV1NonBatchRouteRegistry,
  isApiV1BatchEligible,
} from "@/lib/api-v1/route-registry";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

export type { TypedBatchItem, TypedBatchRequest } from "@/lib/api-v1/dto/batch";

export interface TypedBatchDispatchContext {
  readonly request: Request;
  readonly principal: ApiKeyPrincipal;
  readonly signal: AbortSignal;
}

export type TypedBatchDispatcher = (
  item: TypedBatchItem,
  context: TypedBatchDispatchContext,
) => Promise<Response>;

export interface TypedBatchOptions {
  readonly dispatch: TypedBatchDispatcher;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly maxConcurrency?: number;
  readonly maxWeight?: number;
}

export interface TypedBatchItemResponse {
  readonly id: string;
  readonly status: number;
  readonly body: unknown;
}

export interface TypedBatchResult {
  readonly responses: readonly TypedBatchItemResponse[];
  readonly partialFailure: boolean;
}

const MAX_ITEM_OUTPUT_BYTES = API_V1_BATCH_ITEM_BODY_MAX_BYTES;
const MAX_TOTAL_OUTPUT_BYTES = API_V1_BATCH_BODY_MAX_BYTES;

// Derive the child allow-list from explicit registry metadata. The batch
// descriptor itself is intentionally appended to the public graph separately
// and can never become a child through an accidental registry cycle.
const descriptorPaths = apiV1NonBatchRouteRegistry.filter(
  (route) =>
    route.lifecycle === "exposed" &&
    route.method === "POST" &&
    isApiV1BatchEligible(route.id),
);
const descriptorGets = apiV1NonBatchRouteRegistry.filter(
  (route) =>
    route.lifecycle === "exposed" &&
    isApiV1BatchEligible(route.id) &&
    route.method === "GET",
);

function pathMatches(template: string, candidate: string): boolean {
  const templateParts = template.split("/").filter(Boolean);
  const candidateParts = candidate.split("/").filter(Boolean);
  if (templateParts.length !== candidateParts.length) return false;
  return templateParts.every((part, index) =>
    part.startsWith("{") && part.endsWith("}")
      ? Boolean(candidateParts[index])
      : part === candidateParts[index],
  );
}

function isAllowed(item: TypedBatchItem): boolean {
  const descriptors = item.method === "POST" ? descriptorPaths : descriptorGets;
  return descriptors.some((route) => pathMatches(route.path, item.path));
}

function weightFor(item: TypedBatchItem, now: number): number {
  const body =
    item.body && typeof item.body === "object"
      ? (item.body as Record<string, unknown>)
      : {};
  const isComparison = item.path.includes("/analytics/comparison");
  const ranges = isComparison
    ? [body.current, body.reference]
    : [body.timeRange];
  const parsedRanges = ranges.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const range = value as Record<string, unknown>;
    const timeRange = "timeRange" in range ? range.timeRange : range;
    if (!timeRange || typeof timeRange !== "object") return [];
    const candidate = timeRange as Record<string, unknown>;
    const from = "from" in candidate ? Date.parse(String(candidate.from)) : NaN;
    const to = "to" in candidate ? Date.parse(String(candidate.to)) : NaN;
    return Number.isFinite(from) && Number.isFinite(to) ? [{ from, to }] : [];
  });
  const from =
    parsedRanges.length > 0
      ? Math.min(...parsedRanges.map((range) => range.from))
      : now - 7 * 24 * 60 * 60 * 1000;
  const to =
    parsedRanges.length > 0
      ? Math.max(...parsedRanges.map((range) => range.to))
      : now;
  const days =
    Number.isFinite(from) && Number.isFinite(to)
      ? Math.max(1, Math.ceil((to - from) / (24 * 60 * 60 * 1000)))
      : 365;
  return calculateQueryCost({
    rangeMs: days * 24 * 60 * 60 * 1000,
    sideCount: isComparison ? 2 : 1,
    siteCount: item.path.includes("/sites/") ? 1 : 2,
    metricCount:
      isComparison &&
      body.select &&
      typeof body.select === "object" &&
      Array.isArray((body.select as Record<string, unknown>).metrics)
        ? ((body.select as Record<string, unknown>).metrics as unknown[]).length
        : Array.isArray(body.metrics)
          ? body.metrics.length
          : 1,
    bucketCount:
      isComparison &&
      body.select &&
      typeof body.select === "object" &&
      (body.select as Record<string, unknown>).trend
        ? Math.max(1, days)
        : 1,
    filterComplexity: isComparison ? 2 : 1,
    breakdownLimit:
      isComparison && "limit" in body ? Number(body.limit) : undefined,
    pageLimit:
      body &&
      typeof body === "object" &&
      "page" in body &&
      body.page &&
      typeof body.page === "object" &&
      "limit" in body.page
        ? Number(body.page.limit)
        : 1,
    provider: item.path.includes("/realtime/") ? "realtime" : "d1",
  });
}

export async function executeTypedBatch(
  request: Request,
  principal: ApiKeyPrincipal,
  input: TypedBatchRequest,
  options: TypedBatchOptions,
): Promise<TypedBatchResult> {
  const invalid = input.requests.filter(
    (item) =>
      item.path.startsWith("/api/v1/") === false ||
      item.path.startsWith("/api/v1/batch") ||
      item.path.startsWith("/collect") ||
      !isAllowed(item),
  );
  if (invalid.length > 0) {
    throw new TypedBatchValidationError(
      "batch_child_not_allowed",
      invalid.map((item) => item.id),
    );
  }

  const origin = new URL(request.url).origin;
  const now = options.now?.() ?? Date.now();
  let outputBytes = 0;
  const work = input.requests.map((item) => ({
    id: item.id,
    weight: weightFor(item, now),
    run: async (signal: AbortSignal) => {
      const childRequest = new Request(new URL(item.path, origin), {
        method: item.method,
        headers: { "content-type": "application/json" },
        body:
          item.method === "POST" ? JSON.stringify(item.body ?? {}) : undefined,
        signal,
      });
      const response = await options.dispatch(item, {
        request: childRequest,
        principal,
        signal,
      });
      const bounded =
        response.status === 204
          ? { ok: true as const, bytes: new Uint8Array() }
          : await readBoundedBody(response, MAX_ITEM_OUTPUT_BYTES);
      if (!bounded.ok) throw new BatchOutputTooLarge();
      outputBytes += bounded.bytes.byteLength;
      if (outputBytes > MAX_TOTAL_OUTPUT_BYTES) throw new BatchOutputTooLarge();
      let body: unknown = null;
      if (bounded.bytes.byteLength > 0) {
        try {
          body = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes),
          ) as unknown;
        } catch {
          throw new Error("invalid_child_json");
        }
      }
      return {
        id: item.id,
        status: response.status,
        body,
      } satisfies TypedBatchItemResponse;
    },
  }));
  const deadline = input.deadlineMs ? now + input.deadlineMs : undefined;
  const result = await executeBoundedBatch(work, {
    maxConcurrency: options.maxConcurrency ?? 4,
    maxWeight: options.maxWeight ?? 10_000,
    signal: options.signal,
    deadlineMs: deadline,
    now: options.now,
  });
  const responses = result.map((item) =>
    item.ok
      ? item.value
      : {
          id: item.id,
          status:
            item.error === "internal_error"
              ? 500
              : item.error === "deadline_exceeded"
                ? 504
                : item.error === "budget_exceeded"
                  ? 422
                  : item.error === "payload_too_large"
                    ? 413
                    : 408,
          body: { error: { code: item.error } },
        },
  );
  return {
    responses,
    partialFailure: responses.some((item) => item.status >= 400),
  };
}

export class TypedBatchValidationError extends Error {
  readonly code = "batch_child_not_allowed";
  readonly itemIds: readonly string[];

  constructor(code: string, itemIds: readonly string[]) {
    super(code);
    this.itemIds = itemIds;
  }
}

class BatchOutputTooLarge extends Error {
  constructor() {
    super("payload_too_large");
  }
}
