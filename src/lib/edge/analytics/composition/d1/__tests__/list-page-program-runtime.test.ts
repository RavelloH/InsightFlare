// @vitest-environment node
import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import type { SqliteD1Trace } from "@/lib/db/__tests__/sqlite-d1";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { TeamId } from "@/lib/edge/analytics/contract/types";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";
import { qualificationRequestOwnDataSnapshot } from "@/lib/edge/analytics/providers/d1/internal/pages-dashboard-qualification-request";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

// Full DTOs and unnormalized ordered SQL/parameter and diagnostic fingerprints
// come from genuine pre-migration registry executions. No historical files or
// environment switches are read by this permanent regression.
const EXPECTED = {
  "channels-session-page1": {
    dto: {
      value: {
        items: [
          {
            channel: "referral",
            views: 7,
            sessions: 6,
            visitors: 4,
          },
          {
            channel: "organic_search",
            views: 5,
            sessions: 4,
            visitors: 2,
          },
        ],
      },
    },
    sqlFingerprint:
      "ecad753b27d7273548542c3a38836cc95bd5695d5a1396ced9f4bd6f5917c41a",
    diagnosticsFingerprint:
      "b39b869ef0f6fa63d7eec3e5a5bb27608b9489f2cadae079e6db37ae23078f33",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:overview-channels",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 3,
  },
  "channels-visitor-page1": {
    dto: {
      value: {
        items: [
          {
            channel: "referral",
            views: 8,
            sessions: 7,
            visitors: 4,
          },
          {
            channel: "direct",
            views: 7,
            sessions: 7,
            visitors: 3,
          },
        ],
      },
    },
    sqlFingerprint:
      "5f6625d86d37e23f536062baf5ea2068e8e61690246b530227c1e2fbca77ae55",
    diagnosticsFingerprint:
      "64959ceac9f228fcfc3d788688c64af8fbf87c902345f14fa1e6309ea67ae297",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:overview-channels",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 3,
  },
  "pages-session-page1": {
    dto: {
      value: {
        items: [
          {
            pathname: "/",
            query: "",
            hash: "",
            views: 5,
            sessions: 5,
          },
        ],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiOWYyZjY3MDIxMDQzMWFiZjQwY2JlMmIzZThlZTMwNDAwNTNmYjM3Nzc5ZmYyZTA0OGVjODczYzg0NmYyMGNiNiIsImtleSI6eyJoYXNoIjoiIiwicGF0aG5hbWUiOiIvIiwicXVlcnkiOiIiLCJzZXNzaW9ucyI6NSwidmlld3MiOjV9fQ.aHpYGJCzEHnLvwac1timwAEih25ASBzoOAQc67snaEY",
        },
      },
      source: "raw",
    },
    sqlFingerprint:
      "6e8c780286e2db8d00910eb9647d702966e7d647e48308054c8664ab54de3858",
    diagnosticsFingerprint:
      "b39b869ef0f6fa63d7eec3e5a5bb27608b9489f2cadae079e6db37ae23078f33",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:pages-page",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 3,
  },
  "pages-session-page2": {
    dto: {
      value: {
        items: [
          {
            pathname: "/qualifier",
            query: "",
            hash: "",
            views: 3,
            sessions: 2,
          },
        ],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiOWYyZjY3MDIxMDQzMWFiZjQwY2JlMmIzZThlZTMwNDAwNTNmYjM3Nzc5ZmYyZTA0OGVjODczYzg0NmYyMGNiNiIsImtleSI6eyJoYXNoIjoiIiwicGF0aG5hbWUiOiIvcXVhbGlmaWVyIiwicXVlcnkiOiIiLCJzZXNzaW9ucyI6Miwidmlld3MiOjN9fQ.sQRuXObxD42YDxchuPl4JSoYce4oZ-a-IYuSVnGoqq4",
        },
      },
      source: "raw",
    },
    sqlFingerprint:
      "7bff48b5bf70ebcfa8f83fd3984d8191cc8e8e9af8ab36b9d6587e1c93de3b53",
    diagnosticsFingerprint:
      "b39b869ef0f6fa63d7eec3e5a5bb27608b9489f2cadae079e6db37ae23078f33",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:pages-page",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 3,
  },
  "pages-visitor-page1": {
    dto: {
      value: {
        items: [
          {
            pathname: "/qualifier",
            query: "",
            hash: "",
            views: 6,
            sessions: 5,
          },
        ],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiMTdiNDAxYjk0OWM1MjE5ZTBmMTFkNDZmNWM4OTk0MDFhNjczNWQ5MWEzMDk1MzZkNjlkYzk5OTJmNTk1Y2U4OCIsImtleSI6eyJoYXNoIjoiIiwicGF0aG5hbWUiOiIvcXVhbGlmaWVyIiwicXVlcnkiOiIiLCJzZXNzaW9ucyI6NSwidmlld3MiOjZ9fQ.eApkOK44IT53-s5T4LbSTAwhR4Z0moGYZsT-qff6QG0",
        },
      },
      source: "raw",
    },
    sqlFingerprint:
      "b4075a2840efd9564dda86b513627d4d3b7df6308e141d140ae83208eaf2ea35",
    diagnosticsFingerprint:
      "02e64cedbc36812cd09af6fba266f430e0f585ed64ab481651b8647bc745155c",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:pages-page",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 3,
  },
  "pages-visitor-page2": {
    dto: {
      value: {
        items: [
          {
            pathname: "/",
            query: "",
            hash: "",
            views: 5,
            sessions: 5,
          },
        ],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiMTdiNDAxYjk0OWM1MjE5ZTBmMTFkNDZmNWM4OTk0MDFhNjczNWQ5MWEzMDk1MzZkNjlkYzk5OTJmNTk1Y2U4OCIsImtleSI6eyJoYXNoIjoiIiwicGF0aG5hbWUiOiIvIiwicXVlcnkiOiIiLCJzZXNzaW9ucyI6NSwidmlld3MiOjV9fQ.OKGfqBKvF6H9DXTSjjRCziZ4PhAJ0uKIvBhwA-CsGoQ",
        },
      },
      source: "raw",
    },
    sqlFingerprint:
      "2d9793cbad8555b9ea9acb241ed8ea263f124bf3ec1966ad7ba9cec370f3af7d",
    diagnosticsFingerprint:
      "02e64cedbc36812cd09af6fba266f430e0f585ed64ab481651b8647bc745155c",
    events: [
      "execute-returned",
      "Core",
      "Core-reaction",
      "report:pages-page",
      "resolved",
    ],
    coreCalls: 1,
    preparedCount: 3,
  },
};

