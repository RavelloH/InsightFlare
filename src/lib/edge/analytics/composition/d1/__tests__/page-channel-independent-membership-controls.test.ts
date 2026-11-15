// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as countSupport from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import type { PageChannelMembershipReader } from "@/lib/edge/analytics/engine/page-channel-membership-dependency-plan";
import * as recipe from "@/lib/edge/analytics/engine/page-channel-membership-dependency-plan";
import * as wholeFamily from "@/lib/edge/analytics/engine/page-whole-original-family";
import { observeCostDatabase } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as afe from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as reportReader from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import * as channelReader from "@/lib/edge/analytics/providers/d1/internal/channels";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as reader from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import * as binding from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as pagination from "@/lib/edge/analytics/providers/d1/internal/pagination";
import * as prepared from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as wholeReader from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";
const dsl = (s: string) => parseFilterDsl(s, analyticsFilterRegistry);
function request(scope: "session" | "visitor" = "session") {
  return {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: createQueryTime(
      SEED_BASE_MS + 3 * SEED_DAY_MS,
      SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
    ),
    scopePreference: scope,
    filters: dsl(
      "count(page { page.durationMs gt 5 }) gte 1 and time gte @range.start+1d",
    ),
    dimension: "client.browser",
    page: { limit: 2 },
  };
}
function fixture(visits = 200) {
  const native = createMigratedDatabase();
  for (const s of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits }),
  ])
    native.exec(s);
  return native;
}
async function run(
  native: ReturnType<typeof fixture>,
  q: ReturnType<typeof request>,
  mode: "old" | "candidate" | "core" = "candidate",
  operation: "dimension" | "channels" = "dimension",
) {
  const bridge = vi.spyOn(prepared, "registerPreparedMembership"),
    binder = vi.spyOn(binding, "bindPageVisitQualificationPreparation"),
    evalSpy = vi.spyOn(evaluator, "evaluateFilterDocument");
  const currentRecipe =
    mode === "candidate"
      ? vi.spyOn(recipe, "planPageChannelMembershipDependencies")
      : undefined;
  const wholeBind = vi.spyOn(wholeReader, "bindWholeOriginalReader");
  const spy =
    mode === "old"
      ? vi
          .spyOn(recipe, "planPageChannelMembershipDependencies")
          .mockReturnValue(undefined)
      : undefined;
  // Isolate the original registry/Core oracles from the later whole-filter route.
  const legacyWhole =
    mode !== "candidate"
      ? vi
          .spyOn(wholeFamily, "pageWholeOriginalFamilyFromQuery")
          .mockReturnValue(undefined)
      : undefined;
  const core =
    mode === "core"
      ? vi.spyOn(countSupport, "classifyAdvancedCountFilter").mockReturnValue({
          kind: "unsupported",
          code: "page_channel_core_oracle",
          path: "root",
          reason: "Complete original Core oracle",
        })
      : undefined;
  const initialChanges = native.prepare("SELECT total_changes() AS n").get()!.n;
  const observed = observeCostDatabase(createSqliteD1Database(native)),
    errors: string[] = [];
  try {
    const registry = createD1SiteProviderRegistry({
      env: {
        DB: observed.database,
        MAIN_SECRET: "page-channel-scratch",
      } as Env,
      siteId: SEED_SITE_ID,
      diagnostics: createD1ReadDiagnostics(),
    });
    // Isolate the existing Count/whole qualification adapter contracts with the
    // actual registered providers, middleware, application service and request.
    // The base dispatcher prevents the newer Program from replacing a declined
    // route. This is a compatibility control, not a historical-source oracle or
    // coverage of the current D1 Program; real registry Program tests cover it.
    Object.defineProperty(registry, "resolve", {
      value: AnalyticsProviderRegistry.prototype.resolve,
    });
    const runtime = createAnalyticsQueryRuntime(registry);
    const result = await runtime.execute(operation, q as never, {
      onProviderError(e) {
        errors.push(String(e));
      },
    });
    expect(native.prepare("SELECT total_changes() AS n").get()!.n).toEqual(
      initialChanges,
    );

    return {
      result,
      bridge: bridge.mock.calls.length,
      recipeAdmissions:
        currentRecipe?.mock.results.filter(
          (result) => result.type === "return" && result.value !== undefined,
        ).length ?? 0,
      wholeBindCalls: wholeBind.mock.calls.length,
      binder: binder.mock.calls.length,
      core: evalSpy.mock.calls.length,
      observations: observed.observations,
      errors,
    };
  } finally {
    wholeBind.mockRestore();
    currentRecipe?.mockRestore();
    legacyWhole?.mockRestore();
    spy?.mockRestore();
    core?.mockRestore();
    bridge.mockRestore();
    binder.mockRestore();
    evalSpy.mockRestore();
  }
}
async function triple(
  native: ReturnType<typeof fixture>,
  q: ReturnType<typeof request>,
  operation: "dimension" | "channels" = "dimension",
) {
  const old = await run(native, q, "old", operation),
    candidate = await run(native, q, "candidate", operation),
    core = await run(native, q, "core", operation);
  expect(candidate.result).toEqual(old.result);
  expect(candidate.result).toEqual(core.result);
  expect(
    candidate.observations.map(({ sql, params }) => ({ sql, params })),
  ).toEqual(old.observations.map(({ sql, params }) => ({ sql, params })));
  return { old, candidate, core };
}
async function prepare(native: ReturnType<typeof fixture>, q = request()) {
  const input = prepareScopedQuery("dimension", q as never);
  return (await afe.d1AdvancedFilterMiddleware(
    { DB: createSqliteD1Database(native) } as Env,
    undefined,
    SEED_SITE_ID,
  )("dimension", input, async (value) => value)) as typeof input;
}
const readerConfig = (): PageChannelMembershipReader => ({
  kind: "dimension-page",
  dimension: "client.browser",
  limit: 2,
  cursorText: null,
  excludeEmpty: false,
  sortBy: "views",
  sortDirection: "desc",
  audience: "private-dashboard",
});
it("actual page2/search/limits and all metric directions remain exact", async () => {
  const native = fixture();
  try {
    for (const scope of ["session", "visitor"] as const)
      for (const key of ["views", "sessions", "visitors"] as const)
        for (const direction of ["asc", "desc"] as const) {
          const q = { ...request(scope), sort: { key, direction } };
          const first = await triple(native, q);
          expect(first.candidate.bridge).toBe(0);
          const cursor = (
            first.old.result.ok ? first.old.result.data : undefined
          ) as { pagination?: { nextCursor?: string | null } } | undefined;
          expect(cursor?.pagination?.nextCursor).toBeTruthy();
          await triple(native, {
            ...q,
            page: { limit: 2, cursor: cursor!.pagination!.nextCursor! },
          } as typeof q);
        }
    for (const extra of [
      { page: { limit: 0 } },
      { page: { limit: 1 }, search: "Fire" },
      { page: { limit: 2 }, search: "no-such-browser" },
    ])
      await triple(native, { ...request(), ...extra });
  } finally {
    native.close();
  }
}, 120000);
it("preserves numeric whole Core fallback while removing only the registry", async () => {
  const native = fixture();
  native.exec("UPDATE visits SET duration_ms='invalid-duration'");
  try {
    const result = await triple(native, request());
    expect(result.candidate.core).toBeGreaterThan(0);
    expect(result.candidate.bridge).toBe(0);
    expect(result.old.bridge).toBe(1);
  } finally {
    native.close();
  }
});
it("rejects clones/replay/cross-reader and hidden original request mutations", async () => {
  const native = fixture();
  try {
    const q = await prepare(native);
    expect(afe.hasIndependentPageChannelMembershipDependency(q)).toBe(true);
    expect(afe.hasIndependentPageChannelMembershipDependency({ ...q })).toBe(
      false,
    );
    for (const invalid of [
      { ...readerConfig(), limit: 3 },
      { ...readerConfig(), audience: "api-v1" },
      { ...readerConfig(), dimension: "event.name" },
    ])
      expect(() =>
        afe.claimIndependentPageChannelMembershipDependency(
          q,
          invalid as PageChannelMembershipReader,
          null,
        ),
      ).toThrow("page_channel_membership_reader_mismatch");
    expect(() =>
      afe.claimIndependentPageChannelMembershipDependency(q, readerConfig(), {
        primary: 1,
        secondary: 1,
        value: "x",
        extra: 1,
      } as { primary: number; secondary: number; value: string }),
    ).toThrow("page_channel_membership_reader_mismatch");
    for (const descriptor of [
      { value: 1, enumerable: false },
      { get: () => 1, enumerable: false },
    ]) {
      const opaqueCursor = { primary: 1, secondary: 1, value: "x" };
      Object.defineProperty(opaqueCursor, "extra", descriptor);
      expect(() =>
        afe.claimIndependentPageChannelMembershipDependency(
          q,
          readerConfig(),
          opaqueCursor,
        ),
      ).toThrow("page_channel_membership_reader_mismatch");
    }
    const accessorCursor = { primary: 1, secondary: 1, value: "x" };
    Object.defineProperty(accessorCursor, "primary", {
      get: () => 1,
      enumerable: true,
    });
    expect(() =>
      afe.claimIndependentPageChannelMembershipDependency(
        q,
        readerConfig(),
        accessorCursor,
      ),
    ).toThrow("page_channel_membership_reader_mismatch");
    const config = readerConfig(),
      claim = afe.claimIndependentPageChannelMembershipDependency(
        q,
        config,
        null,
      )!;
    expect(() =>
      afe.claimIndependentPageChannelMembershipDependency(q, config, null),
    ).toThrow("page_channel_membership_replayed");
    (config as { limit: number }).limit = 3;
    expect(() => claim.assertFresh()).toThrow(
      "page_channel_membership_reader_mismatch",
    );
    const mutations = [
      (x: typeof q) => {
        (scopedFilterMetadata(x.filters)!.siteIds as string[])[0] = "foreign";
      },
      (x: typeof q) => {
        (
          scopedFilterMetadata(x.filters)!.plan as {
            requiresRawSource: boolean;
          }
        ).requiresRawSource = !scopedFilterMetadata(x.filters)!.plan
          .requiresRawSource;
      },
      (x: typeof q) => {
        (x as unknown as { scopePreference: string }).scopePreference =
          "visitor";
      },
      (x: typeof q) => {
        (x as unknown as { dimension: string }).dimension = "page.path";
      },
      (x: typeof q) => {
        (
          (x as unknown as { time: QueryTime }).time.range as {
            startMs: number;
          }
        ).startMs++;
      },
    ];
    for (const field of ["requestedScope", "resolvedScope"] as const) {
      const output = await prepare(native);
      (
        scopedFilterMetadata(output.filters)! as unknown as Record<
          string,
          unknown
        >
      )[field] = "changed";
      expect(() =>
        afe.hasIndependentPageChannelMembershipDependency(output),
      ).toThrow("page_channel_membership_request_changed");
    }
    for (const mutate of mutations) {
      const output = await prepare(native);
      mutate(output);
      expect(() =>
        afe.hasIndependentPageChannelMembershipDependency(output),
      ).toThrow("page_channel_membership_request_changed");
    }
  } finally {
    native.close();
  }
});
it.each(["requestedScope", "resolvedScope", "plan", "time", "domain"] as const)(
  "rejects %s mutation inside whole Core admission",
  async (field) => {
    const native = fixture();
    native.exec("UPDATE visits SET duration_ms='invalid-duration'");
    const input = prepareScopedQuery("dimension", request() as never),
      original = evaluator.evaluateFilterDocument;
    const spy = vi
      .spyOn(evaluator, "evaluateFilterDocument")
      .mockImplementation((...args) => {
        const result = original(...args),
          metadata = scopedFilterMetadata(input.filters)!;
        if (field === "plan")
          (metadata.plan as { requiresRawSource: boolean }).requiresRawSource =
            !metadata.plan.requiresRawSource;
        else if (field === "domain")
          (metadata.siteIds as string[])[0] = "foreign";
        else if (field === "time")
          (
            (input as unknown as { time: QueryTime }).time.range as {
              startMs: number;
            }
          ).startMs++;
        else
          (metadata as unknown as Record<string, unknown>)[field] = "changed";
        return result;
      });
    try {
      await expect(
        afe.d1AdvancedFilterMiddleware(
          { DB: createSqliteD1Database(native) } as Env,
          undefined,
          SEED_SITE_ID,
        )("dimension", input, async (value) => value),
      ).rejects.toThrow("page_channel_membership_request_changed");
    } finally {
      spy.mockRestore();
      native.close();
    }
  },
);
it.each(["decode", "decode-throw", "dimension-read", "channel-read"] as const)(
  "rejects mutated request after %s await including throwing decoder",
  async (stage) => {
    const native = fixture();
    let captured: unknown;
    const has = afe.hasIndependentPageChannelMembershipDependency;
    const capture = vi
      .spyOn(afe, "hasIndependentPageChannelMembershipDependency")
      .mockImplementation((q) => {
        captured = q;
        return has(q);
      });
    const mutate = () => {
      const metadata = scopedFilterMetadata(
        (captured as { filters: ReturnType<typeof dsl> }).filters,
      )!;
      (metadata.plan as { requiresRawSource: boolean }).requiresRawSource =
        !metadata.plan.requiresRawSource;
    };
    const decode = reader.decodeDimensionCursor,
      dimensionRead = reader.queryDimensionPageFromD1,
      channelRead = channelReader.queryChannelAggregate;
    const spy =
      stage === "decode" || stage === "decode-throw"
        ? vi
            .spyOn(reader, "decodeDimensionCursor")
            .mockImplementation(async (...args) => {
              const result = await decode(...args);
              mutate();
              if (stage === "decode-throw")
                throw Error("decoder_original_failure");
              return result;
            })
        : stage === "dimension-read"
          ? vi
              .spyOn(reader, "queryDimensionPageFromD1")
              .mockImplementation(async (...args) => {
                const result = await dimensionRead(...args);
                mutate();
                return result;
              })
          : vi
              .spyOn(channelReader, "queryChannelAggregate")
              .mockImplementation(async (...args) => {
                const result = await channelRead(...args);
                mutate();
                return result;
              });
    try {
      const q =
        stage === "channel-read"
          ? { ...request(), mode: "list", limit: 3 }
          : request();
      const result = await run(
        native,
        q,
        "candidate",
        stage === "channel-read" ? "channels" : "dimension",
      );
      expect(result.result.ok).toBe(false);
      expect(result.bridge).toBe(0);
      expect(result.binder).toBe(stage.startsWith("decode") ? 0 : 1);
      expect(result.errors).toContain(
        "Error: page_channel_membership_request_changed",
      );
    } finally {
      spy.mockRestore();
      capture.mockRestore();
      native.close();
    }
  },
);

