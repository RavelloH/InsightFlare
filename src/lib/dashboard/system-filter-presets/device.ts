// Built-in filter examples; validated by the shared preset contract tests.
export const devicePresets = [
  {
    id: "mobileDesktopVisitor",
    category: "device",
    scope: "visitor",
    filterDsl:
      'PAGE { $.client.deviceType eq "mobile" } exists AND PAGE { $.client.deviceType eq "desktop" } exists',
  },
  {
    id: "multiDeviceVisitor",
    category: "device",
    scope: "visitor",
    filterDsl: "countDistinct(PAGE -> client.deviceType) gte 2",
  },
  {
    id: "multiBrowserVisitor",
    category: "device",
    scope: "visitor",
    filterDsl: "countDistinct(PAGE -> client.browser) gte 2",
  },
  {
    id: "multiOsVisitor",
    category: "device",
    scope: "visitor",
    filterDsl: "countDistinct(PAGE -> client.os) gte 2",
  },
  {
    id: "mobileLandscape",
    category: "device",
    scope: "event",
    filterDsl: 'client.deviceType eq "mobile" AND client.screenWidth gt 600',
  },
  {
    id: "multiLanguageVisitor",
    category: "device",
    scope: "visitor",
    filterDsl: "countDistinct(PAGE -> client.language) gte 2",
  },
] as const;