const fixture = buildJourneyEventFieldsCostFixture(24);
const whole =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function field(value: unknown, key: PropertyKey): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function requestFor(
  registry: ReturnType<typeof createD1SiteProviderRegistry>,
  operation: "channels" | "pages",
  scope: "session" | "visitor",
  cursor: string | null,
  signal: AbortSignal,
) {
  const originalContext = siteQueryContext(SEED_SITE_ID, "api-v1");
  if (originalContext.subject.kind !== "site")
    throw new Error("expected_site_context");
  const context =
    operation === "channels" && scope === "visitor"
      ? {
          ...originalContext,
          subject: { ...originalContext.subject, teamId: "c01-team" as TeamId },
        }
      : originalContext;
  const common = {
    context,
    time,
    filters: parseFilterDsl(whole, analyticsFilterRegistry),
    scopePreference: scope,
    limit: 2,
  };
  if (operation === "channels") {
    const query = prepareScopedQuery("channels", {
      ...common,
      mode: "list" as const,
    });
    const provider = registry.resolve("channels");
    if (!provider) throw new Error("missing_channels_provider");
    return { query, execute: () => provider.execute(query, { signal }) };
  }
  const query = prepareScopedQuery("pages", {
    ...common,
    variant: "list" as const,
    includeDetails: false,
    page: { limit: 1, cursor },
  });
  const provider = registry.resolve("pages");
  if (!provider) throw new Error("missing_pages_provider");
  return { query, execute: () => provider.execute(query, { signal }) };
}