it.each([
  {
    name: "fullHistory",
    wholeOriginal: true,
    override: { filters: dsl("count(page) gt 0 and time lt @range.end") },
  },
  {
    name: "public audience",
    override: { context: siteQueryContext(SEED_SITE_ID, "public-share") },
  },
  {
    name: "API audience",
    override: { context: siteQueryContext(SEED_SITE_ID, "api-v1") },
  },
  { name: "event scope", override: { scopePreference: "event" } },
  {
    name: "Seq",
    wholeOriginal: true,
    override: {
      filters: dsl(
        "sequence([window(page,@range.start,[0ms,99ms]),window(event,@range.start,[0ms,99ms])]) exists",
      ),
    },
  },
  {
    name: "empty filter window",
    wholeOriginal: true,
    override: {
      filters: dsl(
        "count(page) gt 0 and time gt @range.end+100d and time lt @range.start",
      ),
    },
  },
  {
    name: "payload",
    override: {
      filters: dsl(
        'count(event { event.payload("/value") eq "paid" }) gte 1 and time gte @range.start+1d',
      ),
    },
  },
])("preserves $name complete original fallback", async (sample) => {
  const { override } = sample;
  const hasWholeOriginal =
    "wholeOriginal" in sample && sample.wholeOriginal === true;
  const native = fixture();
  try {
    const q = { ...request(), ...override } as ReturnType<typeof request>,
      old = await run(native, q, "old"),
      candidate = await run(native, q);
    expect(candidate.result).toEqual(old.result);
    expect(
      candidate.observations.map(({ sql, params }) => ({ sql, params })),
    ).toEqual(old.observations.map(({ sql, params }) => ({ sql, params })));
    // The Page/Channel recipe still declines all seven controls. Three private
    // Page requests use the later whole-original reader without the legacy bridge.
    expect(candidate.recipeAdmissions).toBe(0);
    expect(old.wholeBindCalls).toBe(0);
    expect(candidate.wholeBindCalls).toBe(hasWholeOriginal ? 1 : 0);
    expect(candidate.binder).toBe(hasWholeOriginal ? 1 : 0);
    expect(candidate.bridge).toBe(hasWholeOriginal ? 0 : old.bridge);
    expect(candidate.core).toBe(old.core);
    expect(candidate.errors).toEqual(old.errors);
  } finally {
    native.close();
  }
});
it("preserves whole activity admission failure before invalid cursor", async () => {
  const native = fixture(16000);
  native.exec(
    "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='v8000'",
  );
  try {
    const q = {
      ...request(),
      time: createQueryTime(
        SEED_BASE_MS,
        SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
        "UTC",
        SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
      ),
      page: { limit: 2, cursor: "bad-cursor" },
    };
    const result = await triple(native, q);
    expect(result.candidate.result).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(result.candidate.binder).toBe(0);
    expect(result.candidate.bridge).toBe(0);
  } finally {
    native.close();
  }
}, 60000);

