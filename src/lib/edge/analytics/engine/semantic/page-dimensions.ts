import type { SemanticAttributeId } from "./attributes";

export const SEMANTIC_PAGE_DIMENSIONS = {
  trafficChannel: {
    dependencies: [
      "page.report.referrerHost",
      "page.report.utmSource",
      "page.report.utmMedium",
      "page.report.utmCampaign",
    ],
    nullableFromDependencies: false,
  },
  browserEngine: {
    dependencies: ["page.report.browser", "page.report.os"],
    nullableFromDependencies: false,
  },
  osVersion: {
    dependencies: ["page.report.os", "page.report.osVersion"],
    nullableFromDependencies: false,
  },
  overviewOsVersion: {
    dependencies: ["page.report.os", "page.report.osVersion"],
    nullableFromDependencies: false,
  },
  browserMajorVersion: {
    dependencies: ["page.report.browserVersion"],
    nullableFromDependencies: true,
  },
  screenSize: {
    dependencies: ["page.report.screenWidth", "page.report.screenHeight"],
    nullableFromDependencies: false,
  },
  referrerDomain: {
    dependencies: ["page.report.referrerHost"],
    nullableFromDependencies: false,
  },
  geoRegion: {
    dependencies: [
      "page.report.country",
      "page.report.regionCode",
      "page.report.region",
    ],
    nullableFromDependencies: true,
  },
  geoCity: {
    dependencies: [
      "page.report.country",
      "page.report.regionCode",
      "page.report.region",
      "page.report.city",
    ],
    nullableFromDependencies: true,
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly dependencies: readonly SemanticAttributeId[];
      readonly nullableFromDependencies: boolean;
    }
  >
>;

export type SemanticPageDimensionId = keyof typeof SEMANTIC_PAGE_DIMENSIONS;

export function semanticPageDimension(
  id: string,
): (typeof SEMANTIC_PAGE_DIMENSIONS)[SemanticPageDimensionId] | undefined {
  if (!Object.hasOwn(SEMANTIC_PAGE_DIMENSIONS, id)) return undefined;
  return SEMANTIC_PAGE_DIMENSIONS[id as SemanticPageDimensionId] as
    (typeof SEMANTIC_PAGE_DIMENSIONS)[SemanticPageDimensionId] | undefined;
}
