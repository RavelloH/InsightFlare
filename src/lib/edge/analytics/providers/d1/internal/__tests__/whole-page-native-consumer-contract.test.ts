// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

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
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { D1LogicalProgramExecution } from "@/lib/edge/analytics/providers/d1/internal/logical-program-execution";
import * as preparations from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const readerTime = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const mismatch = "qualification_execution_plan_snapshot_mismatch";
const replay = "qualification_execution_preparation_replayed";
const planMismatch = "qualification_execution_plan_context_mismatch";
type PageInput = Parameters<typeof whole.bindWholeOriginalReader>[0];
const bind = whole.bindWholeOriginalReader;
const nativeBind =
  D1LogicalProgramExecution.prototype.bindWholeOriginalPageConsumer;
const refsBind = preparations.bindPageVisitQualificationPreparation;

afterEach(() => vi.restoreAllMocks());

/** Stop only the consumer, after a real registry request has completed its
 * SQLite/Core producer. No test supplies rows, a completion, or a replacement
 * completedWholeOutputs getter. Subsequent binds are synchronous and read no DB. */
async function completedRequest() {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "whole-page-native-consumer-contract",
  } as unknown as Env;
  const query = prepareScopedQuery("channels", {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time,
    filters: parseFilterDsl(
      'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"',
      analyticsFilterRegistry,
    ),
    scopePreference: "session",
    mode: "list" as const,
    limit: 2,
  });
  const stopped = new Error("stop_at_actual_consumer_checkpoint");
  let captured: PageInput | undefined;
  const capture = vi
    .spyOn(whole, "bindWholeOriginalReader")
    .mockImplementation((input) => {
      if (input.consumer.kind !== "page")
        throw new Error("expected_page_consumer");
      captured = input;
      throw stopped;
    });
  try {
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
    }).resolve("channels");
    if (!provider) throw new Error("missing_channels_provider");
    await expect(provider.execute(query)).rejects.toBe(stopped);
    capture.mockRestore();
    const input = captured;
    if (!input || !input.execution?.program)
      throw new Error("expected_actual_completed_program");
    const program = input.execution.program;
    const completed = program.completedWholeOutputs;
    expect(completed).toHaveLength(1);
    expect(completed[0]!.plan.outputs).toContain(completed[0]!.output);
    expect(trace.preparedSql.length).toBeGreaterThanOrEqual(2);
    return { input, program, trace, database, reads: trace.preparedSql.length };
  } catch (error) {
    capture.mockRestore();
    database.close();
    throw error;
  }
}

function refs(input: PageInput): PageInput {
  const { execution: _execution, ...withoutExecution } = input;
  return withoutExecution;
}

function changedConfiguration(input: PageInput): PageInput {
  return {
    ...input,
    consumer: {
      kind: "page",
      family: "channels",
      reader: { kind: "channels-list", configuration: { limit: 3 } },
    },
  };
}

/** Fail an original plan-context check after its request snapshot is captured.
 * The real binder still validates the real producer and every Source; the test
 * changes only the asserted reader window, never a graph or output authority. */
function failNativeOnce() {
  return vi
    .spyOn(D1LogicalProgramExecution.prototype, "bindWholeOriginalPageConsumer")
    .mockImplementationOnce(function (this: D1LogicalProgramExecution, input) {
      return nativeBind.call(this, { ...input, readerQueryTime: readerTime });
    });
}

function failRefsOnce() {
  return vi
    .spyOn(preparations, "bindPageVisitQualificationPreparation")
    .mockImplementationOnce((input) =>
      refsBind({ ...input, readerQueryTime: readerTime }),
    );
}

