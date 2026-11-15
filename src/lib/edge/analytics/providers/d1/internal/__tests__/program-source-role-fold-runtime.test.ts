// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { compileD1Query, lowerLogicalPlan } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { snapshotLogicalPlan as snapshotUnvalidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";
import {
  eventMembershipRelation,
  type PreparedMembershipMatch,
  visitMembershipRelation,
} from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as coreOperation from "@/lib/edge/analytics/providers/d1/internal/whole-membership-core-operation";
import { createWholeOriginalCompletionMembershipInvocation } from "@/lib/edge/analytics/providers/d1/internal/whole-membership-stage-program";
import type { Env } from "@/lib/edge/types";

afterEach(() => vi.restoreAllMocks());

// This remains a foreign plan identity, but satisfies the public validated-plan
// input contract before the program checks that identity.
function snapshotLogicalPlan(
  plan: Parameters<typeof snapshotUnvalidatedLogicalPlan>[0],
) {
  return validateLogicalPlan(snapshotUnvalidatedLogicalPlan(plan));
}

/** Invalid values enter only at the actual Core evaluator boundary. Coverage
 * and activity commands still read real SQLite, and the concrete invocation
 * records its own terminal. This helper never supplies a completion or rows to
 * the program/frame API. The pure legacy normalizers are physical controls,
 * not a historical provider oracle or an authorization source. */
async function completedFixture(injected: readonly PreparedMembershipMatch[]) {
  const database = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 12 }),
  ])
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "native-local",
  } as Env;
  const context = siteQueryContext(SEED_SITE_ID, "private-dashboard");
  const time = createQueryTime(
    SEED_BASE_MS,
    SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
    "UTC",
    SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
  );
  const prepared = prepareScopedQuery("event-records", {
    context,
    time,
    filters: EMPTY_FILTER_DOCUMENT,
    scopePreference: "event",
  });
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("fixture_preparation_missing");
  const filters = prepared.filters;
  const scopePlan = prepared.scopePlan;
  expect(scopePlan.mode).toBe("observation");
  const actualEvaluate = coreOperation.evaluateWholeMembershipCoreRows;
  const evaluate = vi
    .spyOn(coreOperation, "evaluateWholeMembershipCoreRows")
    .mockImplementation((...args: Parameters<typeof actualEvaluate>) => {
      // Keep the real evaluator's complete four/five-argument tuple. Vitest's
      // contextual inference otherwise widens a named trailing rest array.
      const [state, rows, payloads, node, resultScope] = args;
      // Exercise the real evaluator before changing only its boundary result.
      if (resultScope === undefined)
        actualEvaluate(state, rows, payloads, node);
      else actualEvaluate(state, rows, payloads, node, resultScope);
      return [...injected];
    });
  const invocation = createWholeOriginalCompletionMembershipInvocation({
    env,
    subject: semanticSubjectFromQuerySubject(context.subject),
    queryTime: prepared.time,
    filters,
    scope: "event",
    originalScopePlan: scopePlan,
  });
  const program = new D1LogicalProgramExecution();
  const promise = program.executeWholeAtOriginalCheckpoint(invocation);
  expect(program.completedWholeOutputs).toEqual([]);
  const matches = await promise;
  expect(matches).toEqual(injected);
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(trace.preparedSql.length).toBeGreaterThanOrEqual(2);
  const completed = program.completedWholeOutput(invocation);
  if (!completed) throw new Error("fixture_nonempty_terminal_missing");
  const producer = completed;
  expect(Object.isFrozen(producer.plan)).toBe(true);
  expect(program.completedWholeOutputs).toEqual([producer]);
  expect(producer.output.fields.map((field) => field.name)).toEqual([
    "site_id",
    "match_kind",
    "match_id",
  ]);

  function consumer(role: "visit" | "event", unknownChain = false) {
    const builder = new LogicalPlanBuilder(producer.plan.context);
    const imported = builder.importProgramAnalysisResult(
      producer.plan,
      producer.output.id,
      producer.output.fields.map(({ name }) => ({ field: name })),
    );
    const selected = builder.filter(
      imported,
      builder.compare(
        "eq",
        builder.slot(imported, "match_kind"),
        builder.literal(role, { kind: "scalar", scalar: "string" }),
      ),
    );
    const projected = builder.project(selected, {
      site_id: builder.slot(selected, "site_id"),
      member_id: builder.slot(selected, "match_id"),
    });
    const pair = builder.distinct(projected, [
      { input: "site_id" },
      { input: "member_id" },
    ]);
    // LIMIT remains a valid keyed pair, but is deliberately outside the finite
    // constant-fold license. It must not silently read an unregistered result.
    const input = unknownChain ? builder.limit(pair, 1) : pair;
    const siteId = input.slots.site_id;
    const memberId = input.slots.member_id;
    if (siteId === undefined || memberId === undefined)
      throw new Error("fixture_pair_missing");
    const selection = createSemanticScopedSourceSelection(
      {
        profile: "prepared-scoped-v1",
        filters,
        expectedPlan: scopePlan,
        subject: producer.plan.context.subject,
        time: producer.plan.context.time,
      },
      [{ input: input.id, role, siteId, memberId }],
    );
    // Source entities have composite physical keys. The generic command
    // output contract exports scalar slots, so request the actual local ID.
    const memberAttribute =
      role === "visit" ? "page.report.localId" : "event.report.localId";
    const source = builder.source(role === "visit" ? "page" : "event", {
      selection,
      attributes: [memberAttribute],
      membershipInputs: [
        {
          relation: input,
          role,
          siteId: "site_id",
          memberId: "member_id",
        },
      ],
    });
    builder.output("members", source, [
      {
        name: "member",
        slot: `attribute:${memberAttribute}`,
      },
    ]);
    const draft = builder.finish();
    const stage = program.appendStage(draft, ["members"]);
    const sourceNode = stage.plan.nodes.find((node) => node.kind === "source");
    const edge = sourceNode?.membershipInputs?.[0];
    if (!edge) throw new Error("fixture_source_edge_missing");
    return { draft, stage, edge };
  }
  return { database, env, trace, program, invocation, producer, consumer };
}

