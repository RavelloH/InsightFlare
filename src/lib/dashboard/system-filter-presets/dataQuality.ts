// Built-in filter examples; validated by the shared preset contract tests.
export const dataQualityPresets = [
  {
    id: "emptyPageTitle",
    category: "dataQuality",
    scope: "session",
    filterDsl: "PAGE { $.title isEmpty } exists",
  },
  {
    id: "eventOnlySession",
    category: "dataQuality",
    scope: "session",
    filterDsl: "count(EVENT) gt 0 AND count(PAGE) eq 0",
  },
  {
    id: "missingPerformance",
    category: "dataQuality",
    scope: "event",
    filterDsl:
      "performance.lcpMs notExists AND performance.inpMs notExists AND performance.cls notExists",
  },
  {
    id: "missingDevice",
    category: "dataQuality",
    scope: "event",
    filterDsl: "client.deviceType notExists OR client.browser notExists",
  },
  {
    id: "missingCampaignMedium",
    category: "dataQuality",
    scope: "event",
    filterDsl:
      "utm.campaign notEmpty AND (utm.medium notExists OR utm.medium isEmpty)",
  },
  {
    id: "missingPayloadAmount",
    category: "dataQuality",
    scope: "event",
    filterDsl:
      'event.name eq "purchase" AND event.payload("/amount") notExists',
  },
  {
    id: "countryChanges",
    category: "dataQuality",
    scope: "visitor",
    filterDsl: "countDistinct(PAGE -> geo.country) gte 2",
  },
] as const;