it("uses the actual producer at F != R and rejects native, refs, and transferred-owner replay", async () => {
  const f = await completedRequest();
  const create = vi.spyOn(
    preparations,
    "createPageVisitQualificationPreparation",
  );
  const legacy = vi.spyOn(
    preparations,
    "bindPageVisitQualificationPreparation",
  );
  const native = vi.spyOn(
    D1LogicalProgramExecution.prototype,
    "bindWholeOriginalPageConsumer",
  );
  try {
    const input = { ...f.input, readerQueryTime: readerTime };
    expect(input.queryTime.fullHistory).toBe(true);
    expect(input.queryTime.range).toEqual(time.range);
    const bound = bind(input);
    expect(bound?.execution).toBe(input.execution);
    expect(bound?.executionInputs).toBeUndefined();
    const producer = f.program.completedWholeOutputs[0]!;
    const imported = bound?.plan.nodes.find(
      (node) => node.kind === "analysis-result",
    );
    expect(imported?.childPlan).toBe(producer.plan);
    expect(imported?.outputId).toBe(producer.output.id);
    for (const node of bound!.plan.nodes) {
      if (node.kind !== "source") continue;
      expect(node.selection?.time).toEqual(
        semanticTemporalDomainsFromQueryTime(readerTime),
      );
      expect(node.selection?.preparationTime).toEqual(
        semanticTemporalDomainsFromQueryTime(input.queryTime),
      );
      expect(node.selection?.qualificationDependencyRefs).toBeUndefined();
    }
    expect(() => bind(input)).toThrow(replay);
    expect(() => bind(refs(input))).toThrow(replay);
    const alias = {};
    whole.transferWholeOriginalCompletion(input.owner, alias);
    expect(() => bind({ ...input, owner: alias })).toThrow(replay);
    expect(native).toHaveBeenCalledTimes(3);
    expect(create).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(f.trace.preparedSql).toHaveLength(f.reads);
  } finally {
    f.database.close();
  }
});

it("keeps a failed legacy snapshot when native configuration changes, then retires its legacy view on success", async () => {
  const f = await completedRequest();
  const create = vi.spyOn(
    preparations,
    "createPageVisitQualificationPreparation",
  );
  const legacy = failRefsOnce();
  try {
    expect(() => bind(refs(f.input))).toThrow(planMismatch);
    expect(create).toHaveBeenCalledTimes(1);
    expect(() => bind(changedConfiguration(f.input))).toThrow(mismatch);
    const bound = bind(f.input);
    expect(bound?.execution).toBe(f.input.execution);
    expect(bound?.executionInputs).toBeUndefined();
    expect(() => bind(refs(f.input))).toThrow(replay);
    expect(create).toHaveBeenCalledTimes(1);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(f.trace.preparedSql).toHaveLength(f.reads);
  } finally {
    f.database.close();
  }
});

it("keeps a failed native snapshot across refs configuration changes and permits the original refs retry", async () => {
  const f = await completedRequest();
  const native = failNativeOnce();
  const create = vi.spyOn(
    preparations,
    "createPageVisitQualificationPreparation",
  );
  try {
    expect(() => bind(f.input)).toThrow(planMismatch);
    expect(create).not.toHaveBeenCalled();
    expect(() => bind(refs(changedConfiguration(f.input)))).toThrow(mismatch);
    const bound = bind(refs(f.input));
    expect(bound?.executionInputs).toBeDefined();
    expect(bound?.execution).toBeUndefined();
    expect(() => bind(f.input)).toThrow(replay);
    expect(create).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledTimes(1);
    expect(f.trace.preparedSql).toHaveLength(f.reads);
  } finally {
    f.database.close();
  }
});

it("does not consume a failed native attempt and preserves the same snapshot for its successful retry", async () => {
  const f = await completedRequest();
  const native = failNativeOnce();
  const create = vi.spyOn(
    preparations,
    "createPageVisitQualificationPreparation",
  );
  try {
    expect(() => bind(f.input)).toThrow(planMismatch);
    expect(() => bind(changedConfiguration(f.input))).toThrow(mismatch);
    expect(bind(f.input)?.execution).toBe(f.input.execution);
    expect(() => bind(f.input)).toThrow(replay);
    expect(native).toHaveBeenCalledTimes(4);
    expect(create).not.toHaveBeenCalled();
    expect(f.trace.preparedSql).toHaveLength(f.reads);
  } finally {
    f.database.close();
  }
});
