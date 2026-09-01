import { type FilterCodecOptions, parseFilterParams } from "./filter-codec";
import { analyticsFilterRegistry } from "./filter-registry";
import {
  assertFilterAudience,
  type FilterDocument,
  normalizeFilterDocument,
} from "./filters";
import {
  attachFilterScopePreference,
  parseFilterScopePreference,
} from "./scoped-filter";
import type { QueryAudience } from "./types";

export class FilterAdapterError extends Error {
  readonly audience: QueryAudience;

  constructor(audience: QueryAudience, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Invalid filter input.");
    this.name = "FilterAdapterError";
    this.audience = audience;
    this.cause = cause;
  }
}

function fromUrl(
  audience: QueryAudience,
  input: string | URL | URLSearchParams,
  options?: FilterCodecOptions,
): FilterDocument {
  try {
    const document = parseFilterParams(input, analyticsFilterRegistry, options);
    assertFilterAudience(document, analyticsFilterRegistry, audience);
    return attachFilterScopePreference(
      document,
      parseFilterScopePreference(input),
    );
  } catch (error) {
    throw new FilterAdapterError(audience, error);
  }
}

function fromJson(audience: QueryAudience, input: unknown): FilterDocument {
  try {
    const document = normalizeFilterDocument(input, analyticsFilterRegistry);
    assertFilterAudience(document, analyticsFilterRegistry, audience);
    return document;
  } catch (error) {
    throw new FilterAdapterError(audience, error);
  }
}

/** Private dashboard protocol adapter. */
export function parsePrivateFilterUrl(
  input: string | URL | URLSearchParams,
  options?: FilterCodecOptions,
): FilterDocument {
  return fromUrl("private-dashboard", input, options);
}

/** Public sharing protocol adapter. Sensitive fields fail closed before D1 access. */
export function parsePublicFilterUrl(
  input: string | URL | URLSearchParams,
  options?: FilterCodecOptions,
): FilterDocument {
  return fromUrl("public-share", input, options);
}

/** API v1 URL filter adapter. */
export function parseApiV1FilterUrl(
  input: string | URL | URLSearchParams,
  options?: FilterCodecOptions,
): FilterDocument {
  return fromUrl("api-v1", input, options);
}

/** Selects one of the protocol adapters from the already-authorized audience. */
export function parseFilterUrlForAudience(
  audience: QueryAudience,
  input: string | URL | URLSearchParams,
  options?: FilterCodecOptions,
): FilterDocument {
  if (audience === "public-share") return parsePublicFilterUrl(input, options);
  if (audience === "api-v1") return parseApiV1FilterUrl(input, options);
  return parsePrivateFilterUrl(input, options);
}

/** API v1 structured filter adapter for request bodies such as analytics/explore. */
export function parseApiV1FilterDocument(input: unknown): FilterDocument {
  return fromJson("api-v1", input);
}
