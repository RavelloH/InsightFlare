// @vitest-environment node
import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import type { SqliteD1Trace } from "@/lib/db/__tests__/sqlite-d1";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import type { GeoPointsResult } from "@/lib/edge/analytics/contract/types";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as afe from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";
import { qualificationRequestOwnDataSnapshot } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

// Frozen old/new pairs independently agreed on every full DTO and ordered
// SQL+parameter fingerprint below. This permanent test does not reconstruct
// a historical oracle or read evidence files/environment switches at runtime.
const EXPECTED = {
  "session-whole": {
    dto: {
      value: {
        points: [
          {
            latitude: 37.5,
            longitude: -122.3,
            timestampMs: 1700579600000,
            country: "FR",
            region: "",
            regionCode: "",
            city: "",
            pointCount: 1,
          },
          {
            latitude: 37.52,
            longitude: -122.32,
            timestampMs: 1700554400000,
            country: "CN",
            region: "",
            regionCode: "",
            city: "",
            pointCount: 1,
          },
        ],
        countryCounts: [
          {
            country: "CN",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "DE",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "GB",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "IN",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "BR",
            views: 2,
            sessions: 2,
            visitors: 2,
          },
          {
            country: "FR",
            views: 2,
            sessions: 2,
            visitors: 2,
          },
          {
            country: "JP",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            country: "US",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
        regionCounts: [],
        cityCounts: [],
      },
    },
    sqlFingerprint:
      "00f7a753439bd9b9baaae064e2da63774345950559ba293f52abd66d8e05fc31",
    diagnosticsFingerprint:
      "b39b869ef0f6fa63d7eec3e5a5bb27608b9489f2cadae079e6db37ae23078f33",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:journey-geo-points",
      "report:journey-geo-country-summary",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 4,
  },
  "visitor-whole": {
    dto: {
      value: {
        points: [
          {
            latitude: 37.5,
            longitude: -122.3,
            timestampMs: 1700579600000,
            country: "FR",
            region: "",
            regionCode: "",
            city: "",
            pointCount: 1,
          },
          {
            latitude: 37.52,
            longitude: -122.32,
            timestampMs: 1700554400000,
            country: "CN",
            region: "",
            regionCode: "",
            city: "",
            pointCount: 1,
          },
        ],
        countryCounts: [
          {
            country: "BR",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "CN",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "DE",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "FR",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "GB",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "IN",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "JP",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "US",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "",
            views: 2,
            sessions: 2,
            visitors: 1,
          },
        ],
        regionCounts: [],
        cityCounts: [],
      },
    },
    sqlFingerprint:
      "745b29184e43035c4be2eea76263b9dbc6ebf04acaafac1fdab9417a9deb5abf",
    diagnosticsFingerprint:
      "02e64cedbc36812cd09af6fba266f430e0f585ed64ab481651b8647bc745155c",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:journey-geo-points",
      "report:journey-geo-country-summary",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 4,
  },
  "session-same-site-team": {
    dto: {
      value: {
        points: [
          {
            latitude: 37.5,
            longitude: -122.3,
            timestampMs: 1700579600000,
            country: "FR",
            region: "",
            regionCode: "",
            city: "",
            pointCount: 1,
          },
          {
            latitude: 37.52,
            longitude: -122.32,
            timestampMs: 1700554400000,
            country: "CN",
            region: "",
            regionCode: "",
            city: "",
            pointCount: 1,
          },
        ],
        countryCounts: [
          {
            country: "CN",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "DE",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "GB",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "IN",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "BR",
            views: 2,
            sessions: 2,
            visitors: 2,
          },
          {
            country: "FR",
            views: 2,
            sessions: 2,
            visitors: 2,
          },
          {
            country: "JP",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            country: "US",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
        regionCounts: [],
        cityCounts: [],
      },
    },
    sqlFingerprint:
      "00f7a753439bd9b9baaae064e2da63774345950559ba293f52abd66d8e05fc31",
    diagnosticsFingerprint:
      "22c1fbc2d2aac6de6d5c6a7793afcd6bdc2ed7aa2f1cbe0b81afe217f0c7623d",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:journey-geo-points",
      "report:journey-geo-country-summary",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 4,
  },
  "Core-marker-abort": {
    dto: null,
    sqlFingerprint:
      "3eba7efcc9848012471d26be9574b0fb8d4a511494c37837d319b4a9b32d186b",
    diagnosticsFingerprint:
      "b39b869ef0f6fa63d7eec3e5a5bb27608b9489f2cadae079e6db37ae23078f33",
    events: ["execute-returned", "Core", "Core-error-reaction", "rejected"],
    coreCalls: 1,
    preparedCount: 2,
  },
  "prepared-empty-range": {
    dto: {
      value: {
        points: [],
        countryCounts: [],
        regionCounts: [],
        cityCounts: [],
      },
    },
    sqlFingerprint:
      "54a1c187a19638626a51defb1bc6823c7d03638e4b6b9161e7cd1ba3d0dd6d7d",
    diagnosticsFingerprint:
      "f185ee663988843964432a8a9bf5e281b4805024d12a29323c6357f253f40fcd",
    events: [
      "execute-returned",
      "report:journey-geo-points",
      "report:journey-geo-country-summary",
      "resolved",
    ],
    coreCalls: 0,
    preparedCount: 2,
  },
  "native-page-control": {
    dto: {
      value: {
        points: [
          {
            latitude: 37.5,
            longitude: -122.3,
            timestampMs: 1700579600000,
            country: "FR",
            region: "",
            regionCode: "",
            city: "",
            pointCount: 1,
          },
          {
            latitude: 37.52,
            longitude: -122.32,
            timestampMs: 1700554400000,
            country: "CN",
            region: "",
            regionCode: "",
            city: "",
            pointCount: 1,
          },
        ],
        countryCounts: [
          {
            country: "CN",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "GB",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "IN",
            views: 3,
            sessions: 3,
            visitors: 3,
          },
          {
            country: "DE",
            views: 2,
            sessions: 2,
            visitors: 2,
          },
          {
            country: "FR",
            views: 2,
            sessions: 2,
            visitors: 2,
          },
          {
            country: "BR",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            country: "US",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
        regionCounts: [],
        cityCounts: [],
      },
    },
    sqlFingerprint:
      "ffb9b163cfbd1c93aa18c0ae0463eebb57c2af161226aaab8fd6276c07bc5d62",
    diagnosticsFingerprint:
      "f185ee663988843964432a8a9bf5e281b4805024d12a29323c6357f253f40fcd",
    events: [
      "execute-returned",
      "report:journey-geo-points",
      "report:journey-geo-country-summary",
      "resolved",
    ],
    coreCalls: 0,
    preparedCount: 2,
  },
} as const;

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const whole =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const fixture = buildJourneyEventFieldsCostFixture(24);
// W48's fixture intentionally has no coordinates. Add real reportable points
// without changing its paths, sessions, visitors, events or qualification DSL.
const coordinates =
  "UPDATE visits SET latitude=37.5+(rowid%3)/100.0,longitude=-122.3-(rowid%3)/100.0";
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);

function field(value: unknown, key: PropertyKey): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function programObservation(program: unknown) {
  const completed = list(field(program, "completedWholeOutputs"));
  const stages = list(field(program, "stages"));
  return {
    completed: completed.map((item) => ({
      subject: field(field(item, "plan"), "context"),
      output: field(item, "output"),
    })),
    stages: stages.map((stage) => {
      const plan = field(stage, "plan");
      const nodes = list(field(plan, "nodes"));
      return {
        index: field(stage, "index"),
        context: field(plan, "context"),
        outputs: field(stage, "outputs"),
        dependencies: field(stage, "dependencies"),
        imports: nodes
          .filter((node) => field(node, "kind") === "analysis-result")
          .map((node) => ({
            id: field(node, "id"),
            execution: field(node, "execution"),
            outputId: field(node, "outputId"),
            exactCompletedChild: completed.some(
              (item) =>
                field(node, "childPlan") === field(item, "plan") &&
                field(node, "outputId") === field(field(item, "output"), "id"),
            ),
          })),
        sources: nodes
          .filter((node) => field(node, "kind") === "source")
          .map((node) => ({
            id: field(node, "id"),
            entity: field(node, "entity"),
            membershipInputs: field(node, "membershipInputs"),
          })),
      };
    }),
    physicalFrameCount: list(field(program, "physicalFrames")).length,
  };
}

const cases: readonly {
  key: keyof typeof EXPECTED;
  kind: "whole" | "core-error" | "empty" | "native";
  scope: "session" | "visitor";
  team?: boolean;
}[] = [
  { key: "session-whole", kind: "whole", scope: "session" },
  { key: "visitor-whole", kind: "whole", scope: "visitor" },
  {
    key: "session-same-site-team",
    kind: "whole",
    scope: "session",
    team: true,
  },
  { key: "Core-marker-abort", kind: "core-error", scope: "session" },
  { key: "prepared-empty-range", kind: "empty", scope: "session" },
  { key: "native-page-control", kind: "native", scope: "session" },
];

for (const spec of cases) {
  it(`preserves the real geo registry program: ${spec.key}`, async () => {
    const database = createMigratedDatabase();
    for (const sql of [...fixture.seed, coordinates]) database.exec(sql);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET: "geo-program-local-only",
    } as unknown as Env;
    const context = siteQueryContext(SEED_SITE_ID, "private-dashboard");
    if (context.subject.kind !== "site")
      throw new Error("geo_program_expected_site_context");
    const team = teamQueryContext("c01-team", "private-dashboard").subject;
    if (team.kind !== "team") throw new Error("fixture_team_missing");
    const initialQuery = prepareScopedQuery("geo-points", {
      context: {
        ...context,
        subject: {
          kind: "site",
          siteId: context.subject.siteId,
          ...(spec.team ? { teamId: team.teamId } : {}),
        },
      },
      time,
      filters: parseFilterDsl(
        spec.kind === "native" ? 'page.path eq "/"' : whole,
        analyticsFilterRegistry,
      ),
      scopePreference: spec.scope,
      limit: 2,
    });
    const initialMetadata = scopedFilterMetadata(initialQuery.filters);
    if (!initialMetadata)
      throw new Error("geo_program_expected_prepared_metadata");
    // Prepared-empty contract from the genuine pair; not a DSL inference claim.
    const emptyTime = { ...initialQuery.time, filterRangeEmpty: true as const };
    const query =
      spec.kind === "empty"
        ? {
            ...initialQuery,
            time: emptyTime,
            filters: attachScopedFilterMetadata(initialQuery.filters, {
              ...initialMetadata,
              time: emptyTime,
            }),
          }
        : initialQuery;
    const before = qualificationRequestOwnDataSnapshot(query);
    const metadataIdentity = scopedFilterMetadata(query.filters);
    const metadataBefore = JSON.parse(
      JSON.stringify(scopedFilterMetadata(query.filters)),
    );
    const changesBefore = database.prepare("SELECT total_changes() AS n").get();
    const diagnostics = createD1ReadDiagnostics();
    const controller = new AbortController();
    const reactions: string[] = [];
    const bridgeEvents: string[] = [];
    const programs: unknown[] = [];
    const reportCalls: {
      readonly outputId: string;
      readonly context: unknown;
      readonly imports: readonly unknown[];
      readonly sources: readonly unknown[];
      readonly hasProgram: boolean;
      readonly exactCompletedChild: boolean;
    }[] = [];
    const marker = new Error("geo-program-Core-marker");
    const middlewareOwners: unknown[] = [];
    const actualMiddlewareFactory = afe.d1AdvancedFilterMiddleware;
    const actualCore = evaluator.evaluateFilterDocument;
    const actualRows = reports.queryAnalyticsReportOutputRowsFromD1;
    const actualRegister = bridge.registerPreparedMembership;
    const actualResolve = bridge.resolvePreparedMembership;
    let forbiddenFetches = 0;
    vi.stubGlobal("fetch", () => {
      forbiddenFetches += 1;
      throw new Error("geo_program_network_forbidden");
    });
    const core = vi
      .spyOn(evaluator, "evaluateFilterDocument")
      .mockImplementation((...args: Parameters<typeof actualCore>) => {
        reactions.push("Core");
        if (spec.kind === "core-error") {
          controller.abort();
          queueMicrotask(() => reactions.push("Core-error-reaction"));
          throw marker;
        }
        const value = actualCore(...args);
        queueMicrotask(() => reactions.push("Core-reaction"));
        return value;
      });
    const register = vi
      .spyOn(bridge, "registerPreparedMembership")
      .mockImplementation((...args) => {
        bridgeEvents.push("register");
        return actualRegister(...args);
      });
    const resolve = vi
      .spyOn(bridge, "resolvePreparedMembership")
      .mockImplementation((...args) => {
        bridgeEvents.push("resolve");
        return actualResolve(...args);
      });
    const middlewareFactory = vi
      .spyOn(afe, "d1AdvancedFilterMiddleware")
      .mockImplementation(
        (...factoryArgs: Parameters<typeof actualMiddlewareFactory>) => {
          const middleware = actualMiddlewareFactory(...factoryArgs);
          // Observe the actual D1 dispatch execution value. Synchronous forwarding
          // preserves the exact returned Promise and adds no await/.then frame.
          return (...args: Parameters<typeof middleware>) => {
            middlewareOwners.push(args[1]);
            const program = field(Reflect.get(args, 3), "program");
            if (program && !programs.includes(program)) programs.push(program);
            return middleware(...args);
          };
        },
      );
    const rows = vi
      .spyOn(reports, "queryAnalyticsReportOutputRowsFromD1")
      .mockImplementation((...args: Parameters<typeof actualRows>) => {
        // Forward the original report call synchronously; observe the real program
        // passed at the existing report checkpoint without another async frame.
        const execution = Reflect.get(args, 6);
        const program = field(execution, "program");
        if (program && !programs.includes(program)) programs.push(program);
        const plan: ValidatedLogicalPlan = args[1];
        const imports = plan.nodes.filter(
          (node) => node.kind === "analysis-result",
        );
        const completed = list(field(program, "completedWholeOutputs"));
        reportCalls.push({
          outputId: args[2],
          context: plan.context,
          imports: imports.map((node) => ({
            id: node.id,
            execution: field(node, "execution"),
            outputId: node.outputId,
          })),
          sources: plan.nodes
            .filter((node) => node.kind === "source")
            .map((node) => ({
              id: node.id,
              entity: node.entity,
              selection: node.selection,
              membershipInputs: field(node, "membershipInputs"),
            })),
          hasProgram: program !== undefined,
          exactCompletedChild:
            imports.length === 1 &&
            completed.some(
              (item) =>
                imports[0]?.childPlan === field(item, "plan") &&
                imports[0]?.outputId === field(field(item, "output"), "id"),
            ),
        });
        reactions.push(`report:${args[2]}`);
        return actualRows(...args);
      });
    let result: { readonly value: GeoPointsResult } | undefined;
    let error: unknown;
    try {
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SEED_SITE_ID,
        diagnostics,
      }).resolve("geo-points");
      if (!provider) throw new Error("geo_program_missing_geo_provider");
      try {
        const pending = provider.execute(query, { signal: controller.signal });
        reactions.push("execute-returned");
        result = await pending;
        reactions.push("resolved");
      } catch (caught) {
        error = caught;
        reactions.push("rejected");
      }
      const after = qualificationRequestOwnDataSnapshot(query);
      const changesAfter = database
        .prepare("SELECT total_changes() AS n")
        .get();
      const observations = programs.map(programObservation);
      const expected = EXPECTED[spec.key];
      expect(result ?? null).toEqual(expected.dto);
      expect(reactions).toEqual(expected.events);
      expect(bridgeEvents).toEqual(
        spec.kind === "empty" ? ["register", "resolve", "resolve"] : [],
      );
      expect(core).toHaveBeenCalledTimes(expected.coreCalls);
      expect(trace.preparedSql).toHaveLength(expected.preparedCount);
      expect(
        fingerprint(
          trace.preparedSql.map((sql, index) => ({
            sql,
            params: trace.bindings[index],
          })),
        ),
      ).toBe(expected.sqlFingerprint);
      expect(fingerprint(diagnostics)).toBe(expected.diagnosticsFingerprint);
      expect(scopedFilterMetadata(query.filters)).toBe(metadataIdentity);
      expect(
        JSON.parse(JSON.stringify(scopedFilterMetadata(query.filters))),
      ).toEqual(metadataBefore);
      expect(middlewareOwners).toEqual([query]);
      expect(middlewareOwners[0]).toBe(query);
      expect(middlewareFactory).toHaveBeenCalledTimes(1);
      expect(before).toBeDefined();
      expect(after).toBe(before);
      expect(changesAfter).toEqual(changesBefore);
      expect(forbiddenFetches).toBe(0);
      expect(trace.bindings.length).toBe(trace.preparedSql.length);
      expect(programs).toHaveLength(1);
      expect(programs[0]).toBeInstanceOf(D1LogicalProgramExecution);
      if (spec.kind === "whole") {
        expect(error).toBeUndefined();
        expect(controller.signal.aborted).toBe(false);
        expect(result?.value.points.length).toBeGreaterThan(0);
        expect(register).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
        expect(reportCalls).toHaveLength(2);
        expect(
          reportCalls.every(
            (call) => call.hasProgram && call.exactCompletedChild,
          ),
        ).toBe(true);
        expect(
          reportCalls.every(
            (call) =>
              call.sources.length === 1 &&
              field(call.sources[0], "entity") === "page" &&
              list(field(call.sources[0], "membershipInputs")).length === 1 &&
              field(
                list(field(call.sources[0], "membershipInputs"))[0],
                "role",
              ) === "entity",
          ),
        ).toBe(true);
        expect(observations[0]?.stages).toHaveLength(3);
        expect(observations[0]?.completed).toHaveLength(1);
        expect(observations[0]?.physicalFrameCount).toBe(2);
        const program = programs[0];
        const completed = list(field(program, "completedWholeOutputs"));
        expect(Object.isFrozen(field(completed[0], "plan"))).toBe(true);
        const producerContext = field(field(completed[0], "plan"), "context");
        expect(field(field(producerContext, "subject"), "siteIds")).toEqual([
          SEED_SITE_ID,
        ]);
        expect(field(field(producerContext, "scope"), "logicalScope")).toBe(
          spec.scope,
        );
        for (const stage of list(field(program, "stages")).slice(1)) {
          const dependencies = list(field(stage, "dependencies"));
          expect(dependencies).toHaveLength(1);
          expect(field(dependencies[0], "producerStage")).toBe(0);
          expect(field(dependencies[0], "output")).toBe(
            field(completed[0], "output"),
          );
        }
        expect(
          reportCalls.every(
            (call) =>
              field(field(call.context, "subject"), "teamId") ===
              (spec.team ? team.teamId : undefined),
          ),
        ).toBe(true);
      } else {
        for (const observation of observations) {
          expect(observation.completed).toHaveLength(0);
          expect(observation.stages).toHaveLength(0);
          expect(observation.physicalFrameCount).toBe(0);
        }
        expect(
          reportCalls.every(
            (call) => !call.hasProgram && call.imports.length === 0,
          ),
        ).toBe(true);
        if (spec.kind === "core-error") {
          expect(error).toBe(marker);
          expect(controller.signal.aborted).toBe(true);
          expect(core).toHaveBeenCalledTimes(1);
          expect(register).not.toHaveBeenCalled();
          expect(resolve).not.toHaveBeenCalled();
          expect(reportCalls).toHaveLength(0);
        } else {
          expect(error).toBeUndefined();
          expect(controller.signal.aborted).toBe(false);
          expect(core).not.toHaveBeenCalled();
          expect(reportCalls).toHaveLength(2);
          if (spec.kind === "empty") {
            expect(result?.value.points).toEqual([]);
            expect(register).toHaveBeenCalledTimes(1);
            expect(resolve).toHaveBeenCalledTimes(2);
            expect(scopedFilterMetadata(query.filters)?.time).toBe(query.time);
            expect(query.time.filterRangeEmpty).toBe(true);
          } else {
            expect(result?.value.points.length).toBeGreaterThan(0);
            expect(register).not.toHaveBeenCalled();
            expect(resolve).not.toHaveBeenCalled();
          }
        }
      }
    } finally {
      rows.mockRestore();
      middlewareFactory.mockRestore();
      core.mockRestore();
      register.mockRestore();
      resolve.mockRestore();
      vi.unstubAllGlobals();
      database.close();
    }
  });
}
