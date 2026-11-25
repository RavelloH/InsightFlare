// Built-in filter examples; validated by the shared preset contract tests.
export const acquisitionPresets = [
  {
    id: "paidSearch",
    category: "acquisition",
    scope: "preserve",
    filterDsl: 'traffic.channel eq "paid_search"',
  },
  {
    id: "emailTraffic",
    category: "acquisition",
    scope: "preserve",
    filterDsl: 'traffic.channel eq "email"',
  },
  {
    id: "campaignNoSource",
    category: "acquisition",
    scope: "event",
    filterDsl:
      "utm.campaign notEmpty AND (utm.source notExists OR utm.source isEmpty)",
  },
  {
    id: "externalWithUtmMedium",
    category: "acquisition",
    scope: "session",
    filterDsl:
      'PAGE { $.referrer.domain neq "__direct__" AND $.utm.medium notEmpty } exists',
  },
  {
    id: "multiReferrerVisitor",
    category: "acquisition",
    scope: "visitor",
    filterDsl: "countDistinct(PAGE -> referrer.domain) gte 2",
  },
  {
    id: "multiCampaignVisitor",
    category: "acquisition",
    scope: "visitor",
    filterDsl:
      "countDistinct(PAGE { $.utm.campaign notEmpty } -> utm.campaign) gte 2",
  },
] as const;
