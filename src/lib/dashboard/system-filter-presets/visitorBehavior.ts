// Built-in filter examples; validated by the shared preset contract tests.
export const visitorBehaviorPresets = [
  {
    id: "recentPageVisitor",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "time(last(PAGE)) gte @now-7d",
  },
  {
    id: "inactivePageVisitor",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "time(last(PAGE)) lt @now-30d",
  },
  {
    id: "activeFiveDays",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "countDistinct(bucket(PAGE, 1d)) gte 5",
  },
  {
    id: "activeThreeWeeks",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "count(periods(PAGE, 1w) { count($items) gte 3 }) gte 3",
  },
  {
    id: "weeklyBurst",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "periods(PAGE, 1w) { count($items) gte 10 } exists",
  },
  {
    id: "monthActivity",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "countDistinct(bucket(PAGE, 1mo)) gte 2",
  },
  {
    id: "longActivitySpan",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "sequence([PAGE, PAGE]) { $span gte 30d } exists",
  },
  {
    id: "recentEventVisitor",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "time(last(EVENT)) gte @now-7d",
  },
  {
    id: "recentFirstPage",
    category: "visitorBehavior",
    scope: "visitor",
    filterDsl: "time(first(PAGE)) gte @range.end-7d",
  },
] as const;