function match(kind: PreparedMembershipMatch["kind"], id: string) {
  return { siteId: SEED_SITE_ID, kind, id };
}

it("selects the visible role before validating values, preserving legacy pair SQL, binding order and deduplication", async () => {
  const ignored = match("event", "ignored");
  expect(Reflect.set(ignored, "siteId", null)).toBe(true);
  expect(Reflect.set(ignored, "id", undefined)).toBe(true);
  const ids = [
    "z",
    "a",
    "ä",
    "A",
    "a",
    "x\u0000y",
    "emoji-😀",
    "isolated-\ud800",
  ];
  const rows = [ignored, ...ids.map((id) => match("visit", id))];
  const fixture = await completedFixture(rows);
  try {
    const { program, consumer, trace } = fixture;
    const { stage, edge } = consumer("visit");
    const reads = trace.preparedSql.length;
    const relation = program.foldSourceMembershipInput(stage.plan, edge);
    if (!relation) throw new Error("fixture_fold_missing");
    const actual = compileD1Query(lowerLogicalPlan(relation));
    const expected = compileD1Query(
      lowerLogicalPlan(visitMembershipRelation([SEED_SITE_ID], rows)),
    );
    expect(actual.sql).toBe(expected.sql);
    expect(actual.bindings).toEqual(expected.bindings);
    if (actual.bindings === undefined)
      throw new Error("fixture_role_bindings_missing");
    expect(actual.bindings.length).toBe(new Set(ids).size * 2);
    // The expected sequence is locale ordering, not insertion/codepoint order.
    const ordered = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    expect(ordered).not.toEqual([...new Set(ids)]);
    const explicitOrder = compileD1Query(
      lowerLogicalPlan(
        visitMembershipRelation(
          [SEED_SITE_ID],
          ordered.map((id) => match("visit", id)),
        ),
      ),
    );
    expect(actual.bindings).toEqual(explicitOrder.bindings);
    const lowered = program.lowerStageOutput(
      stage,
      "members",
      "program-role-fold-boundary",
    );
    expect(lowered.command.kind).toBe("logical-sql");
    expect(
      program.lowerStageOutput(stage, "members", "program-role-fold-boundary")
        .command,
    ).toEqual(lowered.command);
    expect(trace.preparedSql).toHaveLength(reads);
  } finally {
    fixture.database.close();
  }
});

