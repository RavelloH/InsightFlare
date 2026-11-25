// Built-in filter examples; validated by the shared preset contract tests.
export const performancePresets = [
  {
    id: "slowPagesSession",
    category: "performance",
    scope: "session",
    filterDsl: "count(PAGE { $.performance.lcpMs gt 2500 }) gte 2",
  },
  {
    id: "avgLcpSession",
    category: "performance",
    scope: "session",
    filterDsl: "avg(PAGE -> performance.lcpMs) gt 2500",
  },
  {
    id: "worstInpSession",
    category: "performance",
    scope: "session",
    filterDsl: "max(PAGE -> performance.inpMs) gt 500",
  },
  {
    id: "avgClsSession",
    category: "performance",
    scope: "session",
    filterDsl: "avg(PAGE -> performance.cls) gt 0.1",
  },
  {
    id: "severalSlowTtfb",
    category: "performance",
    scope: "session",
    filterDsl: "count(PAGE { $.performance.ttfbMs gt 800 }) gte 2",
  },
  {
    id: "goodMeasuredVitals",
    category: "performance",
    scope: "event",
    filterDsl:
      "performance.lcpMs lte 2500 AND performance.inpMs lte 200 AND performance.cls lte 0.1",
  },
  {
    id: "mobileSlowLcp",
    category: "performance",
    scope: "event",
    filterDsl: 'client.deviceType eq "mobile" AND performance.lcpMs gt 2500',
  },
] as const;
