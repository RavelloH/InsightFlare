import { describe, expect, it } from "vitest";

import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
  TeamId,
  TimeRange,
} from "@/lib/edge/analytics/contract/types";
import type { QuerySubject } from "@/lib/edge/analytics/contract/types";
import {
  type AnalyticsEntityKind,
  resolveAnalyticsScope,
  validateResolvedAnalyticsScope,
} from "@/lib/edge/analytics/engine/semantic/entities";
import {
  createSemanticSubjectDomain,
  isCanonicalSemanticSubjectDomain,
  semanticSubjectFromQuerySubject,
} from "@/lib/edge/analytics/engine/semantic/subject";
import {
  createSemanticTemporalDomains,
  semanticTemporalDomainsFromQueryTime,
} from "@/lib/edge/analytics/engine/semantic/time";

describe("semantic foundation", () => {
  it("resolves the external event scope to the observation entity", () => {
    expect(resolveAnalyticsScope("event")).toEqual({
      requested: "event",
      contractScope: "event",
      logicalScope: "observation",
    });
    expect(resolveAnalyticsScope("auto")).toEqual({
      requested: "auto",
      contractScope: null,
      logicalScope: null,
    });
    expect(resolveAnalyticsScope("session").logicalScope).toBe("session");
  });

  it.each([
    {
      requested: "auto",
      contractScope: null,
      logicalScope: null,
    },
    {
      requested: "auto",
      contractScope: "event",
      logicalScope: "observation",
    },
    {
      requested: "auto",
      contractScope: "session",
      logicalScope: "session",
    },
    {
      requested: "auto",
      contractScope: "visitor",
      logicalScope: "visitor",
    },
    {
      requested: "event",
      contractScope: "event",
      logicalScope: "observation",
    },
    {
      requested: "session",
      contractScope: "session",
      logicalScope: "session",
    },
    {
      requested: "visitor",
      contractScope: "visitor",
      logicalScope: "visitor",
    },
  ] as const)("validates and preserves resolved scope %#", (scope) => {
    expect(validateResolvedAnalyticsScope(scope)).toEqual(scope);
  });

  it("rejects inconsistent resolved scopes", () => {
    expect(() => validateResolvedAnalyticsScope(null as never)).toThrow(
      "invalid_resolved_analytics_scope",
    );
    expect(() =>
      validateResolvedAnalyticsScope({
        requested: "unknown",
        contractScope: null,
        logicalScope: null,
      } as never),
    ).toThrow("invalid_resolved_analytics_scope");
    expect(() =>
      validateResolvedAnalyticsScope({
        requested: "auto",
        contractScope: "session",
        logicalScope: "observation",
      }),
    ).toThrow("invalid_resolved_analytics_scope");
    expect(() =>
      validateResolvedAnalyticsScope({
        requested: "event",
        contractScope: null,
        logicalScope: null,
      }),
    ).toThrow("invalid_resolved_analytics_scope");
  });

  it("canonicalizes authorized site domains without treating site as an entity", () => {
    const subject = createSemanticSubjectDomain({
      origin: "team",
      teamId: "team-1" as TeamId,
      siteIds: ["site-b" as SiteId, "site-a" as SiteId, "site-b" as SiteId],
    });
    expect(subject.siteIds).toEqual(["site-a", "site-b"]);
    expect(isCanonicalSemanticSubjectDomain(subject)).toBe(true);

    const querySubject: QuerySubject = {
      kind: "site",
      siteId: "site-c" as SiteId,
      teamId: "team-1" as TeamId,
    };
    expect(semanticSubjectFromQuerySubject(querySubject)).toEqual({
      origin: "site",
      siteIds: ["site-c"],
      teamId: "team-1",
    });
    expect(() =>
      createSemanticSubjectDomain({
        origin: "site",
        siteIds: [],
      }),
    ).toThrow("exactly one authorized site");
  });

  it("preserves candidate, filter, bounded read, and retained-history domains", () => {
    const candidate: TimeRange = {
      startMs: 100 as EpochMs,
      endExclusiveMs: 300 as EpochMs,
    };
    const queryTime = {
      range: candidate,
      filterRange: { startMs: 50, endExclusiveMs: 250 },
      readRange: {
        startMs: 10 as EpochMs,
        endExclusiveMs: 300 as EpochMs,
      },
      reportingTimeZone: "UTC" as ReportingTimeZone,
      capturedAtMs: 300 as EpochMs,
    };
    const bounded = semanticTemporalDomainsFromQueryTime(queryTime);
    expect(bounded).toMatchObject({
      candidate,
      filter: queryTime.filterRange,
      read: { kind: "bounded", range: queryTime.readRange },
    });

    expect(
      semanticTemporalDomainsFromQueryTime({
        ...queryTime,
        fullHistory: true,
      }).read,
    ).toEqual({ kind: "retained-history" });
    expect(() =>
      createSemanticTemporalDomains({
        candidate: { startMs: 2 as EpochMs, endExclusiveMs: 1 as EpochMs },
        read: { kind: "retained-history" },
        reportingTimeZone: "UTC" as ReportingTimeZone,
        capturedAtMs: 3 as EpochMs,
      }),
    ).toThrow("candidate time range");
  });

  it("keeps the analytics entity vocabulary free of legacy visit IDs", () => {
    const entities: readonly AnalyticsEntityKind[] = [
      "observation",
      "page",
      "event",
      "session",
      "visitor",
    ];
    expect(entities).not.toContain("visit");
  });
});
