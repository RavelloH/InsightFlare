import { describe, expect, it } from "vitest";

import {
  checkWholeFilterAudiencePolicy,
  type WholeFilterExposure,
} from "@/lib/edge/analytics/application/whole-filter-audience-policy";

const EXPOSURES: readonly WholeFilterExposure[] = [
  "page-dimension",
  "channel-list",
  "channel-overview",
];

describe("whole-filter audience policy", () => {
  for (const exposure of EXPOSURES) {
    it(`${exposure} preserves private exposure and other audience fallbacks`, () => {
      expect(
        checkWholeFilterAudiencePolicy({
          exposure,
          audience: "private-dashboard",
        }),
      ).toEqual({ allowed: true, reason: "private-whole-filter" });
      for (const audience of ["api-v1", "public-share", undefined, null, ""]) {
        expect(checkWholeFilterAudiencePolicy({ exposure, audience })).toEqual({
          allowed: false,
          effect: "keep-existing-fallback",
          reason: "private-whole-filter-required",
        });
      }
    });
  }
});
