// Built-in filter examples; validated by the shared preset contract tests.
export const pageContentPresets = [
  {
    id: "distinctPagesSession",
    category: "pageContent",
    scope: "session",
    filterDsl: "countDistinct(PAGE -> path) gte 4",
  },
  {
    id: "docsDeepSession",
    category: "pageContent",
    scope: "session",
    filterDsl: 'count(PAGE { $.path startsWith "/docs" }) gte 3',
  },
  {
    id: "avgPageDuration",
    category: "pageContent",
    scope: "session",
    filterDsl: "avg(PAGE -> durationMs) gte 60000",
  },
  {
    id: "maxPageDuration",
    category: "pageContent",
    scope: "session",
    filterDsl: "max(PAGE -> durationMs) gte 120000",
  },
  {
    id: "totalPageDuration",
    category: "pageContent",
    scope: "session",
    filterDsl: "sum(PAGE -> durationMs) gte 180000",
  },
  {
    id: "firstPricingPage",
    category: "pageContent",
    scope: "session",
    filterDsl: 'first(PAGE).path eq "/pricing"',
  },
  {
    id: "lastPricingPage",
    category: "pageContent",
    scope: "session",
    filterDsl: 'last(PAGE).path eq "/pricing"',
  },
  {
    id: "secondDocsPage",
    category: "pageContent",
    scope: "session",
    filterDsl: 'nth(PAGE, 2).path startsWith "/docs"',
  },
  {
    id: "pageQueryActivity",
    category: "pageContent",
    scope: "event",
    filterDsl: "page.query notEmpty",
  },
  {
    id: "multiHostname",
    category: "pageContent",
    scope: "visitor",
    filterDsl: "countDistinct(PAGE -> hostname) gte 2",
  },
] as const;
