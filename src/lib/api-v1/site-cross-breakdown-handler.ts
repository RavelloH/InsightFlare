import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
  type AnalysisDefinitionReader,
} from "@/lib/api-v1/analysis-definition-reader";
import {
  type SiteCrossBreakdownQueryDto,
  SiteCrossBreakdownQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import {
  apiV1ErrorCodeFromProviderError,
  apiV1ErrorRegistry,
} from "@/lib/api-v1/errors";
import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/query-application";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1TimeRange } from "@/lib/api-v1/time-range";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import {
  attachSavedFilterScopePreference,
  type CrossBreakdownResult,
  type FilterDocument,
  isReportingTimeZone,
  parseApiV1FilterDocument,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { type ApiKeyPrincipal, canAccessSiteId } from "@/lib/edge/api-key-auth";

const MAX_BODY_BYTES = 64 * 1024;

export interface SiteCrossBreakdownReaderInput {
  readonly siteId: string;
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly timeZone: string;
  readonly primaryDimension: string;
  readonly secondaryDimension: string;
  readonly primaryLimit: number;
  readonly secondaryLimit: number;
  readonly filters: FilterDocument;
  readonly signal?: AbortSignal;
}

export type SiteCrossBreakdownReader = (
  input: SiteCrossBreakdownReaderInput,
) => Promise<CrossBreakdownResult>;

function response(
  status: number,
  body: unknown,
  requestId = crypto.randomUUID(),
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}

function errorResponse(code: keyof typeof apiV1ErrorRegistry): Response {
  const requestId = crypto.randomUUID();
  const definition = apiV1ErrorRegistry[code];
  return response(
    definition.status,
    {
      error: {
        code,
        message: definition.message,
        retryable: definition.retryable,
      },
      meta: { requestId },
    },
    requestId,
  );
}

function cancelledResponse(): Response {
  const requestId = crypto.randomUUID();
  return response(
    499,
    {
      error: {
        code: "request_cancelled",
        message: "The request was cancelled by the client.",
        retryable: false,
      },
      meta: { requestId },
    },
    requestId,
  );
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return true;
  return accept.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
    return (
      mediaType === "application/json" ||
      mediaType === "application/*" ||
      mediaType === "*/*"
    );
  });
}

async function readBody(request: Request): Promise<unknown> {
  return readBoundedJson(request, MAX_BODY_BYTES);
}

async function resolveFilter(
  input: SiteCrossBreakdownQueryDto,
  siteId: string,
  definitions: AnalysisDefinitionReader | undefined,
  signal: AbortSignal | undefined,
): Promise<FilterDocument | null> {
  if (!input.filter) return { version: 1, root: null };
  if (input.filter.type === "saved") {
    if (!definitions) return null;
    return definitions
      .resolveTeamVisibleSavedFilter({
        siteId,
        id: input.filter.id,
        signal,
      })
      .then((resolved) =>
        resolved
          ? attachSavedFilterScopePreference(
              resolved.document,
              resolved.scopePreference ?? "auto",
            )
          : null,
      );
  }
  try {
    return parseApiV1FilterDocument({
      version: 1,
      root: input.filter.expression,
    });
  } catch {
    return null;
  }
}

