// @vitest-environment node
// Real middleware owners and preparers supply every capability; no injected authority.
import { createHash } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1TeamQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import {
  createQueryTime,
  scopedFilterMetadata,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import * as afe from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as stages from "@/lib/edge/analytics/providers/d1/internal/analytics-logical-staged-runtime";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as qualified from "@/lib/edge/analytics/providers/d1/internal/team-sites-qualification";
import * as whole from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import * as projection from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-projection";
import * as common from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const TEAM = "w121-team";
const AUTHORIZED = ["w121-site-a", "w121-site-b"];
const FOREIGN = "w121-site-c";
/** 24 actual visits per site; only A/B authorized. Role IDs deliberately
 * collide across sites; event and Page spelling also overlap across kinds.
 * event_id itself stays globally unique, as required by the real schema. */
function fixture(numericRefusal = false, missingCoverage = false) {
  const db = createMigratedDatabase();
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare(
    "INSERT INTO teams(id,name,slug,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,0,0)",
  ).run(TEAM, TEAM, TEAM, "w121-user");
  for (const [siteIndex, site] of [...AUTHORIZED, FOREIGN].entries()) {
    const sitePk = siteIndex + 1;
    db.prepare("INSERT INTO site_identities(site_pk,site_id) VALUES(?,?)").run(
      sitePk,
      site,
    );
    db.prepare(
      "INSERT INTO sites(id,team_id,name,domain,created_at,updated_at) VALUES(?,?,?,?,0,0)",
    ).run(site, TEAM, site, `${site}.invalid`);
    db.prepare(
      "INSERT INTO custom_event_names(id,site_id,site_pk,name,last_seen_at) VALUES(?,?,?,'qualifier',0)",
    ).run(sitePk, site, sitePk);
    for (let i = 0; i < 24; i++) {
      const selected = siteIndex === 2 || i % 2 === siteIndex;
      const id = `${site}:page:${i}`;
      const at = 110 + i;
      db.prepare(
        `INSERT INTO visits(visit_id,site_id,site_pk,visitor_id,session_id,status,started_at,last_activity_at,pathname,hostname,duration_ms)
        VALUES(?,?,?,?,?,'closed',?,?,?,?,?)`,
      ).run(
        id,
        site,
        sitePk,
        `v${i % 2}`,
        `s${i % 2}`,
        at,
        at,
        "/qualifier",
        `${site}.invalid`,
        numericRefusal && i === 23 ? "invalid-duration" : 10,
      );
      if (selected)
        db.prepare(
          `INSERT INTO custom_events(event_id,site_id,site_pk,visit_id,event_name_id,occurred_at,received_at,sequence,node_count,value_count)
        VALUES(?,?,?,?,?,?,?,1,0,0)`,
        ).run(
          siteIndex === 1 && i === 1
            ? `${AUTHORIZED[0]}:page:0`
            : `${site}:event:${i}`,
          site,
          sitePk,
          id,
          sitePk,
          at + 1,
          at + 1,
        );
    }
  }
  if (missingCoverage)
    db.prepare("DELETE FROM sites WHERE id=?").run(AUTHORIZED[1]);
  db.exec("PRAGMA query_only=ON");
  return db;
}

const expected = {
  session: {
    response: {
      ok: true,
      data: {
        items: [
          {
            siteId: "w121-site-a",
            name: "w121-site-a",
            domain: "w121-site-a.invalid",
            publicEnabled: false,
            publicSlug: null,
            createdAt: 0,
            updatedAt: 0,
            metrics: {
              views: 12,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 120,
              durationViews: 12,
            },
            trend: [
              {
                bucket: 0,
                timestampMs: 0,
                views: 12,
                sessions: 1,
                visitors: 1,
                bounces: 0,
                totalDurationMs: 120,
                durationViews: 12,
              },
            ],
            lastEventAtMs: 132,
          },
        ],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiMDkyMzg0NDI0YTIwMzA4YTE1NmM5OTkxZmU1NzZhNzk4MzM5MDYyMWVkYmRkOGY0MWY4NTcyZWRmYWY3MDFkOCIsImtleSI6eyJjcmVhdGVkQXQiOjAsImlkIjoidzEyMS1zaXRlLWEifX0.UZKO8A5PZwE29ZtNAXHaXbkhtlec5iKx-GPRTsGiSY8",
        },
      },
      meta: {
        time: {
          range: {
            startMs: 100,
            endExclusiveMs: 200,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: 300,
          fullHistory: true,
        },
        source: "raw",
        approximateVisitors: false,
        filterScope: {
          requested: "session",
          resolved: "session",
        },
      },
    },
    sqlFingerprint:
      "7cbffc3a808dc4a9450c617076929372140102fd5eaadae5f9fc81fea931ac1c",
  },
  visitor: {
    response: {
      ok: true,
      data: {
        items: [
          {
            siteId: "w121-site-a",
            name: "w121-site-a",
            domain: "w121-site-a.invalid",
            publicEnabled: false,
            publicSlug: null,
            createdAt: 0,
            updatedAt: 0,
            metrics: {
              views: 12,
              sessions: 1,
              visitors: 1,
              bounces: 0,
              totalDurationMs: 120,
              durationViews: 12,
            },
            trend: [
              {
                bucket: 0,
                timestampMs: 0,
                views: 12,
                sessions: 1,
                visitors: 1,
                bounces: 0,
                totalDurationMs: 120,
                durationViews: 12,
              },
            ],
            lastEventAtMs: 132,
          },
        ],
        pagination: {
          limit: 1,
          returned: 1,
          hasMore: true,
          nextCursor:
            "eyJ2IjoxLCJiaW5kaW5nIjoiZDFiN2IwMjZkOTYwNDk0MzE0NWZiZjAyNjNjYzZkNTFhYTlkMTI0MWU4N2UzZGQ0ODI5NjQ2OGYyMGYxZTVkNSIsImtleSI6eyJjcmVhdGVkQXQiOjAsImlkIjoidzEyMS1zaXRlLWEifX0.PBtU5Kj16orY77-mogrEw_22aMC5nUqeXXRY1KHp8iM",
        },
      },
      meta: {
        time: {
          range: {
            startMs: 100,
            endExclusiveMs: 200,
          },
          reportingTimeZone: "UTC",
          capturedAtMs: 300,
          fullHistory: true,
        },
        source: "raw",
        approximateVisitors: false,
        filterScope: {
          requested: "visitor",
          resolved: "visitor",
        },
      },
    },
    sqlFingerprint:
      "9cf4840e7469c85a3f35477b9d3deaefc9c90bea69330859f06608d92164eb66",
  },
} as const;
const controls = [
  "copied-owner-and-qualification",
  "foreign-ref-and-page-role",
  "foreign-site-and-repeated-site",
  "repeated-child",
  "tampered-metadata-domain",
  "tampered-authorized-domain",
] as const;
beforeAll(() =>
  vi.stubGlobal("fetch", () => {
    throw Error("network_forbidden");
  }),
);
for (const scope of ["session", "visitor"] as const)
  for (const control of controls)
    it(`${scope}/${control}`, async () => {
      const db = fixture(),
        trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const env = {
        DB: createSqliteD1Database(db, trace),
        MAIN_SECRET: "w121-local-only",
      } as Env;
      // Unbounded sequence deliberately declines the existing Count recipe. The
      // actual whole/stage counters below must prove the new branch was reached.
      const query = {
        context: teamQueryContext(TEAM, "private-dashboard", AUTHORIZED),
        teamId: TEAM,
        allowedSiteIds: AUTHORIZED,
        time: createQueryTime(100, 200, "UTC", 300),
        scopePreference: scope,
        interval: "day" as const,
        page: { limit: 1, cursor: null },
        filters: parseFilterDsl(
          'sequence([page { page.path eq "/qualifier" },event { event.name eq "qualifier" }]) exists',
          analyticsFilterRegistry,
        ),
      };
      let owner:
        | Parameters<typeof afe.prepareTeamSitesQualification>[0]["query"]
        | undefined;
      const originalPrepare = afe.prepareTeamSitesQualification;
      vi.spyOn(afe, "prepareTeamSitesQualification").mockImplementation(
        (input) => {
          owner = input.query;
          return originalPrepare(input);
        },
      );
      const minted = vi.spyOn(
          preparation,
          "createPageVisitQualificationPreparation",
        ),
        bound = vi.spyOn(preparation, "bindPageVisitQualificationPreparation");
      const register = vi.spyOn(bridge, "registerPreparedMembership"),
        resolve = vi.spyOn(bridge, "resolvePreparedMembership");
      const projected = vi.spyOn(projection, "projectWholeOriginalMembership");
      const stage = vi.spyOn(stages, "executeAnalyticsLogicalStage"),
        old = vi.spyOn(whole, "evaluateWholeFilterMembership"),
        evaluate = vi.spyOn(core, "evaluateFilterDocument");
      const originalReaders = qualified.teamSitesQualificationReaders;
      let probes = 0;
      const rejectWithoutStorageOrSlot = (
        label: string,
        run: () => unknown,
      ) => {
        const sqlBefore = trace.preparedSql.length,
          prepBefore = minted.mock.calls.length,
          bindBefore = bound.mock.calls.length;
        let error: unknown;
        try {
          run();
        } catch (value) {
          error = value;
        }
        expect(error, label).toBeInstanceOf(Error);
        expect(trace.preparedSql.length, label).toBe(sqlBefore);
        expect(minted.mock.calls.length, label).toBe(prepBefore);
        expect(bound.mock.calls.length, label).toBe(bindBefore);
        probes++;
      };
      vi.spyOn(qualified, "teamSitesQualificationReaders").mockImplementation(
        (input, capability) => {
          if (!owner) throw Error("w133_real_forwarded_owner_not_observed");
          if (!capability || typeof capability !== "object")
            throw Error("w133_real_opaque_qualification_not_observed");
          expect(common.hasWholeOriginalCompletion(owner, "team-sites")).toBe(
            true,
          );
          expect(
            common.wholeOriginalTeamSitesQualificationFromQuery(owner),
          ).toBe(capability);
          if (control === "copied-owner-and-qualification") {
            expect(
              common.wholeOriginalTeamSitesQualificationFromQuery({ ...owner }),
            ).toBeUndefined();
            rejectWithoutStorageOrSlot("copied qualification", () =>
              originalReaders(input, { ...capability }),
            );
          }
          if (
            control === "tampered-metadata-domain" ||
            control === "tampered-authorized-domain"
          ) {
            const metadata = scopedFilterMetadata(owner.filters);
            if (!metadata) throw Error("actual metadata missing");
            const target =
              control === "tampered-metadata-domain"
                ? metadata
                : owner.context.subject;
            const key =
              control === "tampered-metadata-domain"
                ? "siteIds"
                : "authorizedSiteIds";
            const descriptor = Object.getOwnPropertyDescriptor(target, key);
            if (!descriptor) throw Error("actual domain descriptor missing");
            expect(
              Reflect.set(target, key, [AUTHORIZED[0], AUTHORIZED[0]]),
            ).toBe(true);
            try {
              rejectWithoutStorageOrSlot(control, () =>
                originalReaders(input, capability),
              );
            } finally {
              Object.defineProperty(target, key, descriptor);
            }
          }
          const readers = originalReaders(input, capability);
          rejectWithoutStorageOrSlot("qualification replay", () =>
            originalReaders(input, capability),
          );
          let first = true;
          return {
            ...readers,
            site(siteId: string) {
              if (first && control === "foreign-site-and-repeated-site")
                rejectWithoutStorageOrSlot("foreign site", () =>
                  readers.site(FOREIGN),
                );
              const site = readers.site(siteId);
              if (first && control === "foreign-site-and-repeated-site")
                rejectWithoutStorageOrSlot("repeated site", () =>
                  readers.site(siteId),
                );
              const checkFirst = first;
              first = false;
              let firstChild = true;
              return {
                ...site,
                membership: {
                  bindPlan(build, readerTime) {
                    if (
                      checkFirst &&
                      firstChild &&
                      control === "foreign-ref-and-page-role"
                    ) {
                      rejectWithoutStorageOrSlot(
                        "foreign Event membership ref",
                        () =>
                          site.membership.bindPlan(
                            (context) =>
                              build({
                                ...context,
                                qualificationDependencyRefs: [
                                  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
                                ],
                              }),
                            readerTime,
                          ),
                      );
                      rejectWithoutStorageOrSlot(
                        "foreign Page observation role",
                        () =>
                          site.membership.bindPlan(
                            (context) =>
                              build({
                                ...context,
                                qualificationDependencyRefs: [
                                  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
                                ],
                              }),
                            readerTime,
                          ),
                      );
                    }
                    const result = site.membership.bindPlan(build, readerTime);
                    if (
                      checkFirst &&
                      firstChild &&
                      control === "repeated-child"
                    )
                      rejectWithoutStorageOrSlot(
                        "repeated successful child",
                        () => site.membership.bindPlan(build, readerTime),
                      );
                    firstChild = false;
                    return result;
                  },
                },
              };
            },
          };
        },
      );
      const before = db.prepare("SELECT total_changes() AS changes").get();
      let response: unknown;
      try {
        response = await createD1TeamQueryRuntime({ env }).execute(
          "team-sites",
          query,
        );
        expect(response).toEqual(expected[scope].response);
        expect(trace.preparedSql).toHaveLength(6);
        expect(
          createHash("sha256")
            .update(
              JSON.stringify({
                sql: trace.preparedSql,
                params: trace.bindings,
              }),
            )
            .digest("hex"),
        ).toBe(expected[scope].sqlFingerprint);
        expect(stage).toHaveBeenCalledTimes(1);
        expect(old).not.toHaveBeenCalled();
        expect(stage.mock.calls[0]?.[0].kind).toBe(
          "whole-original-completion-at-original-checkpoint",
        );
        expect(evaluate.mock.calls.length).toBeGreaterThan(0);
        expect(projected).toHaveBeenCalledTimes(1);
        expect(projected.mock.calls[0]?.[0]).toEqual({
          siteIds: AUTHORIZED,
          mode: "entity",
          matches: [
            {
              siteId: AUTHORIZED[0],
              kind: "entity",
              id: scope === "session" ? "s0" : "v0",
            },
            {
              siteId: AUTHORIZED[1],
              kind: "entity",
              id: scope === "session" ? "s1" : "v1",
            },
          ],
        });
        expect(register).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
        expect(minted).toHaveBeenCalledTimes(1);
        expect(bound).toHaveBeenCalledTimes(3);
        expect(
          new Set(bound.mock.calls.map(([input]) => input.preparation)).size,
        ).toBe(1);
        for (const [input] of bound.mock.calls) {
          expect(input.siteId).toBe(AUTHORIZED[0]);
          expect(
            input.plan.nodes
              .filter((node) => node.kind === "source")
              .every(
                (source) =>
                  source.selection?.subject.siteIds.length === 1 &&
                  source.selection.subject.siteIds[0] === AUTHORIZED[0],
              ),
          ).toBe(true);
        }
        expect(probes).toBeGreaterThan(0);
        expect(db.prepare("SELECT total_changes() AS changes").get()).toEqual(
          before,
        );
      } finally {
        vi.restoreAllMocks();
        db.close();
      }
    });
afterAll(() => vi.unstubAllGlobals());
