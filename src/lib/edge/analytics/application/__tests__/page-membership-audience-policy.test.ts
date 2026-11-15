import { describe, expect, it } from "vitest";

import { checkPageMembershipAudiencePolicy } from "@/lib/edge/analytics/application/page-membership-audience-policy";

const consumers = [
  "pages-aggregate-page",
  "pages-tabs",
  "referrers",
  "page-dimension",
  "channel-overview",
  "channel-list",
  "session-boundary-dimension",
  "session-boundary-overview-page",
  "filter-values",
];
const optInRoles = [
  "performance",
  "geo-points",
  "cross-dimension",
  "radar",
  "share-trend",
];
const unsupported = [
  "overview",
  "trend",
  "event-summary",
  "visitors",
  "retention",
  "unknown",
  "toString",
  "__proto__",
];
const audiences = [
  undefined,
  "private-dashboard",
  "api-v1",
  "public-share",
  "unknown",
];
const roles = [...consumers, ...optInRoles, ...unsupported];

describe("Page membership audience policy", () => {
  it.each(roles)(
    "preserves the complete event exposure matrix for %s",
    (operation) => {
      for (const preparationAudience of audiences) {
        for (const readerAudience of audiences) {
          for (const consumerAudience of audiences) {
            for (let mask = 0; mask < 8; mask += 1) {
              const privateOptIns = {
                performance: Boolean(mask & 1),
                geoPoints: Boolean(mask & 2),
                technology: Boolean(mask & 4),
              };
              const selectedOptIn =
                operation === "performance"
                  ? privateOptIns.performance
                  : operation === "geo-points"
                    ? privateOptIns.geoPoints
                    : privateOptIns.technology;
              const expected =
                preparationAudience === "private-dashboard" &&
                (readerAudience === undefined ||
                  readerAudience === preparationAudience) &&
                (consumers.includes(operation)
                  ? consumerAudience === "private-dashboard"
                  : optInRoles.includes(operation) &&
                    readerAudience === "private-dashboard" &&
                    selectedOptIn);
              const result = checkPageMembershipAudiencePolicy({
                exposure: "event-page-visits",
                operation,
                preparationAudience,
                readerAudience,
                consumerAudience,
                privateOptIns,
              });
              expect(result.allowed).toBe(expected);
              if (!result.allowed)
                expect(result.effect).toBe("keep-existing-fallback");
            }
          }
        }
      }
    },
  );

  it.each(roles)(
    "preserves entity role constraints without adding audience gates for %s",
    (operation) => {
      for (const preparationAudience of audiences) {
        for (const readerAudience of audiences) {
          const result = checkPageMembershipAudiencePolicy({
            exposure: "entity-membership",
            operation,
            preparationAudience,
            readerAudience,
            consumerAudience: "public-share",
          });
          expect(result.allowed).toBe(
            (consumers.includes(operation) && operation !== "filter-values") ||
              optInRoles.includes(operation),
          );
        }
      }
    },
  );

  it("explains each declined exposure separately from query permissions", () => {
    const input = {
      exposure: "event-page-visits" as const,
      operation: "performance",
      preparationAudience: "private-dashboard",
      readerAudience: "private-dashboard",
    };
    const cases = [
      [
        { ...input, preparationAudience: undefined },
        "private-preparation-required",
      ],
      [{ ...input, readerAudience: "api-v1" }, "reader-audience-mismatch"],
      [{ ...input, operation: "referrers" }, "private-consumer-required"],
      [{ ...input, readerAudience: undefined }, "private-reader-required"],
      [input, "private-opt-in-required"],
      [{ ...input, operation: "overview" }, "unsupported-page-role"],
    ] as const;
    for (const [value, reason] of cases)
      expect(checkPageMembershipAudiencePolicy(value)).toEqual({
        allowed: false,
        effect: "keep-existing-fallback",
        reason,
      });
  });

  it.each(optInRoles)(
    "requires the matching explicit opt-in for %s",
    (operation) => {
      expect(
        checkPageMembershipAudiencePolicy({
          exposure: "event-page-visits",
          operation,
          preparationAudience: "private-dashboard",
          readerAudience: "private-dashboard",
        }),
      ).toEqual({
        allowed: false,
        effect: "keep-existing-fallback",
        reason: "private-opt-in-required",
      });
    },
  );
});
