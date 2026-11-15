// @vitest-environment node
// Portable proposal: actual runtime only; no capture mode, filesystem writes, or alternate old source.
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as staged from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as programs from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

type Mutation =
  "core2-null" | "core2-payload-null" | "activity-cap" | "payload-cap";
const cases = [
  { scope: "session", mutation: "core2-payload-null" },
  { scope: "visitor", mutation: "core2-null" },
  { scope: "session", mutation: "activity-cap" },
  { scope: "session", mutation: "payload-cap" },
] as const;

for (const sample of cases) {
  const { scope } = sample;
  it(`${scope}/${sample.mutation}: preserves physical checkpoints and private predecessor authority`, async () => {
    const database = createMigratedDatabase();
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 24 }),
    ])
      database.exec(sql);
    const storageSetupSql = [
      "UPDATE visits SET duration_ms=1",
      "UPDATE visits SET duration_ms='invalid-duration' WHERE rowid=(SELECT min(rowid) FROM visits)",
    ];
    for (const sql of storageSetupSql) database.exec(sql);
    const diagnostics = createD1ReadDiagnostics();
    const original = createSqliteD1Database(database);
    const launches: {
      ordinal: number;
      sql: string;
      params: readonly unknown[];
      status: string;
      error?: unknown;
    }[] = [];
    const controller = new AbortController();
    let captured:
      | Parameters<
          typeof programs.executeChannelListQualificationProgram
        >[0]["deferred"]
      | undefined;
    let mutation: unknown;
    let result: unknown;
    let hookFailure: unknown;
    const actualProgram = programs.executeChannelListQualificationProgram;
    const programSpy = vi
      .spyOn(programs, "executeChannelListQualificationProgram")
      .mockImplementation((input) => {
        captured = input.deferred;
        return actualProgram(input);
      });
    const registered = vi.spyOn(bridge, "registerPreparedMembership");
    const resolved = vi.spyOn(bridge, "resolvePreparedMembership");
    const evaluator = vi.spyOn(core, "evaluateFilterDocument");

    const payloadDsl = 'first(event.payload("/amount")) gt 0';
    let secondMutation: unknown;
    const fixtureExec = (sql: string) => database.exec(sql);
    const seedPayload = (cap: boolean) => {
      fixtureExec(
        `INSERT INTO custom_event_json_paths(id,site_id,site_pk,path,last_seen_at,created_at) VALUES(1,'${SEED_SITE_ID}',1,'',0,0),(2,'${SEED_SITE_ID}',1,'/amount',0,0)`,
      );
      fixtureExec(
        `INSERT INTO custom_event_json_keys(id,site_id,site_pk,key,last_seen_at,created_at) VALUES(1,'${SEED_SITE_ID}',1,'amount',0,0)`,
      );
      if (cap)
        fixtureExec(
          `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50001) INSERT INTO custom_event_json_nodes(event_pk,node_id,parent_node_id,key_id,path_id,value_type,array_index,depth,member_order) SELECT (SELECT min(event_pk) FROM custom_events),x,NULL,NULL,2,0,NULL,0,NULL FROM n`,
        );
      else {
        fixtureExec(
          `INSERT INTO custom_event_json_nodes(event_pk,node_id,parent_node_id,key_id,path_id,value_type,array_index,depth,member_order) SELECT event_pk,1,NULL,NULL,1,4,NULL,0,NULL FROM custom_events UNION ALL SELECT event_pk,2,1,1,2,2,NULL,1,0 FROM custom_events`,
        );
        fixtureExec(
          `INSERT INTO custom_event_json_values(event_pk,node_id,site_id,event_name_id,path_id,occurred_at,scope_node_id,value_type,string_value,string_hash,number_value,boolean_value,site_pk) SELECT event_pk,2,site_id,event_name_id,2,occurred_at,1,2,NULL,NULL,1,NULL,site_pk FROM custom_events`,
        );
      }
    };
    const mutate = (
      kind: Mutation,
      sql: string,
      rows: readonly Record<string, unknown>[],
    ) => {
      if (!captured) return;
      if (mutation) {
        if (
          !secondMutation &&
          ((kind === "core2-null" &&
            rows.some((row) => row.kind === "page" || row.kind === "event")) ||
            (kind === "core2-payload-null" &&
              rows.some((row) => "node_id" in row && "value_type" in row)))
        ) {
          const before = captured.filters.root;
          expect(Reflect.set(captured.filters, "root", null)).toBe(true);
          secondMutation = {
            checkpoint:
              kind === "core2-null"
                ? "activity-read-completed-before-Core2"
                : "payload-read-completed-before-reconstruction-and-Core2",
            before,
            after: captured.filters.root,
            sql,
          };
        }
        return;
      }
      const before = captured.filters.root;
      const dsl = payloadDsl;
      expect(
        Reflect.set(
          captured.filters,
          "root",
          parseFilterDsl(dsl, analyticsFilterRegistry).root,
        ),
      ).toBe(true);
      mutation = {
        kind,
        checkpoint: "initial-fused-read-completed",
        before,
        after: captured.filters.root,
        sql,
      };
      seedPayload(kind === "payload-cap");
      if (kind === "activity-cap") {
        const columns = database.prepare("PRAGMA table_info(visits)").all() as {
          name: string;
        }[];
        const names = columns.map((row) => `"${row.name}"`);
        const expressions = columns.map((row) =>
          row.name === "visit_id" ? "'cap-'||n.x" : `v."${row.name}"`,
        );
        fixtureExec(
          `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20001) INSERT INTO visits(${names.join(",")}) SELECT ${expressions.join(",")} FROM n CROSS JOIN (SELECT * FROM visits ORDER BY rowid LIMIT 1) v`,
        );
      }
    };
    // Observe launch order without introducing a new async/all return frame.
    // The completion reaction is registered before the real query's awaiting
    // consumer; only the configured hook changes captured values. Returned DB
    // promises and rows are the original adapter's actual values.
    const wrapped = new Proxy(original, {
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
                    const record = {
                      ordinal: launches.length,
                      sql,
                      params,
                      status: "pending",
                    };
                    launches.push(record);
                    const pending = Reflect.apply(
                      prepared.all,
                      prepared,
                      args,
                    ) as ReturnType<D1PreparedStatement["all"]>;
                    void pending.then(
                      (value) => {
                        record.status = "completed";
                        if (captured) {
                          try {
                            mutate(
                              sample.mutation,
                              sql,
                              value.results as Record<string, unknown>[],
                            );
                          } catch (cause) {
                            hookFailure = cause;
                          }
                        }
                      },
                      (cause) => {
                        record.status = "failed";
                        Object.assign(record, { error: cause });
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
    const actualBind = staged.bindDeferredChannelMembershipSuccessor;
    let authorityChecks = 0;
    const bindSpy = vi
      .spyOn(staged, "bindDeferredChannelMembershipSuccessor")
      .mockImplementation((input) => {
        const before = launches.length;
        const copiedOwner = { ...input.deferred };
        expect(staged.hasDeferredChannelMembershipProgram(copiedOwner)).toBe(
          false,
        );
        expect(() => actualBind({ ...input, deferred: copiedOwner })).toThrow(
          "deferred_event_qualification_untrusted",
        );
        expect(() => actualBind({ ...input, siteId: "other-site" })).toThrow(
          "channels_membership_reader_context_mismatch",
        );
        expect(() =>
          actualBind({ ...input, queryTime: { ...input.queryTime } }),
        ).toThrow("channels_membership_reader_context_mismatch");
        expect(() =>
          actualBind({ ...input, scopePlan: { ...input.scopePlan } }),
        ).toThrow("channels_membership_reader_context_mismatch");
        const copiedFilters = Object.defineProperties(
          { ...input.filters },
          Object.getOwnPropertyDescriptors(input.filters),
        );
        expect(() => actualBind({ ...input, filters: copiedFilters })).toThrow(
          "channels_membership_successor_not_available",
        );
        const frame = input.deferred.channelMembershipInvocation;
        expect(frame).toBeDefined();
        if (!frame) throw new Error("expected-real-membership-frame");
        const stages = frame.observedSemanticStages();
        expect(stages).toHaveLength(2);
        expect(
          stages[0]?.nodes.some(
            (node) => node.kind === "whole-filter-membership",
          ),
        ).toBe(true);
        expect(
          stages[1]?.nodes.some((node) => node.kind === "whole-filter-core"),
        ).toBe(true);
        expect(() => frame.completedFor(structuredClone(stages[0]!))).toThrow(
          "channels_membership_predecessor_not_completed",
        );
        expect(frame.completedFor(stages[0]!).matches.length).toBeGreaterThan(
          0,
        );
        // All previous invalid attempts and canonical construction failure leave
        // the actual single reader slot available for its original successful bind.
        expect(() => actualBind({ ...input, limit: Number.NaN })).toThrow();
        expect(launches).toHaveLength(before);
        const value = actualBind(input);
        expect(() => actualBind(input)).toThrow(
          "channels_membership_successor_not_available",
        );
        authorityChecks++;
        return value;
      });
    try {
      const runtime = createD1SiteQueryRuntime({
        env: { DB: wrapped, MAIN_SECRET: "w56-native-only" } as Env,
        siteId: SEED_SITE_ID,
        diagnostics,
      });
      const pending = runtime.execute(
        "channels",
        {
          context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
          time: createQueryTime(
            SEED_BASE_MS,
            SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
            "UTC",
            SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
          ),
          scopePreference: scope,
          mode: "list",
          limit: 3,
          filters: parseFilterDsl(
            "count(page { page.durationMs gt 0 }) gte 1",
            analyticsFilterRegistry,
          ),
        },
        { signal: controller.signal },
      );
      result = await pending;
      expect(hookFailure, "completion observer must not fail").toBeUndefined();
      expect(
        mutation,
        "actual naturally admitted fused completion must fire",
      ).toBeDefined();
      expect(
        captured,
        "original Count deferred route must be naturally entered",
      ).toBeDefined();
      if (
        sample.mutation === "core2-null" ||
        sample.mutation === "core2-payload-null"
      ) {
        expect(evaluator).toHaveBeenCalledTimes(1);
        expect(secondMutation).toBeDefined();
        expect(authorityChecks).toBe(1);
        expect(result).toEqual({
          ok: true,
          data: {
            items: [
              { channel: "referral", views: 8, sessions: 7, visitors: 4 },
              { channel: "organic_search", views: 7, sessions: 6, visitors: 4 },
              { channel: "direct", views: 5, sessions: 5, visitors: 3 },
            ],
          },
          meta: {
            time: {
              range: {
                startMs: SEED_BASE_MS,
                endExclusiveMs: SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
              },
              reportingTimeZone: "UTC",
              capturedAtMs: SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
            },
            source: "raw",
            approximateVisitors: false,
            filterScope: { requested: scope, resolved: scope },
          },
        });
        expect(launches).toHaveLength(5);
        const commands =
          captured?.channelMembershipInvocation?.observedSqlCommands();
        expect(commands).toHaveLength(3);
        expect(
          commands?.map((command) => {
            if (command.kind !== "logical-sql")
              throw new Error(
                "channels_staged_test_expected_single_sql_command",
              );
            return {
              sql: command.query.sql,
              params: command.query.bindings,
            };
          }),
        ).toEqual(
          [launches[0], launches[2], launches[3]].map((record) => ({
            sql: record?.sql,
            params: record?.params,
          })),
        );
        expect(
          commands?.map((command) =>
            command.plan.nodes.some((node) => node.kind === "membership-read"),
          ),
        ).toEqual([true, false, true]);
        await expect(
          captured?.channelMembershipInvocation?.executeAtOriginalEvaluatorCheckpoint(),
        ).rejects.toThrow("channels_membership_stage_replayed");
        await expect(
          captured?.channelMembershipInvocation?.readCoverageAtOriginalCheckpoint(),
        ).rejects.toThrow("channels_coverage_predecessor_replayed");
      } else {
        const countSql =
          sample.mutation === "activity-cap"
            ? "SELECT count(*) AS rows FROM visits"
            : "SELECT count(*) AS rows FROM custom_event_json_nodes";
        expect(database.prepare(countSql).get()).toEqual({
          rows: sample.mutation === "activity-cap" ? 20025 : 50001,
        });
        expect(evaluator).not.toHaveBeenCalled();
        expect(bindSpy).not.toHaveBeenCalled();
        expect(result).toEqual({
          ok: false,
          error: {
            kind: "invalid-input",
            issues: [
              {
                path: "filters",
                code:
                  sample.mutation === "activity-cap"
                    ? "filter_activity_limit_exceeded"
                    : "filter_payload_node_limit_exceeded",
              },
            ],
          },
        });
        expect(launches).toHaveLength(4);
      }
      expect(registered).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
    } finally {
      bindSpy.mockRestore();
      programSpy.mockRestore();
      registered.mockRestore();
      resolved.mockRestore();
      evaluator.mockRestore();
      database.close();
    }
  });
}
