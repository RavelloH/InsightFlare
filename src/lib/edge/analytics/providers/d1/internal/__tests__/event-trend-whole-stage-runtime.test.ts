// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type { FilterDocument } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as report from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const dsl =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const changes: readonly string[] = [
  "control",
  "series-time-clone",
  "series-time",
  "points-time-clone",
  "points-time",
  "third-time-clone",
  "third-time",
  "third-error",
  "named-control",
  "named-series-time-clone",
  "named-series-time",
  "named-points-time-clone",
  "named-points-time",
  "named-third-time-clone",
  "named-third-time",
  "named-third-error",
  "blank-control",
  "blank-third-time-clone",
  "blank-third-time",
  "blank-third-error",
  "spaces-control",
];
// Captured from the original complete middleware+reader, before this migration.
const originalValues = [
  {
    value: {
      interval: "day",
      series: [
        {
          key: "other",
          eventName: "other",
          label: "other",
          events: 3,
          sessions: 3,
          visitors: 3,
        },
        {
          key: "other",
          eventName: "Other",
          label: "Other",
          events: 6,
          sessions: 2,
          visitors: 2,
          isOther: true,
        },
      ],
      data: [
        {
          bucket: 0,
          timestampMs: 1699920000000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 1,
          timestampMs: 1700006400000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 2,
          timestampMs: 1700092800000,
          totalEvents: 1,
          eventsBySeries: {
            other: 1,
          },
        },
        {
          bucket: 3,
          timestampMs: 1700179200000,
          totalEvents: 3,
          eventsBySeries: {
            other: 1,
          },
        },
        {
          bucket: 4,
          timestampMs: 1700265600000,
          totalEvents: 2,
          eventsBySeries: {
            other: 2,
          },
        },
        {
          bucket: 5,
          timestampMs: 1700352000000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 6,
          timestampMs: 1700438400000,
          totalEvents: 3,
          eventsBySeries: {
            other: 1,
          },
        },
        {
          bucket: 7,
          timestampMs: 1700524800000,
          totalEvents: 0,
          eventsBySeries: {},
        },
      ],
    },
  },
  {
    value: {
      interval: "day",
      series: [
        {
          key: "qualifier",
          eventName: " qualifier ",
          label: " qualifier ",
          events: 3,
          sessions: 2,
          visitors: 2,
        },
        {
          key: "other",
          eventName: "Other",
          label: "Other",
          events: 3,
          sessions: 2,
          visitors: 2,
          isOther: true,
        },
      ],
      data: [
        {
          bucket: 0,
          timestampMs: 1699920000000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 1,
          timestampMs: 1700006400000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 2,
          timestampMs: 1700092800000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 3,
          timestampMs: 1700179200000,
          totalEvents: 2,
          eventsBySeries: {
            qualifier: 1,
            other: 1,
          },
        },
        {
          bucket: 4,
          timestampMs: 1700265600000,
          totalEvents: 2,
          eventsBySeries: {
            qualifier: 1,
            other: 1,
          },
        },
        {
          bucket: 5,
          timestampMs: 1700352000000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 6,
          timestampMs: 1700438400000,
          totalEvents: 2,
          eventsBySeries: {
            qualifier: 1,
            other: 1,
          },
        },
        {
          bucket: 7,
          timestampMs: 1700524800000,
          totalEvents: 0,
          eventsBySeries: {},
        },
      ],
    },
  },
  {
    value: {
      interval: "day",
      series: [],
      data: [
        {
          bucket: 0,
          timestampMs: 1699920000000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 1,
          timestampMs: 1700006400000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 2,
          timestampMs: 1700092800000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 3,
          timestampMs: 1700179200000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 4,
          timestampMs: 1700265600000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 5,
          timestampMs: 1700352000000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 6,
          timestampMs: 1700438400000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 7,
          timestampMs: 1700524800000,
          totalEvents: 0,
          eventsBySeries: {},
        },
      ],
    },
  },
  {
    value: {
      interval: "day",
      series: [
        {
          key: "qualifier",
          eventName: " qualifier ",
          label: " qualifier ",
          events: 6,
          sessions: 5,
          visitors: 3,
        },
        {
          key: "other",
          eventName: "Other",
          label: "Other",
          events: 11,
          sessions: 7,
          visitors: 4,
          isOther: true,
        },
      ],
      data: [
        {
          bucket: 0,
          timestampMs: 1699920000000,
          totalEvents: 1,
          eventsBySeries: {
            other: 1,
          },
        },
        {
          bucket: 1,
          timestampMs: 1700006400000,
          totalEvents: 2,
          eventsBySeries: {
            qualifier: 1,
            other: 1,
          },
        },
        {
          bucket: 2,
          timestampMs: 1700092800000,
          totalEvents: 1,
          eventsBySeries: {
            other: 1,
          },
        },
        {
          bucket: 3,
          timestampMs: 1700179200000,
          totalEvents: 5,
          eventsBySeries: {
            qualifier: 2,
            other: 3,
          },
        },
        {
          bucket: 4,
          timestampMs: 1700265600000,
          totalEvents: 4,
          eventsBySeries: {
            qualifier: 2,
            other: 2,
          },
        },
        {
          bucket: 5,
          timestampMs: 1700352000000,
          totalEvents: 1,
          eventsBySeries: {
            other: 1,
          },
        },
        {
          bucket: 6,
          timestampMs: 1700438400000,
          totalEvents: 3,
          eventsBySeries: {
            qualifier: 1,
            other: 2,
          },
        },
        {
          bucket: 7,
          timestampMs: 1700524800000,
          totalEvents: 0,
          eventsBySeries: {},
        },
      ],
    },
  },
  {
    value: {
      interval: "day",
      series: [
        {
          key: "qualifier",
          eventName: " qualifier ",
          label: " qualifier ",
          events: 6,
          sessions: 5,
          visitors: 3,
        },
        {
          key: "other",
          eventName: "Other",
          label: "Other",
          events: 6,
          sessions: 5,
          visitors: 3,
          isOther: true,
        },
      ],
      data: [
        {
          bucket: 0,
          timestampMs: 1699920000000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 1,
          timestampMs: 1700006400000,
          totalEvents: 2,
          eventsBySeries: {
            qualifier: 1,
            other: 1,
          },
        },
        {
          bucket: 2,
          timestampMs: 1700092800000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 3,
          timestampMs: 1700179200000,
          totalEvents: 4,
          eventsBySeries: {
            qualifier: 2,
            other: 2,
          },
        },
        {
          bucket: 4,
          timestampMs: 1700265600000,
          totalEvents: 4,
          eventsBySeries: {
            qualifier: 2,
            other: 2,
          },
        },
        {
          bucket: 5,
          timestampMs: 1700352000000,
          totalEvents: 0,
          eventsBySeries: {},
        },
        {
          bucket: 6,
          timestampMs: 1700438400000,
          totalEvents: 2,
          eventsBySeries: {
            qualifier: 1,
            other: 1,
          },
        },
        {
          bucket: 7,
          timestampMs: 1700524800000,
          totalEvents: 0,
          eventsBySeries: {},
        },
      ],
    },
  },
];
const originalStages = [
  {
    scope: "session",
    change: "control",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 0,
  },
  {
    scope: "session",
    change: "series-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 0,
  },
  {
    scope: "session",
    change: "series-time",
    error: {
      name: "Error",
      message:
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    },
    errorIsMarker: false,
    reactions: ["event-trend-series", "stage-completed"],
    core: 1,
    sqlCount: 3,
    valueIndex: -1,
  },
  {
    scope: "session",
    change: "points-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "stage-completed",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 0,
  },
  {
    scope: "session",
    change: "points-time",
    error: {
      name: "Error",
      message:
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    },
    errorIsMarker: false,
    reactions: ["event-trend-series", "event-trend-points", "stage-completed"],
    core: 1,
    sqlCount: 4,
    valueIndex: -1,
  },
  {
    scope: "session",
    change: "third-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 0,
  },
  {
    scope: "session",
    change: "third-time",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 0,
  },
  {
    scope: "session",
    change: "third-error",
    error: {
      name: "Error",
      message: "original-trend-stage-error",
    },
    errorIsMarker: true,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "original-error",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: -1,
  },
  {
    scope: "session",
    change: "named-control",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 1,
  },
  {
    scope: "session",
    change: "named-series-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 1,
  },
  {
    scope: "session",
    change: "named-series-time",
    error: {
      name: "Error",
      message:
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    },
    errorIsMarker: false,
    reactions: ["event-trend-series", "stage-completed"],
    core: 1,
    sqlCount: 3,
    valueIndex: -1,
  },
  {
    scope: "session",
    change: "named-points-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "stage-completed",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 1,
  },
  {
    scope: "session",
    change: "named-points-time",
    error: {
      name: "Error",
      message:
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    },
    errorIsMarker: false,
    reactions: ["event-trend-series", "event-trend-points", "stage-completed"],
    core: 1,
    sqlCount: 4,
    valueIndex: -1,
  },
  {
    scope: "session",
    change: "named-third-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 1,
  },
  {
    scope: "session",
    change: "named-third-time",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 1,
  },
  {
    scope: "session",
    change: "named-third-error",
    error: {
      name: "Error",
      message: "original-trend-stage-error",
    },
    errorIsMarker: true,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "original-error",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: -1,
  },
  {
    scope: "session",
    change: "blank-control",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 0,
  },
  {
    scope: "session",
    change: "blank-third-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 0,
  },
  {
    scope: "session",
    change: "blank-third-time",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 0,
  },
  {
    scope: "session",
    change: "blank-third-error",
    error: {
      name: "Error",
      message: "original-trend-stage-error",
    },
    errorIsMarker: true,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "original-error",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: -1,
  },
  {
    scope: "session",
    change: "spaces-control",
    error: null,
    errorIsMarker: false,
    reactions: ["event-trend-series", "stage-completed", "event-trend-points"],
    core: 1,
    sqlCount: 4,
    valueIndex: 2,
  },
  {
    scope: "visitor",
    change: "control",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 3,
  },
  {
    scope: "visitor",
    change: "series-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 3,
  },
  {
    scope: "visitor",
    change: "series-time",
    error: {
      name: "Error",
      message:
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    },
    errorIsMarker: false,
    reactions: ["event-trend-series", "stage-completed"],
    core: 1,
    sqlCount: 3,
    valueIndex: -1,
  },
  {
    scope: "visitor",
    change: "points-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "stage-completed",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 3,
  },
  {
    scope: "visitor",
    change: "points-time",
    error: {
      name: "Error",
      message:
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    },
    errorIsMarker: false,
    reactions: ["event-trend-series", "event-trend-points", "stage-completed"],
    core: 1,
    sqlCount: 4,
    valueIndex: -1,
  },
  {
    scope: "visitor",
    change: "third-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 3,
  },
  {
    scope: "visitor",
    change: "third-time",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 3,
  },
  {
    scope: "visitor",
    change: "third-error",
    error: {
      name: "Error",
      message: "original-trend-stage-error",
    },
    errorIsMarker: true,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "original-error",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: -1,
  },
  {
    scope: "visitor",
    change: "named-control",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 4,
  },
  {
    scope: "visitor",
    change: "named-series-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 4,
  },
  {
    scope: "visitor",
    change: "named-series-time",
    error: {
      name: "Error",
      message:
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    },
    errorIsMarker: false,
    reactions: ["event-trend-series", "stage-completed"],
    core: 1,
    sqlCount: 3,
    valueIndex: -1,
  },
  {
    scope: "visitor",
    change: "named-points-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "stage-completed",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 4,
  },
  {
    scope: "visitor",
    change: "named-points-time",
    error: {
      name: "Error",
      message:
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
    },
    errorIsMarker: false,
    reactions: ["event-trend-series", "event-trend-points", "stage-completed"],
    core: 1,
    sqlCount: 4,
    valueIndex: -1,
  },
  {
    scope: "visitor",
    change: "named-third-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 4,
  },
  {
    scope: "visitor",
    change: "named-third-time",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 4,
  },
  {
    scope: "visitor",
    change: "named-third-error",
    error: {
      name: "Error",
      message: "original-trend-stage-error",
    },
    errorIsMarker: true,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "original-error",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: -1,
  },
  {
    scope: "visitor",
    change: "blank-control",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "stage-completed",
      "event-trend-points",
      "event-trend-other",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 3,
  },
  {
    scope: "visitor",
    change: "blank-third-time-clone",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 3,
  },
  {
    scope: "visitor",
    change: "blank-third-time",
    error: null,
    errorIsMarker: false,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "stage-completed",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: 3,
  },
  {
    scope: "visitor",
    change: "blank-third-error",
    error: {
      name: "Error",
      message: "original-trend-stage-error",
    },
    errorIsMarker: true,
    reactions: [
      "event-trend-series",
      "event-trend-points",
      "event-trend-other",
      "original-error",
    ],
    core: 1,
    sqlCount: 5,
    valueIndex: -1,
  },
  {
    scope: "visitor",
    change: "spaces-control",
    error: null,
    errorIsMarker: false,
    reactions: ["event-trend-series", "stage-completed", "event-trend-points"],
    core: 1,
    sqlCount: 4,
    valueIndex: 2,
  },
];
for (const scope of ["session", "visitor"] as const)
  for (const change of changes)
    it(`${scope} trend original stage checkpoint ${change}`, async () => {
      const db = createMigratedDatabase();
      for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
        db.exec(sql);
      db.exec(
        "INSERT INTO custom_event_names(id,site_id,name,created_at,last_seen_at,site_pk) VALUES(3,'" +
          SEED_SITE_ID +
          "',' qualifier ',0,0,1)",
      );
      db.exec(
        "INSERT INTO custom_events(event_id,site_id,site_pk,visit_id,event_name_id,occurred_at,received_at,sequence,node_count,value_count,created_at) SELECT event_id||'--spaced',site_id,site_pk,visit_id,3,occurred_at+1,received_at+1,sequence+1,0,0,created_at FROM custom_events WHERE event_name_id=1",
      );
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] },
        env = {
          DB: createSqliteD1Database(db, trace),
          MAIN_SECRET: "w47-native-stage-oracle",
        } as unknown as Env;
      const registry = createD1SiteProviderRegistry({
        env,
        siteId: SEED_SITE_ID,
      });
      let owner: { filters: FilterDocument; time: typeof time } | undefined;
      registry.useMiddleware(async (_operation, input, next) => {
        owner = input as typeof owner;
        return next(input);
      });
      const original = report.queryAnalyticsReportOutputRowsFromD1,
        register = vi.spyOn(bridge, "registerPreparedMembership"),
        evaluate = vi.spyOn(core, "evaluateFilterDocument"),
        marker = new Error("original-trend-stage-error");
      const reactions: string[] = [];
      let changed = false;
      const read = vi
        .spyOn(report, "queryAnalyticsReportOutputRowsFromD1")
        .mockImplementation((...args) => {
          const pending = original(...args),
            stage = args[2];
          reactions.push(stage);
          const target = change.includes("third-")
            ? "event-trend-other"
            : change.includes("points-")
              ? "event-trend-points"
              : "event-trend-series";
          if (!changed && stage === target) {
            changed = true;
            if (change.endsWith("-error"))
              return pending.then(() => {
                reactions.push("original-error");
                throw marker;
              });
            void pending.then(() => {
              const filters = owner!.filters,
                metadata = scopedFilterMetadata(filters)!;
              if (change.endsWith("-null"))
                Object.assign(filters, { root: null });
              if (change.endsWith("-native"))
                Object.assign(filters, {
                  root: parseFilterDsl(
                    'page.path eq "/excluded"',
                    analyticsFilterRegistry,
                  ).root,
                });
              if (change === "series-inplace") {
                const replacement = parseFilterDsl(
                  'page.path eq "/excluded"',
                  analyticsFilterRegistry,
                ).root!;
                for (const key of Object.keys(filters.root!))
                  Reflect.deleteProperty(filters.root!, key);
                Object.assign(filters.root!, replacement);
              }
              if (change === "series-owner-replace")
                Object.assign(owner!, {
                  filters: parseFilterDsl(
                    'page.path eq "/excluded"',
                    analyticsFilterRegistry,
                  ),
                  time: createQueryTime(
                    SEED_BASE_MS + 1,
                    SEED_BASE_MS + SEED_DAY_MS,
                    "UTC",
                    time.capturedAtMs,
                  ),
                });
              if (change.endsWith("-time-clone"))
                Object.assign(metadata, {
                  time: JSON.parse(JSON.stringify(metadata.time)),
                });
              if (change.endsWith("-time"))
                Object.assign(metadata, {
                  time: createQueryTime(
                    SEED_BASE_MS + 1,
                    SEED_BASE_MS + SEED_DAY_MS,
                    "UTC",
                    time.capturedAtMs,
                  ),
                });
              if (change === "series-plan")
                Object.assign(metadata, { plan: { ...metadata.plan } });
              reactions.push("stage-completed");
            });
          }
          return pending;
        });
      try {
        const request = prepareScopedQuery("event-trend", {
          context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
          time,
          filters: parseFilterDsl(
            change === "empty"
              ? 'sequence([event { event.name eq "missing-event" },event { event.name eq "other" }]) exists'
              : dsl,
            analyticsFilterRegistry,
          ),
          scopePreference: scope,
          interval: "day" as const,
          limit: change === "limit-zero" ? 0 : 1,
          ...(change.startsWith("blank-")
            ? { eventName: "" }
            : change.startsWith("spaces-")
              ? { eventName: " qualifier " }
              : change.startsWith("named-")
                ? { eventName: "qualifier" }
                : {}),
        });
        let value: unknown, error: unknown;
        try {
          value = await registry.resolve("event-trend")!.execute(request);
        } catch (e) {
          error = e;
        }
        if (change.endsWith("-error")) expect(error).toBe(marker);
        const original = originalStages.find(
          (row) => row.scope === scope && row.change === change,
        )!;
        expect(
          error instanceof Error
            ? { name: error.name, message: error.message }
            : null,
        ).toEqual(original.error);
        expect(error === marker).toBe(original.errorIsMarker);
        expect(value).toEqual(
          original.valueIndex < 0
            ? undefined
            : originalValues[original.valueIndex],
        );
        expect(reactions).toEqual(original.reactions);
        expect(evaluate.mock.calls.length).toBe(original.core);
        expect(register).not.toHaveBeenCalled();
        expect(trace.preparedSql).toHaveLength(original.sqlCount);
      } finally {
        read.mockRestore();
        register.mockRestore();
        evaluate.mockRestore();
        db.close();
      }
    });
