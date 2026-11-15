import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as inspector from "node:inspector";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import * as db from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import * as d1Budget from "@/lib/db/d1-budget";
import type { CompiledQuery } from "@/lib/db/query/compiled";
import {
  compileD1QuerySemiMembershipFallbackForTest,
  compileD1QueryWithDiagnosticsForTest,
} from "@/lib/db/query/compiler";
import type { AnyExpression } from "@/lib/db/query/expression";
import {
  analyzeSemiMembershipEligibilityForDiagnostics,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";
import {
  analyzeRelationalKeyFacts,
  hasStableRowNumberOrdering,
} from "@/lib/db/query/relational-key-facts";
import type { DatabaseStatement } from "@/lib/db/types";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type {
  CanonicalQuery,
  QueryInput,
  QueryTime,
  ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  DEFAULT_SESSION_LIST_SORT,
  DEFAULT_VISITOR_LIST_SORT,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { FunnelConfigV2 } from "@/lib/edge/analytics/contract/funnel-config";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import {
  ADVANCED_COUNT_FILTER_OUTPUTS,
  type AdvancedCountFilterMatchPlanInput,
  appendAdvancedCountQualification,
  buildAdvancedCountFilterMatchPlan,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { classifyAdvancedCountFilter } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import {
  appendFunnelProgressionRelations,
  createJourneyFunnelProgressionSourceSelections,
} from "@/lib/edge/analytics/engine/funnel-progression-report-plan";
import {
  appendJourneySessionListReport,
  appendJourneyVisitorListReport,
  JOURNEY_LIST_EVENT_ATTRIBUTES,
  JOURNEY_LIST_PAGE_ATTRIBUTES,
  JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  JOURNEY_VISITOR_LIST_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  appendQualifiedObservationMembership,
  splitPageDimensionNativeFilters,
} from "@/lib/edge/analytics/engine/qualified-page-source";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  preparedMembershipFromIds,
  preparedMembershipIdentities,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import * as eventMembershipFallbackModule from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import {
  sessionListPageFromRecords,
  visitorListPageFromRecords,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import * as preparedMembershipModule from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import { compileQualificationProgramEnvelope } from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import {
  deferredSessionListQualificationFromQuery,
  sessionListQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import * as sessionListQualificationRequests from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-request";
import {
  deferredVisitorListQualificationFromQuery,
  visitorListQualificationConfigurationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-request";
import * as visitorListQualificationRequests from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-request";
import {
  readSiteSessions,
  readSiteVisitors,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "wave97aa-safe-composition";
const MAIN_SECRET = "wave97aa-safe-composition-secret";
const BASE = Date.UTC(2026, 9, 1);
const END = BASE + 24 * 60 * 60 * 1000;
const COUNT_FILTER_DSL =
  'page.path eq "/allowed" and count(page { page.path eq "/count" }) gte 1';
const EVIDENCE_DIRECTORY =
  process.env.INSIGHTFLARE_JOURNEY_FUNNEL_EVIDENCE_DIR?.trim();
const RUN_97CK_FULL_COMPILE_CAPTURE =
  process.env.INSIGHTFLARE_97CK_FULL_COMPILE_CAPTURE === "1";
const RUN_97CK_EVIDENCE_DIRECTORY =
  process.env.INSIGHTFLARE_97CK_EVIDENCE_DIRECTORY?.trim();
const RUN_97CL_CPU_PROFILE = process.env.INSIGHTFLARE_97CL_CPU_PROFILE === "1";
const RUN_97CL_EVIDENCE_DIRECTORY =
  process.env.INSIGHTFLARE_97CL_EVIDENCE_DIRECTORY?.trim();

function postInspector<T>(
  session: inspector.Session,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const post = session.post as unknown as (
    this: inspector.Session,
    method: string,
    params: Record<string, unknown>,
    callback: (error: Error | null, result?: unknown) => void,
  ) => void;
  return new Promise((resolve, reject) => {
    post.call(session, method, params, (error, result) => {
      if (error) reject(error);
      else resolve(result as T);
    });
  });
}

type Operation = "visitors" | "sessions";
type Scope = "session" | "visitor";

const CROSS_SCOPE_CASES = [
  {
    operation: "sessions",
    countScope: "visitor",
    progressionScope: "session",
  },
  {
    operation: "visitors",
    countScope: "session",
    progressionScope: "visitor",
  },
] as const;

const DROPOFF_CASES = [
  {
    operation: "visitors",
    countScope: "visitor",
    progressionScope: "visitor",
  },
  {
    operation: "visitors",
    countScope: "session",
    progressionScope: "visitor",
  },
  {
    operation: "sessions",
    countScope: "visitor",
    progressionScope: "session",
  },
  {
    operation: "sessions",
    countScope: "session",
    progressionScope: "session",
  },
] as const;

// Shared MATERIALIZED definitions keep only the first two singleton choices
// at two reachable readers; later choices have one final-render emission.
// Closed, total nested membership now uses its proven one-time membership
// strategy. Pin the shorter emitted SQL; admission limits and fusion counts stay
// exact, including both normally accepted and selected statement fingerprints.
const COMPACT_ALIAS_CASES = [
  {
    caseId: "same-scope-10",
    stepCount: 10,
    countScope: "session",
    progressionScope: "session",
    previousSqlBytes: 93_737,
    originalSqlBytes: 91_703,
    originalSqlSha256:
      "68267A0514A1DCD012F32B1EC09612E719D9019CBD07F84CB273C15E68284CD5",
    expectedNormalSqlBytes: 67_040,
    expectedNormalSqlSha256:
      "469A168097E303A97484204ECABE4B7A90D53A24F357DC617AEF5E58726A3526",
    expectedNormalAccepted: true,
    expectedSelectedSqlBytes: 67_040,
    expectedSelectedSqlSha256:
      "469A168097E303A97484204ECABE4B7A90D53A24F357DC617AEF5E58726A3526",
    expectedSingletonRankFusionCount: 10,
    expectedSingletonRankEmissionCounts: [2, 2, 1, 1, 1, 1, 1, 1, 1, 1],
  },
  {
    caseId: "cross-scope-10",
    stepCount: 10,
    countScope: "visitor",
    progressionScope: "session",
    previousSqlBytes: null,
    originalSqlBytes: 92_537,
    originalSqlSha256:
      "962F76A8B0BB29AB7737CE7AF075EA1E8464403D456E62F05FF3243A080881A2",
    expectedNormalSqlBytes: 67_672,
    expectedNormalSqlSha256:
      "58D4EF37FF89AA5B8F6112E61B9F29B4268EDE4A5209D4EC9AA6C9E4771BF0A8",
    expectedNormalAccepted: true,
    expectedSelectedSqlBytes: 67_672,
    expectedSelectedSqlSha256:
      "58D4EF37FF89AA5B8F6112E61B9F29B4268EDE4A5209D4EC9AA6C9E4771BF0A8",
    expectedSingletonRankFusionCount: 10,
    expectedSingletonRankEmissionCounts: [2, 2, 1, 1, 1, 1, 1, 1, 1, 1],
  },
  {
    caseId: "same-scope-12",
    stepCount: 12,
    countScope: "session",
    progressionScope: "session",
    previousSqlBytes: null,
    originalSqlBytes: 102_844,
    originalSqlSha256:
      "6801F5D080F6F9FC1563756DF2D7658C7A44F0C3FF8836386AE7EC6E427B861E",
    expectedNormalSqlBytes: 72_035,
    expectedNormalSqlSha256:
      "0F2CA97F46102A446A7CE2E12244198AA8176A1D1245D8299A410521EE1D11D4",
    expectedNormalAccepted: true,
    expectedSelectedSqlBytes: 72_035,
    expectedSelectedSqlSha256:
      "0F2CA97F46102A446A7CE2E12244198AA8176A1D1245D8299A410521EE1D11D4",
    expectedSingletonRankFusionCount: 12,
    expectedSingletonRankEmissionCounts: [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  },
  {
    caseId: "cross-scope-12",
    stepCount: 12,
    countScope: "visitor",
    progressionScope: "session",
    previousSqlBytes: null,
    originalSqlBytes: 103_844,
    originalSqlSha256:
      "78A6B03F240E4A9BA02B454391928F24BA65BBCC03B2168C724E088E371DBA28",
    expectedNormalSqlBytes: 72_772,
    expectedNormalSqlSha256:
      "73E2246C3F2D06F4812216DDC4ED769F11A0D52DA27A376FA0035E83EAD2952F",
    expectedNormalAccepted: true,
    expectedSelectedSqlBytes: 72_772,
    expectedSelectedSqlSha256:
      "73E2246C3F2D06F4812216DDC4ED769F11A0D52DA27A376FA0035E83EAD2952F",
    expectedSingletonRankFusionCount: 12,
    expectedSingletonRankEmissionCounts: [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  },
] as const;

const twoStepFunnel = {
  filterDslVersion: 1,
  steps: [
    { id: "step-0", filterDsl: 'page.path eq "/start"' },
    { id: "step-1", filterDsl: 'event.name eq "funnel-convert"' },
  ],
} as const;

function funnelConfigFor(
  stepCount: number,
  progressionScope: Scope,
): FunnelConfigV2 {
  return {
    filterDslVersion: 1,
    progressionScope,
    conversionWindowMs: progressionScope === "visitor" ? 60_000 : null,
    steps: Array.from({ length: stepCount }, (_, index) => ({
      id: `budget-step-${index}`,
      filterDsl:
        index % 2 === 0
          ? `page.path eq "/budget-step-${index}"`
          : `event.name eq "budget-step-${index}"`,
    })),
  };
}

function seedFixture(database: DatabaseSync): number {
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave97aa-team', 'Journey Funnel composition', 'funnel.test', 0)`,
    )
    .run(SITE_ID);

  const visits = [
    ["one-count", "visitor-one", "session-one", BASE + 1_000, "/count"],
    ["one-start", "visitor-one", "session-one", BASE + 1_100, "/start"],
    ["two-count", "visitor-two", "session-two-count", BASE + 2_000, "/count"],
    ["two-start", "visitor-two", "session-two-funnel", BASE + 2_100, "/start"],
    ["three-count", "visitor-three", "session-three", BASE + 3_000, "/count"],
    ["three-start", "visitor-three", "session-three", BASE + 3_100, "/start"],
    ["four-start", "visitor-four", "session-four", BASE + 4_000, "/start"],
    [
      "risk-allowed",
      "visitor-risk",
      "risk-session-allowed",
      BASE + 5_000,
      "/allowed",
    ],
    [
      "risk-count-allowed",
      "visitor-risk",
      "risk-session-allowed",
      BASE + 5_100,
      "/count",
    ],
    [
      "risk-count-funnel",
      "visitor-risk",
      "risk-session-funnel",
      BASE + 6_000,
      "/count",
    ],
    [
      "risk-start",
      "visitor-risk",
      "risk-session-funnel",
      BASE + 6_100,
      "/start",
    ],
  ] as const;
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'funnel.test')`,
  );
  for (const [visitId, visitorId, sessionId, startedAt, pathname] of visits)
    insertVisit.run(
      visitId,
      SITE_ID,
      sitePk,
      visitorId,
      sessionId,
      startedAt,
      startedAt + 500,
      pathname,
    );

  database
    .prepare(
      `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, 'funnel-convert', ?, ?)
       ON CONFLICT(site_pk, name) DO NOTHING`,
    )
    .run(SITE_ID, END, sitePk);
  const eventName = database
    .prepare(
      "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'funnel-convert'",
    )
    .get(sitePk) as { readonly id: number };
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
  );
  for (const [visitId, occurredAt] of [
    ["one-start", BASE + 1_200],
    ["two-start", BASE + 2_200],
    ["four-start", BASE + 4_100],
    ["risk-start", BASE + 6_200],
  ] as const)
    insertEvent.run(
      `event-${visitId}`,
      SITE_ID,
      sitePk,
      visitId,
      eventName.id,
      occurredAt,
      occurredAt,
    );

  const insertFunnel = database.prepare(
    `INSERT INTO analysis_definitions (
      id, site_id, kind, name, config_json, config_version, created_at, updated_at
    ) VALUES (?, ?, 'funnel', ?, ?, 2, ?, ?)`,
  );
  for (const progressionScope of ["session", "visitor"] as const)
    insertFunnel.run(
      `funnel-${progressionScope}`,
      SITE_ID,
      `funnel-${progressionScope}`,
      JSON.stringify({
        ...twoStepFunnel,
        progressionScope,
        conversionWindowMs: progressionScope === "visitor" ? 60_000 : null,
      }),
      BASE,
      BASE,
    );
  return sitePk;
}

function seedPrivateCountFunnelFixture(
  database: DatabaseSync,
  operation: Operation,
): readonly string[] {
  const progressionScope = operation === "visitors" ? "visitor" : "session";
  const funnelId = `funnel-${progressionScope}`;
  const config: FunnelConfigV2 = {
    filterDslVersion: 1,
    progressionScope,
    conversionWindowMs: progressionScope === "visitor" ? 60_000 : null,
    steps: [
      { id: "step-0", filterDsl: 'page.path eq "/allowed"' },
      { id: "step-1", filterDsl: 'event.name eq "funnel-convert"' },
    ],
  };
  database
    .prepare(
      "UPDATE analysis_definitions SET config_json = ? WHERE id = ? AND site_id = ? AND kind = 'funnel'",
    )
    .run(JSON.stringify(config), funnelId, SITE_ID);
  database
    .prepare("DELETE FROM custom_events WHERE event_id IN (?, ?, ?, ?)")
    .run(
      "event-one-start",
      "event-two-start",
      "event-four-start",
      "event-risk-start",
    );
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  const eventNameId = Number(
    (
      database
        .prepare(
          "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'funnel-convert'",
        )
        .get(sitePk) as { readonly id: number }
    ).id,
  );
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'funnel.test')`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
  );
  const entityIds: string[] = [];
  for (const suffix of ["a", "b"] as const) {
    const visitorId = `native-${operation}-visitor-${suffix}`;
    const sessionId = `native-${operation}-session-${suffix}`;
    const identity = operation === "visitors" ? visitorId : sessionId;
    entityIds.push(identity);
    const allowedVisitId = `native-${operation}-allowed-${suffix}`;
    const countVisitId = `native-${operation}-count-${suffix}`;
    const startedAt = BASE + 15_000;
    insertVisit.run(
      allowedVisitId,
      SITE_ID,
      sitePk,
      visitorId,
      sessionId,
      startedAt,
      startedAt + 500,
      "/allowed",
    );
    insertVisit.run(
      countVisitId,
      SITE_ID,
      sitePk,
      visitorId,
      sessionId,
      startedAt + 100,
      startedAt + 500,
      "/count",
    );
    insertEvent.run(
      `native-${operation}-convert-${suffix}`,
      SITE_ID,
      sitePk,
      allowedVisitId,
      eventNameId,
      startedAt + 250,
      startedAt + 250,
    );
  }
  return entityIds;
}

function seedPrivateCrossScopeCountFunnelFixture(
  database: DatabaseSync,
  operation: Operation,
): {
  readonly expectedCountIds: readonly string[];
  readonly expectedReportIds: readonly string[];
  readonly noCountIds: readonly string[];
  readonly noNativeIds: readonly string[];
} {
  const progressionScope = operation === "visitors" ? "visitor" : "session";
  const config: FunnelConfigV2 = {
    filterDslVersion: 1,
    progressionScope,
    conversionWindowMs: progressionScope === "visitor" ? 60_000 : null,
    steps: [
      { id: "step-0", filterDsl: 'page.path eq "/allowed"' },
      { id: "step-1", filterDsl: 'event.name eq "funnel-convert"' },
    ],
  };
  database
    .prepare(
      "UPDATE analysis_definitions SET config_json = ? WHERE id = ? AND site_id = ? AND kind = 'funnel'",
    )
    .run(JSON.stringify(config), `funnel-${progressionScope}`, SITE_ID);
  database.prepare("DELETE FROM custom_events WHERE site_id = ?").run(SITE_ID);
  database.prepare("DELETE FROM visits WHERE site_id = ?").run(SITE_ID);

  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  const eventNameId = Number(
    (
      database
        .prepare(
          "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = 'funnel-convert'",
        )
        .get(sitePk) as { readonly id: number }
    ).id,
  );
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'funnel.test')`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
  );
  type SeededVisit = readonly [
    visitId: string,
    visitorId: string,
    sessionId: string,
    offset: number,
    pathname: string,
    conversionOffset?: number,
  ];
  const visits: SeededVisit[] = [];
  const addVisit = (...visit: SeededVisit) => visits.push(visit);
  const expectedCountIds: string[] = [];
  const expectedReportIds: string[] = [];
  const noCountIds: string[] = [];
  const noNativeIds: string[] = [];

  for (const suffix of ["a", "b"] as const) {
    const visitorId = `cw-${operation}-target-${suffix}`;
    if (operation === "visitors") {
      const firstSessionId = `${visitorId}-session-one`;
      const secondSessionId = `${visitorId}-session-two`;
      addVisit(
        `${firstSessionId}-count`,
        visitorId,
        firstSessionId,
        1_000,
        "/count",
      );
      addVisit(
        `${firstSessionId}-allowed`,
        visitorId,
        firstSessionId,
        10_000,
        "/allowed",
      );
      addVisit(
        `${secondSessionId}-count`,
        visitorId,
        secondSessionId,
        19_000,
        "/count",
      );
      addVisit(
        `${secondSessionId}-allowed`,
        visitorId,
        secondSessionId,
        20_000,
        "/allowed",
        21_000,
      );
      expectedCountIds.push(firstSessionId, secondSessionId);
      expectedReportIds.push(visitorId);
    } else {
      const countSessionId = `${visitorId}-count-session`;
      const funnelSessionId = `${visitorId}-funnel-session`;
      addVisit(
        `${countSessionId}-count`,
        visitorId,
        countSessionId,
        1_000,
        "/count",
      );
      addVisit(
        `${funnelSessionId}-allowed`,
        visitorId,
        funnelSessionId,
        20_000,
        "/allowed",
        21_000,
      );
      expectedCountIds.push(visitorId);
      expectedReportIds.push(funnelSessionId);
    }
  }

  const noFunnelVisitorId = `cw-${operation}-no-funnel`;
  if (operation === "visitors") {
    const sessionId = `${noFunnelVisitorId}-session`;
    addVisit(
      `${sessionId}-count`,
      noFunnelVisitorId,
      sessionId,
      1_000,
      "/count",
    );
    addVisit(
      `${sessionId}-allowed`,
      noFunnelVisitorId,
      sessionId,
      2_000,
      "/allowed",
    );
    expectedCountIds.push(sessionId);
  } else {
    const countSessionId = `${noFunnelVisitorId}-count-session`;
    const reportSessionId = `${noFunnelVisitorId}-report-session`;
    addVisit(
      `${countSessionId}-count`,
      noFunnelVisitorId,
      countSessionId,
      1_000,
      "/count",
    );
    addVisit(
      `${reportSessionId}-allowed`,
      noFunnelVisitorId,
      reportSessionId,
      2_000,
      "/allowed",
    );
    expectedCountIds.push(noFunnelVisitorId);
  }

  const nativeMismatchVisitorId = `cw-${operation}-native-mismatch`;
  const nativeMismatchSessionId = `${nativeMismatchVisitorId}-session`;
  addVisit(
    `${nativeMismatchSessionId}-count`,
    nativeMismatchVisitorId,
    nativeMismatchSessionId,
    1_000,
    "/count",
  );
  addVisit(
    `${nativeMismatchSessionId}-blocked`,
    nativeMismatchVisitorId,
    nativeMismatchSessionId,
    2_000,
    "/blocked",
  );
  noNativeIds.push(
    operation === "visitors"
      ? nativeMismatchSessionId
      : nativeMismatchVisitorId,
  );

  const noCountVisitorId = `cw-${operation}-no-count`;
  if (operation === "visitors") {
    const firstSessionId = `${noCountVisitorId}-session-one`;
    const secondSessionId = `${noCountVisitorId}-session-two`;
    addVisit(
      `${firstSessionId}-allowed`,
      noCountVisitorId,
      firstSessionId,
      10_000,
      "/allowed",
    );
    addVisit(
      `${secondSessionId}-allowed`,
      noCountVisitorId,
      secondSessionId,
      20_000,
      "/allowed",
      21_000,
    );
    noCountIds.push(firstSessionId, secondSessionId);
  } else {
    const sessionId = `${noCountVisitorId}-session`;
    addVisit(
      `${sessionId}-allowed`,
      noCountVisitorId,
      sessionId,
      20_000,
      "/allowed",
      21_000,
    );
    noCountIds.push(noCountVisitorId);
  }

  for (const [
    visitId,
    visitorId,
    sessionId,
    offset,
    pathname,
    conversionOffset,
  ] of visits) {
    const startedAt = BASE + offset;
    insertVisit.run(
      visitId,
      SITE_ID,
      sitePk,
      visitorId,
      sessionId,
      startedAt,
      startedAt + 100,
      pathname,
    );
    if (conversionOffset !== undefined) {
      const occurredAt = BASE + conversionOffset;
      insertEvent.run(
        `event-${visitId}`,
        SITE_ID,
        sitePk,
        visitId,
        eventNameId,
        occurredAt,
        occurredAt,
      );
    }
  }

  return {
    expectedCountIds: expectedCountIds.sort(),
    expectedReportIds: expectedReportIds.sort(),
    noCountIds,
    noNativeIds,
  };
}

interface PrivateCountFunnelDropoffFixture {
  readonly expectedCountIds: readonly string[];
  readonly middleDropoffIds: readonly string[];
  readonly lastDropoffIds: readonly string[];
  readonly noCountIds: readonly string[];
  readonly noCountEntityIds: readonly string[];
  readonly noNativeIds: readonly string[];
  readonly noNativeEntityIds: readonly string[];
  readonly noPreviousIds: readonly string[];
  readonly noPreviousEntityIds: readonly string[];
  readonly reachedSelectedIds: readonly string[];
  readonly countQualifiedStep0SessionId?: string;
  readonly uncountedConversionSessionId?: string;
  readonly uncountedConversionVisitorId?: string;
}

function seedPrivateCountFunnelDropoffFixture(
  database: DatabaseSync,
  operation: Operation,
  countScope: Scope,
): PrivateCountFunnelDropoffFixture {
  seedPrivateCrossScopeCountFunnelFixture(database, operation);
  const progressionScope = operation === "visitors" ? "visitor" : "session";
  const funnelConfig: FunnelConfigV2 = {
    filterDslVersion: 1,
    progressionScope,
    conversionWindowMs: progressionScope === "visitor" ? 60_000 : null,
    steps: [
      { id: "dropoff-step-0", filterDsl: 'event.name eq "dropoff-start"' },
      {
        id: "dropoff-step-1",
        filterDsl: 'event.name eq "dropoff-middle"',
      },
      {
        id: "dropoff-step-2",
        filterDsl: 'event.name eq "dropoff-finish"',
      },
    ],
  };
  database
    .prepare(
      "UPDATE analysis_definitions SET config_json = ? WHERE id = ? AND site_id = ? AND kind = 'funnel'",
    )
    .run(JSON.stringify(funnelConfig), `funnel-${progressionScope}`, SITE_ID);

  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  const insertEventName = database.prepare(
    `INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(site_pk, name) DO NOTHING`,
  );
  const eventNames = new Map<string, number>();
  for (const name of ["dropoff-start", "dropoff-middle", "dropoff-finish"]) {
    insertEventName.run(SITE_ID, name, END, sitePk);
    const row = database
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(sitePk, name) as { readonly id: number };
    eventNames.set(name, Number(row.id));
  }
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'funnel.test')`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
  );
  const addVisit = (
    visitId: string,
    visitorId: string,
    sessionId: string,
    offset: number,
    pathname: string,
  ) => {
    insertVisit.run(
      visitId,
      SITE_ID,
      sitePk,
      visitorId,
      sessionId,
      BASE + offset,
      BASE + 40_000,
      pathname,
    );
  };
  const addEvent = (
    visitId: string,
    name: "dropoff-start" | "dropoff-middle" | "dropoff-finish",
    offset: number,
  ) => {
    const eventNameId = eventNames.get(name);
    if (eventNameId === undefined)
      throw new Error("dropoff_event_name_missing");
    const occurredAt = BASE + offset;
    insertEvent.run(
      `event-${visitId}-${name}`,
      SITE_ID,
      sitePk,
      visitId,
      eventNameId,
      occurredAt,
      occurredAt,
    );
  };

  const expectedCountIds: string[] = [];
  const middleDropoffIds: string[] = [];
  const lastDropoffIds: string[] = [];
  const noCountIds: string[] = [];
  const noCountEntityIds: string[] = [];
  const noNativeIds: string[] = [];
  const noNativeEntityIds: string[] = [];
  const noPreviousIds: string[] = [];
  const noPreviousEntityIds: string[] = [];
  const reachedSelectedIds: string[] = [];

  const targetVisitors = ["a", "b"].map(
    (suffix) => `cw-${operation}-target-${suffix}`,
  );
  for (const [index, visitorId] of targetVisitors.entries()) {
    const reportSessionId =
      operation === "visitors"
        ? `${visitorId}-session-one`
        : `${visitorId}-funnel-session`;
    const reportVisitId = `${reportSessionId}-allowed`;
    if (operation === "sessions" && countScope === "session") {
      addVisit(
        `${reportSessionId}-dropoff-count`,
        visitorId,
        reportSessionId,
        20_000,
        "/count",
      );
    }
    addEvent(reportVisitId, "dropoff-start", 20_100 + index);
    addEvent(reportVisitId, "dropoff-middle", 20_200 + index);
    const reportId = operation === "visitors" ? visitorId : reportSessionId;
    lastDropoffIds.push(reportId);
    reachedSelectedIds.push(reportId);
    if (countScope === "visitor") expectedCountIds.push(visitorId);
    else if (operation === "visitors") {
      expectedCountIds.push(
        `${visitorId}-session-one`,
        `${visitorId}-session-two`,
      );
    } else expectedCountIds.push(reportSessionId);
  }

  const noFunnelVisitorId = `cw-${operation}-no-funnel`;
  const noFunnelSessionId =
    operation === "visitors"
      ? `${noFunnelVisitorId}-session`
      : `${noFunnelVisitorId}-report-session`;
  if (operation === "sessions" && countScope === "session") {
    addVisit(
      `${noFunnelSessionId}-dropoff-count`,
      noFunnelVisitorId,
      noFunnelSessionId,
      20_000,
      "/count",
    );
  }
  const noFunnelAllowedVisitId = `${noFunnelSessionId}-allowed`;
  addEvent(noFunnelAllowedVisitId, "dropoff-start", 20_100);
  middleDropoffIds.push(
    operation === "visitors" ? noFunnelVisitorId : noFunnelSessionId,
  );
  if (countScope === "visitor") expectedCountIds.push(noFunnelVisitorId);
  else expectedCountIds.push(noFunnelSessionId);

  let uncountedConversionSessionId: string | undefined;
  let uncountedConversionVisitorId: string | undefined;
  let countQualifiedStep0SessionId: string | undefined;
  if (operation === "visitors" && countScope === "session") {
    uncountedConversionVisitorId = noFunnelVisitorId;
    countQualifiedStep0SessionId = noFunnelSessionId;
    uncountedConversionSessionId = `${noFunnelVisitorId}-uncounted-session`;
    const visitId = `${uncountedConversionSessionId}-allowed`;
    addVisit(
      visitId,
      noFunnelVisitorId,
      uncountedConversionSessionId,
      21_000,
      "/allowed",
    );
    addEvent(visitId, "dropoff-middle", 21_100);
  }

  const addNewEntity = (
    suffix: string,
    steps: readonly ("dropoff-start" | "dropoff-middle" | "dropoff-finish")[],
    options: {
      readonly counted?: boolean;
      readonly blockedStart?: boolean;
    } = {},
  ) => {
    const counted = options.counted ?? true;
    const visitorId = `cw-dropoff-${operation}-${countScope}-${suffix}`;
    const reportSessionId =
      operation === "sessions"
        ? `${visitorId}-report-session`
        : `${visitorId}-funnel-session`;
    const countSessionId =
      countScope === "session" ? reportSessionId : `${visitorId}-count-session`;
    if (counted) {
      addVisit(
        `${countSessionId}-count`,
        visitorId,
        countSessionId,
        countScope === "session" ? 20_000 : 1_000,
        "/count",
      );
      expectedCountIds.push(
        countScope === "visitor" ? visitorId : countSessionId,
      );
    }
    const allowedVisitId = `${reportSessionId}-allowed`;
    addVisit(allowedVisitId, visitorId, reportSessionId, 20_000, "/allowed");
    for (const [index, name] of steps.entries())
      addEvent(allowedVisitId, name, 20_100 + index * 100);
    if (options.blockedStart) {
      const blockedVisitId = `${reportSessionId}-blocked`;
      addVisit(blockedVisitId, visitorId, reportSessionId, 20_500, "/blocked");
      addEvent(blockedVisitId, "dropoff-start", 20_600);
    }
    return {
      visitorId,
      reportSessionId,
      reportId: operation === "visitors" ? visitorId : reportSessionId,
      countId: countScope === "visitor" ? visitorId : countSessionId,
    };
  };

  const middleB = addNewEntity("middle-b", ["dropoff-start"]);
  middleDropoffIds.push(middleB.reportId);
  const noPrevious = addNewEntity("no-previous", ["dropoff-middle"]);
  noPreviousIds.push(noPrevious.reportId);
  noPreviousEntityIds.push(noPrevious.countId);
  const converted = addNewEntity("converted", [
    "dropoff-start",
    "dropoff-middle",
    "dropoff-finish",
  ]);
  reachedSelectedIds.push(converted.reportId);
  const noCount = addNewEntity(
    "no-count",
    ["dropoff-start", "dropoff-middle"],
    { counted: false },
  );
  noCountIds.push(noCount.reportId);
  noCountEntityIds.push(noCount.countId);

  const nativeMismatchVisitorId = `cw-${operation}-native-mismatch`;
  const nativeMismatchSessionId = `${nativeMismatchVisitorId}-session`;
  const nativeMismatchBlockedVisitId = `${nativeMismatchSessionId}-blocked`;
  addEvent(nativeMismatchBlockedVisitId, "dropoff-start", 2_600);
  const nativeMismatchReportId =
    operation === "visitors"
      ? nativeMismatchVisitorId
      : nativeMismatchSessionId;
  const nativeMismatchCountId =
    countScope === "visitor"
      ? nativeMismatchVisitorId
      : nativeMismatchSessionId;
  noNativeIds.push(nativeMismatchReportId);
  noNativeEntityIds.push(nativeMismatchCountId);

  const noCountVisitorId = `cw-${operation}-no-count`;
  const noCountReportSessionIds =
    operation === "visitors"
      ? [`${noCountVisitorId}-session-one`, `${noCountVisitorId}-session-two`]
      : [`${noCountVisitorId}-session`];
  for (const [index, sessionId] of noCountReportSessionIds.entries()) {
    const visitId = `${sessionId}-allowed`;
    addEvent(visitId, "dropoff-start", 20_100 + index);
    addEvent(visitId, "dropoff-middle", 20_200 + index);
  }
  if (operation === "visitors") noCountIds.push(noCountVisitorId);
  else noCountIds.push(noCountReportSessionIds[0]!);
  noCountEntityIds.push(
    ...(countScope === "visitor"
      ? [noCountVisitorId]
      : noCountReportSessionIds),
  );

  if (operation === "visitors") {
    for (const visitorId of [noFunnelVisitorId, middleB.visitorId])
      database
        .prepare(
          "UPDATE visits SET started_at = ? WHERE visitor_id = ? AND pathname = '/allowed'",
        )
        .run(BASE + 20_000, visitorId);
  } else {
    for (const sessionId of [noFunnelSessionId, middleB.reportSessionId])
      database
        .prepare("UPDATE visits SET started_at = ? WHERE session_id = ?")
        .run(BASE + 20_000, sessionId);
  }

  return {
    expectedCountIds: [...new Set(expectedCountIds)].sort(),
    middleDropoffIds: middleDropoffIds.sort(),
    lastDropoffIds: lastDropoffIds.sort(),
    noCountIds: noCountIds.sort(),
    noCountEntityIds: [...new Set(noCountEntityIds)].sort(),
    noNativeIds: noNativeIds.sort(),
    noNativeEntityIds: [...new Set(noNativeEntityIds)].sort(),
    noPreviousIds: noPreviousIds.sort(),
    noPreviousEntityIds: [...new Set(noPreviousEntityIds)].sort(),
    reachedSelectedIds: reachedSelectedIds.sort(),
    ...(countQualifiedStep0SessionId ? { countQualifiedStep0SessionId } : {}),
    ...(uncountedConversionSessionId ? { uncountedConversionSessionId } : {}),
    ...(uncountedConversionVisitorId ? { uncountedConversionVisitorId } : {}),
  };
}

function queryFor(input: {
  readonly operation: Operation;
  readonly funnel?: {
    readonly stepId: string;
    readonly outcome?: "converted" | "dropoff";
  };
  readonly filterDsl?: string;
  readonly scopePreference?: Scope;
  readonly cursor?: string | null;
  readonly pageLimit?: number;
}): CanonicalQuery<"visitors"> | CanonicalQuery<"sessions"> {
  const common = {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: createQueryTime(BASE, END, "UTC", END),
    ...(input.scopePreference
      ? { scopePreference: input.scopePreference }
      : {}),
    filters: input.filterDsl
      ? parseFilterDsl(input.filterDsl, analyticsFilterRegistry)
      : EMPTY_FILTER_DOCUMENT,
    ...(input.funnel
      ? {
          analysisContext: {
            type: "funnel" as const,
            funnelId:
              input.operation === "visitors"
                ? "funnel-visitor"
                : "funnel-session",
            stepId: input.funnel.stepId,
            ...(input.funnel.outcome ? { outcome: input.funnel.outcome } : {}),
          },
        }
      : {}),
    page: { limit: input.pageLimit ?? 1, cursor: input.cursor ?? null },
  };
  return input.operation === "visitors"
    ? ({
        ...common,
        sort: DEFAULT_VISITOR_LIST_SORT,
      } as CanonicalQuery<"visitors">)
    : ({
        ...common,
        sort: DEFAULT_SESSION_LIST_SORT,
      } as CanonicalQuery<"sessions">);
}

async function legacyListPageWithCountMatches(input: {
  readonly env: Env;
  readonly operation: Operation;
  readonly request: CanonicalQuery<"visitors"> | CanonicalQuery<"sessions">;
  readonly countEntityIds: readonly string[];
  readonly cursor: string | null;
  readonly limit?: number;
}) {
  const prepared = prepareScopedQuery(
    input.operation,
    input.request as never,
  ) as unknown as {
    readonly filters?: ReturnType<typeof parseFilterDsl>;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("journey_funnel_legacy_prepared_filter_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata)
    throw new Error("journey_funnel_legacy_filter_metadata_missing");
  const filters = attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      preparedMembership: preparedMembershipFromIds({
        entityIds: input.countEntityIds.map((id) => ({ siteId: SITE_ID, id })),
      }),
    },
  });
  const time = input.request.time;
  const common = {
    env: input.env,
    siteId: SITE_ID,
    window: {
      startMs: time.range.startMs,
      endExclusiveMs: time.range.endExclusiveMs,
      nowMs: time.capturedAtMs,
      timeZone: time.reportingTimeZone,
    },
    filters,
    analysisContext: input.request.analysisContext,
    audience: "private-dashboard" as const,
    page: { limit: input.limit ?? 1, cursor: input.cursor },
  };
  return input.operation === "visitors"
    ? readSiteVisitors({
        ...common,
        sort: {
          field: DEFAULT_VISITOR_LIST_SORT.key,
          direction: DEFAULT_VISITOR_LIST_SORT.direction,
        },
      })
    : readSiteSessions({
        ...common,
        sort: {
          field: DEFAULT_SESSION_LIST_SORT.key,
          direction: DEFAULT_SESSION_LIST_SORT.direction,
        },
      });
}

async function forwardedQuery(
  env: Env,
  operation: Operation,
  request: CanonicalQuery<"visitors"> | CanonicalQuery<"sessions">,
): Promise<QueryInput & Record<string, unknown>> {
  const prepared = prepareScopedQuery(
    operation,
    request as never,
  ) as unknown as QueryInput & Record<string, unknown>;
  let forwarded: unknown;
  await d1AdvancedFilterMiddleware(env, undefined, SITE_ID)(
    operation,
    prepared,
    async (query) => {
      forwarded = query;
      return query;
    },
  );
  if (!forwarded || typeof forwarded !== "object")
    throw new Error("journey_funnel_middleware_query_missing");
  return forwarded as QueryInput & Record<string, unknown>;
}

function writeEvidence(filename: string, value: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  const path = join(EVIDENCE_DIRECTORY, filename);
  if (existsSync(path))
    throw new Error(`journey_funnel_evidence_exists:${filename}`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withLegacyJourneyListReader<T>(
  operation: Operation,
  read: () => Promise<T>,
): Promise<T> {
  if (operation === "visitors") {
    const parser = vi
      .spyOn(
        visitorListQualificationRequests,
        "visitorListQualificationConfigurationFromQuery",
      )
      .mockReturnValue(undefined);
    try {
      const result = await read();
      expect(parser).toHaveBeenCalled();
      return result;
    } finally {
      parser.mockRestore();
    }
  }

  const parser = vi
    .spyOn(
      sessionListQualificationRequests,
      "sessionListQualificationConfigurationFromQuery",
    )
    .mockReturnValue(undefined);
  try {
    const result = await read();
    expect(parser).toHaveBeenCalled();
    return result;
  } finally {
    parser.mockRestore();
  }
}

function actualRowNumberProofs(root: QuerySource): readonly unknown[] {
  const pending = [root];
  const seenSources = new Set<QuerySource>();
  const proofs: unknown[] = [];
  while (pending.length > 0) {
    const source = pending.pop()!;
    if (seenSources.has(source)) continue;
    seenSources.add(source);
    const node = source.node;
    if (node.kind === "window") {
      for (const [index, { name, specification }] of node.windows.entries()) {
        if (specification.kind !== "row-number") continue;
        const facts = analyzeRelationalKeyFacts(node.input);
        const fieldName = (expression: AnyExpression): string =>
          expression.kind === "column" &&
          expression.scope === node.input.scope &&
          Number.isInteger(expression.index) &&
          expression.index >= 0 &&
          expression.index < node.input.fields.length
            ? node.input.fields[expression.index]!.name
            : `expression:${expression.kind}`;
        proofs.push({
          windowField:
            node.fields[node.input.fields.length + index]?.name ?? name,
          partitionFields: specification.partitionBy.map(fieldName),
          orderFields: specification.orderBy.map(
            ({ expression, direction }) => ({
              field: fieldName(expression),
              direction,
            }),
          ),
          stable: hasStableRowNumberOrdering(node.input, specification),
          candidateKeys: facts.keys.map((key) => ({
            fields: key.fields.map(
              (field) => node.input.fields[field]?.name ?? field,
            ),
            collations: key.collations,
            requiresNonNull: key.requiredNonNull.map(
              (field) => node.input.fields[field]?.name ?? field,
            ),
            lookupContracts: key.lookupContracts,
          })),
        });
      }
    }

    const found: QuerySource[] = [];
    const visited = new WeakSet<object>();
    const findSources = (value: unknown): void => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (
        "node" in value &&
        "scope" in value &&
        "fields" in value &&
        Array.isArray(value.fields)
      ) {
        found.push(value as QuerySource);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(findSources);
        return;
      }
      if (value instanceof Map) {
        for (const [key, entry] of value) {
          findSources(key);
          findSources(entry);
        }
        return;
      }
      if (value instanceof Set) {
        for (const entry of value) findSources(entry);
        return;
      }
      for (const entry of Object.values(value)) findSources(entry);
    };
    findSources(node as LogicalQueryNode);
    pending.push(...found);
  }
  return proofs;
}

function graphSnapshot(value: unknown): unknown {
  const ids = new WeakMap<object, string>();
  const pending: { readonly id: string; readonly value: object }[] = [];
  const objects: Record<string, unknown>[] = [];
  let nextId = 0;
  const encode = (candidate: unknown): unknown => {
    if (candidate === undefined) return { $undefined: true };
    if (typeof candidate === "symbol")
      return { $symbol: candidate.description ?? "" };
    if (typeof candidate === "function")
      return { $function: candidate.name || "anonymous" };
    if (typeof candidate === "bigint") return { $bigint: candidate.toString() };
    if (!candidate || typeof candidate !== "object") return candidate;
    const existing = ids.get(candidate);
    if (existing !== undefined) return { $ref: existing };
    const id = `g${nextId++}`;
    ids.set(candidate, id);
    pending.push({ id, value: candidate });
    return { $ref: id };
  };
  const root = encode(value);
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor]!;
    if (current.value instanceof Map) {
      objects.push({
        id: current.id,
        kind: "Map",
        entries: [...current.value.entries()].map(([key, item]) => [
          encode(key),
          encode(item),
        ]),
      });
    } else if (current.value instanceof Set) {
      objects.push({
        id: current.id,
        kind: "Set",
        entries: [...current.value.values()].map(encode),
      });
    } else if (Array.isArray(current.value)) {
      objects.push({
        id: current.id,
        kind: "Array",
        entries: current.value.map(encode),
      });
    } else {
      objects.push({
        id: current.id,
        kind: current.value.constructor?.name ?? "Object",
        properties: Object.fromEntries(
          Object.keys(current.value).map((key) => [
            key,
            encode(Reflect.get(current.value, key)),
          ]),
        ),
      });
    }
  }
  return { format: "identity-deduplicated-graph-v1", root, objects };
}

function objectGraphSummary(root: unknown) {
  const referenceCounts = new Map<object, number>();
  const kinds = new Map<string, number>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    const previous = referenceCounts.get(value);
    referenceCounts.set(value, (previous ?? 0) + 1);
    if (previous !== undefined) continue;
    if ("kind" in value && typeof value.kind === "string")
      kinds.set(value.kind, (kinds.get(value.kind) ?? 0) + 1);
    pending.push(...Object.values(value));
  }
  return {
    objectCount: referenceCounts.size,
    repeatedObjectReferences: [...referenceCounts.values()].filter(
      (count) => count > 1,
    ).length,
    kindCounts: Object.fromEntries([...kinds.entries()].sort()),
    sourceCount: kinds.get("source") ?? 0,
    scanCount: kinds.get("scan") ?? 0,
  };
}

