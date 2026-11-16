// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { evaluateWholeFilterMembership } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import {
  createDeferredWholeOriginalCompletionMembershipInvocation,
  createWholeOriginalCompletionMembershipInvocation,
} from "@/lib/edge/analytics/providers/d1/internal/whole-membership-stage-program";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const envelopeHook = vi.hoisted(() => ({
  override: undefined as undefined | (() => never),
}));
vi.mock(
  import("@/lib/edge/analytics/engine/advanced-sequence-filter-plan"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      buildSequenceAggregateEnvelope: (
        ...args: Parameters<typeof actual.buildSequenceAggregateEnvelope>
      ) =>
        envelopeHook.override?.() ??
        actual.buildSequenceAggregateEnvelope(...args),
    };
  },
);

const END = SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS;
const baseTime = createQueryTime(
  SEED_BASE_MS,
  END,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);

function fixture(dsl: string, scope: "session" | "event" = "event") {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = { DB: createSqliteD1Database(database, trace) } as Env;
  const queryContext = siteQueryContext(SEED_SITE_ID, "api-v1");
  const request = prepareScopedQuery("event-summary", {
    context: queryContext,
    time: baseTime,
    scopePreference: scope,
    filters: parseFilterDsl(dsl, analyticsFilterRegistry),
  } as QueryInput) as unknown as { filters: FilterDocument };
  const metadata = scopedFilterMetadata(request.filters);
  if (!metadata) throw new Error("expected-scoped-fixture");
  const input = {
    env,
    subject: semanticSubjectFromQuerySubject(queryContext.subject),
    queryTime: baseTime as QueryTime,
    filters: request.filters,
    scope,
    originalScopePlan: metadata.plan as ScopedFilterPlan,
  };
  return { database, trace, env, input, metadata };
}

const payloadFilter = 'first(event.payload("/amount")) gt 0';

it("rejects replayed and foreign deferred owners before any stage starts", () => {
  const f = fixture(payloadFilter);
  try {
    const invocation =
      createDeferredWholeOriginalCompletionMembershipInvocation(f.input);
    const owner = {};
    expect(() => invocation.assertSameDeferredOwner(owner)).toThrow(
      "channels_membership_deferred_owner_mismatch",
    );
    invocation.retainDeferredOwnerAtOriginalConstruction(owner);
    expect(() =>
      invocation.retainDeferredOwnerAtOriginalConstruction({}),
    ).toThrow("channels_membership_deferred_owner_replayed");
    expect(() => invocation.assertSameDeferredOwner({})).toThrow(
      "channels_membership_deferred_owner_mismatch",
    );
    expect(() => invocation.assertSameDeferredOwner(owner)).not.toThrow();
    // Nothing was read or completed by the ownership checks.
    expect(invocation.observedSqlCommands()).toEqual([]);
    expect(f.trace.preparedSql).toEqual([]);
  } finally {
    f.database.close();
  }
});

it("refuses projection, reader filters and reader consumers before their checkpoints", () => {
  const f = fixture(payloadFilter);
  try {
    const invocation =
      createDeferredWholeOriginalCompletionMembershipInvocation(f.input);
    const owner = {};
    invocation.retainDeferredOwnerAtOriginalConstruction(owner);
    expect(() =>
      invocation.projectAtOriginalRegistrationCheckpoint(owner),
    ).toThrow("channels_membership_projection_not_available");
    expect(() =>
      invocation.retainReaderFiltersAtOriginalReturnCheckpoint(
        owner,
        f.input.filters,
      ),
    ).toThrow("channels_membership_reader_filters_replayed");
    // Only the page-role profile can retain a reader consumer.
    expect(() =>
      invocation.retainReaderConsumerAtOriginalFallbackCheckpoint(
        owner,
        {} as never,
      ),
    ).toThrow("page_membership_reader_consumer_replayed");
    // Each of these also requires the exact retained owner.
    expect(() =>
      invocation.projectAtOriginalRegistrationCheckpoint({}),
    ).toThrow("channels_membership_deferred_owner_mismatch");
    expect(() => invocation.completedFor({} as never)).toThrow(
      "channels_membership_predecessor_not_completed",
    );
  } finally {
    f.database.close();
  }
});

