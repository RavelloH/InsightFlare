import { describe, expect, it } from "vitest";

import { analyticsOperationRegistry } from "@/lib/edge/analytics/application/operation-registry";
import {
  attachFilterScopePreference,
  attachSavedFilterScopePreference,
  FILTER_SCOPE_CAPABILITIES,
  type FilterDocument,
  type FilterExpression,
  filterScopePreferenceFromDocument,
  normalizeFilterScopePreference,
  parseFilterScopePreference,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  reconcileFilterScopePreferences,
  resolveFilterScope,
  serializeFilterScopePreference,
} from "@/lib/edge/analytics/contract";
import {
  compileScopedDatasetSql,
  scopedDatasetFor,
} from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";

const context = {
  subject: { kind: "site", siteId: "site-1" },
  policy: {
    revision: "test",
    audience: "api-v1",
    allowedOperations: new Set(),
    allowedDimensions: new Set(),
    allowedFilters: new Set(),
    allowedDetails: new Set(),
    limits: {},
    cursorPagination: false,
  },
} as unknown as QueryInput["context"];

const time = {
  range: { startMs: 1, endExclusiveMs: 100 },
  reportingTimeZone: "UTC",
  capturedAtMs: 100,
} as unknown as QueryTime;

const filter = (field: string, value: string): FilterDocument => ({
  version: 1,
  root: {
    kind: "condition",
    target: { kind: "field", field: field as never },
    operator: "eq",
    value,
  },
});

const documentWithRoot = (root: FilterExpression | null): FilterDocument => ({
  version: 1,
  root,
});

const condition = (field: string, value: string): FilterExpression =>
  filter(field, value).root!;