function logicalRelationReferenceCounts(nodes: readonly LogicalNode[]) {
  const references = new Map<LogicalNode["id"], number>();
  for (const node of nodes) {
    const values = [
      ...("input" in node ? [node.input] : []),
      ...("left" in node ? [node.left] : []),
      ...("right" in node ? [node.right] : []),
      ...("inputs" in node ? node.inputs : []),
    ];
    for (const value of values)
      references.set(value, (references.get(value) ?? 0) + 1);
  }
  return [...references.entries()]
    .map(([relationId, referenceCount]) => ({ relationId, referenceCount }))
    .filter(({ referenceCount }) => referenceCount > 1)
    .sort((left, right) => right.referenceCount - left.referenceCount);
}

function logicalRelationReferenceCount(
  nodes: readonly LogicalNode[],
  relationId: LogicalNode["id"],
): number {
  let count = 0;
  for (const node of nodes) {
    const values = [
      ...("input" in node ? [node.input] : []),
      ...("left" in node ? [node.left] : []),
      ...("right" in node ? [node.right] : []),
      ...("inputs" in node ? node.inputs : []),
    ];
    for (const value of values) if (value === relationId) count += 1;
  }
  return count;
}

function countInputFor(
  filters: ReturnType<typeof parseFilterDsl>,
  queryTime: QueryTime,
  scope: Scope,
): {
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly native: ReturnType<typeof splitPageDimensionNativeFilters>;
} {
  const native = splitPageDimensionNativeFilters(filters);
  if (native.kind !== "supported")
    throw new Error("journey_funnel_native_filter_split_unsupported");
  const support = classifyAdvancedCountFilter(native.advancedFilters, scope);
  if (support.kind !== "supported")
    throw new Error(
      `journey_funnel_count_filter_unsupported:${support.reason}`,
    );
  const readRange = queryTime.readRange ?? queryTime.range;
  return {
    native,
    count: {
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: [SITE_ID as SiteId],
      }),
      candidateRange: queryTime.range,
      readRange,
      expressionRange: queryTime.range,
      expressionUsesExplicitRange: false,
      lowerBounds: [{ siteId: SITE_ID, startMs: readRange.startMs }],
      scope,
      reportingTimeZone: queryTime.reportingTimeZone,
      capturedAtMs: queryTime.capturedAtMs,
      analysis: support.analysis,
      numericCompatibilityRequirements:
        support.numericCompatibilityRequirements,
    },
  };
}