it.each([
  "report",
  "report-throw",
  "empty-report",
  "binding",
  "binding-throw",
  "empty-binding",
  "encode",
  "encode-throw",
] as const)(
  "rejects request mutation at internal %s await before the next side effect",
  async (stage) => {
    const native = fixture();
    let captured: unknown;
    let armed = false;
    let bindingsAfterClaim = 0;
    let encodesAfterClaim = 0;
    const has = afe.hasIndependentPageChannelMembershipDependency;
    const originalBind = binding.bindPageVisitQualificationPreparation;
    const originalReport = reportReader.queryAnalyticsReportOutputRowsFromD1;
    const originalPaginationBinding = pagination.paginationBindingForWindow;
    const originalEncode = pagination.encodePageCursor;
    const capture = vi
      .spyOn(afe, "hasIndependentPageChannelMembershipDependency")
      .mockImplementation((q) => {
        captured = q;
        return has(q);
      });
    const bind = vi
      .spyOn(binding, "bindPageVisitQualificationPreparation")
      .mockImplementation((...args) => {
        const result = originalBind(...args);
        armed = true;
        return result;
      });
    const mutate = () => {
      const metadata = scopedFilterMetadata(
        (captured as { filters: ReturnType<typeof dsl> }).filters,
      )!;
      (metadata as unknown as Record<string, unknown>).requestedScope =
        "changed";
    };
    const report = vi
      .spyOn(reportReader, "queryAnalyticsReportOutputRowsFromD1")
      .mockImplementation(async (...args) => {
        const result = await originalReport(...args);
        if (
          armed &&
          (stage === "report" ||
            stage === "report-throw" ||
            stage === "empty-report")
        ) {
          mutate();
          if (stage === "report-throw")
            throw new Error("original_report_failure");
        }
        return result;
      });
    const pageBinding = vi
      .spyOn(pagination, "paginationBindingForWindow")
      .mockImplementation(async (...args) => {
        const result = await originalPaginationBinding(...args);
        if (armed) {
          bindingsAfterClaim++;
          if (
            stage === "binding" ||
            stage === "binding-throw" ||
            stage === "empty-binding"
          ) {
            mutate();
            if (stage === "binding-throw")
              throw new Error("original_binding_failure");
          }
        }
        return result;
      });
    const encode = vi
      .spyOn(pagination, "encodePageCursor")
      .mockImplementation(async (...args) => {
        const result = await originalEncode(...args);
        if (armed) {
          encodesAfterClaim++;
          if (stage === "encode" || stage === "encode-throw") {
            mutate();
            if (stage === "encode-throw")
              throw new Error("original_encode_failure");
          }
        }
        return result;
      });
    try {
      const q = stage.startsWith("empty-")
        ? { ...request(), search: "definitely-no-match" }
        : request();
      const result = await run(native, q);
      expect(result.result.ok).toBe(false);
      expect(result.bridge).toBe(0);
      expect(result.binder).toBe(1);
      expect(result.errors).toContain(
        "Error: page_channel_membership_request_changed",
      );
      expect(bindingsAfterClaim).toBe(stage.includes("report") ? 0 : 1);
      expect(encodesAfterClaim).toBe(stage.startsWith("encode") ? 1 : 0);
    } finally {
      encode.mockRestore();
      pageBinding.mockRestore();
      report.mockRestore();
      bind.mockRestore();
      capture.mockRestore();
      native.close();
    }
  },
);