async function preservesListProgram(
  operation: "channels" | "pages",
  scope: "session" | "visitor",
) {
  let cursor: string | null = null;
  for (let page = 1; page <= (operation === "pages" ? 2 : 1); page += 1) {
    // Each historical page used an independently seeded database as well.
    const database = createMigratedDatabase();
    for (const sql of fixture.seed) database.exec(sql);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = {
      DB: createSqliteD1Database(database, trace),
      MAIN_SECRET:
        operation === "pages" ? "w176-local-only" : "w175-local-only",
    } as unknown as Env;
    const diagnostics = createD1ReadDiagnostics();
    const controller = new AbortController();
    const events: string[] = [];
    const programs: D1LogicalProgramExecution[] = [];
    const actualCore = evaluator.evaluateFilterDocument;
    const actualRows = reports.queryAnalyticsReportOutputRowsFromD1;
    const register = vi.spyOn(bridge, "registerPreparedMembership");
    const resolve = vi.spyOn(bridge, "resolvePreparedMembership");
    const core = vi
      .spyOn(evaluator, "evaluateFilterDocument")
      .mockImplementation((...args: Parameters<typeof actualCore>) => {
        events.push("Core");
        const result = actualCore(...args);
        queueMicrotask(() => events.push("Core-reaction"));
        return result;
      });
    const rows = vi
      .spyOn(reports, "queryAnalyticsReportOutputRowsFromD1")
      .mockImplementation((...args: Parameters<typeof actualRows>) => {
        const program = field(Reflect.get(args, 6), "program");
        expect(program).toBeInstanceOf(D1LogicalProgramExecution);
        if (!(program instanceof D1LogicalProgramExecution))
          throw new Error("expected_real_program");
        programs.push(program);
        const completed = program.completedWholeOutputs;
        expect(completed).toHaveLength(1);
        const producer = completed[0];
        if (!producer) throw new Error("expected_completed_producer");
        expect(Object.isFrozen(producer.plan)).toBe(true);
        expect(producer.plan.outputs).toContain(producer.output);
        const plan = args[1];
        const imports = plan.nodes.filter(
          (node) => node.kind === "analysis-result",
        );
        expect(imports).toHaveLength(1);
        expect(imports[0]?.execution).toBe("program");
        expect(imports[0]?.childPlan).toBe(producer.plan);
        expect(imports[0]?.outputId).toBe(producer.output.id);
        const sources = plan.nodes.filter((node) => node.kind === "source");
        expect(sources).toHaveLength(1);
        expect(sources[0]?.entity).toBe("page");
        const inputs = sources[0]?.membershipInputs;
        expect(inputs).toHaveLength(1);
        expect(inputs?.[0]?.role).toBe("entity");
        const distinct = plan.nodes.find(
          (node) => node.id === inputs?.[0]?.input,
        );
        expect(distinct?.kind).toBe("distinct");
        const projection = plan.nodes.find(
          (node) => node.id === field(distinct, "input"),
        );
        expect(projection?.kind).toBe("project");
        const roleFilter = plan.nodes.find(
          (node) => node.id === field(projection, "input"),
        );
        expect(roleFilter?.kind).toBe("filter");
        expect(field(roleFilter, "input")).toBe(imports[0]?.id);
        expect(plan.context.subject).toEqual(producer.plan.context.subject);
        expect(plan.context.scope.logicalScope).toBe(scope);
        events.push(`report:${args[2]}`);
        // Observe and synchronously forward the original Promise, without an
        // added async wrapper or completion supplied by the test.
        return actualRows(...args);
      });
    let forbiddenFetches = 0;
    vi.stubGlobal("fetch", () => {
      forbiddenFetches += 1;
      throw new Error("list_program_network_forbidden");
    });
    try {
      const registry = createD1SiteProviderRegistry({
        env,
        siteId: SEED_SITE_ID,
        diagnostics,
      });
      const request = requestFor(
        registry,
        operation,
        scope,
        cursor,
        controller.signal,
      );
      const before = qualificationRequestOwnDataSnapshot(request.query);
      const metadata = scopedFilterMetadata(request.query.filters);
      const metadataBefore = fingerprint(metadata);
      const changesBefore = database
        .prepare("SELECT total_changes() AS n")
        .get();
      const pending = request.execute();
      events.push("execute-returned");
      const result = await pending;
      events.push("resolved");
      const expected =
        EXPECTED[`${operation}-${scope}-page${page}` as keyof typeof EXPECTED];
      expect(result).toEqual(expected.dto);
      expect(events).toEqual(expected.events);
      expect(core).toHaveBeenCalledTimes(expected.coreCalls);
      expect(trace.preparedSql).toHaveLength(expected.preparedCount);
      expect(trace.bindings).toHaveLength(trace.preparedSql.length);
      expect(
        fingerprint(
          trace.preparedSql.map((sql, index) => ({
            sql,
            params: trace.bindings[index],
          })),
        ),
      ).toBe(expected.sqlFingerprint);
      expect(fingerprint(diagnostics)).toBe(expected.diagnosticsFingerprint);
      expect(register).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(rows).toHaveBeenCalledTimes(1);
      expect(programs).toHaveLength(1);
      const program = programs[0];
      expect(program?.stages).toHaveLength(2);
      expect(program?.physicalFrames).toHaveLength(1);
      expect(program?.stages[1]?.dependencies).toHaveLength(1);
      expect(program?.stages[1]?.dependencies[0]?.producerStage).toBe(0);
      expect(program?.stages[1]?.dependencies[0]?.output).toBe(
        program?.completedWholeOutputs[0]?.output,
      );
      expect(qualificationRequestOwnDataSnapshot(request.query)).toBe(before);
      expect(scopedFilterMetadata(request.query.filters)).toBe(metadata);
      expect(fingerprint(scopedFilterMetadata(request.query.filters))).toBe(
        metadataBefore,
      );
      expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(
        changesBefore,
      );
      expect(controller.signal.aborted).toBe(false);
      expect(forbiddenFetches).toBe(0);
      expect(
        list(field(field(result, "value"), "items")).length,
      ).toBeGreaterThan(0);
      if (operation === "pages") {
        const next = field(
          field(field(result, "value"), "pagination"),
          "nextCursor",
        );
        expect(typeof next).toBe("string");
        if (typeof next !== "string" || !next)
          throw new Error("expected_real_next_cursor");
        // The second request uses this execution's actual first-page cursor.
        cursor = next;
      }
    } finally {
      rows.mockRestore();
      core.mockRestore();
      register.mockRestore();
      resolve.mockRestore();
      vi.unstubAllGlobals();
      database.close();
    }
  }
}

it("preserves Channels Session DTO and ordered SQL through its real Program Source", async () => {
  await preservesListProgram("channels", "session");
});
it("preserves Channels Visitor and same-site team subject through its real Program Source", async () => {
  await preservesListProgram("channels", "visitor");
});
it("preserves Pages Session and its actual second-page cursor through real Program Sources", async () => {
  await preservesListProgram("pages", "session");
});
it("preserves Pages Visitor and its actual second-page cursor through real Program Sources", async () => {
  await preservesListProgram("pages", "visitor");
});