function nativeFunnelSources(input: {
  readonly operation: Operation;
  readonly qualificationScope: Scope;
  readonly entityScope: Scope;
  readonly queryTime: QueryTime;
  readonly nativeFilters: ReturnType<typeof attachScopedFilterMetadata>;
}) {
  const nativeScopePlan = createScopedFilterPlan(
    input.operation,
    input.nativeFilters,
    input.qualificationScope,
  );
  if (!nativeScopePlan)
    throw new Error("journey_funnel_native_scope_plan_missing");
  const scopedNativeFilters = attachScopedFilterMetadata(input.nativeFilters, {
    requestedScope: input.qualificationScope,
    resolvedScope: nativeScopePlan.scope,
    plan: nativeScopePlan,
    time: input.queryTime,
    siteIds: [SITE_ID],
  });
  return createJourneyFunnelProgressionSourceSelections({
    siteId: SITE_ID,
    window: {
      startMs: input.queryTime.range.startMs,
      endExclusiveMs: input.queryTime.range.endExclusiveMs,
      nowMs: input.queryTime.capturedAtMs,
      timeZone: input.queryTime.reportingTimeZone,
    },
    filters: scopedNativeFilters,
    entityScope: input.entityScope,
    preparedPlanOperation: input.operation,
  });
}

function addOutput(
  builder: LogicalPlanBuilder,
  id: string,
  relation: LogicalRelationHandle,
  fields: readonly string[] = Object.keys(relation.slots),
): void {
  builder.output(
    id,
    relation,
    fields.map((name) => ({ name, slot: name })),
  );
}

function compileOutput(
  plan: ReturnType<LogicalPlanBuilder["finish"]>,
  id: string,
) {
  const output = plan.outputs.find((candidate) => candidate.id === id);
  if (!output) throw new Error(`journey_funnel_output_missing:${id}`);
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE_ID,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  return db.compileD1Query(
    db.lowerLogicalPlan<object, Readonly<Record<string, AnyExpression>>>(
      lowerer.projectOutput(
        lowered,
        output.fields.map(({ name, slot }) => ({ name, slot })),
      ),
    ),
    { tag: `test.${id}` },
  ) as unknown as CompiledQuery<Record<string, unknown>>;
}

function buildDirectListComposition(input: {
  readonly operation: Operation;
  readonly countInput: AdvancedCountFilterMatchPlanInput;
  readonly filters: ReturnType<typeof parseFilterDsl>;
  readonly queryTime: QueryTime;
  readonly config: FunnelConfigV2;
  readonly throughStepIndex?: number;
}) {
  const builder = createAdvancedCountQualificationBuilder(input.countInput);
  const qualification = appendAdvancedCountQualification(
    builder,
    input.countInput,
  );
  const split = splitPageDimensionNativeFilters(input.filters);
  if (split.kind !== "supported")
    throw new Error("journey_funnel_native_filter_split_unsupported");
  const sources = nativeFunnelSources({
    operation: input.operation,
    qualificationScope: input.countInput.scope,
    entityScope: input.operation === "visitors" ? "visitor" : "session",
    queryTime: input.queryTime,
    nativeFilters: split.filters,
  });
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: JOURNEY_LIST_PAGE_ATTRIBUTES,
    selection: sources.page,
  });
  const events = builder.source("event", {
    temporalDomain: "candidate",
    attributes: JOURNEY_LIST_EVENT_ATTRIBUTES,
    selection: sources.event,
  });
  const qualifiedPages = appendQualifiedObservationMembership({
    builder,
    observations: pages,
    matches: qualification.matches,
    siteId: SITE_ID,
    ownerAttribute:
      input.countInput.scope === "session"
        ? "page.report.sessionId"
        : "page.report.visitorId",
  });
  const qualifiedEvents = appendQualifiedObservationMembership({
    builder,
    observations: events,
    matches: qualification.matches,
    siteId: SITE_ID,
    ownerAttribute:
      input.countInput.scope === "session"
        ? "event.report.ownerSessionId"
        : "event.report.ownerVisitorId",
  });
  const progression = appendFunnelProgressionRelations({
    builder,
    sources,
    config: input.config,
    throughStepIndex: input.throughStepIndex ?? input.config.steps.length - 1,
    preparedPlanOperation: input.operation,
    qualificationMembership: {
      matches: qualification.matches,
      siteId: SITE_ID,
      countScope: input.countInput.scope,
    },
  });
  const membership =
    progression.reachedSteps[
      input.throughStepIndex ?? input.config.steps.length - 1
    ]!;
  const pageIdentity =
    input.config.progressionScope === "visitor"
      ? "attribute:page.report.visitorId"
      : "attribute:page.report.sessionId";
  const eventIdentity =
    input.config.progressionScope === "visitor"
      ? "attribute:event.report.ownerVisitorId"
      : "attribute:event.report.ownerSessionId";
  const reportPages = builder.semiJoin(qualifiedPages, membership, [
    { left: pageIdentity, right: "identity" },
  ]);
  const reportEvents = builder.semiJoin(qualifiedEvents, membership, [
    { left: eventIdentity, right: "identity" },
  ]);
  const reportOutputId =
    input.operation === "visitors"
      ? JOURNEY_VISITOR_LIST_REPORT_OUTPUT
      : JOURNEY_SESSION_LIST_REPORT_OUTPUT;
  if (input.operation === "visitors")
    appendJourneyVisitorListReport({
      builder,
      pages: reportPages,
      events: reportEvents,
      limit: 20,
      sort: DEFAULT_VISITOR_LIST_SORT,
    });
  else
    appendJourneySessionListReport({
      builder,
      pages: reportPages,
      events: reportEvents,
      limit: 20,
      sort: DEFAULT_SESSION_LIST_SORT,
    });
  addOutput(
    builder,
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
  );
  addOutput(builder, "count-match-identities", qualification.matches);
  addOutput(builder, "count-grouped-summary", qualification.groupedSummary);
  addOutput(builder, "funnel-reached-identities", membership, ["identity"]);
  const plan = builder.finish();
  const reportOutput = plan.outputs.find(
    (candidate) => candidate.id === reportOutputId,
  );
  const controlsOutput = plan.outputs.find(
    (candidate) => candidate.id === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  if (!reportOutput || !controlsOutput)
    throw new Error("journey_funnel_composed_outputs_missing");
  return {
    plan,
    qualification,
    pages,
    events,
    membership,
    reportOutput,
    controlsOutput,
    reportSourceRelations: [
      { relationId: pages.id, entity: "page" as const },
      { relationId: events.id, entity: "event" as const },
    ],
  };
}