describe("scoped filter contract", () => {
  it("normalizes, parses, serializes, and preserves scope preferences", () => {
    expect(normalizeFilterScopePreference(undefined)).toBe("auto");
    expect(normalizeFilterScopePreference(null)).toBe("auto");
    expect(normalizeFilterScopePreference("visitor")).toBe("visitor");
    expect(() => normalizeFilterScopePreference("invalid")).toThrow(
      "invalid_filter_scope",
    );

    expect(parseFilterScopePreference("?scope=session")).toBe("session");
    expect(parseFilterScopePreference("scope=visitor")).toBe("visitor");
    expect(
      parseFilterScopePreference("https://example.test/dashboard?scope=event"),
    ).toBe("event");
    expect(
      parseFilterScopePreference(
        new URL("https://example.test/dashboard?scope=visitor"),
      ),
    ).toBe("visitor");
    expect(parseFilterScopePreference(new URLSearchParams("scope=event"))).toBe(
      "event",
    );

    const concrete = serializeFilterScopePreference(
      new URLSearchParams("range=7d"),
      "visitor",
    );
    expect(concrete.get("scope")).toBe("visitor");
    expect(
      serializeFilterScopePreference(concrete, "auto").get("scope"),
    ).toBeNull();

    const attached = attachFilterScopePreference(
      filter("page.path", "/"),
      "session",
    );
    expect(filterScopePreferenceFromDocument(attached)).toBe("session");
    expect(filterScopePreferenceFromDocument(undefined)).toBeUndefined();

    const copied = attachFilterScopePreference(
      attachSavedFilterScopePreference(attached, "visitor"),
      "event",
    );
    expect(filterScopePreferenceFromDocument(copied)).toBe("event");
  });

  it.each([
    ["auto", "auto", "auto"],
    ["auto", "event", "event"],
    ["auto", "session", "session"],
    ["auto", "visitor", "visitor"],
    ["event", "auto", "event"],
    ["session", "auto", "session"],
    ["visitor", "auto", "visitor"],
    ["event", "event", "event"],
    ["session", "session", "session"],
    ["visitor", "visitor", "visitor"],
  ] as const)("reconciles %s + %s", (caller, saved, result) => {
    expect(reconcileFilterScopePreferences(caller, saved)).toBe(result);
  });

  it.each([
    ["event", "session"],
    ["event", "visitor"],
    ["session", "event"],
    ["session", "visitor"],
    ["visitor", "event"],
    ["visitor", "session"],
  ] as const)(
    "rejects different concrete scopes (%s + %s) instead of allowing an override",
    (caller, saved) => {
      expect(() => reconcileFilterScopePreferences(caller, saved)).toThrow(
        "scope_conflict",
      );
    },
  );

  it("requires every canonical operation to declare a scope capability", () => {
    expect(analyticsOperationRegistry.length).toBeGreaterThan(0);
    for (const capability of Object.values(FILTER_SCOPE_CAPABILITIES)) {
      expect(capability).toBeDefined();
      if (capability.kind === "scoped") {
        expect(capability.supportedScopes.length).toBeGreaterThan(0);
        expect(capability.supportedScopes).toContain(capability.autoScope);
      }
    }
  });

  it("defaults only entity-oriented operations to entity scopes", () => {
    expect(FILTER_SCOPE_CAPABILITIES.overview).toMatchObject({
      kind: "scoped",
      autoScope: "event",
    });
    expect(FILTER_SCOPE_CAPABILITIES.trend).toMatchObject({
      kind: "scoped",
      autoScope: "event",
    });
    expect(FILTER_SCOPE_CAPABILITIES.comparison).toMatchObject({
      kind: "scoped",
      autoScope: "event",
    });
    expect(FILTER_SCOPE_CAPABILITIES["comparison-breakdown"]).toMatchObject({
      kind: "scoped",
      autoScope: "event",
    });

    expect(FILTER_SCOPE_CAPABILITIES.sessions).toMatchObject({
      kind: "scoped",
      autoScope: "session",
    });
    expect(FILTER_SCOPE_CAPABILITIES["session-events"]).toMatchObject({
      kind: "scoped",
      autoScope: "session",
    });
    expect(FILTER_SCOPE_CAPABILITIES.visitors).toMatchObject({
      kind: "scoped",
      autoScope: "visitor",
    });
    expect(FILTER_SCOPE_CAPABILITIES["visitor-events"]).toMatchObject({
      kind: "scoped",
      autoScope: "visitor",
    });
    expect(FILTER_SCOPE_CAPABILITIES["visitor-sessions"]).toMatchObject({
      kind: "scoped",
      autoScope: "visitor",
    });
  });

  it("does not provide an implicit Realtime scope fallback", () => {
    expect(resolveFilterScope("realtime", "auto")).toBeNull();
    expect(() => resolveFilterScope("realtime", "event")).toThrow(
      "unsupported_filter_scope",
    );
    expect(
      prepareScopedQuery("realtime", {
        context,
        time,
        filters: filter("page.path", "/docs"),
        scopePreference: "auto",
      } as QueryInput & { time: QueryTime }),
    ).toMatchObject({ scopePreference: "auto" });
  });

  it("rejects unknown operations and unsupported concrete preferences", () => {
    expect(() => resolveFilterScope("unknown" as never, "auto")).toThrow(
      "missing_filter_scope_capability",
    );
    expect(() => resolveFilterScope("overview", "invalid" as never)).toThrow(
      "unsupported_filter_scope",
    );
  });

  it("keeps the requested Auto value while resolving Overview to Event", () => {
    const prepared = prepareScopedQuery("overview", {
      context,
      time,
      filters: filter("page.path", "/docs"),
      scopePreference: "auto",
    } as QueryInput & { time: QueryTime });

    expect(prepared.scopePreference).toBe("auto");
    expect(prepared.scopePlan?.scope).toBe("event");
    expect(prepared.scopePlan?.membership.kind).toBe("observation");
    expect(prepared.filters?.root).toEqual(filter("page.path", "/docs").root);
  });

  it("creates an empty scoped plan when no filter document is supplied", () => {
    const prepared = prepareScopedQuery("overview", {
      context,
      time,
      scopePreference: "auto",
    } as QueryInput & { time: QueryTime });

    expect(prepared.scopePlan?.scope).toBe("event");
    expect(prepared.filters?.root).toBeNull();
  });

  it("does not claim an observation source for an unknown field", () => {
    const prepared = prepareScopedQuery("overview", {
      context,
      time,
      filters: filter("unknown.field", "value"),
      scopePreference: "session",
    } as QueryInput & { time: QueryTime });

    expect(prepared.scopePlan?.requiredSources).toEqual(new Set());
  });

  it("requires a time window for scoped queries", () => {
    expect(() =>
      prepareScopedQuery("overview", {
        context,
        filters: filter("page.path", "/docs"),
        scopePreference: "auto",
      } as QueryInput),
    ).toThrow("scoped_query_requires_time");
  });

  it("applies Saved Filter reconciliation before registry resolution", () => {
    const saved = attachSavedFilterScopePreference(
      filter("page.path", "/docs"),
      "visitor",
    );
    const prepared = prepareScopedQuery("overview", {
      context,
      time,
      filters: saved,
      scopePreference: "auto",
    } as QueryInput & { time: QueryTime });

    expect(prepared.scopePlan?.scope).toBe("visitor");
    expect(() =>
      prepareScopedQuery("overview", {
        context,
        time,
        filters: saved,
        scopePreference: "session",
      } as QueryInput & { time: QueryTime }),
    ).toThrow("scope_conflict");
  });

  it("keeps separate current/reference membership expressions under one scope", () => {
    const prepared = prepareScopedQuery("comparison", {
      context,
      scopePreference: "auto",
      current: { time, filters: filter("page.path", "/current") },
      reference: { time, filters: filter("page.path", "/reference") },
      metrics: ["views"],
    } as unknown as QueryInput);
    const current = prepared as QueryInput & {
      current: { filters?: FilterDocument };
      reference: { filters?: FilterDocument };
    };

    expect(current.scopePlan?.scope).toBe("event");
    expect(current.current.filters?.root).toEqual(
      filter("page.path", "/current").root,
    );
    expect(current.reference.filters?.root).toEqual(
      filter("page.path", "/reference").root,
    );
  });

  it.each([
    ["auto", "auto", "event"],
    ["auto", "visitor", "visitor"],
    ["session", "auto", "session"],
    ["session", "session", "session"],
  ] as const)(
    "resolves comparison sides %s + %s once to %s",
    (currentScope, referenceScope, resolvedScope) => {
      const prepared = prepareScopedQuery("comparison", {
        context,
        scopePreference: "auto",
        current: { time, scopePreference: currentScope },
        reference: { time, scopePreference: referenceScope },
        metrics: ["views"],
      } as unknown as QueryInput) as QueryInput & {
        scopePlan?: { scope: string };
        current: { scopePreference?: string };
        reference: { scopePreference?: string };
      };

      expect(prepared.scopePlan?.scope).toBe(resolvedScope);
      expect(prepared.current.scopePreference).toBe(resolvedScope);
      expect(prepared.reference.scopePreference).toBe(resolvedScope);
    },
  );

  it("rejects comparison sides with different concrete preferences", () => {
    expect(() =>
      prepareScopedQuery("comparison", {
        context,
        scopePreference: "auto",
        current: { time, scopePreference: "session" },
        reference: { time, scopePreference: "visitor" },
        metrics: ["views"],
      } as unknown as QueryInput),
    ).toThrow("scope_conflict");
  });

  it("fills missing comparison side filters and preserves team site scope", () => {
    const prepared = prepareScopedQuery("comparison", {
      context: {
        ...context,
        subject: { kind: "team", authorizedSiteIds: ["site-1", "site-2"] },
      },
      scopePreference: "auto",
      current: { time },
      reference: { time },
      metrics: ["views"],
    } as unknown as QueryInput);
    const comparison = prepared as QueryInput & {
      current: { filters?: FilterDocument; scopePreference?: string };
      reference: { filters?: FilterDocument; scopePreference?: string };
    };

    expect(comparison.scopePlan?.scope).toBe("event");
    expect(comparison.current.scopePreference).toBe("event");
    expect(comparison.reference.scopePreference).toBe("event");
    expect(comparison.current.filters?.root).toBeNull();
    expect(comparison.reference.filters?.root).toBeNull();
  });

  it("rejects comparison sides whose Saved Filters reconcile to different scopes", () => {
    const preparedQuery = {
      context,
      scopePreference: "auto",
      current: {
        time,
        filters: attachSavedFilterScopePreference(
          filter("page.path", "/current"),
          "session",
        ),
      },
      reference: {
        time,
        filters: attachSavedFilterScopePreference(
          filter("page.path", "/reference"),
          "visitor",
        ),
      },
      metrics: ["views"],
    } as unknown as QueryInput;

    expect(() => prepareScopedQuery("comparison", preparedQuery)).toThrow(
      "scope_conflict",
    );
  });

  it("exposes only final scoped dataset relations to providers", () => {
    const prepared = prepareScopedQuery("overview", {
      context,
      time,
      filters: filter("page.path", "/docs"),
      scopePreference: "visitor",
    } as QueryInput & { time: QueryTime });
    const scopedFilters = prepared.filters!;
    const dataset = compileScopedDatasetSql({
      filters: scopedFilters,
      plan: prepared.scopePlan!,
      siteIds: ["site-1"],
      window: {
        startMs: time.range.startMs,
        endExclusiveMs: time.range.endExclusiveMs,
        nowMs: time.capturedAtMs,
        timeZone: time.reportingTimeZone,
      },
    });

    expect(dataset).toMatchObject({
      visitRelation: "scope_final_visits",
      eventRelation: "scope_final_events",
      sessionRelation: "scope_final_sessions",
      visitorRelation: "scope_final_visitors",
      scope: "visitor",
    });
    expect(dataset.ctes).toContain("scope_universe");
    expect(dataset.ctes).toContain("scope_final_visitors");
    expect(dataset.ctes).not.toContain("matched_sessions");
    expect(dataset.ctes).not.toContain("matched_visitors");
  });

  it("compiles observation scope filters and validates scoped metadata", () => {
    const prepared = prepareScopedQuery("overview", {
      context,
      time,
      filters: documentWithRoot(condition("event.name", "Signup")),
      scopePreference: "event",
    } as QueryInput & { time: QueryTime });
    const scopedFilters = prepared.filters!;
    const dataset = compileScopedDatasetSql({
      filters: scopedFilters,
      plan: prepared.scopePlan!,
      siteIds: ["site-1"],
      window: {
        startMs: time.range.startMs,
        endExclusiveMs: time.range.endExclusiveMs,
        nowMs: time.capturedAtMs,
        timeZone: time.reportingTimeZone,
      },
    });

    expect(dataset.scope).toBe("event");
    expect(dataset.ctes).toContain("scope_final_events");
    expect(dataset.bindings.length).toBeGreaterThan(0);
    expect(
      scopedDatasetFor(
        "site-1",
        {
          startMs: time.range.startMs,
          endExclusiveMs: time.range.endExclusiveMs,
          nowMs: time.capturedAtMs,
          timeZone: time.reportingTimeZone,
        },
        scopedFilters,
      ),
    ).toMatchObject({ scope: "event" });
    expect(
      scopedDatasetFor(
        "site-1",
        {
          startMs: time.range.startMs,
          endExclusiveMs: time.range.endExclusiveMs,
          nowMs: time.capturedAtMs,
          timeZone: time.reportingTimeZone,
        },
        filter("page.path", "/docs"),
      ),
    ).toBeNull();
    expect(() =>
      compileScopedDatasetSql({
        filters: filter("page.path", "/docs"),
        plan: prepared.scopePlan!,
        siteIds: ["site-1"],
        window: {
          startMs: time.range.startMs,
          endExclusiveMs: time.range.endExclusiveMs,
          nowMs: time.capturedAtMs,
          timeZone: time.reportingTimeZone,
        },
      }),
    ).toThrow("scoped_dataset_metadata_required");
    expect(() =>
      compileScopedDatasetSql({
        filters: scopedFilters,
        plan: prepared.scopePlan!,
        siteIds: [],
        window: {
          startMs: time.range.startMs,
          endExclusiveMs: time.range.endExclusiveMs,
          nowMs: time.capturedAtMs,
          timeZone: time.reportingTimeZone,
        },
      }),
    ).toThrow("scoped_dataset_requires_site");

    const payloadPrepared = prepareScopedQuery("overview", {
      context,
      time,
      filters: documentWithRoot({
        kind: "condition",
        target: { kind: "event-payload", path: "/plan" as never },
        operator: "eq",
        value: "pro",
      }),
      scopePreference: "visitor",
    } as QueryInput & { time: QueryTime });
    expect(
      compileScopedDatasetSql({
        filters: payloadPrepared.filters!,
        plan: payloadPrepared.scopePlan!,
        siteIds: ["site-1"],
        window: {
          startMs: time.range.startMs,
          endExclusiveMs: time.range.endExclusiveMs,
          nowMs: time.capturedAtMs,
          timeZone: time.reportingTimeZone,
        },
      }).ctes,
    ).toContain("scope_raw_events");
  });

  it("compiles entity set NOT/OR/AND semantics and empty memberships", () => {
    const root: FilterExpression = {
      kind: "and",
      children: [
        condition("page.path", "/docs"),
        {
          kind: "or",
          children: [
            condition("event.name", "Signup"),
            condition("page.title", "Docs"),
          ],
        },
        { kind: "not", child: condition("page.path", "/private") },
      ],
    };
    const prepared = prepareScopedQuery("overview", {
      context,
      time,
      filters: documentWithRoot(root),
      scopePreference: "session",
    } as QueryInput & { time: QueryTime });
    const dataset = compileScopedDatasetSql({
      filters: prepared.filters!,
      plan: prepared.scopePlan!,
      siteIds: ["site-1"],
      window: {
        startMs: time.range.startMs,
        endExclusiveMs: time.range.endExclusiveMs,
        nowMs: time.capturedAtMs,
        timeZone: time.reportingTimeZone,
      },
    });

    expect(dataset.scope).toBe("session");
    expect(dataset.ctes).toContain("UNION");
    expect(dataset.ctes).toContain("NOT EXISTS");
    expect(dataset.ctes).toContain("INNER JOIN");

    const emptyPrepared = prepareScopedQuery("overview", {
      context,
      time,
      filters: documentWithRoot(null),
      scopePreference: "session",
    } as QueryInput & { time: QueryTime });
    expect(
      compileScopedDatasetSql({
        filters: emptyPrepared.filters!,
        plan: emptyPrepared.scopePlan!,
        siteIds: ["site-1"],
        window: {
          startMs: time.range.startMs,
          endExclusiveMs: time.range.endExclusiveMs,
          nowMs: time.capturedAtMs,
          timeZone: time.reportingTimeZone,
        },
      }).ctes,
    ).toContain("scope_universe");
  });
});
