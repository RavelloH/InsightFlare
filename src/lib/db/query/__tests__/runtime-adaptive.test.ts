// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  aggregate,
  callFunction,
  count,
  distinct,
  eq,
  param,
  sort,
  union,
} from "@/lib/db";
import { constant, project, scan } from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createDatabaseClient } from "@/lib/db/query/client";
import { compileD1AdaptiveQueryForTest } from "@/lib/db/query/compiler";
import { compileD1Query } from "@/lib/db/query/compiler";
import { deriveRuntimeBooleanMembership } from "@/lib/db/query/physical/runtime-boolean-membership";
import {
  deriveRuntimeWindowCertificate,
  totalRuntimeGuardProducer,
} from "@/lib/db/query/physical/runtime-window-certificate";
import {
  lowerLogicalQuerySource,
  validatePhysicalQueryPlan,
} from "@/lib/db/query/physical-plan";
import { schema } from "@/lib/db/schema";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { siteQueryContext } from "@/lib/edge/analytics/contract";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import { COST_TIME } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import { SEED_SITE_ID } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const capture = vi.hoisted(() => ({ physical: [] as any[] }));
vi.mock("@/lib/db", async (importOriginal) => {
  const a = await importOriginal<any>();
  return {
    ...a,
    lowerLogicalPlan: (...args: any[]) => {
      const p = a.lowerLogicalPlan(...args);
      capture.physical.push(p);
      return p;
    },
  };
});
const bindings = (q: any) =>
  (q.bindings ?? []).map((v: any) => (typeof v === "boolean" ? Number(v) : v));
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";

