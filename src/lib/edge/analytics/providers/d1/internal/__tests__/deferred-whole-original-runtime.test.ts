// @vitest-environment node
// Actual Count numeric refusal at the original deferred checkpoint; no selector is forced to decline.
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as afe from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as stages from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import * as diagnosticsModule from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const operations = [
  "event-summary",
  "event-types",
  "event-fields",
  "event-field-values",
  "event-records",
] as const;
type Operation = (typeof operations)[number];
type Scope = "session" | "visitor" | "event";
type Mutation =
  "sequence" | "none" | "payload" | "filter-range" | "full-history" | "scope";
type Sample = {
  key: string;
  operation: Operation;
  scope: Scope;
  mutation: Mutation;
  coreError?: boolean;
  nullAfterCore?: boolean;
  audience?: "private-dashboard" | "api-v1" | "public-share";
};
const samples: Sample[] = [];
for (const operation of operations) {
  for (const scope of ["session", "visitor", "event"] as const)
    samples.push({
      key: `${operation}/${scope}/late-sequence`,
      operation,
      scope,
      mutation: "sequence",
    });
  samples.push({
    key: `${operation}/session/finite-numeric-control`,
    operation,
    scope: "session",
    mutation: "none",
  });
}
samples.push(
  {
    key: "event-field-values/visitor/late-payload-and-filter-range",
    operation: "event-field-values",
    scope: "visitor",
    mutation: "payload",
  },
  {
    key: "event-summary/session/late-filter-range",
    operation: "event-summary",
    scope: "session",
    mutation: "filter-range",
  },
  {
    key: "event-records/visitor/late-full-history",
    operation: "event-records",
    scope: "visitor",
    mutation: "full-history",
  },
  {
    key: "event-summary/session/late-scope",
    operation: "event-summary",
    scope: "session",
    mutation: "scope",
  },
  {
    key: "event-fields/session/original-Core-error",
    operation: "event-fields",
    scope: "session",
    mutation: "sequence",
    coreError: true,
  },
  {
    key: "event-types/visitor/null-after-successful-Core",
    operation: "event-types",
    scope: "visitor",
    mutation: "sequence",
    nullAfterCore: true,
  },
);
const countDsl = "count(page { page.durationMs gt 5 }) gte 0";
const sequenceDsl =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const payloadDsl = 'first(event.payload("/amount")) gt 0';
const expectedValues: unknown[] = [
  {
    value: {
      summary: {
        events: 6,
        eventTypes: 2,
        sessions: 3,
        visitors: 3,
        avgEventsPerSession: 2,
      },
      cards: {
        event: {
          name: [
            {
              label: "other",
              views: 3,
              sessions: 3,
              visitors: 3,
            },
            {
              label: "qualifier",
              views: 3,
              sessions: 2,
              visitors: 2,
            },
          ],
        },
        page: {
          path: [
            {
              label: "/qualifier",
              views: 3,
              sessions: 2,
              visitors: 2,
            },
            {
              label: "/",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/blog/c",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/docs/guide",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
          ],
          title: [],
          hostname: [
            {
              label: "c01.example.invalid",
              views: 6,
              sessions: 3,
              visitors: 3,
            },
          ],
        },
      },
    },
  },
  {
    value: {
      summary: {
        events: 11,
        eventTypes: 2,
        sessions: 7,
        visitors: 4,
        avgEventsPerSession: 1.5714285714285714,
      },
      cards: {
        event: {
          name: [
            {
              label: "qualifier",
              views: 6,
              sessions: 5,
              visitors: 3,
            },
            {
              label: "other",
              views: 5,
              sessions: 5,
              visitors: 4,
            },
          ],
        },
        page: {
          path: [
            {
              label: "/qualifier",
              views: 6,
              sessions: 5,
              visitors: 3,
            },
            {
              label: "/",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/blog/c",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/docs/guide",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/excluded",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/pricing",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
          ],
          title: [],
          hostname: [
            {
              label: "c01.example.invalid",
              views: 11,
              sessions: 7,
              visitors: 4,
            },
          ],
        },
      },
    },
  },
  null,
  {
    value: {
      items: [
        {
          label: "other",
          views: 3,
          sessions: 3,
          visitors: 3,
        },
        {
          label: "qualifier",
          views: 3,
          sessions: 2,
          visitors: 2,
        },
      ],
      pagination: {
        limit: 2,
        returned: 2,
        hasMore: false,
        nextCursor: null,
      },
    },
  },
  {
    value: {
      items: [
        {
          label: "qualifier",
          views: 6,
          sessions: 5,
          visitors: 3,
        },
        {
          label: "other",
          views: 5,
          sessions: 5,
          visitors: 4,
        },
      ],
      pagination: {
        limit: 2,
        returned: 2,
        hasMore: false,
        nextCursor: null,
      },
    },
  },
  {
    value: {
      data: {
        items: [
          {
            path: "/active",
            valueType: "boolean",
            events: 3,
            occurrences: 3,
            firstSeenAt: 1700226800001,
            lastSeenAt: 1700453600001,
            exampleValue: true,
          },
          {
            path: "/amount",
            valueType: "number",
            events: 3,
            occurrences: 3,
            firstSeenAt: 1700226800001,
            lastSeenAt: 1700453600001,
            exampleValue: 42,
          },
        ],
        pagination: {
          limit: 2,
          returned: 2,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiNzFjZjdiMThlNWRhNzlmMjEwOTI1MDFiYjIyOTcyNzY4MTY2Y2MzODQ2MGRjZTYyNTZmMGY1N2Y0MzM4NWJkNSIsImtleSI6eyJldmVudHMiOjMsIm9jY3VycmVuY2VzIjozLCJwYXRoIjoiL2Ftb3VudCIsInZhbHVlVHlwZSI6Mn19.WUCNTGU0sAKRDiYV7fv5JDA0q03rL2YZBs768WD4ivg",
        },
      },
    },
  },
  {
    value: {
      data: {
        items: [
          {
            path: "/active",
            valueType: "boolean",
            events: 6,
            occurrences: 6,
            firstSeenAt: 1700050400001,
            lastSeenAt: 1700453600001,
            exampleValue: true,
          },
          {
            path: "/amount",
            valueType: "number",
            events: 6,
            occurrences: 6,
            firstSeenAt: 1700050400001,
            lastSeenAt: 1700453600001,
            exampleValue: 42,
          },
        ],
        pagination: {
          limit: 2,
          returned: 2,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiNzBmMmViNTY5YTQzMzU4NTZhNDNkNzJkZjQxOWNhZjllOTRhNDZiZDUzMTcwMWM5ZGExMTM4MDhlMjc4NGEzNyIsImtleSI6eyJldmVudHMiOjYsIm9jY3VycmVuY2VzIjo2LCJwYXRoIjoiL2Ftb3VudCIsInZhbHVlVHlwZSI6Mn19.PkvjXg91vFuzeJiB5bpNAVGUzHZOQSjN9CP5OH7z898",
        },
      },
    },
  },
  {
    value: {
      data: {
        items: [
          {
            path: "/active",
            valueType: "boolean",
            events: 6,
            occurrences: 6,
            firstSeenAt: 1700050400001,
            lastSeenAt: 1700453600001,
            exampleValue: true,
          },
          {
            path: "/amount",
            valueType: "number",
            events: 6,
            occurrences: 6,
            firstSeenAt: 1700050400001,
            lastSeenAt: 1700453600001,
            exampleValue: 42,
          },
        ],
        pagination: {
          limit: 2,
          returned: 2,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiMTM0N2I2YmMxZmUyMTM1NTBkNTQwMmRjODdmOTRmMWRmZjI3NzQxMDM4OGI5OWJmMmI0ZmJjM2ExODc0MmJjMyIsImtleSI6eyJldmVudHMiOjYsIm9jY3VycmVuY2VzIjo2LCJwYXRoIjoiL2Ftb3VudCIsInZhbHVlVHlwZSI6Mn19.T5OMY1FyjOCa9Cyix-tPmgwt5JLo36ekpjFbiBoG6bE",
        },
      },
    },
  },
  {
    value: {
      fieldPath: "/plan",
      fieldValueType: "string",
      data: {
        items: [
          {
            value: "pro",
            events: 3,
            occurrences: 3,
            firstSeenAt: 1700226800001,
            lastSeenAt: 1700453600001,
          },
        ],
        pagination: {
          limit: 2,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    },
  },
  {
    value: {
      fieldPath: "/plan",
      fieldValueType: "string",
      data: {
        items: [
          {
            value: "pro",
            events: 6,
            occurrences: 6,
            firstSeenAt: 1700050400001,
            lastSeenAt: 1700453600001,
          },
        ],
        pagination: {
          limit: 2,
          returned: 1,
          hasMore: false,
          nextCursor: null,
        },
      },
    },
  },
  {
    value: {
      items: [
        {
          eventId: "e20o",
          eventName: "other",
          occurredAt: 1700504000002,
          receivedAt: 1700504000002,
          sequence: 1,
          visitId: "v20",
          sessionId: "ses6",
          visitorId: "vis3",
          pathname: "/",
          title: "",
          hostname: "c01.example.invalid",
          referrerHost: "github.com",
          country: "GB",
          region: "",
          city: "",
          browser: "Chrome",
          browserVersion: "",
          os: "Windows",
          osVersion: "",
          deviceType: "desktop",
          nodeCount: 0,
          valueCount: 0,
        },
        {
          eventId: "e18q",
          eventName: "qualifier",
          occurredAt: 1700453600001,
          receivedAt: 1700453600001,
          sequence: 0,
          visitId: "v18",
          sessionId: "ses6",
          visitorId: "vis3",
          pathname: "/qualifier",
          title: "",
          hostname: "c01.example.invalid",
          referrerHost: "t.co",
          country: "BR",
          region: "",
          city: "",
          browser: "Firefox",
          browserVersion: "",
          os: "Windows",
          osVersion: "",
          deviceType: "desktop",
          nodeCount: 4,
          valueCount: 3,
        },
      ],
      pagination: {
        limit: 2,
        hasMore: true,
        nextCursor:
          "eyJ2IjoxLCJiaW5kaW5nIjoiN2EwYmQ5ZTE0N2MxOTNiMzEwNTgxM2U4OTQ1MTVkMzM0M2Q0ZjQwOWYyZmIzYTQzYTk1MWFlMzZhOGM0M2RlZiIsImtleSI6eyJldmVudElkIjoiZTE4cSIsImV2ZW50UGsiOjgsIm9jY3VycmVkQXQiOjE3MDA0NTM2MDAwMDF9fQ.Gaz8GYjWFUQsMNKzxJIdbvGHyXRjdEF1MzVyIdfKPrE",
        returned: 2,
      },
    },
  },
  {
    value: {
      items: [
        {
          eventId: "e20o",
          eventName: "other",
          occurredAt: 1700504000002,
          receivedAt: 1700504000002,
          sequence: 1,
          visitId: "v20",
          sessionId: "ses6",
          visitorId: "vis3",
          pathname: "/",
          title: "",
          hostname: "c01.example.invalid",
          referrerHost: "github.com",
          country: "GB",
          region: "",
          city: "",
          browser: "Chrome",
          browserVersion: "",
          os: "Windows",
          osVersion: "",
          deviceType: "desktop",
          nodeCount: 0,
          valueCount: 0,
        },
        {
          eventId: "e18q",
          eventName: "qualifier",
          occurredAt: 1700453600001,
          receivedAt: 1700453600001,
          sequence: 0,
          visitId: "v18",
          sessionId: "ses6",
          visitorId: "vis3",
          pathname: "/qualifier",
          title: "",
          hostname: "c01.example.invalid",
          referrerHost: "t.co",
          country: "BR",
          region: "",
          city: "",
          browser: "Firefox",
          browserVersion: "",
          os: "Windows",
          osVersion: "",
          deviceType: "desktop",
          nodeCount: 4,
          valueCount: 3,
        },
      ],
      pagination: {
        limit: 2,
        hasMore: true,
        nextCursor:
          "eyJ2IjoxLCJiaW5kaW5nIjoiOWRjMzI5MWYzZjY3NjZiMTEwMDUzNWNhOGViNTIzYzdlYmU5ZWNkOWM1YzUxMDY1MzcyY2YxY2FmMDVkYjI5ZCIsImtleSI6eyJldmVudElkIjoiZTE4cSIsImV2ZW50UGsiOjgsIm9jY3VycmVkQXQiOjE3MDA0NTM2MDAwMDF9fQ.tnlS6RoIZ2flQj8iZZ0-ucUtJrygBZvDmgv0k1FqfDg",
        returned: 2,
      },
    },
  },
  {
    value: {
      items: [
        {
          eventId: "e20o",
          eventName: "other",
          occurredAt: 1700504000002,
          receivedAt: 1700504000002,
          sequence: 1,
          visitId: "v20",
          sessionId: "ses6",
          visitorId: "vis3",
          pathname: "/",
          title: "",
          hostname: "c01.example.invalid",
          referrerHost: "github.com",
          country: "GB",
          region: "",
          city: "",
          browser: "Chrome",
          browserVersion: "",
          os: "Windows",
          osVersion: "",
          deviceType: "desktop",
          nodeCount: 0,
          valueCount: 0,
        },
        {
          eventId: "e18q",
          eventName: "qualifier",
          occurredAt: 1700453600001,
          receivedAt: 1700453600001,
          sequence: 0,
          visitId: "v18",
          sessionId: "ses6",
          visitorId: "vis3",
          pathname: "/qualifier",
          title: "",
          hostname: "c01.example.invalid",
          referrerHost: "t.co",
          country: "BR",
          region: "",
          city: "",
          browser: "Firefox",
          browserVersion: "",
          os: "Windows",
          osVersion: "",
          deviceType: "desktop",
          nodeCount: 4,
          valueCount: 3,
        },
      ],
      pagination: {
        limit: 2,
        hasMore: true,
        nextCursor:
          "eyJ2IjoxLCJiaW5kaW5nIjoiZDAwNTExZGVlYTJkODExNjBmNDM0ODljNTA0NzhlMWVjMWM1ZjMyNjVhMGNmNGZiYjg3MTc4MGNkOTgwNTgyOCIsImtleSI6eyJldmVudElkIjoiZTE4cSIsImV2ZW50UGsiOjgsIm9jY3VycmVkQXQiOjE3MDA0NTM2MDAwMDF9fQ.tDWlu9j4RPl0oyd6INdzfg7Vu6cy-wh1ivaaVSRnmRk",
        returned: 2,
      },
    },
  },
  {
    value: {
      summary: {
        events: 3,
        eventTypes: 2,
        sessions: 2,
        visitors: 1,
        avgEventsPerSession: 1.5,
      },
      cards: {
        event: {
          name: [
            {
              label: "other",
              views: 2,
              sessions: 2,
              visitors: 1,
            },
            {
              label: "qualifier",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
          ],
        },
        page: {
          path: [
            {
              label: "/docs/guide",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/pricing",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
            {
              label: "/qualifier",
              views: 1,
              sessions: 1,
              visitors: 1,
            },
          ],
          title: [],
          hostname: [
            {
              label: "c01.example.invalid",
              views: 3,
              sessions: 2,
              visitors: 1,
            },
          ],
        },
      },
    },
  },
  {
    value: {
      items: [
        {
          eventId: "e20o",
          eventName: "other",
          occurredAt: 1700504000002,
          receivedAt: 1700504000002,
          sequence: 1,
          visitId: "v20",
          sessionId: "ses6",
          visitorId: "vis3",
          pathname: "/",
          title: "",
          hostname: "c01.example.invalid",
          referrerHost: "github.com",
          country: "GB",
          region: "",
          city: "",
          browser: "Chrome",
          browserVersion: "",
          os: "Windows",
          osVersion: "",
          deviceType: "desktop",
          nodeCount: 0,
          valueCount: 0,
        },
        {
          eventId: "e18q",
          eventName: "qualifier",
          occurredAt: 1700453600001,
          receivedAt: 1700453600001,
          sequence: 0,
          visitId: "v18",
          sessionId: "ses6",
          visitorId: "vis3",
          pathname: "/qualifier",
          title: "",
          hostname: "c01.example.invalid",
          referrerHost: "t.co",
          country: "BR",
          region: "",
          city: "",
          browser: "Firefox",
          browserVersion: "",
          os: "Windows",
          osVersion: "",
          deviceType: "desktop",
          nodeCount: 4,
          valueCount: 3,
        },
      ],
      pagination: {
        limit: 2,
        hasMore: true,
        nextCursor:
          "eyJ2IjoxLCJiaW5kaW5nIjoiM2Q3M2VjMjA4NDZkOWYyMzEyOTFlMTgxOWQyYThjNWQyZTMwOWY2ZDcwMzBlMjE0NjU3NTU4ZGMyOTFmYjM2YyIsImtleSI6eyJldmVudElkIjoiZTE4cSIsImV2ZW50UGsiOjgsIm9jY3VycmVkQXQiOjE3MDA0NTM2MDAwMDF9fQ.HbeIYOkeY6OW8-nAVPqmXJAQXXHOpqNtIdxMWC0YpJ8",
        returned: 2,
      },
    },
  },
];
const expectedDiagnostics: unknown[] = [
  {
    rowsRead: 0,
    rowsReadAvailable: false,
    requestedScope: "session",
    resolvedScope: "session",
    requiredSources: ["visit"],
    requiresRawSource: true,
    advancedCountSqlFallbackReason: {
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    },
  },
  {
    rowsRead: 0,
    rowsReadAvailable: false,
    requestedScope: "visitor",
    resolvedScope: "visitor",
    requiredSources: ["visit"],
    requiresRawSource: true,
    advancedCountSqlFallbackReason: {
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    },
  },
  {
    rowsRead: 0,
    rowsReadAvailable: false,
    requestedScope: "event",
    resolvedScope: "event",
    requiredSources: ["visit"],
    requiresRawSource: true,
    advancedCountSqlFallbackReason: {
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    },
  },
  {
    rowsRead: 0,
    rowsReadAvailable: false,
    requestedScope: "visitor",
    resolvedScope: "visitor",
    requiredSources: ["visit"],
    requiresRawSource: true,
  },
];
const expectedReactions: readonly string[][] = [
  [
    "sql-enter:0",
    "sql-complete:0",
    "entry-pulse-1",
    "entry-pulse-2",
    "actual-deferred-after-original-coverage",
    "sql-enter:1",
    "sql-complete:1",
    "sql-enter:2",
    "sql-complete:2",
    "Core-enter",
    "sql-enter:3",
    "sql-complete:3",
    "provider-resolved",
  ],
  [
    "sql-enter:0",
    "sql-complete:0",
    "entry-pulse-1",
    "entry-pulse-2",
    "actual-deferred-after-original-coverage",
    "sql-enter:1",
    "sql-complete:1",
    "sql-enter:2",
    "sql-complete:2",
    "Core-enter",
    "provider-rejected",
  ],
  [
    "sql-enter:0",
    "sql-complete:0",
    "entry-pulse-1",
    "entry-pulse-2",
    "actual-deferred-after-original-coverage",
    "sql-enter:1",
    "sql-complete:1",
    "sql-enter:2",
    "sql-complete:2",
    "sql-enter:3",
    "sql-complete:3",
    "Core-enter",
    "sql-enter:4",
    "sql-complete:4",
    "provider-resolved",
  ],
  [
    "sql-enter:0",
    "sql-complete:0",
    "entry-pulse-1",
    "entry-pulse-2",
    "actual-deferred-after-original-coverage",
    "provider-rejected",
  ],
  [
    "sql-enter:0",
    "sql-complete:0",
    "entry-pulse-1",
    "entry-pulse-2",
    "actual-deferred-after-original-coverage",
    "sql-enter:1",
    "sql-complete:1",
    "sql-enter:2",
    "sql-complete:2",
    "sql-enter:3",
    "sql-complete:3",
    "Core-enter",
    "provider-rejected",
  ],
  [
    "sql-enter:0",
    "sql-complete:0",
    "entry-pulse-1",
    "entry-pulse-2",
    "actual-deferred-after-original-coverage",
    "sql-enter:1",
    "sql-complete:1",
    "sql-enter:2",
    "sql-complete:2",
    "Core-enter",
    "root-null-at-Core-completion",
    "sql-enter:3",
    "sql-complete:3",
    "provider-resolved",
  ],
];
const expectedOutcomes: Record<
  string,
  { value: number; diagnostics: number; reactions: number; sqlCount: number }
> = {
  "event-summary/session/late-sequence": {
    value: 0,
    diagnostics: 0,
    reactions: 0,
    sqlCount: 4,
  },
  "event-summary/visitor/late-sequence": {
    value: 1,
    diagnostics: 1,
    reactions: 0,
    sqlCount: 4,
  },
  "event-summary/event/late-sequence": {
    value: 2,
    diagnostics: 2,
    reactions: 1,
    sqlCount: 3,
  },
  "event-summary/session/finite-numeric-control": {
    value: 1,
    diagnostics: 0,
    reactions: 2,
    sqlCount: 5,
  },
  "event-types/session/late-sequence": {
    value: 3,
    diagnostics: 0,
    reactions: 0,
    sqlCount: 4,
  },
  "event-types/visitor/late-sequence": {
    value: 4,
    diagnostics: 1,
    reactions: 0,
    sqlCount: 4,
  },
  "event-types/event/late-sequence": {
    value: 2,
    diagnostics: 2,
    reactions: 1,
    sqlCount: 3,
  },
  "event-types/session/finite-numeric-control": {
    value: 4,
    diagnostics: 0,
    reactions: 2,
    sqlCount: 5,
  },
  "event-fields/session/late-sequence": {
    value: 5,
    diagnostics: 0,
    reactions: 0,
    sqlCount: 4,
  },
  "event-fields/visitor/late-sequence": {
    value: 6,
    diagnostics: 1,
    reactions: 0,
    sqlCount: 4,
  },
  "event-fields/event/late-sequence": {
    value: 2,
    diagnostics: 2,
    reactions: 1,
    sqlCount: 3,
  },
  "event-fields/session/finite-numeric-control": {
    value: 7,
    diagnostics: 0,
    reactions: 2,
    sqlCount: 5,
  },
  "event-field-values/session/late-sequence": {
    value: 8,
    diagnostics: 0,
    reactions: 0,
    sqlCount: 4,
  },
  "event-field-values/visitor/late-sequence": {
    value: 9,
    diagnostics: 1,
    reactions: 0,
    sqlCount: 4,
  },
  "event-field-values/event/late-sequence": {
    value: 2,
    diagnostics: 2,
    reactions: 1,
    sqlCount: 3,
  },
  "event-field-values/session/finite-numeric-control": {
    value: 9,
    diagnostics: 0,
    reactions: 2,
    sqlCount: 5,
  },
  "event-records/session/late-sequence": {
    value: 10,
    diagnostics: 0,
    reactions: 0,
    sqlCount: 4,
  },
  "event-records/visitor/late-sequence": {
    value: 11,
    diagnostics: 1,
    reactions: 0,
    sqlCount: 4,
  },
  "event-records/event/late-sequence": {
    value: 2,
    diagnostics: 2,
    reactions: 1,
    sqlCount: 3,
  },
  "event-records/session/finite-numeric-control": {
    value: 12,
    diagnostics: 0,
    reactions: 2,
    sqlCount: 5,
  },
  "event-field-values/visitor/late-payload-and-filter-range": {
    value: 2,
    diagnostics: 3,
    reactions: 3,
    sqlCount: 1,
  },
  "event-summary/session/late-filter-range": {
    value: 13,
    diagnostics: 0,
    reactions: 2,
    sqlCount: 5,
  },
  "event-records/visitor/late-full-history": {
    value: 14,
    diagnostics: 1,
    reactions: 2,
    sqlCount: 5,
  },
  "event-summary/session/late-scope": {
    value: 2,
    diagnostics: 0,
    reactions: 4,
    sqlCount: 4,
  },
  "event-fields/session/original-Core-error": {
    value: 2,
    diagnostics: 0,
    reactions: 1,
    sqlCount: 3,
  },
  "event-types/visitor/null-after-successful-Core": {
    value: 4,
    diagnostics: 1,
    reactions: 5,
    sqlCount: 4,
  },
};
beforeAll(() =>
  vi.stubGlobal("fetch", () => {
    throw Error("w139_network_forbidden");
  }),
);
function errorValue(value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  return {
    name: value.name,
    message: value.message,
    ...Object.fromEntries(Object.entries(value)),
  };
}
for (const sample of samples)
  it(sample.key, async () => {
    const database = createMigratedDatabase();
    for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
      database.exec(sql);
    // Real historically invalid SQLite numeric storage makes the actual Count
    // runtime refuse fusion. The evaluator and all SQL remain the real ones.
    const numericUpdate = database
      .prepare(
        "UPDATE visits SET duration_ms = ? WHERE visit_id = (SELECT visit_id FROM visits ORDER BY visit_id LIMIT 1)",
      )
      .run("invalid-duration");
    expect(numericUpdate.changes).toBe(1);
    const time = createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
    );
    const query = prepareScopedQuery(sample.operation, {
      context: siteQueryContext(
        SEED_SITE_ID,
        sample.audience ?? "private-dashboard",
      ),
      time,
      filters: parseFilterDsl(countDsl, analyticsFilterRegistry),
      scopePreference: sample.scope,
      limit: 2,
      fieldPath: "/plan",
      fieldValueType: "string",
      sort: { key: "occurredAt", direction: "desc" },
    } as never);
    const fixtureCounts = database
      .prepare(
        "SELECT (SELECT count(*) FROM visits) AS visits, (SELECT count(*) FROM custom_events) AS events",
      )
      .get();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const diagnostics = diagnosticsModule.createD1ReadDiagnostics();
    const reactions: string[] = [],
      attempts: { sql: string; params: readonly unknown[]; status: string }[] =
        [];
    const adapter = createSqliteD1Database(database, trace);
    const DB = new Proxy(adapter, {
      get(target, key) {
        if (key !== "prepare") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const wrap = (
            statement: D1PreparedStatement,
            params: readonly unknown[],
          ): D1PreparedStatement =>
            new Proxy(statement, {
              get(prepared, method) {
                if (method === "bind")
                  return (...values: unknown[]) =>
                    wrap(prepared.bind(...values), values);
                if (method === "all")
                  return (...args: unknown[]) => {
                    const row = { sql, params, status: "pending" },
                      ordinal = attempts.length;
                    attempts.push(row);
                    reactions.push(`sql-enter:${ordinal}`);
                    const pending = Reflect.apply(
                      prepared.all,
                      prepared,
                      args,
                    ) as ReturnType<D1PreparedStatement["all"]>;
                    void pending.then(
                      () => {
                        row.status = "completed";
                        reactions.push(`sql-complete:${ordinal}`);
                      },
                      () => {
                        row.status = "failed";
                        reactions.push(`sql-fail:${ordinal}`);
                      },
                    );
                    return pending;
                  };
                const value = Reflect.get(prepared, method);
                return typeof value === "function"
                  ? value.bind(prepared)
                  : value;
              },
            });
          return wrap(target.prepare(sql), []);
        };
      },
    });
    const env = { DB, MAIN_SECRET: "w139-local-numeric-fallback" } as Env;
    const sentinel = new Error("w139-original-Core-sentinel");
    const actualCore = core.evaluateFilterDocument;
    let actualDeferred: ReturnType<
      typeof afe.deferredEventQualificationFromQuery
    >;
    const evaluated = vi
      .spyOn(core, "evaluateFilterDocument")
      .mockImplementation((...args) => {
        reactions.push("Core-enter");
        if (sample.coreError) throw sentinel;
        const value = actualCore(...args);
        if (sample.nullAfterCore) {
          expect(actualDeferred).toBeDefined();
          Reflect.set(actualDeferred!.filters, "root", null);
          reactions.push("root-null-at-Core-completion");
        }
        return value;
      });
    const registered = vi.spyOn(bridge, "registerPreparedMembership"),
      resolved = vi.spyOn(bridge, "resolvePreparedMembership");
    const stage = vi.spyOn(stages, "executeAnalyticsLogicalStage"),
      oldExecutor = vi.spyOn(whole, "evaluateWholeFilterMembership");
    const minted = vi.spyOn(
        preparation,
        "createPageVisitQualificationPreparation",
      ),
      bound = vi.spyOn(preparation, "bindPageVisitQualificationPreparation");
    const writesBefore = database
      .prepare("SELECT total_changes() AS writes")
      .get();
    let value: unknown, failure: unknown;
    try {
      const registry = createD1SiteProviderRegistry({
        env,
        siteId: SEED_SITE_ID,
        diagnostics,
      });
      registry.useMiddleware(async (_op, input, next) => {
        actualDeferred = afe.deferredEventQualificationFromQuery(
          input,
          sample.operation,
        );
        expect(actualDeferred).toBeDefined();
        reactions.push("actual-deferred-after-original-coverage");
        if (sample.mutation === "sequence" || sample.mutation === "payload")
          Reflect.set(
            actualDeferred!.filters,
            "root",
            parseFilterDsl(
              sample.mutation === "sequence" ? sequenceDsl : payloadDsl,
              analyticsFilterRegistry,
            ).root,
          );
        if (sample.mutation === "filter-range" || sample.mutation === "payload")
          expect(
            Reflect.set(actualDeferred!.time, "filterRange", {
              startMs: SEED_BASE_MS,
              endExclusiveMs: SEED_BASE_MS + SEED_DAY_MS,
            }),
          ).toBe(true);
        if (sample.mutation === "full-history")
          expect(Reflect.set(actualDeferred!.time, "fullHistory", true)).toBe(
            true,
          );
        if (sample.mutation === "scope")
          expect(
            Reflect.set(actualDeferred!.metadata.plan, "scope", "visitor"),
          ).toBe(true);
        return next(input);
      });
      const pending = registry
        .resolve(sample.operation)!
        .execute(query as never);
      void pending.then(
        () => reactions.push("provider-resolved"),
        () => reactions.push("provider-rejected"),
      );
      queueMicrotask(() => reactions.push("entry-pulse-1"));
      queueMicrotask(() =>
        queueMicrotask(() => reactions.push("entry-pulse-2")),
      );
      try {
        value = await pending;
      } catch (error) {
        failure = error;
      }
      const expectedRefusal =
        sample.scope === "event"
          ? {
              name: "FilterValidationError",
              message: "Relation expressions require visitor or session scope.",
              code: "relation_requires_session_or_visitor_scope",
              path: "root.children[1].target",
            }
          : sample.mutation === "payload"
            ? {
                name: "Error",
                message:
                  "event_field_values_qualification_request_context_mismatch",
              }
            : sample.mutation === "scope"
              ? {
                  name: "Error",
                  message:
                    "invalid_semantic_scoped_source_selection:prepared_scope_mismatch",
                }
              : undefined;
      if (sample.coreError) expect(failure).toBe(sentinel);
      else if (expectedRefusal) {
        expect(errorValue(failure)).toEqual(expectedRefusal);
        expect(value).toBeUndefined();
      } else {
        expect(failure).toBeUndefined();
        expect(value).toBeDefined();
      }
      if (sample.mutation === "payload") {
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        expect(evaluated).not.toHaveBeenCalled();
        expect(trace.preparedSql).toHaveLength(1);
      } else {
        expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });
        expect(evaluated).toHaveBeenCalledTimes(1);
      }
      expect(
        database.prepare("SELECT total_changes() AS writes").get(),
      ).toEqual(writesBefore);
      expect(registered).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
      const residual = sample.mutation !== "none";
      if (expectedRefusal || sample.coreError) {
        expect(minted).not.toHaveBeenCalled();
        expect(bound).not.toHaveBeenCalled();
      } else {
        expect(minted).toHaveBeenCalledTimes(1);
        expect(bound).toHaveBeenCalledTimes(1);
      }
      if (residual) {
        expect(oldExecutor).not.toHaveBeenCalled();
        if (sample.mutation === "payload") expect(stage).not.toHaveBeenCalled();
        else
          expect(stage.mock.calls.map(([input]) => input.kind)).toEqual([
            "whole-original-completion-at-original-checkpoint",
          ]);
      } else {
        expect(oldExecutor).toHaveBeenCalledTimes(1);
        expect(stage).not.toHaveBeenCalled();
      }
      const expected = expectedOutcomes[sample.key]!;
      // The 24-visit fixture adds two boundary visits.
      expect(fixtureCounts).toEqual({ visits: 26, events: 11 });
      expect({
        value: value ?? null,
        diagnostics: Object.fromEntries(
          [
            "rowsRead",
            "rowsReadAvailable",
            "requestedScope",
            "resolvedScope",
            "requiredSources",
            "requiresRawSource",
            "advancedCountSqlFallbackReason",
          ]
            .filter((key) => key in diagnostics)
            .map((key) => [key, Reflect.get(diagnostics, key)]),
        ),
        reactions,
        sqlCount: trace.preparedSql.length,
      }).toEqual({
        value: expectedValues[expected.value],
        diagnostics: expectedDiagnostics[expected.diagnostics],
        reactions: expectedReactions[expected.reactions],
        sqlCount: expected.sqlCount,
      });
    } finally {
      minted.mockRestore();
      bound.mockRestore();
      stage.mockRestore();
      oldExecutor.mockRestore();
      registered.mockRestore();
      resolved.mockRestore();
      evaluated.mockRestore();
      database.close();
    }
  });
afterAll(() => vi.unstubAllGlobals());