it("observes an already aborted signal at the coverage checkpoint before any read", async () => {
  const f = fixture(payloadFilter);
  try {
    const controller = new AbortController();
    controller.abort();
    const invocation = createWholeOriginalCompletionMembershipInvocation({
      ...f.input,
      signal: controller.signal,
    });
    await expect(
      invocation.readCoverageAtOriginalCheckpoint(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.trace.preparedSql).toEqual([]);
    // The one coverage slot is consumed even by the aborted attempt.
    await expect(invocation.readCoverageAtOriginalCheckpoint()).rejects.toThrow(
      "channels_coverage_predecessor_replayed",
    );
  } finally {
    f.database.close();
  }
});

it("never reuses a missing coverage predecessor for the non-raw program entry", async () => {
  const f = fixture(payloadFilter);
  try {
    const invocation = createWholeOriginalCompletionMembershipInvocation(
      f.input,
    );
    await expect(
      invocation.executeAtOriginalEvaluatorCheckpoint(),
    ).rejects.toThrow("channels_coverage_predecessor_context_mismatch");
    // No silent coverage read took its place.
    expect(f.trace.preparedSql).toEqual([]);
    await expect(
      invocation.executeAtOriginalEvaluatorCheckpoint(),
    ).rejects.toThrow("channels_membership_stage_replayed");
  } finally {
    f.database.close();
  }
});

it("rejects a second raw execution of the same private frame", async () => {
  const f = fixture(payloadFilter);
  try {
    const invocation = createWholeOriginalCompletionMembershipInvocation(
      f.input,
    );
    const first = await invocation.executeRawAtOriginalEvaluatorCheckpoint();
    expect(first).toEqual(
      await evaluateWholeFilterMembership({
        env: f.env,
        subject: f.input.subject,
        siteIds: [SEED_SITE_ID],
        filters: f.input.filters,
        plan: f.input.originalScopePlan,
        time: f.input.queryTime,
      }),
    );
    await expect(
      invocation.executeRawAtOriginalEvaluatorCheckpoint(),
    ).rejects.toThrow("channels_membership_stage_replayed");
  } finally {
    f.database.close();
  }
});

it("declines an over-budget sequence compile to the same original result via Core", async () => {
  const predicate = Array.from(
    { length: 100 },
    (_, index) => `page.path contains "/unique-${index}"`,
  ).join(" OR ");
  const dsl = `sequence([page { ${predicate} },event { event.name eq "qualifier" }]) exists`;
  const f = fixture(dsl, "session");
  try {
    const diagnostics = createD1ReadDiagnostics();
    const invocation = createWholeOriginalCompletionMembershipInvocation({
      ...f.input,
      diagnostics,
    });
    const actual = await invocation.executeRawAtOriginalEvaluatorCheckpoint();
    const expected = await evaluateWholeFilterMembership({
      env: f.env,
      subject: f.input.subject,
      siteIds: [SEED_SITE_ID],
      filters: f.input.filters,
      plan: f.input.originalScopePlan,
      time: f.input.queryTime,
    });
    expect(actual).toEqual(expected);
    expect(diagnostics.advancedFilterExecution).toMatchObject({
      strategy: "bounded-core",
      reason: "sql-runtime-sequence_compile_budget",
    });
    expect(
      invocation
        .observedSqlCommands()
        .some((command) => command.kind === "logical-sql"),
    ).toBe(true);
  } finally {
    f.database.close();
  }
});

const wrap = (step: string) =>
  `window(${step},@range.start,[0ms,${END - SEED_BASE_MS - 1}ms])`;
const sequenceDsl = `sequence([${wrap('page { page.path eq "/qualifier" }')},${wrap('event { event.name eq "qualifier" }')}]) exists`;

it("rethrows a non-budget sequence compile error instead of declining it", async () => {
  const f = fixture(sequenceDsl, "session");
  const sentinel = new Error("sequence-compile-sentinel");
  const build = vi.fn((): never => {
    throw sentinel;
  });
  envelopeHook.override = build;
  try {
    const invocation = createWholeOriginalCompletionMembershipInvocation(
      f.input,
    );
    await expect(
      invocation.executeRawAtOriginalEvaluatorCheckpoint(),
    ).rejects.toBe(sentinel);
    expect(build).toHaveBeenCalledTimes(1);
    // Only the coverage read happened; no sequence command was issued.
    expect(f.trace.preparedSql).toHaveLength(1);
  } finally {
    envelopeHook.override = undefined;
    f.database.close();
  }
});

it("declines SQL when the late original scope no longer supports the sequence", async () => {
  const f = fixture(sequenceDsl, "session");
  try {
    const diagnostics = createD1ReadDiagnostics();
    const invocation = createWholeOriginalCompletionMembershipInvocation({
      ...f.input,
      originalScopePlan: { scope: "event" },
      diagnostics,
    });
    // Core then rejects the relation expression in the late event scope; the
    // SQL decline must already have been recorded before that.
    await expect(
      invocation.executeRawAtOriginalEvaluatorCheckpoint(),
    ).rejects.toMatchObject({ name: "FilterValidationError" });
    expect(diagnostics.advancedFilterExecution?.strategy).toBe("bounded-core");
    expect(diagnostics.advancedFilterExecution?.reason).toMatch(
      /^sql-runtime-/,
    );
    expect(
      invocation
        .observedSqlCommands()
        .some((command) => command.kind === "logical-sql"),
    ).toBe(true);
  } finally {
    f.database.close();
  }
});

/** The signal reports abort only while a named original read leaf checks it,
 * modelling an abort that lands between the loop check and the leaf check. */
function abortingInside(leaf: string): AbortSignal {
  return {
    get aborted() {
      return new Error().stack?.includes(leaf) === true;
    },
    throwIfAborted() {},
  } as unknown as AbortSignal;
}

for (const leaf of ["readActivityAtOriginalLeaf", "readPayloadAtOriginalLeaf"])
  it(`observes an abort inside ${leaf} before its compiled query runs`, async () => {
    const f = fixture(payloadFilter);
    try {
      const invocation = createWholeOriginalCompletionMembershipInvocation({
        ...f.input,
        signal: abortingInside(leaf),
      });
      await expect(
        invocation.executeRawAtOriginalEvaluatorCheckpoint(),
      ).rejects.toMatchObject({ name: "AbortError" });
      // The aborted leaf compiled its command, but never sent it to D1. The
      // other concurrent leaf (and coverage) were sent, in compiled form.
      const unsent = invocation
        .observedSqlCommands()
        .filter(
          (command) =>
            "query" in command &&
            !f.trace.preparedSql.includes(
              (command.query as { sql: string }).sql,
            ),
        );
      expect(unsent).toHaveLength(1);
      expect("source" in unsent[0]! ? unsent[0].source : undefined).toBe(
        leaf === "readPayloadAtOriginalLeaf"
          ? "payload-nodes"
          : "logical-plan-output",
      );
    } finally {
      f.database.close();
    }
  });
