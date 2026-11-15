import { checkWholeFilterAudiencePolicy } from "@/lib/edge/analytics/application/whole-filter-audience-policy";
import {
  dimensionPageSelection,
  overviewPageTableDescriptor,
  PAGE_DIMENSION_SELECTIONS,
} from "@/lib/edge/analytics/engine/dimension-report-plan";

/**
 * Existing private whole-filter exposure rules. These checks only select an
 * execution path; site authorization, provenance and time proofs remain with
 * the caller. A false result retains the existing query fallback.
 */
export function isCanonicalPrivatePageDimensionWholeFilterRequest(input: {
  readonly mode: unknown;
  readonly audience: unknown;
  readonly dimension?: unknown;
  readonly tab?: unknown;
  readonly selection: unknown;
  readonly excludeEmpty: unknown;
  readonly overviewFamily?: unknown;
}): boolean {
  if (
    !checkWholeFilterAudiencePolicy({
      exposure: "page-dimension",
      audience: input.audience,
    }).allowed
  )
    return false;
  if (input.mode === "breakdown") {
    if (
      typeof input.dimension !== "string" ||
      input.dimension === "traffic.channel" ||
      input.excludeEmpty !== false
    )
      return false;
    const canonicalSelection = dimensionPageSelection(input.dimension);
    return (
      canonicalSelection !== null &&
      JSON.stringify(input.selection) === JSON.stringify(canonicalSelection)
    );
  }
  if (input.mode !== "overview-tab" || typeof input.tab !== "string")
    return false;
  const descriptor = overviewPageTableDescriptor(input.tab);
  return (
    descriptor !== null &&
    (descriptor.family === "page" ||
      descriptor.family === "client" ||
      descriptor.family === "utm" ||
      descriptor.family === "geo") &&
    (input.overviewFamily === undefined ||
      input.overviewFamily === descriptor.family) &&
    input.excludeEmpty === descriptor.excludeEmpty &&
    JSON.stringify(input.selection) === JSON.stringify(descriptor.selection)
  );
}

export function isCanonicalPrivateChannelListWholeFilterRequest(input: {
  readonly mode: unknown;
  readonly audience: unknown;
}): boolean {
  return (
    input.mode === "list" &&
    checkWholeFilterAudiencePolicy({
      exposure: "channel-list",
      audience: input.audience,
    }).allowed
  );
}

export function isCanonicalPrivateChannelOverviewWholeFilterRequest(input: {
  readonly mode: unknown;
  readonly audience: unknown;
  readonly tab: unknown;
  readonly family: unknown;
  readonly selection: unknown;
  readonly excludeEmpty: unknown;
}): boolean {
  return (
    input.mode === "overview-tab" &&
    checkWholeFilterAudiencePolicy({
      exposure: "channel-overview",
      audience: input.audience,
    }).allowed &&
    input.tab === "source.channel" &&
    input.family === "channel" &&
    input.excludeEmpty === true &&
    JSON.stringify(input.selection) ===
      JSON.stringify(PAGE_DIMENSION_SELECTIONS.trafficChannel)
  );
}
