// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import { createFixture } from "@/lib/edge/analytics/composition/d1/__tests__/team-sites-membership-fixture";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { prepareSiteExactDimensionInputs } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
const dsl =
  'sequence([window(page { page.path eq "/q" },@range.start,[0ms,99ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,99ms])]) exists';
afterEach(() => vi.restoreAllMocks());
it.each([
  "context",
  "time",
  "filters",
  "requestedScope",
  "resolvedScope",
  "domain",
] as const)(
  "fails closed on internal %s mutation after joint completion, before any preparation",
  async (kind) => {
    const db = createFixture(),
      trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const q = prepareScopedQuery("dimension", {
      context: teamQueryContext("b04-team", "private-dashboard", [
        "b04-site-a",
        "b04-site-b",
      ]),
      time: createQueryTime(100, 200, "UTC", 300),
      filters: parseFilterDsl(dsl, analyticsFilterRegistry),
      scopePreference: "session",
      mode: "breakdown",
      dimension: "page.path",
    });
    const metadata = scopedFilterMetadata(q.filters)!;
    const original = whole.evaluateWholeFilterMembership;
    let completedSql = 0;
    const evaluate = vi
      .spyOn(whole, "evaluateWholeFilterMembership")
      .mockImplementation(async (input) => {
        const matches = await original(input);
        completedSql = trace.preparedSql.length;
        if (kind === "context")
          Object.assign(q, {
            context: teamQueryContext("b04-team", "private-dashboard", [
              "b04-site-a",
              "b04-site-b",
            ]),
          });
        if (kind === "time")
          Object.assign(q, { time: createQueryTime(100, 200, "UTC", 300) });
        if (kind === "filters")
          Object.assign(q, {
            filters: parseFilterDsl(dsl, analyticsFilterRegistry),
          });
        if (kind === "requestedScope" || kind === "resolvedScope")
          Object.assign(metadata, { [kind]: "visitor" });
        if (kind === "domain")
          Object.assign(metadata, { siteIds: ["b04-site-a"] });
        return matches;
      });
    const register = vi.spyOn(bridge, "registerPreparedMembership"),
      prep = vi.spyOn(preparation, "createPageVisitQualificationPreparation");
    let value: unknown, error: unknown;
    try {
      const result = await prepareSiteExactDimensionInputs({
        env: { DB: createSqliteD1Database(db, trace) } as Env,
        query: q,
        siteIds: ["b04-site-a", "b04-site-b"],
      });
      value = { sites: [...result.keys()] };
    } catch (e) {
      error =
        e instanceof AnalyticsProviderDomainError
          ? { name: e.name, message: e.message, domainError: e.domainError }
          : e instanceof Error
            ? { name: e.name, message: e.message }
            : e;
    }
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(trace.preparedSql).toHaveLength(completedSql);
    expect(completedSql).toBe(2);
    expect(value).toBeUndefined();
    {
      expect(error).toMatchObject({
        name: "AnalyticsProviderDomainError",
        domainError: {
          kind: "invalid-input",
          issues: [
            { code: "team_exact_membership_admission_context_mismatch" },
          ],
        },
      });
      expect(register).not.toHaveBeenCalled();
      expect(prep).not.toHaveBeenCalled();
    }
  },
);