describe("Journey Funnel safe composition diagnostics", () => {
  it(
    "plans and validates the cross-scope 12-step representative without rendering SQL",
    async () => {
      if (RUN_97CL_CPU_PROFILE && !RUN_97CL_EVIDENCE_DIRECTORY)
        throw new Error("97cl_cpu_profile_evidence_directory_required");
      if (RUN_97CL_CPU_PROFILE && isMainThread)
        throw new Error("97cl_cpu_profile_requires_vitest_worker_thread");
      const cpuProfileSession = RUN_97CL_CPU_PROFILE
        ? new inspector.Session()
        : undefined;
      if (cpuProfileSession) {
        cpuProfileSession.connect();
        await postInspector<undefined>(cpuProfileSession, "Profiler.enable");
        await postInspector<undefined>(
          cpuProfileSession,
          "Profiler.setSamplingInterval",
          {
            interval: 1_000,
          },
        );
        await postInspector<undefined>(
          cpuProfileSession,
          "Profiler.startPreciseCoverage",
          { callCount: true, detailed: true },
        );
        await postInspector<undefined>(cpuProfileSession, "Profiler.start");
      }
      const startedAt = performance.now();
      const totalCpuStarted = cpuProfileSession
        ? process.cpuUsage()
        : undefined;
      const profilePhases: Array<{
        readonly phase: string;
        readonly wallMs: number;
        readonly cpuUserMs: number;
        readonly cpuSystemMs: number;
      }> = [];
      const recordProfilePhase = (
        phase: string,
        phaseStartedAt: number | undefined,
        phaseCpuStarted: ReturnType<typeof process.cpuUsage> | undefined,
      ) => {
        if (phaseStartedAt === undefined || phaseCpuStarted === undefined)
          return;
        const cpu = process.cpuUsage(phaseCpuStarted);
        profilePhases.push({
          phase,
          wallMs: performance.now() - phaseStartedAt,
          cpuUserMs: cpu.user / 1_000,
          cpuSystemMs: cpu.system / 1_000,
        });
      };
      const factoryStartedAt = cpuProfileSession
        ? performance.now()
        : undefined;
      const factoryCpuStarted = cpuProfileSession
        ? process.cpuUsage()
        : undefined;
      const queryTime = createQueryTime(BASE, END, "UTC", END);
      const filters = parseFilterDsl(COUNT_FILTER_DSL, analyticsFilterRegistry);
      const { count } = countInputFor(filters, queryTime, "visitor");
      const composition = buildDirectListComposition({
        operation: "sessions",
        countInput: count,
        filters,
        queryTime,
        config: funnelConfigFor(12, "session"),
      });
      recordProfilePhase(
        "analytics-factory-graph",
        factoryStartedAt,
        factoryCpuStarted,
      );
      // Exercise the complete public envelope, including admission and controls.
      // Stop at the physical-plan boundary before any SQL renderer can run.
      const originalLower = db.lowerLogicalPlan;
      const originalLowerMany = AnalyticsLogicalToDbLowerer.prototype.lowerMany;
      let physical: ReturnType<typeof originalLower> | undefined;
      const planningComplete = new Error("cross_scope_12_planning_complete");
      const analyticsLoweringPhases: Array<{
        readonly wallMs: number;
        readonly cpuUserMs: number;
        readonly cpuSystemMs: number;
      }> = [];
      const lowerManySpy = cpuProfileSession
        ? vi
            .spyOn(AnalyticsLogicalToDbLowerer.prototype, "lowerMany")
            .mockImplementation(function (
              this: AnalyticsLogicalToDbLowerer,
              outputs: Parameters<typeof originalLowerMany>[0],
            ) {
              const phaseStartedAt = performance.now();
              const phaseCpuStarted = process.cpuUsage();
              try {
                return originalLowerMany.call(this, outputs);
              } finally {
                const cpu = process.cpuUsage(phaseCpuStarted);
                analyticsLoweringPhases.push({
                  wallMs: performance.now() - phaseStartedAt,
                  cpuUserMs: cpu.user / 1_000,
                  cpuSystemMs: cpu.system / 1_000,
                });
              }
            })
        : undefined;
      const genericLoweringPhases: Array<{
        readonly wallMs: number;
        readonly cpuUserMs: number;
        readonly cpuSystemMs: number;
      }> = [];
      let lowerCallCount = 0;
      let compileCallCount = 0;
      let lowerManyCallCount = 0;
      const compileSpy = vi.spyOn(db, "compileD1Query");
      const lowerSpy = vi
        .spyOn(db, "lowerLogicalPlan")
        .mockImplementation((...args: Parameters<typeof originalLower>) => {
          const phaseStartedAt = cpuProfileSession
            ? performance.now()
            : undefined;
          const phaseCpuStarted = cpuProfileSession
            ? process.cpuUsage()
            : undefined;
          physical = originalLower(...args);
          if (phaseStartedAt !== undefined && phaseCpuStarted !== undefined) {
            const cpu = process.cpuUsage(phaseCpuStarted);
            genericLoweringPhases.push({
              wallMs: performance.now() - phaseStartedAt,
              cpuUserMs: cpu.user / 1_000,
              cpuSystemMs: cpu.system / 1_000,
            });
          }
          throw planningComplete;
        });
      const envelopeStartedAt = cpuProfileSession
        ? performance.now()
        : undefined;
      const envelopeCpuStarted = cpuProfileSession
        ? process.cpuUsage()
        : undefined;
      try {
        expect(() =>
          compileQualificationProgramEnvelope({
            qualification: {
              plan: composition.plan,
              primaryReportSourceRelationId: composition.pages.id,
              controlsRelationId: composition.qualification.controls.id,
              groupedSummaryRelationId:
                composition.qualification.groupedSummary.id,
              controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
              numericCompatibilityFields:
                composition.qualification.numericCompatibilityFields,
              scope: composition.qualification.scope,
              reportSourceRelations: composition.reportSourceRelations,
            },
            siteId: SITE_ID,
            reports: [
              {
                output: composition.reportOutput,
                fields: composition.reportOutput.fields.map(({ name }) => name),
                rowType: "sessions-list",
              },
            ],
            controlsOutput: composition.controlsOutput,
            reportFields: composition.reportOutput.fields.map(
              ({ name }) => name,
            ),
            controlFields: composition.controlsOutput.fields.map(
              ({ name }) => name,
            ),
            ordering: [
              {
                field: "sessionId",
                direction: "asc",
                nulls: "last",
                outputId: composition.reportOutput.id,
              },
            ],
            errorPrefix: "journey_funnel_safe_composition",
            fallbackTag: "analytics.sessions_list_qualification",
          }),
        ).toThrow(planningComplete);
        expect(lowerSpy).toHaveBeenCalledTimes(1);
        expect(compileSpy).not.toHaveBeenCalled();
      } finally {
        recordProfilePhase(
          "public-envelope-through-physical-plan",
          envelopeStartedAt,
          envelopeCpuStarted,
        );
        lowerCallCount = lowerSpy.mock.calls.length;
        compileCallCount = compileSpy.mock.calls.length;
        lowerManyCallCount = lowerManySpy?.mock.calls.length ?? 0;
        lowerManySpy?.mockRestore();
        lowerSpy.mockRestore();
        compileSpy.mockRestore();
      }
      if (!physical) throw new Error("cross_scope_12_physical_plan_missing");
      const materializationPipelineDiagnostics: Readonly<
        Record<string, unknown>
      >[] = [];
      const validationStartedAt = cpuProfileSession
        ? performance.now()
        : undefined;
      const validationCpuStarted = cpuProfileSession
        ? process.cpuUsage()
        : undefined;
      const interfaces = validatePhysicalQueryPlan(physical, {
        onMaterializationDiagnostics: (diagnostic) =>
          materializationPipelineDiagnostics.push(diagnostic),
      });
      recordProfilePhase(
        "explicit-fresh-physical-validation",
        validationStartedAt,
        validationCpuStarted,
      );
      if (cpuProfileSession) {
        const profile = await postInspector<inspector.Profiler.StopReturnType>(
          cpuProfileSession,
          "Profiler.stop",
        );
        const preciseCoverage =
          await postInspector<inspector.Profiler.TakePreciseCoverageReturnType>(
            cpuProfileSession,
            "Profiler.takePreciseCoverage",
          );
        await postInspector<undefined>(
          cpuProfileSession,
          "Profiler.stopPreciseCoverage",
        );
        await postInspector<undefined>(cpuProfileSession, "Profiler.disable");
        cpuProfileSession.disconnect();
        const totalCpu = process.cpuUsage(totalCpuStarted);
        const evidenceDirectory = RUN_97CL_EVIDENCE_DIRECTORY!;
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(
          join(evidenceDirectory, "planning-only.cpuprofile"),
          `${JSON.stringify(profile)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        writeFileSync(
          join(evidenceDirectory, "planning-only.precise-coverage.json"),
          `${JSON.stringify(preciseCoverage)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        writeFileSync(
          join(evidenceDirectory, "planning-only-phases.json"),
          `${JSON.stringify(
            {
              fixture:
                "cross-scope-12-complete-qualification-envelope-planning-only",
              workerThread: { isMainThread, threadId },
              sampleIntervalMicroseconds: 1_000,
              startedAtMonotonicMs: startedAt,
              totalWallMs: performance.now() - startedAt,
              totalCpuUserMs: totalCpu.user / 1_000,
              totalCpuSystemMs: totalCpu.system / 1_000,
              publicEnvelopePhysicalLowerCallCount: lowerCallCount,
              sqlCompilerCallCount: compileCallCount,
              analyticsLowerManyCallCount: lowerManyCallCount,
              analyticsLowerMany: analyticsLoweringPhases,
              genericPhysicalLowering: genericLoweringPhases,
              phases: profilePhases,
              profilerNotes: [
                "CPU and precise function coverage were collected inside the Vitest worker executing this test.",
                "Precise coverage enables V8 call counts and can perturb optimization; use function sample distribution as the CPU hotspot signal and report this instrumentation caveat.",
                "The public envelope was stopped at the physical-plan boundary; no SQL compilation or rendering ran.",
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
      expect(materializationPipelineDiagnostics).toHaveLength(1);
      const elapsedMs = performance.now() - startedAt;
      const cuts = physical.sharedRelations.filter(
        ({ materializationSelection }) =>
          materializationSelection?.kind === "strict-serial-rank-stage",
      ).length;
      const automaticPromotions = physical.sharedRelations.filter(
        ({ materializationSelection }) =>
          materializationSelection?.kind === "stage-derived-auto" ||
          materializationSelection?.kind === "current-boundary-derived-auto",
      ).length;
      const derivedWitnesses = physical.selfMembershipChoices.filter(
        ({ witness }) => witness !== undefined,
      ).length;
      const stageSelection = materializationPipelineDiagnostics[0]
        ?.stageSelection as
        | {
            readonly diagnostics?: {
              readonly candidateAssessments?: readonly Record<
                string,
                unknown
              >[];
            };
          }
        | undefined;
      const candidateAssessments =
        stageSelection?.diagnostics?.candidateAssessments ?? [];
      const membershipObservationTerminalCount = candidateAssessments.reduce(
        (count, assessment) => {
          const readers = assessment.readers as
            | {
                readonly details?: {
                  readonly membershipObservationTerminals?: readonly unknown[];
                };
              }
            | undefined;
          return (
            count +
            (readers?.details?.membershipObservationTerminals?.length ?? 0)
          );
        },
        0,
      );
      const membershipObservationCoveredCandidateCount =
        candidateAssessments.filter((assessment) => {
          if (assessment.eligible !== true) return false;
          const readers = assessment.readers as
            | {
                readonly details?: {
                  readonly readerContexts?: readonly Record<string, unknown>[];
                };
              }
            | undefined;
          return (readers?.details?.readerContexts ?? []).some(
            (context) =>
              context.bodyProof === "membership-observation" &&
              context.allCandidatePathsClosed === true &&
              context.passed === true,
          );
        }).length;
      const diagnostics = {
        fixture: "cross-scope-12-complete-qualification-envelope",
        elapsedMs,
        cuts,
        automaticPromotions,
        derivedWitnesses,
        membershipObservationTerminalCount,
        membershipObservationCoveredCandidateCount,
        selfMembership: {
          choiceCount: physical.selfMembershipChoices.length,
          directChoiceCount: physical.selfMembershipChoices.filter(
            ({ witness }) => witness === undefined,
          ).length,
          choices: physical.selfMembershipChoices.map(
            ({ leftKeyIndexes, nullableKeyIndexes, witness }) => ({
              tupleWidth: leftKeyIndexes.length,
              nullableKeyCount: nullableKeyIndexes.length,
              derived: witness !== undefined,
              ...(witness
                ? {
                    definitionIndex: witness.definitionIndex,
                    producerIndex: witness.producerIndex,
                    pathKinds: witness.path.map(({ kind }) => kind),
                  }
                : {}),
            }),
          ),
          remainingPositiveTupleCandidateCount:
            physical.positiveTupleMembershipCandidates.length,
        },
        freshMaterializedInterfaceCount: interfaces.interfaces.length,
        historical: { cuts: 5, automaticPromotions: 2, derivedWitnesses: 2 },
        pipelineSummary: materializationPipelineDiagnostics.map(
          (diagnostic) => {
            const stageSelection = diagnostic.stageSelection as
              Record<string, unknown> | undefined;
            const fallback = diagnostic.fallback as
              Record<string, unknown> | undefined;
            const finalBoundary = diagnostic.finalBoundary as
              Record<string, unknown> | undefined;
            return {
              kind: diagnostic.kind,
              stageState: stageSelection?.state,
              stageCandidateCount: stageSelection?.candidateCount,
              selectedStagePostorderIndexes:
                stageSelection?.selectedPostorderIndexes,
              fallbackTriggered: fallback?.triggered,
              finalInterfaceCount: finalBoundary?.interfaceCount,
              finalLicenses: finalBoundary?.licenses,
            };
          },
        ),
      };
      console.info(
        `CROSS_SCOPE_12_PLAN_DIAGNOSTIC ${JSON.stringify(diagnostics)}`,
      );
      writeEvidence("cross-scope-12-complete-envelope-planning.json", {
        diagnostics,
        materializationPipeline: materializationPipelineDiagnostics,
        genericRootGraph: graphSnapshot(physical.root),
        logicalGraph: graphSnapshot(composition.plan),
      });
      expect(physical.root).toBeDefined();
      expect(interfaces.root).toBe(physical.root);
      expect(cuts).toBeGreaterThan(0);
      expect(membershipObservationTerminalCount).toBeGreaterThan(0);
      expect(membershipObservationCoveredCandidateCount).toBeGreaterThan(0);
      expect(elapsedMs).toBeLessThanOrEqual(30_000);
    },
    RUN_97CL_CPU_PROFILE ? 120_000 : 30_000,
  );

  it.skipIf(!RUN_97CK_FULL_COMPILE_CAPTURE)(
    "97CK one-shot cross-scope 12-step public envelope compile capture",
    () => {
      if (!RUN_97CK_EVIDENCE_DIRECTORY)
        throw new Error("97ck_compile_capture_evidence_directory_required");
      const totalStartedAt = performance.now();
      const totalCpuStarted = process.cpuUsage();
      const factoryCpuStarted = process.cpuUsage();
      const factoryStartedAt = performance.now();
      const queryTime = createQueryTime(BASE, END, "UTC", END);
      const filters = parseFilterDsl(COUNT_FILTER_DSL, analyticsFilterRegistry);
      const { count } = countInputFor(filters, queryTime, "visitor");
      const composition = buildDirectListComposition({
        operation: "sessions",
        countInput: count,
        filters,
        queryTime,
        config: funnelConfigFor(12, "session"),
      });
      const factoryGraphPhase = {
        wallMs: performance.now() - factoryStartedAt,
        ...process.cpuUsage(factoryCpuStarted),
      };

      const analyticsLoweringPhases: Array<Record<string, number>> = [];
      const originalLowerMany = AnalyticsLogicalToDbLowerer.prototype.lowerMany;
      const lowerManySpy = vi
        .spyOn(AnalyticsLogicalToDbLowerer.prototype, "lowerMany")
        .mockImplementation(function (
          this: AnalyticsLogicalToDbLowerer,
          outputs: Parameters<typeof originalLowerMany>[0],
        ) {
          const startedAt = performance.now();
          const cpuStarted = process.cpuUsage();
          try {
            return originalLowerMany.call(this, outputs);
          } finally {
            analyticsLoweringPhases.push({
              wallMs: performance.now() - startedAt,
              ...process.cpuUsage(cpuStarted),
            });
          }
        });

      const physicalLoweringPhases: Array<Record<string, number>> = [];
      const originalLower = db.lowerLogicalPlan;
      let genericPhysical: ReturnType<typeof db.lowerLogicalPlan> | undefined;
      const lowerSpy = vi
        .spyOn(db, "lowerLogicalPlan")
        .mockImplementation((...args: Parameters<typeof originalLower>) => {
          const startedAt = performance.now();
          const cpuStarted = process.cpuUsage();
          try {
            genericPhysical = originalLower(...args);
            return genericPhysical;
          } finally {
            physicalLoweringPhases.push({
              wallMs: performance.now() - startedAt,
              ...process.cpuUsage(cpuStarted),
            });
          }
        });

      const compilePhases: Array<Record<string, string | number>> = [];
      let compileCpuCheckpoint = process.cpuUsage();
      let compileCapture:
        ReturnType<typeof compileD1QueryWithDiagnosticsForTest> | undefined;
      let compileCallCount = 0;
      const compileSpy = vi.spyOn(db, "compileD1Query").mockImplementation(((
        input: unknown,
        options?: unknown,
      ) => {
        if (compileCapture)
          throw new Error("97ck_public_envelope_compiled_more_than_once");
        compileCpuCheckpoint = process.cpuUsage();
        compileCapture = compileD1QueryWithDiagnosticsForTest(
          input as Parameters<typeof compileD1QueryWithDiagnosticsForTest>[0],
          options as Parameters<typeof compileD1QueryWithDiagnosticsForTest>[1],
          (phase, elapsedMs) => {
            const cpu = process.cpuUsage(compileCpuCheckpoint);
            compilePhases.push({
              phase,
              wallMs: elapsedMs,
              cpuUserMs: cpu.user / 1_000,
              cpuSystemMs: cpu.system / 1_000,
            });
            compileCpuCheckpoint = process.cpuUsage();
          },
        );
        return compileCapture.query as ReturnType<typeof db.compileD1Query>;
      }) as typeof db.compileD1Query);

      let compilation: ReturnType<typeof compileQualificationProgramEnvelope>;
      try {
        compilation = compileQualificationProgramEnvelope({
          qualification: {
            plan: composition.plan,
            primaryReportSourceRelationId: composition.pages.id,
            controlsRelationId: composition.qualification.controls.id,
            groupedSummaryRelationId:
              composition.qualification.groupedSummary.id,
            controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
            numericCompatibilityFields:
              composition.qualification.numericCompatibilityFields,
            scope: composition.qualification.scope,
            reportSourceRelations: composition.reportSourceRelations,
          },
          siteId: SITE_ID,
          reports: [
            {
              output: composition.reportOutput,
              fields: composition.reportOutput.fields.map(({ name }) => name),
              rowType: "sessions-list",
            },
          ],
          controlsOutput: composition.controlsOutput,
          reportFields: composition.reportOutput.fields.map(({ name }) => name),
          controlFields: composition.controlsOutput.fields.map(
            ({ name }) => name,
          ),
          ordering: [
            {
              field: "sessionId",
              direction: "asc",
              nulls: "last",
              outputId: composition.reportOutput.id,
            },
          ],
          errorPrefix: "journey_funnel_safe_composition",
          fallbackTag: "analytics.sessions_list_qualification",
        });
      } catch (error) {
        const outputPath = join(
          RUN_97CK_EVIDENCE_DIRECTORY,
          "cross-scope-12-full-envelope-compile.json",
        );
        if (existsSync(outputPath))
          throw new Error("97ck_compile_capture_evidence_already_exists");
        mkdirSync(RUN_97CK_EVIDENCE_DIRECTORY, { recursive: true });
        const totalWallMs = performance.now() - totalStartedAt;
        const totalCpu = process.cpuUsage(totalCpuStarted);
        writeFileSync(
          outputPath,
          `${JSON.stringify(
            {
              testName:
                "97CK one-shot cross-scope 12-step public envelope compile capture",
              status: "failed",
              environmentSwitch: "INSIGHTFLARE_97CK_FULL_COMPILE_CAPTURE=1",
              error:
                error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      stack: error.stack,
                    }
                  : String(error),
              compileCallCount: compileSpy.mock.calls.length,
              hasGenericPhysical: genericPhysical !== undefined,
              hasCompileCapture: compileCapture !== undefined,
              phases: {
                analyticsFactoryGraph: factoryGraphPhase,
                analyticsLowering: analyticsLoweringPhases,
                genericPhysicalLowering: physicalLoweringPhases,
                compile: compilePhases,
                total: {
                  wallMs: totalWallMs,
                  cpuUserMs: totalCpu.user / 1_000,
                  cpuSystemMs: totalCpu.system / 1_000,
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        throw error;
      } finally {
        // mockRestore clears call history; preserve the observed count first.
        compileCallCount = compileSpy.mock.calls.length;
        compileSpy.mockRestore();
        lowerSpy.mockRestore();
        lowerManySpy.mockRestore();
      }

      const totalWallMs = performance.now() - totalStartedAt;
      const totalCpu = process.cpuUsage(totalCpuStarted);
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled")
        throw new Error("97ck_full_envelope_compile_unavailable");
      // Persist the real return before diagnostic assertions can fail.
      mkdirSync(RUN_97CK_EVIDENCE_DIRECTORY, { recursive: true });
      writeFileSync(
        join(RUN_97CK_EVIDENCE_DIRECTORY, "returned-query.json"),
        `${JSON.stringify(
          {
            compileCallCount,
            hasGenericPhysical: genericPhysical !== undefined,
            hasCompileCapture: compileCapture !== undefined,
            sameCapturedQuery: compileCapture?.query === compilation.query,
            query: compilation.query,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      expect(compileCallCount).toBe(1);
      if (!genericPhysical || !compileCapture)
        throw new Error("97ck_full_envelope_capture_incomplete");
      const physicalPlan = genericPhysical;
      const query = compilation.query;
      const bindings = query.bindings ?? [];
      const shape = query.physicalPlanShape;
      expect(shape?.version).toBe(14);
      if (shape?.version !== 14)
        throw new Error("97ck_compile_order_v14_shape_missing");
      expect(shape.compileOrder.helperCount).toBe(1);
      expect(shape.compileOrder.leafCount).toBeGreaterThanOrEqual(2);
      expect(bindings.length).toBeLessThanOrEqual(100);

      const sqlBytes = new TextEncoder().encode(query.sql).byteLength;
      const sqlSha256 = createHash("sha256")
        .update(query.sql, "utf8")
        .digest("hex")
        .toUpperCase();
      const bindingIdentity = bindings.map((value, index) => ({
        index,
        type:
          value === null
            ? "null"
            : value instanceof ArrayBuffer
              ? "ArrayBuffer"
              : ArrayBuffer.isView(value)
                ? value.constructor.name
                : typeof value,
        value,
      }));
      const counts = compileCapture.finalRender.emissionCounts;
      const relationIndex = (node: object) =>
        physicalPlan.sharedRelations.findIndex(
          ({ node: current }) => current === node,
        );
      const outputPath = join(
        RUN_97CK_EVIDENCE_DIRECTORY,
        "cross-scope-12-full-envelope-compile.json",
      );
      if (existsSync(outputPath))
        throw new Error("97ck_compile_capture_evidence_already_exists");
      mkdirSync(RUN_97CK_EVIDENCE_DIRECTORY, { recursive: true });
      writeFileSync(
        outputPath,
        `${JSON.stringify(
          {
            testName:
              "97CK one-shot cross-scope 12-step public envelope compile capture",
            environmentSwitch: "INSIGHTFLARE_97CK_FULL_COMPILE_CAPTURE=1",
            compileCallCount,
            phases: {
              analyticsFactoryGraph: factoryGraphPhase,
              analyticsLowering: analyticsLoweringPhases,
              genericPhysicalLowering: physicalLoweringPhases,
              compile: compilePhases,
              total: {
                wallMs: totalWallMs,
                cpuUserMs: totalCpu.user / 1_000,
                cpuSystemMs: totalCpu.system / 1_000,
              },
            },
            compilation: {
              kind: compilation.kind,
              statementTag: compilation.evidence.statementTag,
              sqlBytes,
              sqlSha256,
              sql: query.sql,
              bindings: query.bindings,
              parameterIdentity: {
                strategy: shape.parameterStrategy ?? null,
                occurrenceCount:
                  shape.parameterOccurrenceCount ?? bindings.length,
                slotCount: shape.parameterSlotCount ?? bindings.length,
                values: bindingIdentity,
              },
              physicalPlanShape: shape,
              compileOrderReferenceGraph:
                compileCapture.compileOrderGraph ?? null,
              finalEmissions: {
                sharedReferences: [...counts.sharedReferences].map(
                  ([node, reference]) => ({
                    definitionIndex: relationIndex(node),
                    emissionCount: reference.emissionCount,
                  }),
                ),
                materializedReferences: [...counts.materializedReferences].map(
                  ([node, reference]) => ({
                    definitionIndex: relationIndex(node),
                    fieldCount: reference.fieldCount,
                    emissionCount: reference.emissionCount,
                  }),
                ),
                materializationDefinitions: [
                  ...counts.materializationDefinitions,
                ].map(([node, definition]) => ({
                  definitionIndex: relationIndex(node),
                  kind: definition.selectionKind,
                  choiceIndex: definition.choiceIndex,
                  emissionCount: definition.emissionCount,
                })),
                compileOrderHelpers: [...counts.compileOrderHelpers.values()],
                lexicographic: [...counts.lexicographic.values()],
                semiMembership: [...counts.semiMembership.values()],
                singletonRank: [...counts.singletonRank.values()],
                nativeNullOrdering: [...counts.nativeNullOrdering.values()],
                derivedSelfMembership: [
                  ...counts.derivedSelfMembership.values(),
                ],
              },
            },
            sourceGraphs: {
              analytics: graphSnapshot(composition.plan),
              generic: graphSnapshot(physicalPlan.root),
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      expect(sqlBytes).toBeLessThanOrEqual(100_000);
      expect(compileCapture.finalRender.query).toBe(query);
    },
    120_000,
  );

  it.each(COMPACT_ALIAS_CASES)(
    "preserves the normal output or compacts the over-budget $caseId DAG",
    (testCase) => {
      const {
        caseId,
        stepCount,
        countScope,
        progressionScope,
        previousSqlBytes,
        originalSqlBytes,
        originalSqlSha256,
        expectedNormalSqlBytes,
        expectedNormalSqlSha256,
        expectedNormalAccepted,
        expectedSelectedSqlBytes,
        expectedSelectedSqlSha256,
        expectedSingletonRankFusionCount,
        expectedSingletonRankEmissionCounts,
      } = testCase;
      const queryTime = createQueryTime(BASE, END, "UTC", END);
      const filters = parseFilterDsl(COUNT_FILTER_DSL, analyticsFilterRegistry);
      const { count } = countInputFor(filters, queryTime, countScope);
      const config = funnelConfigFor(stepCount, progressionScope);
      const composition = buildDirectListComposition({
        operation: "sessions",
        countInput: count,
        filters,
        queryTime,
        config,
      });
      const logicalNodes = composition.plan.nodes;
      const logicalEdges = logicalNodes.flatMap((node) => [
        ...("input" in node ? [node.input] : []),
        ...("left" in node ? [node.left] : []),
        ...("right" in node ? [node.right] : []),
        ...("inputs" in node ? node.inputs : []),
      ]);
      const logicalSummary = {
        uniqueNodeCount: logicalNodes.length,
        edgeCount: logicalEdges.length,
        maxNodeOutputWidth: Math.max(
          0,
          ...logicalNodes.map((node) => node.output.length),
        ),
        sharedRelationReferences: logicalRelationReferenceCounts(logicalNodes),
        countMatchReferenceCount: logicalRelationReferenceCount(
          logicalNodes,
          composition.qualification.matches.id,
        ),
        nodeKindCounts: Object.fromEntries(
          [
            ...logicalNodes
              .reduce((counts, node) => {
                counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
                return counts;
              }, new Map<string, number>())
              .entries(),
          ].sort(),
        ),
      };
      const genericGraphs: unknown[] = [];
      const budgetAttempts: Array<{
        readonly statement: DatabaseStatement;
        readonly accepted: boolean;
        readonly assertionMs: number;
        readonly rejection?: {
          readonly name: string;
          readonly item?: string;
          readonly actual?: number;
          readonly limit?: number;
        };
      }> = [];
      const compileCalls: Array<{
        readonly tag: string;
        readonly outcome: "returned" | "threw";
        readonly durationMs: number;
      }> = [];
      const targetTag = "analytics.sessions_list_qualification";
      const originalAssert = d1Budget.assertD1StatementBudget;
      const originalLower = db.lowerLogicalPlan as (input: unknown) => unknown;
      const originalCompile = db.compileD1Query as (
        input: unknown,
        options?: unknown,
      ) => unknown;
      const budgetSpy = vi
        .spyOn(d1Budget, "assertD1StatementBudget")
        .mockImplementation((statement) => {
          if (statement.tag !== targetTag) return originalAssert(statement);
          const startedAt = performance.now();
          try {
            originalAssert(statement);
            budgetAttempts.push({
              statement: { ...statement },
              accepted: true,
              assertionMs: performance.now() - startedAt,
            });
          } catch (error) {
            const rejection =
              error instanceof d1Budget.D1StatementBudgetError
                ? {
                    name: error.name,
                    item: error.item,
                    actual: error.actual,
                    limit: error.limit,
                  }
                : {
                    name: error instanceof Error ? error.name : "unknown",
                  };
            budgetAttempts.push({
              statement: { ...statement },
              accepted: false,
              assertionMs: performance.now() - startedAt,
              rejection,
            });
            throw error;
          }
        });
      const lowerSpy = vi.spyOn(db, "lowerLogicalPlan").mockImplementation(((
        input: unknown,
      ) => {
        const lowered = originalLower(input);
        genericGraphs.push(lowered);
        if (EVIDENCE_DIRECTORY)
          writeEvidence(`precompile-${caseId}-dag.json`, {
            state: "generic-dag-captured-before-sql-compilation",
            operation: "sessions",
            caseId,
            countScope: count.scope,
            progressionScope,
            stepCount,
            funnelConfig: config,
            logicalSummary,
            logicalGraph: composition.plan,
            genericSummary: objectGraphSummary(lowered),
            genericGraph: graphSnapshot(lowered),
          });
        return lowered;
      }) as typeof db.lowerLogicalPlan);
      const compileSpy = vi.spyOn(db, "compileD1Query").mockImplementation(((
        input: unknown,
        options?: unknown,
      ) => {
        const tag = (options as { readonly tag?: string } | undefined)?.tag;
        const startedAt = performance.now();
        try {
          const result = originalCompile(input, options);
          if (tag === targetTag)
            compileCalls.push({
              tag,
              outcome: "returned",
              durationMs: performance.now() - startedAt,
            });
          return result;
        } catch (error) {
          if (tag === targetTag)
            compileCalls.push({
              tag,
              outcome: "threw",
              durationMs: performance.now() - startedAt,
            });
          throw error;
        }
      }) as typeof db.compileD1Query);
      let compilation: ReturnType<typeof compileQualificationProgramEnvelope>;
      const compilationStartedAt = performance.now();
      try {
        compilation = compileQualificationProgramEnvelope({
          qualification: {
            plan: composition.plan,
            primaryReportSourceRelationId: composition.pages.id,
            controlsRelationId: composition.qualification.controls.id,
            groupedSummaryRelationId:
              composition.qualification.groupedSummary.id,
            controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
            numericCompatibilityFields:
              composition.qualification.numericCompatibilityFields,
            scope: composition.qualification.scope,
            reportSourceRelations: composition.reportSourceRelations,
          },
          siteId: SITE_ID,
          reports: [
            {
              output: composition.reportOutput,
              fields: composition.reportOutput.fields.map(({ name }) => name),
              rowType: "sessions-list",
            },
          ],
          controlsOutput: composition.controlsOutput,
          reportFields: composition.reportOutput.fields.map(({ name }) => name),
          controlFields: composition.controlsOutput.fields.map(
            ({ name }) => name,
          ),
          ordering: [
            {
              field: "sessionId",
              direction: "asc",
              nulls: "last",
              outputId: composition.reportOutput.id,
            },
          ],
          errorPrefix: "journey_funnel_safe_composition",
          fallbackTag: "analytics.sessions_list_qualification",
        });
      } finally {
        compileSpy.mockRestore();
        lowerSpy.mockRestore();
        budgetSpy.mockRestore();
      }
      const compilationMs = performance.now() - compilationStartedAt;
      expect(genericGraphs).toHaveLength(1);
      const singletonRankChoices = (
        genericGraphs[0] as {
          readonly singletonRankChoices: readonly object[];
        }
      ).singletonRankChoices;
      expect(singletonRankChoices).toHaveLength(
        expectedSingletonRankFusionCount,
      );
      expect(new Set(singletonRankChoices).size).toBe(
        expectedSingletonRankFusionCount,
      );
      expect(logicalSummary.countMatchReferenceCount).toBeGreaterThan(0);
      const normalAttempt = budgetAttempts[0];
      const selectedAttempt = budgetAttempts.at(-1);
      const selectedStatement =
        compilation.kind === "compiled"
          ? {
              tag: compilation.evidence.statementTag,
              sql: compilation.evidence.sql,
              bindings: compilation.evidence.bindings,
            }
          : null;
      const sqlSha256 = (sql: string) =>
        createHash("sha256").update(sql, "utf8").digest("hex").toUpperCase();
      const normalSqlBytes = normalAttempt
        ? new TextEncoder().encode(normalAttempt.statement.sql).byteLength
        : null;
      const selectedSqlBytes = selectedStatement
        ? new TextEncoder().encode(selectedStatement.sql).byteLength
        : null;
      if (
        EVIDENCE_DIRECTORY &&
        (caseId === "cross-scope-10" || caseId === "cross-scope-12")
      ) {
        const physical = genericGraphs[0] as {
          readonly root: LogicalQueryNode;
          readonly semiMembershipChoices: readonly unknown[];
          readonly semiMembershipCostSelections: readonly {
            readonly choice: { readonly node: LogicalQueryNode };
            readonly strategy: "in" | "exists";
            readonly reason: string;
            readonly evidence?: unknown;
          }[];
        };
        const decisions = analyzeSemiMembershipEligibilityForDiagnostics(
          physical.root,
        );
        const summarizeDecision = (decision: (typeof decisions)[number]) => ({
          candidateIndex: decision.candidateIndex,
          nodeKind: decision.node.kind,
          leftOutput: decision.node.left.fields.map(
            ({ name, affinity, nullable }) => ({
              name,
              affinity,
              nullable,
            }),
          ),
          rightOutput: decision.node.right.fields.map(
            ({ name, affinity, nullable }) => ({
              name,
              affinity,
              nullable,
            }),
          ),
          kind: decision.kind,
          phase: decision.phase ?? null,
          reason: decision.reason ?? null,
          inputSide: decision.inputSide ?? null,
          totalityVeto: decision.totalityVeto ?? null,
          comparisons:
            decision.comparisons?.map((comparison) => ({
              leftIndex: comparison.leftIndex,
              rightIndex: comparison.rightIndex,
              compatibility: comparison.compatibility,
              leftAffinity: comparison.leftDomain.affinity,
              leftStorageClasses: comparison.leftDomain.storageClasses,
              leftPath: comparison.leftDomain.path,
              rightAffinity: comparison.rightDomain.affinity,
              rightStorageClasses: comparison.rightDomain.storageClasses,
              rightPath: comparison.rightDomain.path,
            })) ?? null,
          selected: Boolean(decision.choice),
        });
        const costSelections = physical.semiMembershipCostSelections.map(
          ({ choice, strategy, reason, evidence }) => ({
            candidateIndex: decisions.findIndex(
              ({ node }) => node === choice.node,
            ),
            strategy,
            reason,
            evidence: evidence ?? null,
          }),
        );
        const shape = selectedAttempt?.statement.physicalPlanShape as
          | {
              readonly semiMembershipCount?: number;
              readonly semiMemberships?: readonly {
                readonly emissionCount: number;
              }[];
            }
          | undefined;
        writeEvidence(`${caseId}-semi-membership-analysis.json`, {
          state:
            "production-semi-membership-proof-recomputed-from-original-cross-scope-input",
          operation: "sessions",
          caseId,
          preCostOptimizedSqlBytes: originalSqlBytes,
          preCostOptimizedSqlSha256: originalSqlSha256,
          defaultCostSqlBytes: normalSqlBytes,
          defaultCostSqlSha256: normalAttempt
            ? sqlSha256(normalAttempt.statement.sql)
            : null,
          defaultCostBindingCount:
            normalAttempt?.statement.bindings?.length ?? null,
          selectedCostSqlBytes: selectedSqlBytes,
          selectedCostSqlSha256: selectedStatement
            ? sqlSha256(selectedStatement.sql)
            : null,
          selectedCostBindingCount:
            selectedAttempt?.statement.bindings?.length ?? null,
          countScope: count.scope,
          progressionScope,
          stepCount,
          candidateCount: decisions.length,
          eligibleCandidateCount: decisions.filter(
            ({ kind }) => kind === "eligible",
          ).length,
          physicalChoiceCount: physical.semiMembershipChoices.length,
          costSelectionCount: costSelections.length,
          selectedInCount: costSelections.filter(
            ({ strategy }) => strategy === "in",
          ).length,
          selectedExistsCount: costSelections.filter(
            ({ strategy }) => strategy === "exists",
          ).length,
          costSelections,
          actualSemiMembershipChoiceEmissionCount:
            shape?.semiMembershipCount ?? 0,
          actualSemiMembershipEmissionCount:
            shape?.semiMemberships?.reduce(
              (total, { emissionCount }) => total + emissionCount,
              0,
            ) ?? 0,
          normalPhysicalPlanShape:
            normalAttempt?.statement.physicalPlanShape ?? null,
          selectedPhysicalPlanShape:
            selectedAttempt?.statement.physicalPlanShape ?? null,
          normalInSelectEmissionCount: normalAttempt
            ? (normalAttempt.statement.sql.match(/ IN \(SELECT /gu) ?? [])
                .length
            : null,
          selectedInSelectEmissionCount: selectedAttempt
            ? (selectedAttempt.statement.sql.match(/ IN \(SELECT /gu) ?? [])
                .length
            : null,
          normalExistsEmissionCount: normalAttempt
            ? (normalAttempt.statement.sql.match(/\bEXISTS \(SELECT/gu) ?? [])
                .length
            : null,
          selectedExistsEmissionCount: selectedAttempt
            ? (selectedAttempt.statement.sql.match(/\bEXISTS \(SELECT/gu) ?? [])
                .length
            : null,
          candidates: decisions.map(summarizeDecision),
        });
      }
      if (EVIDENCE_DIRECTORY)
        writeEvidence(`compiled-${caseId}-budget.json`, {
          state: compilation.kind,
          operation: "sessions",
          caseId,
          countScope: count.scope,
          progressionScope,
          stepCount,
          previousSqlBytes,
          originalSqlBytes,
          originalSqlSha256,
          expectedNormalSqlBytes,
          expectedNormalSqlSha256,
          expectedNormalAccepted,
          expectedSelectedSqlBytes,
          expectedSelectedSqlSha256,
          expectedSingletonRankFusionCount,
          expectedSingletonRankEmissionCounts,
          compilationMs,
          compileCalls,
          logicalSummary,
          genericSummary: genericGraphs.map(objectGraphSummary),
          budgetAttempts: budgetAttempts.map((attempt) => ({
            ...attempt,
            sqlBytes: new TextEncoder().encode(attempt.statement.sql)
              .byteLength,
            sqlSha256: sqlSha256(attempt.statement.sql),
            bindingCount: attempt.statement.bindings?.length ?? 0,
          })),
          selectedStatement: selectedStatement
            ? {
                ...selectedStatement,
                sqlBytes: selectedSqlBytes,
                sqlSha256: sqlSha256(selectedStatement.sql),
                bindingCount: selectedStatement.bindings.length,
              }
            : null,
          compilation,
        });
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled")
        throw new Error("journey_funnel_budgeted_compile_expected");
      expect(normalAttempt).toBeDefined();
      if (!normalAttempt)
        throw new Error("journey_funnel_normal_attempt_missing");
      expect(normalSqlBytes).toBe(expectedNormalSqlBytes);
      expect(sqlSha256(normalAttempt.statement.sql)).toBe(
        expectedNormalSqlSha256,
      );
      expect(normalAttempt.accepted).toBe(expectedNormalAccepted);
      expect(normalAttempt.statement.physicalPlanShape?.version).toBe(14);
      if (normalAttempt.statement.physicalPlanShape?.version === 14) {
        expect(
          normalAttempt.statement.physicalPlanShape.singletonRankFusionCount,
        ).toBe(expectedSingletonRankFusionCount);
        expect(
          normalAttempt.statement.physicalPlanShape.singletonRankFusions.map(
            ({ emissionCount }) => emissionCount,
          ),
        ).toEqual(expectedSingletonRankEmissionCounts);
        expect(
          normalAttempt.statement.physicalPlanShape.singletonRankFusions.every(
            ({ emissionCount }) =>
              Number.isSafeInteger(emissionCount) && emissionCount > 0,
          ),
        ).toBe(true);
      }
      // Cross-scope membership now has the same closed/total proof as the
      // same-scope program. Pin complete two-key choices and their emissions
      // instead of requiring the former correlated-only physical fallback.
      const expectedMembershipCount = stepCount === 12 ? 20 : 17;
      expect(normalAttempt.statement.physicalPlanShape).toMatchObject({
        semiMembershipCount: expectedMembershipCount,
        semiMemberships: Array.from(
          { length: expectedMembershipCount },
          (_unused, index) => ({
            keyCount: 2,
            emissionCount: index < 3 ? 2 : 1,
          }),
        ),
      });
      expect(normalAttempt.statement.bindings?.length ?? 0).toBe(
        stepCount === 12 ? 32 : 30,
      );
      expect(selectedAttempt).toBeDefined();
      if (!selectedAttempt)
        throw new Error("journey_funnel_selected_attempt_missing");
      if (!selectedStatement)
        throw new Error("journey_funnel_selected_statement_missing");
      expect(selectedAttempt.accepted).toBe(true);
      expect(selectedStatement).toMatchObject({
        tag: targetTag,
        sql: selectedAttempt.statement.sql,
        bindings: selectedAttempt.statement.bindings ?? [],
      });
      expect(selectedSqlBytes).toBe(compilation.evidence.sqlBytes);
      expect(selectedSqlBytes).toBeLessThanOrEqual(100_000);
      expect(selectedSqlBytes).toBe(expectedSelectedSqlBytes);
      expect(sqlSha256(selectedStatement.sql)).toBe(expectedSelectedSqlSha256);
      expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
      expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
      if (stepCount === 10) {
        expect(budgetAttempts).toHaveLength(1);
        expect(normalAttempt.accepted).toBe(true);
        expect(selectedStatement?.sql).toBe(normalAttempt.statement.sql);
        expect(selectedSqlBytes).toBe(expectedSelectedSqlBytes);
        if (caseId === "same-scope-10") {
          expect(selectedSqlBytes).toBeLessThan(previousSqlBytes!);
          expect(normalAttempt.statement.physicalPlanShape).toMatchObject({
            version: 14,
            singletonRankFusionCount: 10,
            lexicographicComparisons: expect.arrayContaining([
              { direction: ">", componentCount: 4, emissionCount: 2 },
            ]),
          });
        }
        return;
      }

      if (normalAttempt.accepted) {
        expect(budgetAttempts).toHaveLength(1);
        expect(selectedStatement?.sql).toBe(normalAttempt.statement.sql);
        expect(selectedSqlBytes).toBe(normalSqlBytes);
        return;
      }

      expect(budgetAttempts).toHaveLength(2);
      expect(normalAttempt.rejection).toMatchObject({
        name: "D1StatementBudgetError",
        item: "sql_bytes",
        actual: normalSqlBytes,
        limit: 100_000,
      });
      const compactSql = compilation.evidence.sql;
      expect(compactSql).not.toMatch(/\bAS _c\d+\b/u);
      expect(compactSql).toMatch(/\bCAST\(/u);
      expect(compactSql).toMatch(/\bAS (?:INTEGER|REAL|TEXT)\)/u);
    },
  );

  it.each(["visitors", "sessions"] as const)(
    "keeps ordinary %s Funnel paging on the public legacy path",
    async (operation) => {
      const database = createMigratedDatabase();
      seedFixture(database);
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET,
      } as unknown as Env;
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      try {
        const first = await runtime.execute(
          operation,
          queryFor({ operation, funnel: { stepId: "step-0" } }) as never,
        );
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error("ordinary_funnel_first_page_failed");
        expect(first.data.pagination.nextCursor).toEqual(expect.any(String));
        const second = await runtime.execute(
          operation,
          queryFor({
            operation,
            funnel: { stepId: "step-0" },
            cursor: first.data.pagination.nextCursor,
          }) as never,
        );
        expect(second.ok).toBe(true);
        if (!second.ok) throw new Error("ordinary_funnel_next_page_failed");
        expect(second.data.pagination.returned).toBe(1);
        const calls = trace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trace.bindings[index] ?? [],
        }));
        expect(
          calls.some(({ sql }) => sql.includes('"analysis_definitions"')),
        ).toBe(true);
        writeEvidence(`ordinary-public-${operation}-two-pages.json`, {
          state: "actual-public-legacy-funnel-two-pages-sqlite",
          operation,
          nodeVersion: process.version,
          siteId: SITE_ID,
          first: first.data,
          second: second.data,
          calls,
        });
      } finally {
        database.close();
      }
    },
  );

  it.each(CROSS_SCOPE_CASES)(
    "uses the private native route for $countScope Count with $progressionScope Funnel on the $operation list",
    async ({ operation, countScope, progressionScope }) => {
      const database = createMigratedDatabase();
      seedFixture(database);
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, trace),
        MAIN_SECRET,
      } as unknown as Env;
      const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
      try {
        const request = queryFor({
          operation,
          funnel: { stepId: "step-1", outcome: "converted" },
          filterDsl: COUNT_FILTER_DSL,
          scopePreference: countScope,
        });
        const forwarded = await forwardedQuery(env, operation, request);
        expect(forwarded.scopePlan?.scope).toBe(countScope);
        expect(
          operation === "sessions"
            ? deferredSessionListQualificationFromQuery(forwarded)
            : deferredVisitorListQualificationFromQuery(forwarded),
        ).toBeDefined();
        expect(
          (forwarded.scopePlan as { readonly preparedMembership?: unknown })
            .preparedMembership,
        ).toBeUndefined();
        const nativeCallStart = trace.preparedSql.length;
        const result = await runtime.execute(operation, request as never);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("cross_scope_native_result_failed");
        const calls = trace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trace.bindings[index] ?? [],
        }));
        const nativeCalls = calls.slice(nativeCallStart);
        const funnelDefinitionLookups = nativeCalls.filter(({ sql }) =>
          sql.includes('"analysis_definitions"'),
        );
        const siteMetadataReads = nativeCalls.filter(({ sql }) =>
          sql.includes('"sites"'),
        );
        const factQueries = nativeCalls.filter(
          ({ sql }) =>
            !sql.includes('"analysis_definitions"') && !sql.includes('"sites"'),
        );
        writeEvidence(`public-cross-scope-native-${operation}.json`, {
          state: "actual-public-cross-scope-funnel-native-sqlite",
          operation,
          qualificationScope: forwarded.scopePlan?.scope,
          countScope,
          progressionScope,
          deferredQualification: true,
          scopePlanHasAdvancedMatches: false,
          funnelDefinitionLookups,
          siteMetadataReads,
          factQueries,
          result: result.data,
          nativeCalls,
        });
        expect(funnelDefinitionLookups).toHaveLength(1);
        expect(siteMetadataReads).toHaveLength(1);
        expect(factQueries).toHaveLength(1);
        expect(factQueries[0]?.sql).toContain('"rowKind"');
        expect(factQueries[0]?.sql).toContain('"outputId"');
      } finally {
        database.close();
      }
    },
  );

  it.each(CROSS_SCOPE_CASES)(
    "matches the legacy DTO for a compiled $countScope Count and $progressionScope Funnel on $operation",
    async ({ operation, countScope, progressionScope }) => {
      const queryTime = createQueryTime(BASE, END, "UTC", END);
      const filters = parseFilterDsl(COUNT_FILTER_DSL, analyticsFilterRegistry);
      const { count, native } = countInputFor(filters, queryTime, countScope);
      if (native.kind !== "supported")
        throw new Error("journey_funnel_cross_scope_native_split_missing");
      const config: FunnelConfigV2 = {
        ...twoStepFunnel,
        progressionScope,
        conversionWindowMs: progressionScope === "visitor" ? 60_000 : null,
      };
      const composition = buildDirectListComposition({
        operation,
        countInput: count,
        filters,
        queryTime,
        config,
      });
      const stepFilterRoots = new Set(
        config.steps.map((step) =>
          JSON.stringify(
            normalizeFilterDocument(
              parseFilterDsl(step.filterDsl, analyticsFilterRegistry),
              analyticsFilterRegistry,
            ).root,
          ),
        ),
      );
      const funnelSources = composition.plan.nodes.filter(
        (node) =>
          node.kind === "source" &&
          node.selection?.postObservationFilter !== undefined &&
          stepFilterRoots.has(
            JSON.stringify(
              normalizeFilterDocument(
                node.selection.postObservationFilter.filter,
                analyticsFilterRegistry,
              ).root,
            ),
          ),
      );
      const expectedNativeFilter = normalizeFilterDocument(
        native.filters,
        analyticsFilterRegistry,
      );
      expect(funnelSources).toHaveLength(3);
      expect(
        funnelSources.every(
          (node) =>
            node.kind === "source" &&
            JSON.stringify(node.selection?.filter) ===
              JSON.stringify(expectedNativeFilter),
        ),
      ).toBe(true);
      expect(
        logicalRelationReferenceCount(
          composition.plan.nodes,
          composition.qualification.matches.id,
        ),
      ).toBeGreaterThan(0);

      const compilation = compileQualificationProgramEnvelope({
        qualification: {
          plan: composition.plan,
          primaryReportSourceRelationId: composition.pages.id,
          controlsRelationId: composition.qualification.controls.id,
          groupedSummaryRelationId: composition.qualification.groupedSummary.id,
          controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
          numericCompatibilityFields:
            composition.qualification.numericCompatibilityFields,
          scope: composition.qualification.scope,
          reportSourceRelations: composition.reportSourceRelations,
        },
        siteId: SITE_ID,
        reports: [
          {
            output: composition.reportOutput,
            fields: composition.reportOutput.fields.map(({ name }) => name),
            rowType: `${operation}-list`,
          },
        ],
        controlsOutput: composition.controlsOutput,
        reportFields: composition.reportOutput.fields.map(({ name }) => name),
        controlFields: composition.controlsOutput.fields.map(
          ({ name }) => name,
        ),
        ordering: [
          {
            field: operation === "visitors" ? "visitorId" : "sessionId",
            direction: "asc",
            nulls: "last",
            outputId: composition.reportOutput.id,
          },
        ],
        errorPrefix: "journey_funnel_cross_scope",
        fallbackTag: `analytics.${operation}_list_qualification`,
      });
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled")
        throw new Error("journey_funnel_cross_scope_compile_unavailable");
      expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
      expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);

      const database = createMigratedDatabase();
      seedFixture(database);
      const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(database, legacyTrace),
        MAIN_SECRET,
      } as unknown as Env;
      try {
        const bindings = compilation.evidence.bindings.map((binding) =>
          typeof binding === "boolean" ? Number(binding) : binding,
        );
        const mainRows = database
          .prepare(compilation.evidence.sql)
          .all(...(bindings as never[])) as Record<string, unknown>[];
        const legacyRuntime = createD1SiteQueryRuntime({
          env,
          siteId: SITE_ID,
        });
        const legacyResult = await withLegacyJourneyListReader(operation, () =>
          legacyRuntime.execute(
            operation,
            queryFor({
              operation,
              funnel: { stepId: "step-1", outcome: "converted" },
              filterDsl: COUNT_FILTER_DSL,
              scopePreference: countScope,
            }) as never,
          ),
        );
        expect(legacyResult.ok).toBe(true);
        if (!legacyResult.ok)
          throw new Error("journey_funnel_cross_scope_legacy_failed");
        const mainReportRows = mainRows.filter(
          (row) =>
            row.rowKind === "report" &&
            row.outputId === composition.reportOutput.id,
        );
        const mainControlRows = mainRows.filter(
          (row) =>
            row.rowKind === "control" &&
            row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
        );
        const reportFields = composition.reportOutput.fields.map(
          ({ name }) => name,
        );
        const mainItems = mainReportRows.map((row) =>
          Object.fromEntries(reportFields.map((field) => [field, row[field]])),
        );
        const mappedItems =
          operation === "sessions"
            ? sessionListPageFromRecords(
                mainItems,
                20,
                DEFAULT_SESSION_LIST_SORT,
              ).rows
            : visitorListPageFromRecords(
                mainItems,
                20,
                DEFAULT_VISITOR_LIST_SORT,
              ).rows;
        const legacyData = legacyResult.data as {
          readonly items: readonly unknown[];
        } | null;
        expect(legacyData).not.toBeNull();
        if (!legacyData)
          throw new Error("journey_funnel_cross_scope_legacy_items_missing");
        expect(mainControlRows.length).toBeGreaterThan(0);
        expect(mappedItems).toEqual(legacyData.items);
        writeEvidence(`cross-scope-compiled-legacy-${operation}.json`, {
          state: "compiled-cross-scope-report-matches-legacy-sqlite",
          operation,
          legacyListParserStubbed: true,
          countScope,
          progressionScope,
          funnelConfig: config,
          countFilterDsl: COUNT_FILTER_DSL,
          nativeFilter: 'page.path eq "/allowed"',
          funnelStepSourcesRetainNativeFilter: true,
          sharedCountMatchReferences: logicalRelationReferenceCount(
            composition.plan.nodes,
            composition.qualification.matches.id,
          ),
          compiledStatement: {
            sql: compilation.evidence.sql,
            bindings: compilation.evidence.bindings,
            sqlBytes: compilation.evidence.sqlBytes,
            bindingCount: compilation.evidence.bindingCount,
            groupWidth: compilation.evidence.groupWidth,
            sharedRelationCount: compilation.evidence.sharedRelationCount,
          },
          logicalSummary: {
            nodeCount: composition.plan.nodes.length,
            edgeCount: composition.plan.nodes.reduce(
              (count, node) =>
                count +
                ("input" in node ? 1 : 0) +
                ("left" in node ? 1 : 0) +
                ("right" in node ? 1 : 0) +
                ("inputs" in node ? node.inputs.length : 0),
              0,
            ),
            maxOutputWidth: Math.max(
              ...composition.plan.nodes.map((node) => node.output.length),
            ),
          },
          mainRows,
          mainItems,
          mappedItems,
          legacyResult: legacyResult.data,
          legacyCalls: legacyTrace.preparedSql.map((sql, index) => ({
            sql,
            bindings: legacyTrace.bindings[index] ?? [],
          })),
        });
      } finally {
        database.close();
      }
    },
  );

  describe("private cross-scope Count/Funnel qualification", () => {
    it.each([
      {
        operation: "visitors",
        countScope: "session",
        outcome: "omitted",
      },
      {
        operation: "sessions",
        countScope: "visitor",
        outcome: "converted",
      },
    ] as const)(
      "keeps $countScope Count IDs separate from $operation Funnel list identities with outcome $outcome",
      async ({ operation, countScope, outcome }) => {
        const database = createMigratedDatabase();
        try {
          seedFixture(database);
          const fixture = seedPrivateCrossScopeCountFunnelFixture(
            database,
            operation,
          );
          const request = queryFor({
            operation,
            funnel: {
              stepId: "step-1",
              ...(outcome === "converted" ? { outcome } : {}),
            },
            filterDsl: COUNT_FILTER_DSL,
            scopePreference: countScope,
          });
          const countProducerTrace: SqliteD1Trace = {
            preparedSql: [],
            bindings: [],
          };
          const countProducerEnv = {
            DB: createSqliteD1Database(database, countProducerTrace),
            MAIN_SECRET,
          } as unknown as Env;
          const countForwarded = await withLegacyJourneyListReader(
            operation,
            () => forwardedQuery(countProducerEnv, operation, request),
          );
          const countPlan = countForwarded.scopePlan as {
            readonly preparedMembership?: {
              readonly entityIds?: readonly {
                readonly id: string;
                readonly siteId: string;
              }[];
            };
          };
          const countRows = preparedMembershipIdentities(
            countPlan.preparedMembership,
          ).entityIds;
          expect(countRows).toBeDefined();
          if (!countRows)
            throw new Error("journey_funnel_legacy_count_ids_missing");
          expect(countRows.every(({ siteId }) => siteId === SITE_ID)).toBe(
            true,
          );
          const countEntityIds = countRows.map(({ id }) => id).sort();
          expect(countEntityIds).toEqual(fixture.expectedCountIds);
          expect(
            fixture.noCountIds.every((id) => !countEntityIds.includes(id)),
          ).toBe(true);
          expect(
            fixture.noNativeIds.every((id) => !countEntityIds.includes(id)),
          ).toBe(true);
          expect(
            fixture.expectedCountIds.some((id) =>
              fixture.expectedReportIds.includes(id),
            ),
          ).toBe(false);

          const legacyReaderTrace: SqliteD1Trace = {
            preparedSql: [],
            bindings: [],
          };
          const legacyEnv = {
            DB: createSqliteD1Database(database, legacyReaderTrace),
            MAIN_SECRET,
          } as unknown as Env;
          const legacyFirst = await legacyListPageWithCountMatches({
            env: legacyEnv,
            operation,
            request,
            countEntityIds,
            cursor: null,
          });
          const legacySecond = await legacyListPageWithCountMatches({
            env: legacyEnv,
            operation,
            request,
            countEntityIds,
            cursor: legacyFirst.pagination.nextCursor,
          });

          const nativeTrace: SqliteD1Trace = {
            preparedSql: [],
            bindings: [],
          };
          const nativeEnv = {
            DB: createSqliteD1Database(database, nativeTrace),
            MAIN_SECRET,
          } as unknown as Env;
          const nativeForwarded = await forwardedQuery(
            nativeEnv,
            operation,
            request,
          );
          const deferred =
            operation === "visitors"
              ? deferredVisitorListQualificationFromQuery(nativeForwarded)
              : deferredSessionListQualificationFromQuery(nativeForwarded);
          expect(deferred).toBeDefined();
          expect(nativeForwarded.scopePlan?.scope).toBe(countScope);
          expect(
            (
              nativeForwarded.scopePlan as {
                readonly preparedMembership?: unknown;
              }
            ).preparedMembership,
          ).toBeUndefined();
          const configuration =
            operation === "visitors"
              ? visitorListQualificationConfigurationFromQuery(nativeForwarded)
              : sessionListQualificationConfigurationFromQuery(
                  nativeForwarded,
                  "sessions",
                );
          expect(configuration?.analysisContext).toEqual({
            type: "funnel",
            funnelId: `funnel-${operation === "visitors" ? "visitor" : "session"}`,
            stepId: "step-1",
            ...(outcome === "converted" ? { outcome } : {}),
          });

          const runtime = createD1SiteQueryRuntime({
            env: nativeEnv,
            siteId: SITE_ID,
          });
          const nativeCallStart = nativeTrace.preparedSql.length;
          const first = await runtime.execute(operation, request as never);
          expect(first.ok).toBe(true);
          if (!first.ok)
            throw new Error("journey_funnel_cross_scope_first_page_failed");
          expect(first.data.pagination.hasMore).toBe(true);
          expect(first.data.pagination.nextCursor).toBe(
            legacyFirst.pagination.nextCursor,
          );

          const second = await runtime.execute(
            operation,
            queryFor({
              operation,
              funnel: {
                stepId: "step-1",
                ...(outcome === "converted" ? { outcome } : {}),
              },
              filterDsl: COUNT_FILTER_DSL,
              scopePreference: countScope,
              cursor: legacyFirst.pagination.nextCursor,
            }) as never,
          );
          expect(second.ok).toBe(true);
          if (!second.ok)
            throw new Error("journey_funnel_cross_scope_second_page_failed");

          const identity = operation === "visitors" ? "visitorId" : "sessionId";
          const listIdentity = (items: readonly unknown[]) =>
            items.map((item) => (item as Record<string, unknown>)[identity]);
          const reportEntityIds = [
            ...listIdentity(first.data.items),
            ...listIdentity(second.data.items),
          ] as string[];
          const sortValueField =
            operation === "visitors" ? "lastSeenAt" : "startedAt";
          const sortValues = [...first.data.items, ...second.data.items].map(
            (item) =>
              (item as unknown as Record<string, unknown>)[sortValueField],
          );

          const nativeCalls = nativeTrace.preparedSql
            .slice(nativeCallStart)
            .map((sql, relativeIndex) => ({
              sql,
              bindings:
                nativeTrace.bindings[nativeCallStart + relativeIndex] ?? [],
            }));
          const definitionReads = nativeCalls.filter(({ sql }) =>
            sql.includes('"analysis_definitions"'),
          );
          const siteMetadataReads = nativeCalls.filter(({ sql }) =>
            sql.includes('"sites"'),
          );
          const factQueries = nativeCalls.filter(
            ({ sql }) =>
              !sql.includes('"analysis_definitions"') &&
              !sql.includes('"sites"'),
          );
          writeEvidence(
            `private-cross-scope-count-funnel-${operation}-${outcome}-two-pages.json`,
            {
              state: "private-cross-scope-count-funnel-native-sqlite",
              operation,
              countScope,
              progressionScope:
                operation === "visitors" ? "visitor" : "session",
              outcome,
              countEntityIds,
              expectedReportIds: fixture.expectedReportIds,
              actualReportIds: reportEntityIds,
              noCountIds: fixture.noCountIds,
              noNativeIds: fixture.noNativeIds,
              deferredQualification: true,
              scopePlanHasAdvancedMatches: false,
              oldCountProducer: countProducerTrace.preparedSql.map(
                (sql, index) => ({
                  sql,
                  bindings: countProducerTrace.bindings[index] ?? [],
                  sqlBytes: new TextEncoder().encode(sql).byteLength,
                }),
              ),
              legacyListReader: legacyReaderTrace.preparedSql.map(
                (sql, index) => ({
                  sql,
                  bindings: legacyReaderTrace.bindings[index] ?? [],
                }),
              ),
              first: { actual: first.data, legacy: legacyFirst },
              second: { actual: second.data, legacy: legacySecond },
              metadataDefinitionReads: definitionReads,
              siteMetadataReads,
              qualificationEnvelopeFactQueries: factQueries.map(
                ({ sql, bindings }) => ({
                  sql,
                  bindings,
                  sqlBytes: new TextEncoder().encode(sql).byteLength,
                  bindingCount: bindings.length,
                  hasRowKind: sql.includes('"rowKind"'),
                  hasOutputId: sql.includes('"outputId"'),
                }),
              ),
            },
          );
          expect(second.data.pagination.hasMore).toBe(false);
          expect(second.data.items).toEqual(legacySecond.items);
          expect(first.data.items).toEqual(legacyFirst.items);
          expect(reportEntityIds).toEqual(fixture.expectedReportIds);
          expect(new Set(reportEntityIds).size).toBe(reportEntityIds.length);
          expect(sortValues.every((value) => typeof value === "number")).toBe(
            true,
          );
          expect(new Set(sortValues).size).toBe(1);
          expect(definitionReads).toHaveLength(2);
          expect(siteMetadataReads).toHaveLength(2);
          expect(factQueries).toHaveLength(2);
          expect(
            factQueries.every(
              ({ sql }) =>
                sql.includes('"rowKind"') && sql.includes('"outputId"'),
            ),
          ).toBe(true);
          expect(
            factQueries.every(
              ({ sql, bindings }) =>
                new TextEncoder().encode(sql).byteLength <=
                  d1Budget.D1_MAX_SQL_UTF8_BYTES &&
                bindings.length <= d1Budget.D1_MAX_BOUND_PARAMETERS,
            ),
          ).toBe(true);
        } finally {
          database.close();
        }
      },
      30_000,
    );
  });

  describe("private Count/Funnel qualification", () => {
    it.each([
      { operation: "visitors", scope: "session" },
      { operation: "visitors", scope: "visitor" },
      { operation: "sessions", scope: "session" },
      { operation: "sessions", scope: "visitor" },
    ] as const)(
      "binds the resolved Funnel stages to one $scope relation for $operation after numeric fallback",
      async ({ operation, scope }) => {
        const database = createMigratedDatabase();
        const bridge = vi.spyOn(
          preparedMembershipModule,
          "registerPreparedMembership",
        );
        let oldRoute = vi
          .spyOn(
            eventMembershipFallbackModule,
            "prepareEventMembershipFallback",
          )
          .mockResolvedValue(undefined);
        try {
          seedFixture(database);
          seedPrivateCountFunnelFixture(database, operation);
          database.prepare("UPDATE visits SET duration_ms = 10").run();
          database
            .prepare(
              "UPDATE visits SET duration_ms = ? WHERE rowid = (SELECT MIN(rowid) FROM visits)",
            )
            .run("invalid-duration");
          const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
          const env = {
            DB: createSqliteD1Database(database, trace),
            MAIN_SECRET,
          } as unknown as Env;
          const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
          const request = queryFor({
            operation,
            funnel: { stepId: "step-1" },
            filterDsl: "count(page { page.durationMs gt 5 }) gte 1",
            scopePreference: scope,
          });
          const before = await runtime.execute(operation, request as never);
          expect(before.ok, JSON.stringify(before)).toBe(true);
          expect(bridge).toHaveBeenCalledTimes(1);
          oldRoute.mockRestore();
          bridge.mockClear();
          const after = await runtime.execute(operation, request as never, {
            onProviderError(error) {
              throw error;
            },
          });
          expect(after).toEqual(before);
          expect(bridge).not.toHaveBeenCalled();
          if (!before.ok || !after.ok)
            throw new Error("analysis_relation_fallback_failed");
          expect(after.data.items.length).toBeGreaterThan(0);
          expect(after.data.pagination.hasMore).toBe(true);
          const next = {
            ...request,
            page: {
              ...request.page,
              cursor: before.data.pagination.nextCursor,
            },
          };
          const afterNext = await runtime.execute(operation, next as never, {
            onProviderError(error) {
              throw error;
            },
          });
          expect(bridge).not.toHaveBeenCalled();
          oldRoute = vi
            .spyOn(
              eventMembershipFallbackModule,
              "prepareEventMembershipFallback",
            )
            .mockResolvedValue(undefined);
          const beforeNext = await runtime.execute(operation, next as never);
          expect(afterNext).toEqual(beforeNext);
        } finally {
          oldRoute.mockRestore();
          bridge.mockRestore();
          database.close();
        }
      },
      30_000,
    );

    it.each([
      { operation: "visitors", outcome: "omitted" },
      { operation: "visitors", outcome: "converted" },
      { operation: "sessions", outcome: "omitted" },
      { operation: "sessions", outcome: "converted" },
    ] as const)(
      "uses converted Funnel membership for $operation when outcome is $outcome and continues a legacy cursor",
      async ({ operation, outcome }) => {
        const database = createMigratedDatabase();
        seedFixture(database);
        const countEntityIds = seedPrivateCountFunnelFixture(
          database,
          operation,
        );
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const env = {
          DB: createSqliteD1Database(database, trace),
          MAIN_SECRET,
        } as unknown as Env;
        const scopePreference =
          operation === "visitors" ? "visitor" : "session";
        const legacyCountEntityIds = [
          ...countEntityIds,
          operation === "visitors" ? "visitor-risk" : "risk-session-allowed",
        ];
        const request = queryFor({
          operation,
          funnel: {
            stepId: "step-1",
            ...(outcome === "converted" ? { outcome } : {}),
          },
          filterDsl: COUNT_FILTER_DSL,
          scopePreference,
        });
        const runtime = createD1SiteQueryRuntime({ env, siteId: SITE_ID });
        try {
          const forwarded = await forwardedQuery(env, operation, request);
          const deferred =
            operation === "visitors"
              ? deferredVisitorListQualificationFromQuery(forwarded)
              : deferredSessionListQualificationFromQuery(forwarded);
          expect(deferred).toBeDefined();
          const configuration =
            operation === "visitors"
              ? visitorListQualificationConfigurationFromQuery(forwarded)
              : sessionListQualificationConfigurationFromQuery(
                  forwarded,
                  "sessions",
                );
          expect(configuration?.analysisContext).toEqual({
            type: "funnel",
            funnelId:
              operation === "visitors" ? "funnel-visitor" : "funnel-session",
            stepId: "step-1",
            ...(outcome === "converted" ? { outcome } : {}),
          });
          expect(
            (forwarded.scopePlan as { readonly preparedMembership?: unknown })
              .preparedMembership,
          ).toBeUndefined();
          const nativeCallStart = trace.preparedSql.length;

          const first = await runtime.execute(operation, request as never);
          expect(first.ok).toBe(true);
          if (!first.ok)
            throw new Error("private_count_funnel_first_page_failed");

          const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
          const legacyEnv = {
            DB: createSqliteD1Database(database, legacyTrace),
            MAIN_SECRET,
          } as unknown as Env;
          const legacyFirst = await legacyListPageWithCountMatches({
            env: legacyEnv,
            operation,
            request,
            countEntityIds: legacyCountEntityIds,
            cursor: null,
          });
          expect(first.data.items).toEqual(legacyFirst.items);
          expect(first.data.pagination.nextCursor).toBe(
            legacyFirst.pagination.nextCursor,
          );
          expect(first.data.pagination.hasMore).toBe(true);

          const legacySecond = await legacyListPageWithCountMatches({
            env: legacyEnv,
            operation,
            request,
            countEntityIds: legacyCountEntityIds,
            cursor: legacyFirst.pagination.nextCursor,
          });
          const second = await runtime.execute(
            operation,
            queryFor({
              operation,
              funnel: {
                stepId: "step-1",
                ...(outcome === "converted" ? { outcome } : {}),
              },
              filterDsl: COUNT_FILTER_DSL,
              scopePreference,
              cursor: legacyFirst.pagination.nextCursor,
            }) as never,
          );
          expect(second.ok).toBe(true);
          if (!second.ok)
            throw new Error("private_count_funnel_legacy_cursor_failed");
          expect(second.data.items).toEqual(legacySecond.items);
          expect(second.data.pagination.hasMore).toBe(false);

          const identity = operation === "visitors" ? "visitorId" : "sessionId";
          const listIdentity = (items: readonly unknown[]) =>
            items.map((item) => (item as Record<string, unknown>)[identity]);
          expect([
            ...listIdentity(first.data.items),
            ...listIdentity(second.data.items),
          ]).toEqual(countEntityIds);
          expect(
            new Set([
              ...listIdentity(first.data.items),
              ...listIdentity(second.data.items),
            ]).size,
          ).toBe(countEntityIds.length);

          const nativeCalls = trace.preparedSql
            .slice(nativeCallStart)
            .map((sql, relativeIndex) => ({
              sql,
              bindings: trace.bindings[nativeCallStart + relativeIndex] ?? [],
            }));
          const funnelDefinitionLookups = nativeCalls.filter(({ sql }) =>
            sql.includes('"analysis_definitions"'),
          );
          expect(funnelDefinitionLookups).toHaveLength(2);
          const composedCountQueries = nativeCalls.filter(
            ({ sql }) =>
              sql.includes('"visits"') && sql.includes('"custom_events"'),
          );
          expect(composedCountQueries).toHaveLength(2);
          expect(
            composedCountQueries.every(
              ({ sql, bindings }) =>
                new TextEncoder().encode(sql).byteLength <=
                  d1Budget.D1_MAX_SQL_UTF8_BYTES &&
                bindings.length <= d1Budget.D1_MAX_BOUND_PARAMETERS,
            ),
          ).toBe(true);
          writeEvidence(
            `private-count-funnel-${operation}-${outcome}-two-pages.json`,
            {
              state: "actual-private-count-funnel-converted-sqlite",
              operation,
              outcome,
              countEntityIds,
              legacyCountEntityIds,
              deferredQualification: true,
              scopePlanHasAdvancedMatches: false,
              first: first.data,
              legacySecondCursor: legacyFirst.pagination.nextCursor,
              second: second.data,
              funnelDefinitionLookups,
              composedCountQueries,
            },
          );
        } finally {
          database.close();
        }
      },
      30_000,
    );

    describe("private Count/Funnel dropoff qualification", () => {
      async function prepareDropoffCase({
        operation,
        countScope,
        progressionScope,
      }: (typeof DROPOFF_CASES)[number]) {
        const database = createMigratedDatabase();
        try {
          seedFixture(database);
          const fixture = seedPrivateCountFunnelDropoffFixture(
            database,
            operation,
            countScope,
          );
          const identity = operation === "visitors" ? "visitorId" : "sessionId";
          const sortField =
            operation === "visitors" ? "lastSeenAt" : "startedAt";
          const makeRequest = (
            stepId: "dropoff-step-0" | "dropoff-step-1" | "dropoff-step-2",
            pageLimit: number,
            cursor: string | null = null,
          ) =>
            queryFor({
              operation,
              funnel: { stepId, outcome: "dropoff" },
              filterDsl: COUNT_FILTER_DSL,
              scopePreference: countScope,
              pageLimit,
              cursor,
            });
          const middleRequest = makeRequest("dropoff-step-1", 1);

          const countProducerTrace: SqliteD1Trace = {
            preparedSql: [],
            bindings: [],
          };
          const countProducerEnv = {
            DB: createSqliteD1Database(database, countProducerTrace),
            MAIN_SECRET,
          } as unknown as Env;
          const countForwarded = await withLegacyJourneyListReader(
            operation,
            () => forwardedQuery(countProducerEnv, operation, middleRequest),
          );
          const countRows = preparedMembershipIdentities(
            (countForwarded.scopePlan as ScopedFilterPlan).preparedMembership,
          ).entityIds;
          expect(countRows).toBeDefined();
          if (!countRows) throw new Error("dropoff_legacy_count_ids_missing");
          expect(countRows.every(({ siteId }) => siteId === SITE_ID)).toBe(
            true,
          );
          const countEntityIds = countRows.map(({ id }) => id).sort();
          expect(countEntityIds).toEqual(fixture.expectedCountIds);
          expect(
            fixture.noCountEntityIds.every(
              (id) => !countEntityIds.includes(id),
            ),
          ).toBe(true);
          expect(
            fixture.noNativeEntityIds.every(
              (id) => !countEntityIds.includes(id),
            ),
          ).toBe(true);
          expect(
            fixture.noPreviousEntityIds.every((id) =>
              countEntityIds.includes(id),
            ),
          ).toBe(true);
          if (fixture.uncountedConversionSessionId) {
            const uncountedConversionSessionId =
              fixture.uncountedConversionSessionId;
            const uncountedConversionVisitorId =
              fixture.uncountedConversionVisitorId;
            const countQualifiedStep0SessionId =
              fixture.countQualifiedStep0SessionId;
            if (!uncountedConversionVisitorId || !countQualifiedStep0SessionId)
              throw new Error("dropoff_counterexample_fixture_incomplete");
            expect(countEntityIds).not.toContain(uncountedConversionSessionId);
            expect(fixture.middleDropoffIds).toContain(
              uncountedConversionVisitorId,
            );
            const counterexampleEvents = database
              .prepare(
                `SELECT visits.session_id, custom_event_names.name
                   FROM custom_events
                   JOIN visits
                     ON visits.visit_id = custom_events.visit_id
                   JOIN custom_event_names
                     ON custom_event_names.id = custom_events.event_name_id
                   WHERE custom_events.site_id = ?
                     AND visits.visitor_id = ?
                     AND custom_event_names.name IN ('dropoff-start', 'dropoff-middle')
                   ORDER BY custom_event_names.name, visits.session_id`,
              )
              .all(
                SITE_ID,
                uncountedConversionVisitorId,
              ) as unknown as readonly {
              readonly session_id: string;
              readonly name: string;
            }[];
            expect(counterexampleEvents).toEqual([
              {
                session_id: uncountedConversionSessionId,
                name: "dropoff-middle",
              },
              {
                session_id: countQualifiedStep0SessionId,
                name: "dropoff-start",
              },
            ]);
            expect(countEntityIds).toContain(countQualifiedStep0SessionId);
          }
          if (countScope !== progressionScope)
            expect(
              fixture.middleDropoffIds.every(
                (id) => !countEntityIds.includes(id),
              ),
            ).toBe(true);

          const legacyReaderTrace: SqliteD1Trace = {
            preparedSql: [],
            bindings: [],
          };
          const legacyEnv = {
            DB: createSqliteD1Database(database, legacyReaderTrace),
            MAIN_SECRET,
          } as unknown as Env;
          const nativeTrace: SqliteD1Trace = {
            preparedSql: [],
            bindings: [],
          };
          const nativeEnv = {
            DB: createSqliteD1Database(database, nativeTrace),
            MAIN_SECRET,
          } as unknown as Env;
          const runtime = createD1SiteQueryRuntime({
            env: nativeEnv,
            siteId: SITE_ID,
          });
          const readConfiguration = (value: unknown) =>
            operation === "visitors"
              ? visitorListQualificationConfigurationFromQuery(value)
              : sessionListQualificationConfigurationFromQuery(
                  value,
                  "sessions",
                );
          const nativeEvidence: {
            readonly metadataDefinitionReads: number;
            readonly siteMetadataReads: number;
            readonly factQueries: readonly {
              readonly sql: string;
              readonly bindings: readonly unknown[];
              readonly sqlBytes: number;
              readonly bindingCount: number;
              readonly hasRowKind: boolean;
              readonly hasOutputId: boolean;
            }[];
          }[] = [];
          const runNative = async (
            request: CanonicalQuery<"visitors"> | CanonicalQuery<"sessions">,
          ) => {
            const forwarded = await forwardedQuery(
              nativeEnv,
              operation,
              request,
            );
            const deferred =
              operation === "visitors"
                ? deferredVisitorListQualificationFromQuery(forwarded)
                : deferredSessionListQualificationFromQuery(forwarded);
            expect(deferred).toBeDefined();
            expect(
              (forwarded.scopePlan as { readonly scope?: unknown }).scope,
            ).toBe(countScope);
            expect(
              (
                forwarded.scopePlan as {
                  readonly preparedMembership?: unknown;
                }
              ).preparedMembership,
            ).toBeUndefined();
            expect(readConfiguration(forwarded)?.analysisContext).toEqual(
              request.analysisContext,
            );

            const callStart = nativeTrace.preparedSql.length;
            const result = await runtime.execute(operation, request as never);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("dropoff_native_request_failed");
            const calls = nativeTrace.preparedSql
              .slice(callStart)
              .map((sql, index) => ({
                sql,
                bindings: nativeTrace.bindings[callStart + index] ?? [],
              }));
            const definitionReads = calls.filter(({ sql }) =>
              sql.includes('"analysis_definitions"'),
            );
            const siteMetadataReads = calls.filter(({ sql }) =>
              sql.includes('"sites"'),
            );
            const factQueries = calls.filter(
              ({ sql }) =>
                !sql.includes('"analysis_definitions"') &&
                !sql.includes('"sites"'),
            );
            expect(definitionReads).toHaveLength(1);
            expect(siteMetadataReads).toHaveLength(1);
            expect(factQueries).toHaveLength(1);
            expect(
              factQueries.every(
                ({ sql, bindings }) =>
                  sql.includes('"rowKind"') &&
                  sql.includes('"outputId"') &&
                  new TextEncoder().encode(sql).byteLength <=
                    d1Budget.D1_MAX_SQL_UTF8_BYTES &&
                  bindings.length <= d1Budget.D1_MAX_BOUND_PARAMETERS,
              ),
            ).toBe(true);
            const evidence = {
              metadataDefinitionReads: definitionReads.length,
              siteMetadataReads: siteMetadataReads.length,
              factQueries: factQueries.map(({ sql, bindings }) => ({
                sql,
                bindings,
                sqlBytes: new TextEncoder().encode(sql).byteLength,
                bindingCount: bindings.length,
                hasRowKind: sql.includes('"rowKind"'),
                hasOutputId: sql.includes('"outputId"'),
              })),
            };
            nativeEvidence.push(evidence);
            return { data: result.data, forwarded, evidence };
          };

          const middleContext = {
            type: "funnel" as const,
            funnelId:
              operation === "visitors" ? "funnel-visitor" : "funnel-session",
            stepId: "dropoff-step-1",
          };
          const parserProbe = {
            ...(await forwardedQuery(nativeEnv, operation, middleRequest)),
            analysisContext: middleContext,
          };
          const omittedOutcome = readConfiguration(parserProbe);
          expect(omittedOutcome?.analysisContext).toEqual(middleContext);
          expect(
            Object.hasOwn(omittedOutcome?.analysisContext ?? {}, "outcome"),
          ).toBe(false);
          const convertedOutcome = readConfiguration({
            ...parserProbe,
            analysisContext: { ...middleContext, outcome: "converted" },
          });
          expect(convertedOutcome?.analysisContext).toEqual({
            ...middleContext,
            outcome: "converted",
          });
          const dropoffOutcome = readConfiguration({
            ...parserProbe,
            analysisContext: { ...middleContext, outcome: "dropoff" },
          });
          expect(dropoffOutcome?.analysisContext).toEqual({
            ...middleContext,
            outcome: "dropoff",
          });
          expect(
            readConfiguration({
              ...parserProbe,
              analysisContext: { ...middleContext, outcome: "unknown" },
            }),
          ).toBeUndefined();

          return {
            database,
            fixture,
            identity,
            sortField,
            makeRequest,
            middleRequest,
            countEntityIds,
            legacyEnv,
            runNative,
            countProducerTrace,
            legacyReaderTrace,
            nativeEvidence,
          };
        } catch (error) {
          database.close();
          throw error;
        }
      }
      const DROPOFF_STAGES = [
        "middle-two-pages",
        "last-step",
        "first-step",
      ] as const;
      it.each(
        DROPOFF_CASES.flatMap((testCase) =>
          DROPOFF_STAGES.map((stage) => ({ ...testCase, stage })),
        ),
      )(
        "matches selected-step dropoff $stage for $operation with $countScope Count",
        async (testCase) => {
          const { operation, countScope, progressionScope, stage } = testCase;
          const {
            database,
            fixture,
            identity,
            sortField,
            makeRequest,
            middleRequest,
            countEntityIds,
            legacyEnv,
            runNative,
            countProducerTrace,
            legacyReaderTrace,
            nativeEvidence,
          } = await prepareDropoffCase(testCase);
          try {
            let stageEvidence: Record<string, unknown>;
            if (stage === "middle-two-pages") {
              const middleLegacyFirst = await legacyListPageWithCountMatches({
                env: legacyEnv,
                operation,
                request: middleRequest,
                countEntityIds,
                cursor: null,
              });
              const middleLegacySecond = await legacyListPageWithCountMatches({
                env: legacyEnv,
                operation,
                request: middleRequest,
                countEntityIds,
                cursor: middleLegacyFirst.pagination.nextCursor,
              });
              const middleNativeFirst = await runNative(middleRequest);
              const middleNativeSecond = await runNative(
                makeRequest(
                  "dropoff-step-1",
                  1,
                  middleLegacyFirst.pagination.nextCursor,
                ) as CanonicalQuery<"visitors"> | CanonicalQuery<"sessions">,
              );
              expect(middleNativeFirst.data).toEqual(middleLegacyFirst);
              expect(middleNativeSecond.data).toEqual(middleLegacySecond);
              expect(middleNativeFirst.data.pagination.hasMore).toBe(true);
              expect(middleNativeFirst.data.pagination.nextCursor).toBe(
                middleLegacyFirst.pagination.nextCursor,
              );
              expect(middleNativeSecond.data.pagination.hasMore).toBe(false);
              const middleItems = [
                ...middleNativeFirst.data.items,
                ...middleNativeSecond.data.items,
              ];
              const middleReportIds = middleItems.map(
                (item) =>
                  (item as unknown as Record<string, unknown>)[
                    identity
                  ] as string,
              );
              expect([...middleReportIds].sort()).toEqual(
                [...fixture.middleDropoffIds].sort(),
              );
              expect(new Set(middleReportIds).size).toBe(
                fixture.middleDropoffIds.length,
              );
              const tieValues = middleItems.map(
                (item) =>
                  (item as unknown as Record<string, unknown>)[sortField],
              );
              expect(new Set(tieValues).size).toBe(1);

              stageEvidence = {
                middle: {
                  expectedReportIds: fixture.middleDropoffIds,
                  actualReportIds: middleReportIds,
                  first: {
                    actual: middleNativeFirst.data,
                    legacy: middleLegacyFirst,
                    factQueries: middleNativeFirst.evidence,
                  },
                  second: {
                    actual: middleNativeSecond.data,
                    legacy: middleLegacySecond,
                    factQueries: middleNativeSecond.evidence,
                  },
                  stableSortTie: tieValues,
                },
              };
            } else if (stage === "last-step") {
              const lastRequest = makeRequest("dropoff-step-2", 10);
              const lastLegacy = await legacyListPageWithCountMatches({
                env: legacyEnv,
                operation,
                request: lastRequest,
                countEntityIds,
                cursor: null,
                limit: 10,
              });
              const lastNative = await runNative(lastRequest);
              expect(lastNative.data).toEqual(lastLegacy);
              const lastReportIds = lastNative.data.items.map(
                (item) =>
                  (item as unknown as Record<string, unknown>)[
                    identity
                  ] as string,
              );
              expect([...lastReportIds].sort()).toEqual(
                [...fixture.lastDropoffIds].sort(),
              );
              expect(lastNative.data.pagination.hasMore).toBe(false);
              expect(lastNative.data.pagination.nextCursor).toBeNull();
              expect(
                fixture.middleDropoffIds.every(
                  (id) => !lastReportIds.includes(id),
                ),
              ).toBe(true);
              expect(
                fixture.reachedSelectedIds.every(
                  (id) => !fixture.middleDropoffIds.includes(id),
                ),
              ).toBe(true);

              stageEvidence = {
                last: {
                  expectedReportIds: fixture.lastDropoffIds,
                  actualReportIds: lastReportIds,
                  actual: lastNative.data,
                  legacy: lastLegacy,
                  factQueries: lastNative.evidence,
                },
              };
            } else {
              const firstRequest = makeRequest("dropoff-step-0", 10);
              const firstLegacy = await legacyListPageWithCountMatches({
                env: legacyEnv,
                operation,
                request: firstRequest,
                countEntityIds,
                cursor: null,
                limit: 10,
              });
              const firstNative = await runNative(firstRequest);
              expect(firstNative.data).toEqual(firstLegacy);
              expect(firstNative.data.items).toEqual([]);
              expect(firstNative.data.pagination.hasMore).toBe(false);
              expect(firstNative.data.pagination.nextCursor).toBeNull();

              stageEvidence = {
                firstStep: {
                  actual: firstNative.data,
                  legacy: firstLegacy,
                  factQueries: firstNative.evidence,
                },
              };
            }
            const oldCountProducerCalls = countProducerTrace.preparedSql.map(
              (sql, index) => ({
                sql,
                bindings: countProducerTrace.bindings[index] ?? [],
              }),
            );
            const oldListReaderCalls = legacyReaderTrace.preparedSql.map(
              (sql, index) => ({
                sql,
                bindings: legacyReaderTrace.bindings[index] ?? [],
              }),
            );
            writeEvidence(
              `private-count-funnel-dropoff-${operation}-${countScope}-${stage}.json`,
              {
                state:
                  "actual-private-count-funnel-dropoff-native-sqlite-partitioned",
                stage,
                operation,
                countScope,
                progressionScope,
                funnelStepIds: [
                  "dropoff-step-0",
                  "dropoff-step-1",
                  "dropoff-step-2",
                ],
                countEntityIds,
                expectedCountIds: fixture.expectedCountIds,
                ...stageEvidence,
                controls: {
                  noCountReportIds: fixture.noCountIds,
                  noCountEntityIds: fixture.noCountEntityIds,
                  noNativeReportIds: fixture.noNativeIds,
                  noNativeEntityIds: fixture.noNativeEntityIds,
                  noPreviousReportIds: fixture.noPreviousIds,
                  noPreviousEntityIds: fixture.noPreviousEntityIds,
                  reachedSelectedIds: fixture.reachedSelectedIds,
                  countQualifiedStep0SessionId:
                    fixture.countQualifiedStep0SessionId,
                  uncountedConversionSessionId:
                    fixture.uncountedConversionSessionId,
                  uncountedConversionVisitorId:
                    fixture.uncountedConversionVisitorId,
                },
                oldCountProducerCalls,
                oldListReaderCalls,
                nativeEvidence,
              },
            );
          } finally {
            database.close();
          }
        },
        30_000,
      );
    });
  });

  it.each(["visitors", "sessions"] as const)(
    "executes the budgeted native-filtered %s two-step graph on SQLite",
    async (operation) => {
      const queryTime = createQueryTime(BASE, END, "UTC", END);
      const filters = parseFilterDsl(COUNT_FILTER_DSL, analyticsFilterRegistry);
      const countScope = operation === "visitors" ? "visitor" : "session";
      const { count, native } = countInputFor(filters, queryTime, countScope);
      if (native.kind !== "supported")
        throw new Error("journey_funnel_native_split_missing");
      const config = {
        ...twoStepFunnel,
        progressionScope: operation === "visitors" ? "visitor" : "session",
        conversionWindowMs: operation === "visitors" ? 60_000 : null,
      } as const;
      const composition = buildDirectListComposition({
        operation,
        countInput: count,
        filters,
        queryTime,
        config,
      });
      const sourceNodes = composition.plan.nodes.filter(
        (node) => node.kind === "source",
      );
      const funnelStepFilterRoots = new Set(
        config.steps.map((step) =>
          JSON.stringify(
            normalizeFilterDocument(
              parseFilterDsl(step.filterDsl, analyticsFilterRegistry),
              analyticsFilterRegistry,
            ).root,
          ),
        ),
      );
      const funnelSourceNodes = sourceNodes.filter(
        (node) =>
          node.kind === "source" &&
          node.selection?.postObservationFilter !== undefined &&
          funnelStepFilterRoots.has(
            JSON.stringify(
              normalizeFilterDocument(
                node.selection.postObservationFilter.filter,
                analyticsFilterRegistry,
              ).root,
            ),
          ),
      );
      const expectedNativeFilter = normalizeFilterDocument(
        native.filters,
        analyticsFilterRegistry,
      );
      expect(funnelSourceNodes).toHaveLength(3);
      const sameNativeFilterOnEveryFunnelSource = funnelSourceNodes.every(
        (node) =>
          node.kind !== "source" ||
          JSON.stringify(node.selection?.filter) ===
            JSON.stringify(expectedNativeFilter),
      );
      expect(sameNativeFilterOnEveryFunnelSource).toBe(true);
      const countMatchReferenceCount = logicalRelationReferenceCount(
        composition.plan.nodes,
        composition.qualification.matches.id,
      );
      expect(countMatchReferenceCount).toBeGreaterThan(0);

      const statements: DatabaseStatement[] = [];
      const genericGraphs: unknown[] = [];
      const physicalGraphs: unknown[] = [];
      const originalAssert = d1Budget.assertD1StatementBudget;
      const originalLower = db.lowerLogicalPlan as (input: unknown) => unknown;
      const originalCompile = db.compileD1Query as (
        input: unknown,
        options?: unknown,
      ) => unknown;
      const budgetSpy = vi
        .spyOn(d1Budget, "assertD1StatementBudget")
        .mockImplementation((statement) => {
          statements.push({ ...statement });
          return originalAssert(statement);
        });
      const lowerSpy = vi.spyOn(db, "lowerLogicalPlan").mockImplementation(((
        input: unknown,
      ) => {
        genericGraphs.push(input);
        return originalLower(input);
      }) as typeof db.lowerLogicalPlan);
      const compileSpy = vi.spyOn(db, "compileD1Query").mockImplementation(((
        input: unknown,
        options?: unknown,
      ) => {
        physicalGraphs.push(input);
        return originalCompile(input, options);
      }) as typeof db.compileD1Query);
      try {
        const reportFields = composition.reportOutput.fields.map(
          ({ name }) => name,
        );
        const controlFields = composition.controlsOutput.fields.map(
          ({ name }) => name,
        );
        let compilation: ReturnType<typeof compileQualificationProgramEnvelope>;
        try {
          compilation = compileQualificationProgramEnvelope({
            qualification: {
              plan: composition.plan,
              primaryReportSourceRelationId: composition.pages.id,
              controlsRelationId: composition.qualification.controls.id,
              groupedSummaryRelationId:
                composition.qualification.groupedSummary.id,
              controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
              numericCompatibilityFields:
                composition.qualification.numericCompatibilityFields,
              scope: composition.qualification.scope,
              reportSourceRelations: composition.reportSourceRelations,
            },
            siteId: SITE_ID,
            reports: [
              {
                output: composition.reportOutput,
                fields: reportFields,
                rowType: `${operation}-list`,
              },
            ],
            controlsOutput: composition.controlsOutput,
            reportFields,
            controlFields,
            ordering: [
              {
                field: operation === "visitors" ? "visitorId" : "sessionId",
                direction: "asc",
                nulls: "last",
                outputId: composition.reportOutput.id,
              },
            ],
            errorPrefix: "journey_funnel_safe_composition",
            fallbackTag: `analytics.${operation}_list_qualification`,
          });
        } catch (error) {
          writeEvidence(`composition-lowering-error-${operation}.json`, {
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : String(error),
            logicalGraph: composition.plan,
            genericSummary: genericGraphs.map(objectGraphSummary),
            genericGraph: genericGraphs.map(graphSnapshot),
          });
          throw error;
        }
        const statement = statements.find(
          ({ tag }) => tag === `analytics.${operation}_list_qualification`,
        );
        expect(compilation.kind).toBe("compiled");
        if (compilation.kind !== "compiled")
          throw new Error("journey_funnel_budgeted_compile_expected");
        expect(statement).toBeDefined();
        if (!statement) throw new Error("journey_funnel_statement_missing");
        const sqlBytes = new TextEncoder().encode(statement.sql).byteLength;
        expect(sqlBytes).toBeLessThanOrEqual(100_000);
        expect(statement.bindings?.length ?? 0).toBeLessThanOrEqual(100);
        expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
        expect(
          compilation.evidence.groupedSummaryProof.matchingSharedRelationCount,
        ).toBe(1);
        expect(genericGraphs).toHaveLength(1);
        expect(physicalGraphs).toHaveLength(1);
        if (operation === "sessions" && EVIDENCE_DIRECTORY) {
          const physical = physicalGraphs[0] as {
            readonly root: LogicalQueryNode;
            readonly semiMembershipChoices: readonly unknown[];
            readonly semiMembershipCostSelections: readonly {
              readonly choice: { readonly node: LogicalQueryNode };
              readonly strategy: "in" | "exists";
              readonly reason: string;
              readonly evidence?: unknown;
            }[];
          };
          const decisions = analyzeSemiMembershipEligibilityForDiagnostics(
            physical.root,
          );
          const fallback = compileD1QuerySemiMembershipFallbackForTest(
            physicalGraphs[0] as Parameters<
              typeof compileD1QuerySemiMembershipFallbackForTest
            >[0],
          );
          const costSelections = physical.semiMembershipCostSelections.map(
            ({ choice, strategy, reason, evidence }) => ({
              candidateIndex: decisions.findIndex(
                ({ node }) => node === choice.node,
              ),
              strategy,
              reason,
              evidence: evidence ?? null,
            }),
          );
          const actualShape = statement.physicalPlanShape as
            | {
                readonly semiMembershipCount?: number;
                readonly semiMemberships?: readonly {
                  readonly emissionCount: number;
                }[];
              }
            | undefined;
          writeEvidence("two-step-sessions-semi-membership-analysis.json", {
            state:
              "production-semi-membership-proof-and-fallback-recomputed-from-original-two-step-session-input",
            operation,
            countScope,
            progressionScope: config.progressionScope,
            stepCount: config.steps.length,
            candidateCount: decisions.length,
            eligibleCandidateCount: decisions.filter(
              ({ kind }) => kind === "eligible",
            ).length,
            physicalChoiceCount: physical.semiMembershipChoices.length,
            costSelectionCount: costSelections.length,
            selectedInCount: costSelections.filter(
              ({ strategy }) => strategy === "in",
            ).length,
            selectedExistsCount: costSelections.filter(
              ({ strategy }) => strategy === "exists",
            ).length,
            costSelections,
            actualSemiMembershipChoiceEmissionCount:
              actualShape?.semiMembershipCount ?? 0,
            actualSemiMembershipEmissionCount:
              actualShape?.semiMemberships?.reduce(
                (total, { emissionCount }) => total + emissionCount,
                0,
              ) ?? 0,
            semiMembershipFallback: {
              sql: fallback.sql,
              bindings: fallback.bindings,
              physicalPlanShape: fallback.physicalPlanShape ?? null,
              inSelectEmissionCount: (
                fallback.sql.match(/ IN \(SELECT /gu) ?? []
              ).length,
            },
            selected: {
              sql: statement.sql,
              bindings: statement.bindings ?? [],
              physicalPlanShape: statement.physicalPlanShape ?? null,
              inSelectEmissionCount: (
                statement.sql.match(/ IN \(SELECT /gu) ?? []
              ).length,
            },
            candidates: decisions.map((decision) => ({
              candidateIndex: decision.candidateIndex,
              kind: decision.kind,
              phase: decision.phase ?? null,
              reason: decision.reason ?? null,
              inputSide: decision.inputSide ?? null,
              totalityVeto: decision.totalityVeto ?? null,
              comparisons:
                decision.comparisons?.map((comparison) => ({
                  leftIndex: comparison.leftIndex,
                  rightIndex: comparison.rightIndex,
                  compatibility: comparison.compatibility,
                  leftAffinity: comparison.leftDomain.affinity,
                  leftStorageClasses: comparison.leftDomain.storageClasses,
                  rightAffinity: comparison.rightDomain.affinity,
                  rightStorageClasses: comparison.rightDomain.storageClasses,
                })) ?? null,
            })),
          });
        }

        const fixtureDatabase = createMigratedDatabase();
        seedFixture(fixtureDatabase);
        const legacyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const env = {
          DB: createSqliteD1Database(fixtureDatabase, legacyTrace),
          MAIN_SECRET,
        } as unknown as Env;
        let mainSqlRows: Record<string, unknown>[];
        let legacyResult: Awaited<
          ReturnType<ReturnType<typeof createD1SiteQueryRuntime>["execute"]>
        >;
        try {
          mainSqlRows = fixtureDatabase
            .prepare(statement.sql)
            .all(
              ...((statement.bindings ?? []).map((binding) =>
                typeof binding === "boolean" ? Number(binding) : binding,
              ) as never[]),
            ) as Record<string, unknown>[];
          compileSpy.mockRestore();
          lowerSpy.mockRestore();
          budgetSpy.mockRestore();
          legacyResult = await createD1SiteQueryRuntime({
            env,
            siteId: SITE_ID,
          }).execute(
            operation,
            queryFor({
              operation,
              funnel: { stepId: "step-1", outcome: "converted" },
              filterDsl: COUNT_FILTER_DSL,
            }) as never,
          );
        } finally {
          fixtureDatabase.close();
        }
        expect(legacyResult.ok).toBe(true);
        if (!legacyResult.ok)
          throw new Error("journey_funnel_legacy_reference_failed");
        const mainReportRows = mainSqlRows.filter(
          (row) =>
            row.rowKind === "report" &&
            row.outputId === composition.reportOutput.id,
        );
        const mainControlRows = mainSqlRows.filter(
          (row) =>
            row.rowKind === "control" &&
            row.outputId === PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
        );
        const mainItems = mainReportRows.map((row) =>
          Object.fromEntries(reportFields.map((field) => [field, row[field]])),
        );
        const mainControls = mainControlRows.map((row) =>
          Object.fromEntries(controlFields.map((field) => [field, row[field]])),
        );
        writeEvidence(`sqlite-execution-pre-assert-${operation}.json`, {
          rows: mainSqlRows,
          reportRows: mainReportRows,
          controlRows: mainControlRows,
          reportFields,
          controlFields,
          reportOutputId: composition.reportOutput.id,
          expectedControlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
          legacyResult,
          legacyCalls: legacyTrace.preparedSql.map((sql, index) => ({
            sql,
            bindings: legacyTrace.bindings[index] ?? [],
          })),
        });
        const legacyData = legacyResult.data as {
          readonly items: readonly unknown[];
        } | null;
        expect(mainControlRows.length).toBeGreaterThan(0);
        expect(legacyData).not.toBeNull();
        if (!legacyData) throw new Error("journey_funnel_legacy_items_missing");
        expect(mainItems).toEqual(legacyData.items);
        if (operation === "visitors")
          expect(mainItems).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ visitorId: "visitor-risk" }),
            ]),
          );
        else expect(mainItems).toEqual([]);

        const sourceCounts = sourceNodes.reduce(
          (counts, node) => {
            if (node.kind !== "source") return counts;
            counts[node.entity] = (counts[node.entity] ?? 0) + 1;
            counts[node.selection ? "selected" : "unselected"] += 1;
            return counts;
          },
          {
            page: 0,
            event: 0,
            site: 0,
            selected: 0,
            unselected: 0,
          } as Record<string, number>,
        );
        const logicalSummary = {
          nodeCount: composition.plan.nodes.length,
          nodeKindCounts: Object.fromEntries(
            [
              ...composition.plan.nodes
                .reduce((counts, node) => {
                  counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
                  return counts;
                }, new Map<string, number>())
                .entries(),
            ].sort(),
          ),
          sourceCounts,
          funnelSourceSelections: funnelSourceNodes.map((node) =>
            node.kind === "source"
              ? {
                  id: node.id,
                  entity: node.entity,
                  filter: node.selection?.filter,
                  postObservationFilter:
                    node.selection?.postObservationFilter?.filter,
                }
              : null,
          ),
          relationReferences: logicalRelationReferenceCounts(
            composition.plan.nodes,
          ),
          sharedCountMatchReferences: countMatchReferenceCount,
          sameNativeFilterOnEveryFunnelSource,
        };
        if (EVIDENCE_DIRECTORY) {
          writeEvidence(`native-source-${operation}-budget-diagnostic.json`, {
            state: "compiled-budgeted-sqlite-executed",
            operation,
            countScope: count.scope,
            filterDsl: COUNT_FILTER_DSL,
            funnelConfig: config,
            result: compilation,
            logicalSummary,
            logicalGraph: composition.plan,
            windowProofs:
              genericGraphs.length === 1
                ? actualRowNumberProofs(genericGraphs[0] as QuerySource)
                : [],
            genericGraph: genericGraphs.map(graphSnapshot),
            genericSummary: genericGraphs.map(objectGraphSummary),
            physicalGraph: physicalGraphs.map(graphSnapshot),
            physicalSummary: physicalGraphs.map(objectGraphSummary),
            compiledStatement: statement
              ? {
                  tag: statement.tag,
                  sql: statement.sql,
                  bindings: statement.bindings ?? [],
                  sqlBytes: new TextEncoder().encode(statement.sql).byteLength,
                  bindingCount: statement.bindings?.length ?? 0,
                  physicalPlanShape: statement.physicalPlanShape,
                }
              : null,
            mainSqlExecuted: true,
            mainSqlRows,
            mainReportItems: mainItems,
            mainControls,
            legacyResult: legacyResult.data,
            legacySqlCalls: legacyTrace.preparedSql.map((sql, index) => ({
              sql,
              bindings: legacyTrace.bindings[index] ?? [],
            })),
            budgetWasCalledThroughOriginalAssertion: statements.includes(
              statement!,
            ),
            baselineOrdinarySql: {
              visitor:
                "see the accepted ordinary public-reference measurement in this run directory",
              session:
                "see the accepted ordinary public-reference measurement in this run directory",
            },
          });
        }
      } finally {
        compileSpy.mockRestore();
        lowerSpy.mockRestore();
        budgetSpy.mockRestore();
      }
    },
  );

  it("requires positive Count session matches before testing the native Funnel boundary", async () => {
    const database = createMigratedDatabase();
    seedFixture(database);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET,
    } as unknown as Env;
    const queryTime = createQueryTime(BASE, END, "UTC", END);
    const filters = parseFilterDsl(COUNT_FILTER_DSL, analyticsFilterRegistry);
    const { count, native } = countInputFor(filters, queryTime, "session");
    if (native.kind !== "supported")
      throw new Error("journey_funnel_native_split_missing");
    const countPlan = buildAdvancedCountFilterMatchPlan(count);
    const matchesOutput = countPlan.outputs.find(
      (output) => output.id === ADVANCED_COUNT_FILTER_OUTPUTS.matches,
    );
    if (!matchesOutput) throw new Error("journey_funnel_count_matches_missing");
    const countQuery = compileOutput(countPlan, matchesOutput.id);
    const countResult = await db
      .createD1DatabaseClient(env.DB)
      .all<Record<string, unknown>>(countQuery);
    const countRows = countResult.results;
    const matchedIds = countRows.map((row) => String(row.entityId));

    const builder = createAdvancedCountQualificationBuilder(count);
    const qualification = appendAdvancedCountQualification(builder, count);
    const nativeScopePlan = createScopedFilterPlan(
      "sessions",
      native.filters,
      count.scope,
    );
    if (!nativeScopePlan)
      throw new Error("journey_funnel_native_scope_plan_missing");
    const nativeFilters = attachScopedFilterMetadata(native.filters, {
      requestedScope: count.scope,
      resolvedScope: nativeScopePlan.scope,
      plan: nativeScopePlan,
      time: queryTime,
      siteIds: [SITE_ID],
    });
    const sources = createJourneyFunnelProgressionSourceSelections({
      siteId: SITE_ID,
      window: {
        startMs: queryTime.range.startMs,
        endExclusiveMs: queryTime.range.endExclusiveMs,
        nowMs: queryTime.capturedAtMs,
        timeZone: queryTime.reportingTimeZone,
      },
      filters: nativeFilters,
      entityScope: "session",
      preparedPlanOperation: "sessions",
    });
    const progression = appendFunnelProgressionRelations({
      builder,
      sources,
      config: {
        ...twoStepFunnel,
        progressionScope: "session",
        conversionWindowMs: null,
      },
      throughStepIndex: 1,
      preparedPlanOperation: "sessions",
      qualificationMembership: {
        matches: qualification.matches,
        siteId: SITE_ID,
        countScope: count.scope,
      },
    });
    addOutput(
      builder,
      PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
      qualification.controls,
    );
    addOutput(builder, "count-match-identities", qualification.matches);
    addOutput(builder, "count-grouped-summary", qualification.groupedSummary);
    addOutput(
      builder,
      "funnel-reached-identities",
      progression.reachedSteps[1]!,
      ["identity"],
    );
    const plan = builder.finish();
    const reachedQuery = compileOutput(plan, "funnel-reached-identities");
    const reachedRows = await db
      .createD1DatabaseClient(env.DB)
      .all<Record<string, unknown>>(reachedQuery);
    const reachedIds = reachedRows.results.map((row) => String(row.identity));
    const countMatchesBothRiskSessions =
      matchedIds.includes("risk-session-allowed") &&
      matchedIds.includes("risk-session-funnel");
    const riskSessionReached = reachedIds.includes("risk-session-funnel");
    writeEvidence("native-filter-boundary-positive-count-control.json", {
      state: "actual-standalone-count-and-funnel-membership-sqlite",
      filterDsl: COUNT_FILTER_DSL,
      nativeFilter: 'page.path eq "/allowed"',
      countFilter: 'count(page { page.path eq "/count" }) gte 1',
      countScope: count.scope,
      fixture: {
        matchedSession: {
          id: "risk-session-allowed",
          pages: ["/allowed", "/count"],
          funnelSteps: [],
        },
        nonNativeSession: {
          id: "risk-session-funnel",
          pages: ["/count", "/start"],
          events: ["funnel-convert"],
        },
      },
      matchedIds,
      countMatchesBothRiskSessions,
      reachedIds,
      riskSessionReached,
      calls: trace.preparedSql.map((sql, index) => ({
        sql,
        bindings: trace.bindings[index] ?? [],
      })),
    });
    expect(countMatchesBothRiskSessions).toBe(true);
    expect(riskSessionReached).toBe(false);
    database.close();
  });
});
