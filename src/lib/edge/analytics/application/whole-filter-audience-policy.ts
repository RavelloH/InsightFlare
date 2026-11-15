export type WholeFilterExposure =
  "page-dimension" | "channel-list" | "channel-overview";

export type WholeFilterAudienceDecision =
  | { readonly allowed: true; readonly reason: "private-whole-filter" }
  | {
      readonly allowed: false;
      readonly effect: "keep-existing-fallback";
      readonly reason: "private-whole-filter-required";
    };

/** Product exposure policy, independent of report/SQL selection details. */
export function checkWholeFilterAudiencePolicy(input: {
  readonly exposure: WholeFilterExposure;
  readonly audience: unknown;
}): WholeFilterAudienceDecision {
  return input.audience === "private-dashboard"
    ? { allowed: true, reason: "private-whole-filter" }
    : {
        allowed: false,
        effect: "keep-existing-fallback",
        reason: "private-whole-filter-required",
      };
}