/** Planned adapter; it remains unregistered until rollout gates are met. */
export async function handlePlannedSiteCrossBreakdown(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution: {
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
    readonly capturedAtMs?: number;
    readonly now?: () => number;
  } = {},
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  if (request.method !== "POST") {
    const response = errorResponse("method_not_allowed");
    response.headers.set("Allow", "POST");
    return response;
  }
  if (request.headers.has("content-encoding")) {
    return errorResponse("unsupported_media_type");
  }
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return errorResponse("unsupported_media_type");
  }
  if (!acceptsJson(request)) return errorResponse("not_acceptable");

  let input: SiteCrossBreakdownQueryDto;
  try {
    input = SiteCrossBreakdownQueryDtoSchema.parse(await readBody(request));
  } catch {
    return errorResponse("validation_failed");
  }
  if (!principal.scopes.includes("analytics:read")) {
    return errorResponse("missing_scope");
  }
  if ((principal.status ?? "active") !== "active") {
    return errorResponse("missing_scope");
  }
  if (!canAccessSiteId(principal, siteId)) {
    return errorResponse("resource_not_found");
  }
  if (
    input.filter?.type === "saved" &&
    !principal.scopes.includes("analysis:read")
  ) {
    return errorResponse("missing_scope");
  }

  const resolvedTimeRange = resolveApiV1TimeRange(
    input.timeRange,
    execution.capturedAtMs ?? Date.now(),
  );
  const startMs = resolvedTimeRange ? Date.parse(resolvedTimeRange.from) : NaN;
  const endExclusiveMs = resolvedTimeRange
    ? Date.parse(resolvedTimeRange.to)
    : NaN;
  const timeZone = resolvedTimeRange?.timeZone ?? "UTC";
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endExclusiveMs) ||
    endExclusiveMs <= startMs ||
    !isReportingTimeZone(timeZone)
  ) {
    return errorResponse("validation_failed");
  }
  let filters: FilterDocument | null;
  try {
    filters = await resolveFilter(input, siteId, definitions, execution.signal);
  } catch (error) {
    if (error instanceof AnalysisDefinitionReadCancelledError) {
      return cancelledResponse();
    }
    if (error instanceof AnalysisDefinitionIntegrityError) {
      return errorResponse("internal_error");
    }
    return errorResponse("internal_error");
  }
  if (!filters) {
    return errorResponse(
      input.filter?.type === "saved"
        ? "resource_not_found"
        : "validation_failed",
    );
  }
  try {
    const query = {
      siteId,
      startMs,
      endExclusiveMs,
      timeZone,
      primaryDimension: input.primaryDimension,
      secondaryDimension: input.secondaryDimension,
      primaryLimit: input.primaryLimit,
      secondaryLimit: input.secondaryLimit,
      filters,
      scopePreference: input.scope ?? "auto",
    };
    const serviceResult = await createApiV1QueryApplicationAdapter().execute<
      SiteCrossBreakdownReaderInput,
      CrossBreakdownResult
    >(
      {
        operation: "site.analytics.crossBreakdown",
        context: siteQueryContext(siteId, "api-v1"),
        query,
        providerRegistry,
      },
      {
        signal: execution.signal,
        deadlineMs: execution.deadlineMs,
        capturedAtMs: execution.capturedAtMs,
        now: execution.now,
        cost: {
          rangeMs: endExclusiveMs - startMs,
          siteCount: 1,
          metricCount: 1,
          dimensionCardinality: input.primaryLimit * input.secondaryLimit,
          pageLimit: input.primaryLimit,
          provider: "d1",
        },
      },
    );
    if (!serviceResult.ok) {
      if (serviceResult.error.kind === "request-cancelled")
        return cancelledResponse();
      if (serviceResult.error.kind === "deadline-exceeded")
        return errorResponse("deadline_exceeded");
      return errorResponse("unsupported_query");
    }
    const result = serviceResult.value;
    if (execution.signal?.aborted) return cancelledResponse();
    if (
      typeof execution.deadlineMs === "number" &&
      (execution.now?.() ?? Date.now()) >= execution.deadlineMs
    ) {
      return errorResponse("deadline_exceeded");
    }
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data: result,
        meta: {
          requestId,
          generatedAt: new Date().toISOString(),
          timeRange: {
            from: new Date(startMs).toISOString(),
            to: new Date(endExclusiveMs).toISOString(),
            timeZone,
          },
          source: "raw",
          accuracy: "exact",
          ...(serviceResult.meta?.filterScope
            ? { filterScope: serviceResult.meta.filterScope }
            : {}),
        },
      },
      requestId,
    );
  } catch (error) {
    if (execution.signal?.aborted) return cancelledResponse();
    const mappedCode = apiV1ErrorCodeFromProviderError(error);
    if (mappedCode) return errorResponse(mappedCode);
    return errorResponse("internal_error");
  }
}
