import { describe, expect, it } from "vitest";

import {
  dimensionPageSelection,
  overviewPageTableDescriptor,
  PAGE_DIMENSION_SELECTIONS,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  isCanonicalPrivateChannelListWholeFilterRequest,
  isCanonicalPrivateChannelOverviewWholeFilterRequest,
  isCanonicalPrivatePageDimensionWholeFilterRequest,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-request";

describe("whole-filter report request proof", () => {
  it("requires the exact breakdown selection and empty-key policy", () => {
    const canonical = {
      mode: "breakdown",
      audience: "private-dashboard",
      dimension: "page.path",
      selection: dimensionPageSelection("page.path"),
      excludeEmpty: false,
    };
    expect(isCanonicalPrivatePageDimensionWholeFilterRequest(canonical)).toBe(
      true,
    );
    for (const changed of [
      { dimension: null },
      { dimension: "no.such.dimension" },
      { dimension: "traffic.channel" },
      { selection: PAGE_DIMENSION_SELECTIONS.pagePath },
      { excludeEmpty: true },
      { mode: "list" },
      { audience: "api-v1" },
      { audience: "public-share" },
    ])
      expect(
        isCanonicalPrivatePageDimensionWholeFilterRequest({
          ...canonical,
          ...changed,
        }),
      ).toBe(false);
  });

  for (const tab of [
    "page.path",
    "client.browser",
    "utm.source",
    "geo.country",
  ]) {
    it(`preserves the ${tab} overview descriptor`, () => {
      const descriptor = overviewPageTableDescriptor(tab);
      expect(descriptor).not.toBeNull();
      if (!descriptor) throw new Error("missing_overview_descriptor");
      const canonical = {
        mode: "overview-tab",
        audience: "private-dashboard",
        tab,
        selection: descriptor.selection,
        excludeEmpty: descriptor.excludeEmpty,
      };
      expect(isCanonicalPrivatePageDimensionWholeFilterRequest(canonical)).toBe(
        true,
      );
      expect(
        isCanonicalPrivatePageDimensionWholeFilterRequest({
          ...canonical,
          overviewFamily: descriptor.family,
        }),
      ).toBe(true);
      for (const changed of [
        { overviewFamily: "channel" },
        { excludeEmpty: !descriptor.excludeEmpty },
        { selection: null },
        { tab: null },
        { tab: "no.such.tab" },
        { audience: "api-v1" },
        { audience: "public-share" },
      ])
        expect(
          isCanonicalPrivatePageDimensionWholeFilterRequest({
            ...canonical,
            ...changed,
          }),
        ).toBe(false);
    });
  }

  it("keeps the channel overview on its own exact exposure path", () => {
    const canonical = {
      mode: "overview-tab",
      audience: "private-dashboard",
      tab: "source.channel",
      family: "channel",
      selection: PAGE_DIMENSION_SELECTIONS.trafficChannel,
      excludeEmpty: true,
    };
    expect(isCanonicalPrivateChannelOverviewWholeFilterRequest(canonical)).toBe(
      true,
    );
    expect(isCanonicalPrivatePageDimensionWholeFilterRequest(canonical)).toBe(
      false,
    );
    for (const changed of [
      { mode: "list" },
      { tab: "page.path" },
      { family: "page" },
      { selection: null },
      { excludeEmpty: false },
      { audience: "api-v1" },
      { audience: "public-share" },
    ])
      expect(
        isCanonicalPrivateChannelOverviewWholeFilterRequest({
          ...canonical,
          ...changed,
        }),
      ).toBe(false);
    expect(
      isCanonicalPrivateChannelListWholeFilterRequest({
        mode: "list",
        audience: "private-dashboard",
      }),
    ).toBe(true);
    expect(
      isCanonicalPrivateChannelListWholeFilterRequest({
        mode: "overview-tab",
        audience: "private-dashboard",
      }),
    ).toBe(false);
  });
});
