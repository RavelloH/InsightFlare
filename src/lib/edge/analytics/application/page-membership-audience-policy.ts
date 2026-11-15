/**
 * Audience policy for the Page-role membership optimization. A denial declines
 * this exposure path; it is never a denial of permission to execute a query.
 * Authorization, trusted preparation and time/site proofs remain caller duties.
 * This module describes product exposure rules without SQL or storage concepts.
 */
export type PageMembershipAudienceDecision =
  | {
      readonly allowed: true;
      readonly reason:
        "entity-page-role" | "private-consumer" | "private-opt-in";
    }
  | {
      readonly allowed: false;
      readonly effect: "keep-existing-fallback";
      readonly reason:
        | "unsupported-page-role"
        | "private-preparation-required"
        | "reader-audience-mismatch"
        | "private-consumer-required"
        | "private-reader-required"
        | "private-opt-in-required";
    };

export interface PageMembershipAudienceInput {
  readonly exposure: "event-page-visits" | "entity-membership";
  readonly operation: string;
  readonly preparationAudience?: unknown;
  readonly consumerAudience?: unknown;
  readonly readerAudience?: unknown;
  readonly privateOptIns?: {
    readonly performance: boolean;
    readonly geoPoints: boolean;
    readonly technology: boolean;
  };
}

const ENTITY_PAGE_ROLES: readonly string[] = [
  "share-trend",
  "radar",
  "cross-dimension",
  "performance",
  "geo-points",
  "pages-aggregate-page",
  "pages-tabs",
  "referrers",
  "page-dimension",
  "channel-overview",
  "channel-list",
  "session-boundary-dimension",
  "session-boundary-overview-page",
];

function deny(
  reason: Extract<PageMembershipAudienceDecision, { allowed: false }>["reason"],
): PageMembershipAudienceDecision {
  return { allowed: false, effect: "keep-existing-fallback", reason };
}

export function checkPageMembershipAudiencePolicy(
  input: PageMembershipAudienceInput,
): PageMembershipAudienceDecision {
  // Entity membership is an ID set for an already authorized site. This path
  // historically has no audience/opt-in gate, but only these report roles.
  if (input.exposure === "entity-membership")
    return ENTITY_PAGE_ROLES.includes(input.operation)
      ? { allowed: true, reason: "entity-page-role" }
      : deny("unsupported-page-role");

  if (input.preparationAudience !== "private-dashboard")
    return deny("private-preparation-required");
  if (
    input.readerAudience !== undefined &&
    input.readerAudience !== input.preparationAudience
  )
    return deny("reader-audience-mismatch");

  let optIn: boolean | undefined;
  switch (input.operation) {
    case "performance":
      optIn = input.privateOptIns?.performance === true;
      break;
    case "geo-points":
      optIn = input.privateOptIns?.geoPoints === true;
      break;
    case "cross-dimension":
    case "radar":
    case "share-trend":
      optIn = input.privateOptIns?.technology === true;
      break;
    case "pages-aggregate-page":
    case "pages-tabs":
    case "referrers":
    case "page-dimension":
    case "channel-overview":
    case "channel-list":
    case "session-boundary-dimension":
    case "session-boundary-overview-page":
    case "filter-values":
      return input.consumerAudience === "private-dashboard"
        ? { allowed: true, reason: "private-consumer" }
        : deny("private-consumer-required");
    default:
      return deny("unsupported-page-role");
  }
  // These event Page projections require an explicit reader as well as the
  // matching private opt-in; an omitted reader is not implicit consent.
  if (input.readerAudience !== "private-dashboard")
    return deny("private-reader-required");
  return optIn
    ? { allowed: true, reason: "private-opt-in" }
    : deny("private-opt-in-required");
}
