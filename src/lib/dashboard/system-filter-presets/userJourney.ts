// Built-in filter examples; validated by the shared preset contract tests.
export const userJourneyPresets = [
  {
    id: "signupToPurchase14d",
    category: "userJourney",
    scope: "visitor",
    filterDsl:
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $span lte 14d } exists',
  },
  {
    id: "pricingAdjacentPurchase",
    category: "userJourney",
    scope: "session",
    filterDsl:
      'adjacent(sequence([PAGE { $.path eq "/pricing" }, EVENT { $.name eq "purchase" }])) exists',
  },
  {
    id: "signupPurchaseNoCancel",
    category: "userJourney",
    scope: "visitor",
    filterDsl:
      'without(sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]), EVENT { $.name eq "cancellation" }) { $span lte 7d } exists',
  },
  {
    id: "sameProductPurchase",
    category: "userJourney",
    scope: "visitor",
    filterDsl:
      'sequence([EVENT { $.name eq "view" }, EVENT { $.name eq "purchase" }]) { $gap(1, 2) lte 7d AND $same($.payload("/productId")) } exists',
  },
  {
    id: "purchaseNoRefundWindow",
    category: "userJourney",
    scope: "visitor",
    filterDsl:
      'EVENT { $.name eq "purchase" } exists AND count(window(EVENT { $.name eq "refund" }, first(EVENT { $.name eq "purchase" }), [0d, 7d])) eq 0',
  },
  {
    id: "homeDocsJourney",
    category: "userJourney",
    scope: "session",
    filterDsl:
      'sequence([PAGE { $.path eq "/" }, PAGE { $.path startsWith "/docs" }]) exists',
  },
  {
    id: "docsPricingJourney",
    category: "userJourney",
    scope: "session",
    filterDsl:
      'sequence([PAGE { $.path startsWith "/docs" }, PAGE { $.path eq "/pricing" }]) exists',
  },
  {
    id: "docsPricingQuick",
    category: "userJourney",
    scope: "session",
    filterDsl:
      'sequence([PAGE { $.path startsWith "/docs" }, PAGE { $.path eq "/pricing" }]) { $span lte 5m } exists',
  },
  {
    id: "signupActivationPurchase",
    category: "userJourney",
    scope: "visitor",
    filterDsl:
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "activation" }, EVENT { $.name eq "purchase" }]) { $gap(1, 2) lte 1d AND $gap(2, 3) lte 7d } exists',
  },
  {
    id: "cartPurchaseJourney",
    category: "userJourney",
    scope: "session",
    filterDsl:
      'sequence([EVENT { $.name eq "add_to_cart" }, EVENT { $.name eq "purchase" }]) exists',
  },
  {
    id: "signupLaterVisit",
    category: "userJourney",
    scope: "visitor",
    filterDsl:
      'sequence([EVENT { $.name eq "signup" }, PAGE]) { $span between [1d, 7d] } exists',
  },
  {
    id: "purchaseFollowup",
    category: "userJourney",
    scope: "visitor",
    filterDsl:
      'count(window(EVENT { $.name eq "purchase" }, first(EVENT { $.name eq "purchase" }), [1d, 30d])) gte 1',
  },
] as const;
