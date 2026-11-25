// Built-in filter examples; validated by the shared preset contract tests.
export const sessionEngagementPresets = [
  {
    id: "pageAndEventSession",
    category: "sessionEngagement",
    scope: "session",
    filterDsl: "PAGE exists AND EVENT exists",
  },
  {
    id: "repeatedPathSession",
    category: "sessionEngagement",
    scope: "session",
    filterDsl: "count(PAGE) gt 1 AND countDistinct(PAGE -> path) eq 1",
  },
  {
    id: "eventHeavySession",
    category: "sessionEngagement",
    scope: "session",
    filterDsl: "sub(count(EVENT), count(PAGE)) gt 0",
  },
  {
    id: "longNoEventSession",
    category: "sessionEngagement",
    scope: "session",
    filterDsl: "session.durationMs gte 300000 AND session.events eq 0",
  },
  {
    id: "shortDeepSession",
    category: "sessionEngagement",
    scope: "session",
    filterDsl: "session.durationMs lt 60000 AND session.views gte 5",
  },
  {
    id: "highEventRatio",
    category: "sessionEngagement",
    scope: "session",
    filterDsl: "count(PAGE) gt 0 AND div(count(EVENT), count(PAGE)) gte 2",
  },
  {
    id: "singlePageWithEvent",
    category: "sessionEngagement",
    scope: "session",
    filterDsl: "session.views eq 1 AND session.events gte 1",
  },
] as const;
