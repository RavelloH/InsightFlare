// @vitest-environment node
import { expect, it, vi } from "vitest";

import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  prepareScopedQuery,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import { prepareTeamSitesQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as pagination from "@/lib/edge/analytics/providers/d1/internal/pagination";
import * as team from "@/lib/edge/analytics/providers/d1/internal/team";
import * as reader from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

import { createFixture } from "./team-sites-membership-fixture";
it.each([
  "binding",
  "decode",
  "empty-listing",
  "encode",
  "final-read",
] as const)(
  "rechecks qualified request after actual %s await",
  async (boundary) => {
    const db = createFixture(),
      trace: SqliteD1Trace = { preparedSql: [], bindings: [] },
      sites = ["b04-site-a", "b04-site-b"];
    const env = {
      DB: createSqliteD1Database(db, trace),
      MAIN_SECRET: "team-sites-await-test",
    } as Env;
    const query = prepareScopedQuery("team-sites", {
      context: teamQueryContext("b04-team", "private-dashboard", sites),
      teamId: "b04-team",
      allowedSiteIds: sites,
      time: createQueryTime(100, 200, "UTC", 300),
      filters: parseFilterDsl(
        'count(event { event.name eq "qualifier" }) gte 1',
        analyticsFilterRegistry,
      ),
      scopePreference: "session" as const,
      page: { limit: 1, cursor: null },
    });
    const qualification = await prepareTeamSitesQualification({ env, query });
    const before = trace.preparedSql.length;
    const mutate = () =>
      Object.assign(scopedFilterMetadata(query.filters)!, {
        requestedScope: "visitor",
      });
    if (boundary === "empty-listing")
      db.exec("UPDATE sites SET team_id='not-listable'");
    const binding = pagination.paginationBindingForWindow,
      decode = pagination.decodePageCursor,
      listing = team.queryTeamSitesPageFromD1,
      encode = pagination.encodePageCursor,
      latest = reader.readLatestSiteActivity;
    const spy =
      boundary === "binding"
        ? vi
            .spyOn(pagination, "paginationBindingForWindow")
            .mockImplementation(async (...args) => {
              const result = await binding(...args);
              mutate();
              return result;
            })
        : boundary === "decode"
          ? vi
              .spyOn(pagination, "decodePageCursor")
              .mockImplementation(async (...args) => {
                const result = await decode(...args);
                mutate();
                return result;
              })
          : boundary === "empty-listing"
            ? vi
                .spyOn(team, "queryTeamSitesPageFromD1")
                .mockImplementation(async (...args) => {
                  const result = await listing(...args);
                  expect(result.rows).toHaveLength(0);
                  mutate();
                  return result;
                })
            : boundary === "encode"
              ? vi
                  .spyOn(pagination, "encodePageCursor")
                  .mockImplementation(async (...args) => {
                    const result = await encode(...args);
                    mutate();
                    return result;
                  })
              : vi
                  .spyOn(reader, "readLatestSiteActivity")
                  .mockImplementation(async (...args) => {
                    const result = await latest(...args);
                    mutate();
                    return result;
                  });
    try {
      await expect(
        readTeamSites({
          env,
          teamId: "b04-team",
          audience: "private-dashboard",
          window: {
            startMs: 100,
            endExclusiveMs: 200,
            nowMs: 300,
            timeZone: "UTC",
          },
          filters: query.filters!,
          allowedSiteIds: sites,
          page: query.page,
          qualification,
        }),
      ).rejects.toMatchObject({
        domainError: {
          issues: [
            { code: "team_sites_membership_admission_context_mismatch" },
          ],
        },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(trace.preparedSql.length - before).toBe(
        boundary === "binding" || boundary === "decode"
          ? 0
          : boundary === "final-read"
            ? 3
            : 1,
      );
    } finally {
      spy.mockRestore();
    }
  },
);
