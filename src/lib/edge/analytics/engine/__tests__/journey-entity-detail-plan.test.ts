import { describe, expect, it } from "vitest";

import {
  buildJourneySessionDetailPlan,
  buildJourneyVisitorDetailPlan,
} from "@/lib/edge/analytics/engine/journey-entity-detail-plan";

describe("journey entity detail plan inputs", () => {
  it("rejects invalid visitor identifiers", () => {
    expect(() =>
      buildJourneyVisitorDetailPlan({ siteId: "site" } as never),
    ).toThrow("journey_entity_detail_invalid_visitor");
  });

  it("rejects invalid session targets", () => {
    expect(() =>
      buildJourneySessionDetailPlan({ siteId: "site", target: null } as never),
    ).toThrow("journey_entity_detail_invalid_target");
  });
});