it("selects, freshly validates, and executes an optional recipe and conservative consumer boundaries through the default compiler while preserving ordinary fixtures", async () => {
  const fixture = buildJourneyEventFieldsCostFixture(120);
  const native = createMigratedDatabase();
  for (const sql of fixture.seed) native.exec(sql);
  native.exec(
    `INSERT INTO analysis_definitions (id,site_id,kind,name,config_json,config_version,created_at,updated_at) VALUES ('w12-cost-visitor-funnel',${literal(SEED_SITE_ID)},'funnel','W12 visitor funnel',${literal(
      JSON.stringify({
        filterDslVersion: 1,
        progressionScope: "visitor",
        conversionWindowMs: 7 * 86400000,
        steps: [
          { id: "landing", filterDsl: 'page.path eq "/qualifier"' },
          { id: "qualified", filterDsl: 'event.name eq "qualifier"' },
        ],
      }),
    )},2,0,0)`,
  );
  native.exec(
    "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='v1'",
  );
  try {
    const runtime = createD1SiteQueryRuntime({
      env: {
        DB: createSqliteD1Database(native),
        MAIN_SECRET: "w12-analysis-membership-secret",
      } as never,
      siteId: SEED_SITE_ID,
      diagnostics: createD1ReadDiagnostics(),
    });
    const dto = await runtime.execute(
      "visitors",
      {
        context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
        time: COST_TIME,
        scopePreference: "session",
        filters: parseFilterDsl(
          "count(page { page.durationMs gt 5 }) gte 1",
          analyticsFilterRegistry,
        ),
        analysisContext: {
          type: "funnel",
          funnelId: "w12-cost-visitor-funnel",
          stepId: "qualified",
        },
        page: { limit: 3, cursor: null },
        sort: { key: "lastSeenAt", direction: "desc" },
      } as never,
      {
        onProviderError(e) {
          throw e;
        },
      },
    );
    expect(dto.ok).toBe(true);
    const old = capture.physical.at(-1);
    expect(old.fields[0].name).toBe("visitorId");
    const plan = lowerLogicalQuerySource({
      node: old.root,
      scope: old.scope,
      fields: old.fields,
    });
    const recipe = plan.runtimeAdaptiveCandidate!;
    expect(recipe).toBeDefined();
    expect(recipe.windows).toHaveLength(7);
    expect(recipe.positiveMembership).toHaveLength(2);
    validatePhysicalQueryPlan(plan);
    const proof = deriveRuntimeWindowCertificate(plan);
    expect(proof.eligible).toBe(true);
    if (!proof.eligible)
      throw new Error("fixture must carry the complete conditional proof");
    const cert = proof.certificate;
    const mutate = (object: any, key: string, value: any, reason: string) => {
      const old = object[key];
      object[key] = value;
      try {
        expect(deriveRuntimeWindowCertificate(plan)).toMatchObject({
          eligible: false,
          reason,
        });
      } finally {
        object[key] = old;
      }
    };
    expect(
      deriveRuntimeBooleanMembership(
        lowerLogicalQuerySource(
          project(scan(schema.visits), { v: constant(1) }),
        ),
      ),
    ).toEqual([]);
    expect(
      deriveRuntimeWindowCertificate({ ...plan, sharedRelations: [] }),
    ).toMatchObject({ eligible: false, reason: "no-repeated-ranked-owner" });
    expect(
      deriveRuntimeWindowCertificate({ ...plan, root: recipe.owner }),
    ).toMatchObject({ eligible: false, reason: "missing-terminal-order" });
    const unsafe = callFunction("abs", param(1));
    mutate(
      (plan.root as any).projections[0],
      "expression",
      unsafe,
      "unsafe-terminal-path",
    );
    mutate(
      cert.terminalSort,
      "keys",
      [{ expression: unsafe, direction: "ASC" }],
      "unsafe-terminal-order",
    );
    mutate(
      (recipe.owner as any).projections[0],
      "expression",
      unsafe,
      "partial-owner-producer",
    );
    const finalWindow = cert.windows.at(-1)!.window as any;
    mutate(
      finalWindow,
      "windows",
      [
        {
          ...finalWindow.windows[0],
          specification: { kind: "count-rows", partitionBy: [] },
        },
      ],
      "unsupported-window",
    );
    mutate(
      finalWindow,
      "windows",
      [finalWindow.windows[0], finalWindow.windows[0]],
      "unsupported-window",
    );
    const spec = finalWindow.windows[0].specification;
    mutate(
      spec,
      "orderBy",
      [{ expression: constant(1), direction: "ASC" }],
      "non-column-window-key",
    );
    mutate(
      cert.terminalSort,
      "keys",
      [{ expression: constant(1), direction: "ASC" }],
      "non-column-terminal-key",
    );
    const cyclicInput = (recipe.owner as any).input;
    const beforeCycle = cyclicInput.node;
    cyclicInput.node = recipe.owner;
    try {
      expect(deriveRuntimeWindowCertificate(plan)).toMatchObject({
        eligible: false,
        reason: "relation-cycle",
      });
      expect(totalRuntimeGuardProducer(recipe.owner)).toBe(recipe.owner);
    } finally {
      cyclicInput.node = beforeCycle;
    }
    const asRelation = (source: any) => ({
      ...source,
      kind: "relation",
      columns: Object.fromEntries(
        source.fields.map((f: any, i: number) => [
          f.name,
          {
            kind: "column",
            scope: source.scope,
            index: i,
            name: f.name,
            resultType: { affinity: f.affinity, nullable: f.nullable },
          },
        ]),
      ),
    });
    const report = asRelation({
      node: plan.root,
      scope: plan.scope,
      fields: plan.fields,
    });
    const rejected = (relation: any, reason: string) => {
      const fresh = lowerLogicalQuerySource(relation);
      // Compile ordinary SQL first: these are legal typed consumer shapes,
      // not malformed metadata that only a recognizer happened to reject.
      expect(
        compileD1Query({ ...fresh, runtimeAdaptiveCandidate: undefined }).sql,
      ).toBeTypeOf("string");
      expect(deriveRuntimeWindowCertificate(fresh)).toMatchObject({
        eligible: false,
        reason,
      });
    };
    const doubled = union(report, report, false);
    rejected(
      sort(doubled, [
        { expression: doubled.columns.visitorId, direction: "ASC" },
      ]),
      "distinct-union-owner-consumer",
    );
    const uniques = distinct(report);
    rejected(
      sort(uniques, [
        { expression: uniques.columns.visitorId, direction: "ASC" },
      ]),
      "unstable-distinct-representative",
    );
    const grouped = aggregate(report, {
      groupBy: { width: report.columns.screenWidth },
      aggregates: { total: count() },
    });
    rejected(
      sort(grouped, [{ expression: grouped.columns.width, direction: "ASC" }]),
      "unstable-group-representative",
    );
    rejected(
      sort(report, [
        { expression: report.columns.screenWidth, direction: "ASC" },
        { expression: report.columns.visitorId, direction: "ASC" },
      ]),
      "unstable-terminal-key",
    );
    const rename = (name: string) => {
      const fields = [{ ...plan.fields[0], name }, ...plan.fields.slice(1)];
      const root = {
        ...plan.root,
        fields,
        projections: [
          { ...(plan.root as any).projections[0], name },
          ...(plan.root as any).projections.slice(1),
        ],
      };
      return lowerLogicalQuerySource({ node: root, scope: root.scope, fields });
    };
    const tooLarge = compileD1AdaptiveQueryForTest(rename("x".repeat(60000)));
    expect(tooLarge.query).toBeUndefined();
    expect(tooLarge.derivation).toMatchObject({
      eligible: false,
      reason: "private-adaptive-budget",
    });
    expect(() =>
      compileD1AdaptiveQueryForTest(rename("x".repeat(100000))),
    ).toThrow(/D1 SQL statement/);
    for (const name of ["_D1_ADAPTIVE_TAG", "_d1_adaptive_allowed"]) {
      const collision = compileD1AdaptiveQueryForTest(rename(name));
      expect(collision.query).toBeUndefined();
      expect(collision.derivation).toMatchObject({
        eligible: false,
        reason: "private-adaptive-field-collision",
      });
    }
    const ordinary = compileD1Query({
      ...old,
      runtimeAdaptiveCandidate: undefined,
    });
    const selected = compileD1Query(plan);
    expect(selected).toEqual(ordinary);
    const calls: any[] = [];
    const client = createDatabaseClient({
      all: async (q: any) => {
        calls.push(q);
        return {
          success: true,
          results: native.prepare(q.sql).all(...bindings(q)),
          meta: { rows_read: 1, rows_written: 0, duration: 1 },
        };
      },
    } as never);
    const result = await client.all(selected);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("_d1_adaptive_allowed");
    expect(result.results).toEqual(
      native.prepare(ordinary.sql).all(...bindings(ordinary)),
    );
    const visitColumns = (
      native.prepare("PRAGMA table_info(visits)").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    for (const control of [
      {
        name: "fractional timestamp",
        setup() {
          native.exec(
            "UPDATE visits SET started_at=started_at+0.5 WHERE visit_id='v2'",
          );
        },
      },
      {
        name: "BLOB id",
        setup() {
          native.exec(
            "UPDATE visits SET visit_id=CAST(visit_id AS BLOB) WHERE visit_id='v3'",
          );
        },
      },
      {
        name: "NULL id ties with different metadata",
        setup() {
          for (const label of ["first", "second"]) {
            const values = visitColumns.map((name) =>
              name === "visit_id"
                ? "NULL"
                : name === "started_at"
                  ? "1700604799000"
                  : name === "browser"
                    ? literal(label)
                    : '"' + name + '"',
            );
            native.exec(
              "INSERT INTO visits (" +
                visitColumns.map((name) => '"' + name + '"').join(",") +
                ") SELECT " +
                values.join(",") +
                " FROM visits WHERE visit_id='v2'",
            );
          }
        },
      },
    ]) {
      native.exec("BEGIN");
      try {
        control.setup();
        calls.length = 0;
        const expected = native
          .prepare(ordinary.sql)
          .all(...bindings(ordinary));
        expect((await client.all(selected)).results, control.name).toEqual(
          expected,
        );
        expect(
          calls.map((q) => q.sql),
          control.name,
        ).toEqual([calls[0].sql, ordinary.sql]);
        expect(calls[0].sql).toContain("_d1_adaptive_allowed");
      } finally {
        native.exec("ROLLBACK");
      }
    }
    // Removing optional metadata from a valid ordinary fixture is deliberately
    // an ordinary route; it cannot grant an unproven adaptive execution.
    const missing = { ...plan, runtimeAdaptiveCandidate: undefined };
    validatePhysicalQueryPlan(missing);
    calls.length = 0;
    await client.all(compileD1Query(missing));
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe(ordinary.sql);
    const forged = [
      { ...recipe, kind: "other" },
      { ...recipe, root: recipe.owner },
      { ...recipe, owner: recipe.root },
      { ...recipe, terminalSort: recipe.owner },
      { ...recipe, windows: recipe.windows.slice(1) },
      { ...recipe, windows: [...recipe.windows].reverse() },
      { ...recipe, windows: [...recipe.windows, recipe.windows[0]] },
      { ...recipe, positiveMembership: [] },
      {
        ...recipe,
        positiveMembership: [...recipe.positiveMembership].reverse(),
      },
    ];
    for (const candidate of forged)
      expect(() =>
        compileD1Query({
          ...plan,
          runtimeAdaptiveCandidate: candidate,
        } as never),
      ).toThrow(/adaptive candidate is inconsistent/);
    const mutable = { ...recipe, windows: [...recipe.windows] };
    const p = { ...plan, runtimeAdaptiveCandidate: mutable };
    validatePhysicalQueryPlan(p);
    mutable.windows.pop();
    expect(() => validatePhysicalQueryPlan(p)).toThrow(
      /adaptive candidate is inconsistent/,
    );
    // A different fresh lower has unrelated current identities; no cross-query
    // recipe may be replayed even though the public output has a valid shape.
    const simple = lowerLogicalQuerySource(
      project(scan(schema.visits), { v: constant(1) }),
    );
    expect(simple.runtimeAdaptiveCandidate).toBeUndefined();
    expect(() =>
      validatePhysicalQueryPlan({
        ...simple,
        runtimeAdaptiveCandidate: recipe,
      }),
    ).toThrow(/adaptive candidate is inconsistent/);
    calls.length = 0;
    await client.all(compileD1Query(simple));
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain("_d1_adaptive_allowed");
    // Existing static metadata rejection remains ahead of private admission.
    expect(() => compileD1Query({ ...plan, sharedRelations: [] })).toThrow();
  } finally {
    native.close();
  }
}, 120000);
