// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  createTimeRange,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { createScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { SiteId } from "@/lib/edge/analytics/contract/types";
import { classifyAdvancedCountFilter } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as queries from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { evaluateWholeFilterMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import {
  type CountMembershipCommand,
  type CountMembershipCommandResult,
  planCountMembershipCommands,
} from "@/lib/edge/analytics/providers/d1/internal/whole-membership-count-program";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const siteId = SEED_SITE_ID as SiteId;
const subject = createSemanticSubjectDomain({
  origin: "site",
  siteIds: [siteId],
});
const coverage = new Map([[SEED_SITE_ID, SEED_BASE_MS - SEED_DAY_MS]]);

function fixture(dsl: string, queryTime: QueryTime = time) {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = { DB: createSqliteD1Database(database, trace) } as unknown as Env;
  const filters = parseFilterDsl(dsl, analyticsFilterRegistry);
  const support = classifyAdvancedCountFilter(filters, "session");
  if (support.kind !== "supported") throw new Error(support.code);
  const plan = createScopedFilterPlan("channels", filters, "session");
  if (!plan) throw new Error("Expected session scope");
  const input = {
    env,
    filters,
    subject,
    siteIds: [siteId],
    plan,
    time: queryTime,
    coverage,
  };
  return {
    database,
    trace,
    input,
    programInput: {
      ...input,
      support,
      readRange: queryTime.readRange ?? queryTime.range,
    },
  };
}

function compiledCommand(command: CountMembershipCommand) {
  return command.kind === "count-combined" ||
    command.kind === "count-payload-combined"
    ? command.query.query
    : command.query;
}

async function executeCommand(
  env: Env,
  command: CountMembershipCommand,
): Promise<CountMembershipCommandResult> {
  // Revalidate the actual plan and execute its compiled query through the real
  // D1 adapter. A command cannot pass by supplying synthetic control rows.
  expect(() => validateLogicalPlan(command.plan)).not.toThrow();
  const compiled = compiledCommand(command);
  expect(compiled.kind).toBe("query");
  expect(compiled.sql).toMatch(/SELECT/);
  expect(compiled.bindings?.length).toBeGreaterThan(0);
  switch (command.kind) {
    case "count-combined":
      return {
        kind: command.kind,
        value: await queries.queryAdvancedFilterCountCombined({
          env,
          query: command.query,
        }),
      };
    case "count-payload-combined":
      return {
        kind: command.kind,
        value: await queries.queryAdvancedFilterCountPayloadCombined({
          env,
          query: command.query,
        }),
      };
    case "count-guard":
      return {
        kind: command.kind,
        value: await queries.queryAdvancedFilterCountGuard({
          env,
          query: command.query,
          numericCompatibilityFields: command.numericCompatibilityFields,
        }),
      };
    case "count-matches":
      return {
        kind: command.kind,
        value: await queries.queryAdvancedFilterCountMatches({
          env,
          query: command.query,
          numericCompatibilityFields: command.numericCompatibilityFields,
        }),
      };
  }
}

async function run(
  context: ReturnType<typeof fixture>,
  afterRead?: () => void,
  signal?: AbortSignal,
) {
  const commands: CountMembershipCommand[] = [];
  const generator = planCountMembershipCommands({
    ...context.programInput,
    signal,
  });
  let step = generator.next();
  while (!step.done) {
    const command = step.value;
    commands.push(command);
    const value = await executeCommand(context.input.env, command);
    afterRead?.();
    step = generator.next(value);
  }
  expect(context.trace.preparedSql).toEqual(
    commands.map((command) => compiledCommand(command).sql),
  );
  expect(context.trace.bindings).toEqual(
    commands.map((command) => compiledCommand(command).bindings),
  );
  return { result: step.value, kinds: commands.map(({ kind }) => kind) };
}

async function expectOracle(
  context: ReturnType<typeof fixture>,
  expectedKinds: CountMembershipCommand["kind"][],
  nonempty = true,
) {
  const actual = await run(context);
  expect(actual.kinds).toEqual(expectedKinds);
  expect(actual.result.kind).toBe("evaluated");
  if (actual.result.kind !== "evaluated")
    throw new Error("Expected evaluated membership");
  const rows = (actual.result.matches.entityIds ?? []).map(
    ({ siteId, id }) => ({ siteId, id, kind: "entity" }),
  );
  expect(rows).toEqual(await evaluateWholeFilterMembership(context.input));
  if (nonempty) expect(rows.length).toBeGreaterThan(0);
  else expect(rows).toEqual([]);
}

it("executes a payload Count command with actual event facts and matches the original evaluator", async () => {
  const context = fixture(
    'count(event { event.payload("/plan") eq "pro" }) gt 0',
  );
  try {
    await expectOracle(context, ["count-payload-combined"]);
  } finally {
    context.database.close();
  }
});

it("keeps an overlapping explicit filter domain separate from the candidate domain", async () => {
  const context = fixture('count(page { page.path eq "/qualifier" }) gt 0', {
    ...time,
    filterRange: createTimeRange(
      SEED_BASE_MS + 2 * SEED_DAY_MS,
      SEED_BASE_MS + 5 * SEED_DAY_MS,
    ),
  });
  try {
    await expectOracle(context, ["count-guard", "count-matches"]);
  } finally {
    context.database.close();
  }
});

it("guards activity but emits no match command for a disjoint explicit filter domain", async () => {
  const context = fixture('count(page { page.path eq "/qualifier" }) gt 0', {
    ...time,
    filterRange: createTimeRange(
      SEED_BASE_MS + 7 * SEED_DAY_MS,
      SEED_BASE_MS + 8 * SEED_DAY_MS,
    ),
  });
  try {
    await expectOracle(context, ["count-guard"], false);
  } finally {
    context.database.close();
  }
});

it("uses guard then matches when the complete Count tree is too wide for a combined group", async () => {
  const dsl = Array.from(
    { length: 16 },
    (_, index) =>
      `count(page { page.path eq "/${index === 0 ? "qualifier" : `unmatched-${index}`}" }) gt 0`,
  ).join(" OR ");
  const context = fixture(dsl);
  try {
    await expectOracle(context, ["count-guard", "count-matches"]);
  } finally {
    context.database.close();
  }
});

for (const explicitRange of [false, true]) {
  it(`declines actual historical numeric storage before partial acceptance (${explicitRange ? "guard" : "combined"})`, async () => {
    const context = fixture(
      "count(page { page.durationMs gt 0 }) gt 0",
      explicitRange ? { ...time, filterRange: time.range } : time,
    );
    try {
      context.database.exec(
        "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id=(SELECT visit_id FROM visits ORDER BY visit_id LIMIT 1)",
      );
      const actual = await run(context);
      expect(actual.kinds).toEqual([
        explicitRange ? "count-guard" : "count-combined",
      ]);
      expect(actual.result).toMatchObject({
        kind: "legacy",
        fallbackReason: { kind: "numeric-data-domain" },
      });
      const diagnostics = createD1ReadDiagnostics();
      const rows = await evaluateWholeFilterMembership({
        ...context.input,
        diagnostics,
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual(
        actual.result.kind === "legacy"
          ? actual.result.fallbackReason
          : undefined,
      );
      expect(diagnostics.advancedFilterExecution?.strategy).toBe(
        "bounded-core",
      );
    } finally {
      context.database.close();
    }
  });
}

it("observes abort after an actual combined read before accepting its matches", async () => {
  const context = fixture('count(page { page.path eq "/qualifier" }) gt 0');
  const controller = new AbortController();
  try {
    await expect(
      run(context, () => controller.abort(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(context.trace.preparedSql).toHaveLength(1);
    const oracleController = new AbortController();
    const actualQuery = queries.queryAdvancedFilterCountCombined;
    const query = vi
      .spyOn(queries, "queryAdvancedFilterCountCombined")
      .mockImplementation(async (input) => {
        const result = await actualQuery(input);
        oracleController.abort();
        return result;
      });
    try {
      await expect(
        evaluateWholeFilterMembership({
          ...context.input,
          signal: oracleController.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      query.mockRestore();
    }
  } finally {
    context.database.close();
  }
});
