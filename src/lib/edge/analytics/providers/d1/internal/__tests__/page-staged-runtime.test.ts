// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { dimensionPageSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { observeCostDatabase } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as staged from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as dimensionReaders from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
import type { PageRequest } from "@/lib/pagination";
for (const scope of ["session", "visitor"] as const)
  for (const dimension of [
    "client.browser",
    "geo.country",
    "referrer.domain",
  ] as const)
    it(`${scope}/${dimension}: real numeric-refusal dimension deferred tail and page2`, async () => {
      const db = createMigratedDatabase();
      for (const sql of [
        ...buildSiteStatements(),
        ...buildDataStatements({ visits: 24 }),
      ])
        db.exec(sql);
      const setup = [
        "UPDATE visits SET duration_ms=1",
        "UPDATE visits SET duration_ms='invalid-duration' WHERE rowid=(SELECT min(rowid) FROM visits)",
      ];
      for (const sql of setup) db.exec(sql);
      const writesBefore = db.prepare("SELECT total_changes() AS writes").get();
      const diagnostics = createD1ReadDiagnostics();
      const observed = observeCostDatabase(createSqliteD1Database(db));
      const registered = vi.spyOn(bridge, "registerPreparedMembership");
      const resolved = vi.spyOn(bridge, "resolvePreparedMembership");
      const evaluated = vi.spyOn(core, "evaluateFilterDocument");
      const actualReaderGuardProbes: Promise<void>[] = [];
      const originalReader = dimensionReaders.queryDimensionPageFromD1;
      const readerCalls: Parameters<typeof originalReader>[] = [];
      const readerProbeMessages: string[] = [];
      const readerSpy = vi
        .spyOn(dimensionReaders, "queryDimensionPageFromD1")
        .mockImplementation((...args) => {
          readerCalls.push(args);
          expect(args.length).toBe(13);
          {
            expect(args[10]).toBeUndefined();
            expect(args[11]).toBeUndefined();
            expect(args[12]?.dimension).toBe(dimension);
          }
          if (dimension === "client.browser") {
            const beforeProbeSql = observed.observations.length;
            const check = (
              key: string,
              changes: (copy: Parameters<typeof originalReader>) => void,
            ) => {
              const copy = [...args] as Parameters<typeof originalReader>;
              changes(copy);
              readerProbeMessages.push(key);
              actualReaderGuardProbes.push(
                expect(originalReader(...copy)).rejects.toThrow(
                  "page_membership_reader_configuration_mismatch",
                ),
              );
            };
            check("actual-selection-mismatch", (copy) => {
              copy[5] = dimensionPageSelection("client.os")!;
            });
            check("actual-audience-mismatch", (copy) => {
              copy[9] = "public-share";
            });
            check("actual-exclude-empty-mismatch", (copy) => {
              copy[6] = { ...copy[6], excludeEmpty: true };
            });
            expect(observed.observations.length).toBe(beforeProbeSql);
          }
          return originalReader(...args);
        });
      const initialPage: PageRequest = { limit: 2 };
      const request = {
        mode: "breakdown" as const,
        context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
        time: createQueryTime(
          SEED_BASE_MS,
          SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
          "UTC",
          SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
        ),
        scopePreference: scope,
        dimension,
        page: initialPage,
        filters: parseFilterDsl(
          "count(page { page.durationMs gt 0 }) gte 1",
          analyticsFilterRegistry,
        ),
      };
      const providerErrors: unknown[] = [];
      const capabilityChecks: string[] = [];
      const actualBind = staged.bindDeferredPageMembershipSuccessor;
      const bindSpy =
        dimension === "client.browser"
          ? vi
              .spyOn(staged, "bindDeferredPageMembershipSuccessor")
              .mockImplementation((input) => {
                const readerArgs = readerCalls.at(-1)!;
                expect(readerArgs[7]).toBe(input.consumer.configuration.cursor);
                expect(readerArgs[12]?.deferred).toBe(input.deferred);
                expect(readerArgs[1]).toBe(input.siteId);
                expect(readerArgs[3]).toBe(input.filters);
                const checks = [
                  [
                    "copied-owner",
                    () =>
                      actualBind({ ...input, deferred: { ...input.deferred } }),
                    "deferred_event_qualification_untrusted",
                  ],
                  [
                    "wrong-site",
                    () => actualBind({ ...input, siteId: "foreign" }),
                    "page_membership_reader_context_mismatch",
                  ],
                  [
                    "copied-time",
                    () =>
                      actualBind({
                        ...input,
                        queryTime: { ...input.queryTime },
                      }),
                    "page_membership_reader_context_mismatch",
                  ],
                  [
                    "copied-scope",
                    () =>
                      actualBind({
                        ...input,
                        scopePlan: { ...input.scopePlan },
                      }),
                    "page_membership_reader_context_mismatch",
                  ],
                  [
                    "copied-filter",
                    () =>
                      actualBind({
                        ...input,
                        filters: Object.defineProperties(
                          { ...input.filters },
                          Object.getOwnPropertyDescriptors(input.filters),
                        ),
                      }),
                    "channels_membership_successor_not_available",
                  ],
                  [
                    "wrong-dimension",
                    () =>
                      actualBind({
                        ...input,
                        consumer: {
                          ...input.consumer,
                          configuration: {
                            ...input.consumer.configuration,
                            dimension: "page.path",
                          },
                        },
                      }),
                    "page_membership_reader_configuration_mismatch",
                  ],
                  [
                    "wrong-limit",
                    () =>
                      actualBind({
                        ...input,
                        consumer: {
                          ...input.consumer,
                          configuration: {
                            ...input.consumer.configuration,
                            limit: 987,
                          },
                        },
                      }),
                    "page_membership_reader_configuration_mismatch",
                  ],
                  [
                    "wrong-sort",
                    () =>
                      actualBind({
                        ...input,
                        consumer: {
                          ...input.consumer,
                          configuration: {
                            ...input.consumer.configuration,
                            sortDirection: "asc",
                          },
                        },
                      }),
                    "page_membership_reader_configuration_mismatch",
                  ],
                  [
                    "wrong-cursor-text",
                    () =>
                      actualBind({
                        ...input,
                        consumer: {
                          ...input.consumer,
                          configuration: {
                            ...input.consumer.configuration,
                            cursorText: "forged",
                          },
                        },
                      }),
                    "page_membership_reader_configuration_mismatch",
                  ],
                  [
                    "wrong-decoded-cursor",
                    () =>
                      actualBind({
                        ...input,
                        consumer: {
                          ...input.consumer,
                          configuration: {
                            ...input.consumer.configuration,
                            cursor: {
                              primary: 987,
                              secondary: 654,
                              value: "foreign",
                            },
                          },
                        },
                      }),
                    "page_membership_reader_descriptor_mismatch",
                  ],
                  [
                    "wrong-source-role",
                    () =>
                      actualBind({
                        ...input,
                        consumer: {
                          kind: "performance-summary",
                          configuration: {},
                        } as never,
                      }),
                    "page_membership_reader_configuration_mismatch",
                  ],
                ] as const;
                const before = observed.observations.length;
                for (const [key, probe, message] of checks) {
                  expect(probe, key).toThrow(message);
                  capabilityChecks.push(key);
                }
                const frame = input.deferred.channelMembershipInvocation!;
                const stages = frame.observedSemanticStages();
                expect(stages.length).toBeGreaterThan(0);
                expect(() =>
                  frame.completedFor(structuredClone(stages[0]!)),
                ).toThrow("channels_membership_predecessor_not_completed");
                capabilityChecks.push("copied-completion-plan");
                expect(observed.observations.length).toBe(before);
                const bound = actualBind(input);
                expect(() => actualBind(input)).toThrow(
                  "channels_membership_successor_not_available",
                );
                capabilityChecks.push("successful-slot-replay");
                return bound;
              })
          : undefined;

      try {
        const runtime = createD1SiteQueryRuntime({
          env: { DB: observed.database, MAIN_SECRET: "w61-native" } as Env,
          siteId: SEED_SITE_ID,
          diagnostics,
        });
        for (const page of dimension === "client.browser" ? [1, 2] : [1]) {
          const beforeSql = observed.observations.length;
          const response = await runtime.execute("dimension", request, {
            onProviderError(error) {
              providerErrors.push(error);
            },
          });
          expect(response).toMatchObject({ ok: true });
          if (!response.ok)
            throw new Error("expected-successful-dimension-result");
          const value = response.data;
          if (!("items" in value))
            throw new Error("expected-dimension-breakdown-items");
          expect(value.items).not.toHaveLength(0);
          const statements = observed.observations.slice(beforeSql);
          expect(statements).toHaveLength(5);
          for (const statement of statements) {
            expect(statement.sql.length).toBeGreaterThan(0);
            expect(Array.isArray(statement.params)).toBe(true);
          }
          if (page === 1 && dimension === "client.browser") {
            if (
              !("pagination" in value) ||
              typeof value.pagination !== "object" ||
              value.pagination === null ||
              !("hasMore" in value.pagination) ||
              !("nextCursor" in value.pagination)
            )
              throw new Error("expected-dimension-pagination");
            expect(value.pagination.hasMore).toBe(true);
            const nextCursor = value.pagination.nextCursor;
            expect(nextCursor).toEqual(expect.any(String));
            if (typeof nextCursor !== "string")
              throw new Error("expected-dimension-next-cursor");
            request.page = { ...request.page, cursor: nextCursor };
          }
        }
        await Promise.all(actualReaderGuardProbes);
        const count = dimension === "client.browser" ? 2 : 1;
        expect(readerCalls.length).toBe(count);
        expect(evaluated.mock.calls.length).toBe(count);
        expect(registered.mock.calls.length).toBe(0);
        expect(resolved.mock.calls.length).toBe(0);
        expect(capabilityChecks).toHaveLength(
          dimension === "client.browser" ? count * 13 : 0,
        );
        expect(readerProbeMessages).toHaveLength(
          dimension === "client.browser" ? count * 3 : 0,
        );
        expect(providerErrors).toEqual([]);
        expect(db.prepare("SELECT total_changes() AS writes").get()).toEqual(
          writesBefore,
        );
      } finally {
        readerSpy.mockRestore();
        bindSpy?.mockRestore();
        registered.mockRestore();
        resolved.mockRestore();
        evaluated.mockRestore();
        db.close();
      }
    });
