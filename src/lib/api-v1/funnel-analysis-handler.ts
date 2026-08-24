import {
  AnalysisDefinitionReadCancelledError,
  type AnalysisDefinitionReader,
} from "@/lib/api-v1/analysis-definition-reader";
import { SiteFunnelAnalysisQueryDtoSchema } from "@/lib/api-v1/dto/analytics";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1TimeRange } from "@/lib/api-v1/time-range";
import {
  jsonError,
  jsonSuccess,
  methodNotAllowed,
} from "@/lib/api-v1/wire-helpers";
import type { TypedApplicationProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { TypedQueryApplicationService } from "@/lib/edge/analytics/application/service";
import {
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  parseApiV1FilterDocument,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import { canAccessSiteId } from "@/lib/edge/api-key-auth";

const MAX_BODY_BYTES = 64 * 1024;

export interface SiteFunnelAnalysisProviderInput {
  readonly siteId: string;
  readonly funnelId: string;
  readonly filters: FilterDocument;
  readonly window: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
    readonly nowMs: number;
    readonly timeZone: string;
  };
}

export interface SiteFunnelAnalysisProviderResult {
  readonly funnel: unknown;
  readonly analysis: unknown;
}

export type SiteFunnelAnalysisProvider = (
  input: SiteFunnelAnalysisProviderInput,
) => Promise<SiteFunnelAnalysisProviderResult | null>;

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept || !accept.trim()) return true;
  return accept.split(",").some((part) => {
    const type = part.split(";", 1)[0]?.trim().toLowerCase();
    return (
      type === "application/json" || type === "application/*" || type === "*/*"
    );
  });
}

async function readJson(request: Request): Promise<unknown> {
  return readBoundedJson(request, MAX_BODY_BYTES);
}

function filterForInput(
  input: {
    readonly filter?:
      | { readonly type: "inline"; readonly expression: unknown }
      | { readonly type: "saved"; readonly id: string }
      | null;
  },
  siteId: string,
  definitions: AnalysisDefinitionReader | undefined,
  signal: AbortSignal | undefined,
): Promise<FilterDocument | null> {
  if (!input.filter) return Promise.resolve(EMPTY_FILTER_DOCUMENT);
  if (input.filter.type === "saved") {
    if (!definitions) return Promise.resolve(null);
    return definitions
      .resolveTeamVisibleSavedFilter({ siteId, id: input.filter.id, signal })
      .then((resolved) => resolved?.document ?? null);
  }
  try {
    return Promise.resolve(
      parseApiV1FilterDocument({ version: 1, root: input.filter.expression }),
    );
  } catch {
    return Promise.resolve(null);
  }
}

/** Typed site funnel-analysis query boundary. */
export async function handlePlannedSiteFunnelAnalysis(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: TypedApplicationProviderRegistry,
  definitions?: AnalysisDefinitionReader,
  execution: {
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
    readonly capturedAtMs?: number;
    readonly now?: () => number;
  } = {},
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, "POST");
  if (request.headers.has("content-encoding")) {
    return jsonError(
      "unsupported_media_type",
      "Content-Encoding is not supported",
      415,
      undefined,
      request,
    );
  }
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return jsonError(
      "unsupported_media_type",
      "Expected application/json",
      415,
      undefined,
      request,
    );
  }
  if (!acceptsJson(request)) {
    return jsonError(
      "not_acceptable",
      "Only application/json is supported",
      406,
      undefined,
      request,
    );
  }
  if (!principal.scopes.includes("analytics:read")) {
    return jsonError(
      "missing_scope",
      "The API key lacks analytics:read",
      403,
      undefined,
      request,
    );
  }
  if (!canAccessSiteId(principal, siteId)) {
    return jsonError(
      "resource_not_found",
      "Site not found",
      404,
      undefined,
      request,
    );
  }

  let raw: unknown;
  try {
    raw = await readJson(request);
  } catch (error) {
    const code =
      error instanceof Error && error.message === "body_too_large"
        ? "unsupported_query"
        : "validation_failed";
    return jsonError(
      code,
      "Request validation failed",
      422,
      undefined,
      request,
    );
  }
  const parsed = SiteFunnelAnalysisQueryDtoSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      "validation_failed",
      "Request validation failed",
      400,
      undefined,
      request,
    );
  }
  if (
    parsed.data.filter?.type === "saved" &&
    !principal.scopes.includes("analysis:read")
  ) {
    return jsonError(
      "missing_scope",
      "The API key lacks analysis:read",
      403,
      undefined,
      request,
    );
  }
  const resolved = resolveApiV1TimeRange(
    parsed.data.timeRange,
    execution.capturedAtMs ?? Date.now(),
  );
  if (!resolved) {
    return jsonError(
      "validation_failed",
      "Invalid time range",
      400,
      undefined,
      request,
    );
  }
  let filters: FilterDocument | null;
  try {
    filters = await filterForInput(
      parsed.data,
      siteId,
      definitions,
      execution.signal,
    );
  } catch (error) {
    if (error instanceof AnalysisDefinitionReadCancelledError) {
      return jsonError(
        "data_unavailable",
        "Request cancelled",
        499,
        undefined,
        request,
      );
    }
    return jsonError(
      "internal_error",
      "Unable to resolve saved filter",
      500,
      undefined,
      request,
    );
  }
  if (!filters) {
    return jsonError(
      "resource_not_found",
      "Saved filter or funnel not found",
      404,
      undefined,
      request,
    );
  }

  try {
    const serviceResult = await new TypedQueryApplicationService().execute<
      SiteFunnelAnalysisProviderInput,
      SiteFunnelAnalysisProviderResult | null
    >(
      {
        operation: "site.analytics.funnelAnalysis",
        context: siteQueryContext(siteId, "api-v1"),
        query: {
          siteId,
          funnelId: parsed.data.funnelId,
          filters,
          window: {
            startMs: Date.parse(resolved.from),
            endExclusiveMs: Date.parse(resolved.to),
            nowMs: execution.capturedAtMs ?? Date.now(),
            timeZone: resolved.timeZone,
          },
        },
        providerRegistry,
      },
      {
        signal: execution.signal,
        deadlineMs: execution.deadlineMs,
        capturedAtMs: execution.capturedAtMs,
        now: execution.now,
        cost: {
          rangeMs: Date.parse(resolved.to) - Date.parse(resolved.from),
          siteCount: 1,
          metricCount: 1,
          provider: "d1",
        },
      },
    );
    if (!serviceResult.ok) {
      if (serviceResult.error.kind === "request-cancelled") {
        return jsonError(
          "internal_error",
          "Request cancelled",
          499,
          undefined,
          request,
        );
      }
      if (serviceResult.error.kind === "deadline-exceeded") {
        return jsonError(
          "deadline_exceeded",
          "The analytics query exceeded its deadline",
          504,
          undefined,
          request,
        );
      }
      return jsonError(
        "unsupported_query",
        "The query exceeds the configured cost budget",
        422,
        undefined,
        request,
      );
    }
    const result = serviceResult.value;
    if (!result) {
      return jsonError(
        "resource_not_found",
        "Funnel not found",
        404,
        undefined,
        request,
      );
    }
    return jsonSuccess(result, {
      request,
      meta: {
        timeRange: resolved,
        source: "raw",
        accuracy: "exact",
      },
    });
  } catch {
    return jsonError(
      "data_unavailable",
      "Funnel data is unavailable",
      503,
      undefined,
      request,
    );
  }
}