it.each(["omitted", "undefined", "100"] as const)(
  "preserves channels %s default-limit semantics without the registry",
  async (kind) => {
    const native = fixture();
    try {
      const q = {
        ...request(),
        mode: "list",
        ...(kind === "omitted"
          ? {}
          : { limit: kind === "100" ? 100 : undefined }),
      };
      const r = await triple(native, q, "channels");
      expect(r.candidate.result.ok).toBe(true);
      expect(r.candidate.bridge).toBe(0);
      expect(r.old.bridge).toBe(1);
      expect(r.candidate.binder).toBe(1);
    } finally {
      native.close();
    }
  },
);
it.each([null, 0, -1, Infinity, NaN, "100", {}])(
  "preserves original unsupported channels limit %j",
  async (limit) => {
    const native = fixture();
    try {
      const q = { ...request(), mode: "list", limit };
      const r = await triple(native, q, "channels");
      // The Count recipe still declines malformed limits. The separately
      // authorized whole-original fallback preserves the old reader normalization.
      expect(r.candidate.recipeAdmissions).toBe(0);
      expect(r.old.bridge).toBe(1);
      expect(r.old.wholeBindCalls).toBe(0);
      expect(r.candidate.bridge).toBe(0);
      expect(r.candidate.wholeBindCalls).toBe(1);
      expect(r.candidate.binder).toBe(1);
    } finally {
      native.close();
    }
  },
);
it("rejects hidden or accessor extras on the complete default channels reader", async () => {
  const native = fixture();
  try {
    const input = prepareScopedQuery("channels", {
      ...request(),
      mode: "list",
    } as never);
    const q = await afe.d1AdvancedFilterMiddleware(
      { DB: createSqliteD1Database(native) } as Env,
      undefined,
      SEED_SITE_ID,
    )("channels", input, async (value) => value);
    const reader = {
      kind: "channels-list",
      mode: "list",
      limit: 100,
      sourceLimit: undefined,
      audience: "private-dashboard",
      hasComparison: false,
      hasCurrent: false,
      hasReference: false,
    } as const;
    for (const descriptor of [
      { value: 1, enumerable: false },
      { get: () => 1, enumerable: true },
    ]) {
      const invalid = { ...reader };
      Object.defineProperty(invalid, "extra", descriptor);
      expect(() =>
        afe.claimIndependentPageChannelMembershipDependency(q, invalid, null),
      ).toThrow("page_channel_membership_reader_mismatch");
    }
    expect(
      afe.claimIndependentPageChannelMembershipDependency(q, reader, null),
    ).toBeDefined();
  } finally {
    native.close();
  }
});
