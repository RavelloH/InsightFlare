import { describe, expect, it } from "vitest";

import {
  COMPARISON_PAGE_READER_TABS,
  comparisonPageReaderContract,
} from "@/lib/edge/analytics/engine/comparison-page-reader-contract";
import { comparisonPageTab } from "@/lib/edge/analytics/engine/comparison-page-tabs";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";

const expected = [
  ["page.path", "pagePathTrimmed", "existing-qualified"],
  ["page.query", "pageQueryTrimmed", "existing-qualified"],
  ["page.title", "pageTitleTrimmed", "existing-qualified"],
  ["page.hostname", "pageHostnameTrimmed", "existing-qualified"],
  ["source.domain", "referrerDomain", "membership-recipe"],
  ["source.link", "referrerUrl", "membership-recipe"],
  ["source.channel", "trafficChannel", "membership-recipe"],
  ["client.browser", "browser", "membership-recipe"],
  ["client.osVersion", "osVersion", "membership-recipe"],
  ["client.deviceType", "deviceType", "membership-recipe"],
  ["client.language", "language", "membership-recipe"],
  ["client.screenSize", "screenSize", "membership-recipe"],
  ["utm.source", "utmSource", "membership-recipe"],
  ["utm.medium", "utmMedium", "membership-recipe"],
  ["utm.campaign", "utmCampaign", "membership-recipe"],
  ["utm.term", "utmTerm", "membership-recipe"],
  ["utm.content", "utmContent", "membership-recipe"],
  ["geo.country", "countryTrimmed", "membership-recipe"],
  ["geo.region", "region", "membership-recipe"],
  ["geo.city", "city", "membership-recipe"],
  ["geo.continent", "continentTrimmed", "membership-recipe"],
  ["geo.timezone", "timezoneTrimmed", "existing-qualified"],
  ["geo.organization", "organizationTrimmed", "existing-qualified"],
] as const;
describe("closed comparison page reader catalog", () => {
  it("declares exactly the existing 23 readers, six qualified and seventeen recipe shapes", () => {
    expect(COMPARISON_PAGE_READER_TABS).toEqual(expected.map(([tab]) => tab));
    expect(Object.isFrozen(COMPARISON_PAGE_READER_TABS)).toBe(true);
    expect(
      expected.filter(([, , route]) => route === "existing-qualified"),
    ).toHaveLength(6);
    expect(
      expected.filter(([, , route]) => route === "membership-recipe"),
    ).toHaveLength(17);
  });
  it.each(expected)(
    "preserves %s exact registered selection %s and route %s",
    (tab, selection, route) => {
      const contract = comparisonPageReaderContract(tab)!;
      expect(contract.selection).toBe(PAGE_DIMENSION_SELECTIONS[selection]);
      expect(contract).toEqual({
        selection: PAGE_DIMENSION_SELECTIONS[selection],
        route,
        readerProfile: "comparison-page-dimension-v1",
        sourceRole: "page",
        maxPlans: 1,
        maxSources: 1,
      });
      expect(Object.isFrozen(contract)).toBe(true);
      if (route === "existing-qualified")
        expect(contract.selection).toBe(comparisonPageTab(tab)!.selection);
      else expect(comparisonPageTab(tab)).toBeUndefined();
    },
  );
  it.each([
    "page.entry",
    "page.exit",
    "client.os",
    "event.name",
    "__proto__",
    "constructor",
    "toString",
    "",
    "SOURCE.DOMAIN",
  ])("rejects undeclared %s", (tab) => {
    expect(comparisonPageReaderContract(tab)).toBeUndefined();
  });
});
