import {
  type FilterDocument,
  type QueryAudience,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  prepareScopedQuery,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";

/** Internal complete aggregate request: deliberately has no paging or limit. */
export interface SiteExactDimensionRequest extends QueryInput {
  readonly kind: "site-exact-dimension";
  readonly time: QueryTime;
  readonly dimension: string;
  readonly filters: FilterDocument;
}

declare const exactQualificationProjectionBrand: unique symbol;
export type SiteExactDimensionQualificationProjection = Readonly<{
  readonly [exactQualificationProjectionBrand]: true;
}>;
interface ProjectionContext {
  readonly siteId: string;
  readonly audience: QueryAudience;
  readonly dimension: string;
  readonly time: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly scopePreference?: QueryInput["scopePreference"];
}
interface ProjectionState {
  readonly context: ProjectionContext;
  readonly snapshot: string;
  readonly preparation: object;
  request?: SiteExactDimensionRequest;
}
const projections = new WeakMap<object, ProjectionState>();
const requests = new WeakMap<
  SiteExactDimensionRequest,
  {
    readonly snapshot: string;
    readonly projection?: SiteExactDimensionQualificationProjection;
  }
>();
function contextSnapshot(context: ProjectionContext): string {
  return JSON.stringify(
    {
      siteId: context.siteId,
      audience: context.audience,
      dimension: context.dimension,
      time: context.time,
      filters: context.filters,
      scopePlan: context.scopePlan,
      scopePreference: context.scopePreference,
    },
    (_key, value: unknown) => (value instanceof Set ? [...value] : value),
  );
}
function projectionMatches(
  state: ProjectionState,
  context: ProjectionContext,
): boolean {
  return (
    state.context.filters === context.filters &&
    state.context.time === context.time &&
    state.context.scopePlan === context.scopePlan &&
    state.snapshot === contextSnapshot(context)
  );
}
/** Records exact private request identity, never relation execution authority.
 * The D1 owner must independently prove the actual preparation before storage. */
export function createSiteExactDimensionQualificationProjection(
  input: ProjectionContext & { readonly preparation: object },
): SiteExactDimensionQualificationProjection {
  const { preparation, ...context } = input;
  const metadata = scopedFilterMetadata(context.filters);
  if (
    context.audience !== "private-dashboard" ||
    !context.siteId ||
    !metadata ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== context.siteId ||
    metadata.plan !== context.scopePlan ||
    metadata.time !== context.time ||
    context.scopePlan.mode !== "entity" ||
    context.scopePlan.preparedMembership !== undefined ||
    !filterDocumentUsesAdvancedExpressions(context.filters)
  )
    throw new Error(
      "site_exact_dimension_qualification_projection_context_mismatch",
    );
  const projection = Object.freeze(
    Object.create(null),
  ) as SiteExactDimensionQualificationProjection;
  projections.set(projection, {
    context,
    snapshot: contextSnapshot(context),
    preparation,
  });
  return projection;
}

function requestSnapshot(request: SiteExactDimensionRequest): string {
  return JSON.stringify(request, (_key, value: unknown) =>
    value instanceof Set ? [...value] : value,
  );
}

export function prepareSiteExactDimensionRequest(input: {
  readonly siteId: string;
  readonly audience: QueryAudience;
  readonly dimension: string;
  readonly time: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePreference?: QueryInput["scopePreference"];
  readonly qualifiedPlan?: ScopedFilterPlan;
  readonly qualification?: SiteExactDimensionQualificationProjection;
}): SiteExactDimensionRequest {
  if (input.audience !== "private-dashboard")
    throw new Error("site_exact_dimension_private_audience_required");
  const projection = input.qualification
    ? projections.get(input.qualification)
    : undefined;
  if (
    input.qualification &&
    (!projection ||
      projection.request !== undefined ||
      !input.qualifiedPlan ||
      !projectionMatches(projection, {
        siteId: input.siteId,
        audience: input.audience,
        dimension: input.dimension,
        time: input.time,
        filters: input.filters,
        scopePlan: input.qualifiedPlan,
        ...(input.scopePreference !== undefined
          ? { scopePreference: input.scopePreference }
          : {}),
      }))
  )
    throw new Error(
      "site_exact_dimension_qualification_projection_context_mismatch",
    );
  if (
    filterDocumentUsesAdvancedExpressions(input.filters) &&
    !input.qualifiedPlan?.preparedMembership &&
    !projection
  )
    throw new Error("site_exact_dimension_qualified_membership_required");
  const query = {
    context: siteQueryContext(input.siteId, input.audience),
    dimension: input.dimension,
    time: input.time,
    filters: input.filters,
    ...(input.scopePreference !== undefined
      ? { scopePreference: input.scopePreference }
      : {}),
  };
  const scoped = input.qualifiedPlan
    ? { ...query, scopePlan: input.qualifiedPlan }
    : prepareScopedQuery("dimension", query);
  const request = Object.freeze({
    ...scoped,
    kind: "site-exact-dimension" as const,
  });
  requests.set(request, {
    snapshot: requestSnapshot(request),
    projection: input.qualification,
  });
  if (projection) projection.request = request;
  return request;
}

/** Reject clones and a qualified handle moved to another site/time domain. */
export function isSiteExactDimensionRequest(
  request: SiteExactDimensionRequest,
): boolean {
  if (
    !requests.has(request) ||
    requests.get(request)?.snapshot !== requestSnapshot(request) ||
    request.context.subject.kind !== "site"
  )
    return false;
  const projection = requests.get(request)?.projection;
  if (projection) {
    const state = projections.get(projection);
    if (
      !state ||
      state.request !== request ||
      !request.scopePlan ||
      !projectionMatches(state, {
        siteId: request.context.subject.siteId,
        audience: request.context.policy.audience,
        dimension: request.dimension,
        time: request.time,
        filters: request.filters,
        scopePlan: request.scopePlan,
        ...(request.scopePreference !== undefined
          ? { scopePreference: request.scopePreference }
          : {}),
      })
    )
      return false;
  }
  const metadata = scopedFilterMetadata(request.filters);
  return (
    metadata !== undefined &&
    metadata.siteIds.length === 1 &&
    metadata.siteIds[0] === request.context.subject.siteId &&
    metadata.time === request.time &&
    metadata.plan === request.scopePlan
  );
}

/** Opaque identity is not proof: the D1 owner must freshly validate this value. */
export function siteExactDimensionQualificationForRequest(
  request: SiteExactDimensionRequest,
): Readonly<{ readonly preparation: unknown }> | undefined {
  if (!isSiteExactDimensionRequest(request))
    throw new Error("site_exact_dimension_request_context_mismatch");
  const projection = requests.get(request)!.projection;
  if (!projection) return undefined;
  return Object.freeze({
    preparation: projections.get(projection)!.preparation,
  });
}