it("rejects only a selected role's invalid identity at consumption, while a valid other role remains consumable", async () => {
  const invalid = match("visit", "invalid");
  expect(Reflect.set(invalid, "id", null)).toBe(true);
  const rows = [invalid, match("event", "event-valid")];
  const fixture = await completedFixture(rows);
  try {
    const { program, consumer, trace } = fixture;
    const visit = consumer("visit");
    const event = consumer("event");
    const reads = trace.preparedSql.length;
    expect(() => visitMembershipRelation([SEED_SITE_ID], rows)).toThrow(
      "prepared_membership_identity_invalid",
    );
    expect(() =>
      program.lowerStageOutput(visit.stage, "members", "selected-invalid"),
    ).toThrow("prepared_membership_identity_invalid");
    const relation = program.foldSourceMembershipInput(
      event.stage.plan,
      event.edge,
    );
    if (!relation) throw new Error("fixture_event_fold_missing");
    expect(compileD1Query(lowerLogicalPlan(relation))).toEqual(
      compileD1Query(
        lowerLogicalPlan(eventMembershipRelation([SEED_SITE_ID], rows)),
      ),
    );
    expect(
      program.lowerStageOutput(event.stage, "members", "other-valid").command
        .kind,
    ).toBe("logical-sql");
    expect(trace.preparedSql).toHaveLength(reads);
  } finally {
    fixture.database.close();
  }
});

it("requires the actual declared producer and actual Source edge, without consuming the valid path on rejection", async () => {
  const fixture = await completedFixture([match("visit", "visit-valid")]);
  try {
    const { program, consumer, trace } = fixture;
    const { stage, edge, draft } = consumer("visit");
    const reads = trace.preparedSql.length;
    const foreign = new D1LogicalProgramExecution();
    expect(() => foreign.appendStage(draft, ["members"])).toThrow(
      "logical_program_producer_not_declared",
    );
    expect(() =>
      program.foldSourceMembershipInput(stage.plan, { ...edge }),
    ).toThrow("logical_program_source_edge_foreign");
    expect(() =>
      program.foldSourceMembershipInput(snapshotLogicalPlan(stage.plan), edge),
    ).toThrow("logical_program_source_edge_foreign");
    expect(() =>
      foreign.lowerStageOutput(stage, "members", "foreign-stage"),
    ).toThrow("logical_program_stage_foreign");
    expect(
      program.lowerStageOutput(stage, "members", "valid-after").command.kind,
    ).toBe("logical-sql");
    expect(trace.preparedSql).toHaveLength(reads);
  } finally {
    fixture.database.close();
  }
});

it("keeps an unknown but valid relational chain explicitly unsupported with zero report reads", async () => {
  const fixture = await completedFixture([match("visit", "visit-valid")]);
  try {
    const { program, consumer, trace } = fixture;
    const unknown = consumer("visit", true);
    const reads = trace.preparedSql.length;
    expect(
      program.foldSourceMembershipInput(unknown.stage.plan, unknown.edge),
    ).toBeUndefined();
    expect(() =>
      program.lowerStageOutput(unknown.stage, "members", "unsupported-chain"),
    ).toThrow("logical_program_import_requires_supported_constant_fold");
    expect(trace.preparedSql).toHaveLength(reads);
    const supported = consumer("visit");
    expect(
      program.lowerStageOutput(supported.stage, "members", "supported-after")
        .command.kind,
    ).toBe("logical-sql");
  } finally {
    fixture.database.close();
  }
});

it("exposes only the actual immutable terminal and rejects invocation replay or a foreign execution", async () => {
  const fixture = await completedFixture([match("visit", "visit-valid")]);
  try {
    const { program, invocation, producer, trace } = fixture;
    const reads = trace.preparedSql.length;
    expect(program.completedWholeOutput(invocation)?.plan).toBe(producer.plan);
    expect(program.completedWholeOutput(invocation)?.output).toBe(
      producer.output,
    );
    expect(Object.isFrozen(producer.output)).toBe(true);
    expect(() => program.executeWholeAtOriginalCheckpoint(invocation)).toThrow(
      "logical_program_invocation_replayed",
    );
    expect(() =>
      new D1LogicalProgramExecution().completedWholeOutput(invocation),
    ).toThrow("logical_program_invocation_foreign");
    expect(trace.preparedSql).toHaveLength(reads);
  } finally {
    fixture.database.close();
  }
});
