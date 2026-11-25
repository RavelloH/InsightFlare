// Built-in filter examples; validated by the shared preset contract tests.
export const eventConversionPresets = [
  {
    id: "purchaseCount",
    category: "eventConversion",
    scope: "visitor",
    filterDsl: 'count(EVENT { $.name eq "purchase" }) gte 2',
  },
  {
    id: "purchaseAmount",
    category: "eventConversion",
    scope: "visitor",
    filterDsl:
      'sum(EVENT { $.name eq "purchase" } -> payload("/amount")) gte 100',
  },
  {
    id: "avgPurchaseAmount",
    category: "eventConversion",
    scope: "visitor",
    filterDsl:
      'avg(EVENT { $.name eq "purchase" } -> payload("/amount")) gte 50',
  },
  {
    id: "distinctPurchasedSku",
    category: "eventConversion",
    scope: "visitor",
    filterDsl:
      'countDistinct(EVENT { $.name eq "purchase" } -> payload("/sku")) gte 3',
  },
  {
    id: "morePurchasesThanRefunds",
    category: "eventConversion",
    scope: "visitor",
    filterDsl:
      'sub(count(EVENT { $.name eq "purchase" }), count(EVENT { $.name eq "refund" })) gt 0',
  },
  {
    id: "eventNamesSession",
    category: "eventConversion",
    scope: "session",
    filterDsl: "countDistinct(EVENT -> name) gte 3",
  },
  {
    id: "eventWithPayload",
    category: "eventConversion",
    scope: "event",
    filterDsl: 'event.payload("/id") exists',
  },
  {
    id: "successfulEvent",
    category: "eventConversion",
    scope: "event",
    filterDsl: 'event.payload("/success") eq true',
  },
  {
    id: "largeTransaction",
    category: "eventConversion",
    scope: "event",
    filterDsl: 'event.name eq "purchase" AND event.payload("/amount") gte 100',
  },
  {
    id: "errorEvents",
    category: "eventConversion",
    scope: "session",
    filterDsl: 'count(EVENT { $.name eq "error" }) gte 2',
  },
  {
    id: "signupNoPurchase",
    category: "eventConversion",
    scope: "visitor",
    filterDsl:
      'EVENT { $.name eq "signup" } exists AND EVENT { $.name eq "purchase" } notExists',
  },
  {
    id: "purchaseWithoutRefund",
    category: "eventConversion",
    scope: "visitor",
    filterDsl:
      'EVENT { $.name eq "purchase" } exists AND EVENT { $.name eq "refund" } notExists',
  },
] as const;
