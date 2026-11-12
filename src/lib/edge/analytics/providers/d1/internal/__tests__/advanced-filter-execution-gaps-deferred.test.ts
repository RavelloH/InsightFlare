import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  assertDeferredEventQualificationEvaluates,
  d1AdvancedFilterMiddleware,
  deferredChannelListQualificationFromQuery,
  deferredEventSummaryQualificationFromQuery,
  deferredReferrersQualificationFromQuery,
  prepareDeferredEventMembershipQualification,
  prepareDeferredEventQualificationFallback,
  prepareDeferredEventSummaryFallback,
  prepareDeferredPageVisitQualification,
  prepareDeferredReferrersSummaryQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const SITE = "gap-deferred-site";
const TIME = createQueryTime(120, 130, "UTC", 500);
const FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';

const databases = new Set<DatabaseSync>();
afterAll(() => {
  for (const database of databases) database.close();
});

type Request = Record<string, unknown>;

function createEnv(): Env {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'gap-team', 'Gap deferred', 'gap.test', 0)`,
    )
    .run(SITE);
  return {
    DB: createSqliteD1Database(database),
    MAIN_SECRET: "gap-deferred-secret",
  } as unknown as Env;
}

interface ArmableEnv {
  readonly env: Env;
  /** Aborts the controller once `statements` more D1 calls have completed. */
  readonly armAbortAfter: (
    statements: number,
    controller: AbortController,
  ) => void;
  readonly completedStatements: () => number;
}

function createArmableEnv(): ArmableEnv {
  const base = createEnv();
  let completed = 0;
  let remaining: number | undefined;
  let controller: AbortController | undefined;
  const afterStatement = (): void => {
    completed += 1;
    if (remaining === undefined) return;
    remaining -= 1;
    if (remaining <= 0) controller?.abort();
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property === "bind")
          return (...args: unknown[]) =>
            wrapStatement(
              (value as (...inner: unknown[]) => D1PreparedStatement).apply(
                target,
                args,
              ),
            );
        if (
          property === "all" ||
          property === "first" ||
          property === "run" ||
          property === "raw"
        )
          return async (...args: unknown[]) => {
            const result = await (
              value as (...inner: unknown[]) => Promise<unknown>
            ).apply(target, args);
            afterStatement();
            return result;
          };
        return value.bind(target);
      },
    });
  const db = new Proxy(base.DB, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "prepare")
        return (sql: string) =>
          wrapStatement(
            (value as (statement: string) => D1PreparedStatement).call(
              target,
              sql,
            ),
          );
      if (property === "batch")
        return async (...args: unknown[]) => {
          const result = await (
            value as (...inner: unknown[]) => Promise<unknown>
          ).apply(target, args);
          afterStatement();
          return result;
        };
      return value.bind(target);
    },
  });
  return {
    env: { ...base, DB: db } as Env,
    armAbortAfter(statements, abortController) {
      remaining = statements;
      controller = abortController;
    },
    completedStatements: () => completed,
  };
}

interface DeferredSubject {
  readonly deferred: unknown;
  readonly controller: AbortController;
  readonly armable: ArmableEnv;
}

type DeferredFactory = () => Promise<DeferredSubject>;

async function qualify(input: {
  readonly operation: string;
  readonly extra?: Request;
  readonly scope: "event" | "session" | "visitor";
  readonly pick: (forwarded: unknown) => unknown;
}): Promise<DeferredSubject> {
  const armable = createArmableEnv();
  const controller = new AbortController();
  const prepared = prepareScopedQuery(
    input.operation as never,
    {
      context: siteQueryContext(SITE, "private-dashboard"),
      time: TIME,
      filters: parseFilterDsl(FILTER, analyticsFilterRegistry),
      scopePreference: input.scope,
    } as never,
  ) as unknown as Request;
  const forwarded = await d1AdvancedFilterMiddleware(
    armable.env,
    undefined,
    SITE,
  )(
    input.operation as never,
    { ...prepared, ...input.extra } as never,
    async (value) => value,
    { signal: controller.signal } as never,
  );
  const deferred = input.pick(forwarded);
  expect(deferred).toBeDefined();
  return { deferred, controller, armable };
}

const pageVisitEventCandidate: DeferredFactory = () =>
  qualify({
    operation: "channels",
    extra: { mode: "list" },
    scope: "event",
    pick: (forwarded) => deferredChannelListQualificationFromQuery(forwarded),
  });
const pageVisitEntity: DeferredFactory = () =>
  qualify({
    operation: "channels",
    extra: { mode: "list" },
    scope: "session",
    pick: (forwarded) => deferredChannelListQualificationFromQuery(forwarded),
  });
const eventSummary: DeferredFactory = () =>
  qualify({
    operation: "event-summary",
    scope: "event",
    pick: (forwarded) => deferredEventSummaryQualificationFromQuery(forwarded),
  });
const referrersSummary: DeferredFactory = () =>
  qualify({
    operation: "referrers",
    extra: { variant: "summary" },
    scope: "event",
    pick: (forwarded) => deferredReferrersQualificationFromQuery(forwarded),
  });

const preparers: ReadonlyArray<{
  readonly name: string;
  readonly make: DeferredFactory;
  readonly run: (deferred: unknown) => Promise<unknown>;
}> = [
  {
    name: "event candidate Page visits",
    make: pageVisitEventCandidate,
    run: (deferred) =>
      prepareDeferredPageVisitQualification(deferred, "gap-consumer", {
        readerAudience: "private-dashboard",
      }),
  },
  {
    name: "entity Page membership",
    make: pageVisitEntity,
    run: (deferred) =>
      prepareDeferredPageVisitQualification(deferred, "gap-consumer", {
        readerAudience: "private-dashboard",
        readerQueryTime: TIME,
      }),
  },
  {
    name: "Event membership",
    make: eventSummary,
    run: (deferred) =>
      prepareDeferredEventMembershipQualification(deferred, "gap-consumer", [
        "event-summary",
      ]),
  },
  {
    name: "Referrers summary",
    make: referrersSummary,
    run: (deferred) =>
      prepareDeferredReferrersSummaryQualification(deferred as never),
  },
  {
    name: "Event qualification fallback",
    make: eventSummary,
    run: (deferred) =>
      prepareDeferredEventQualificationFallback(deferred as never),
  },
  {
    name: "Event summary fallback",
    make: eventSummary,
    run: (deferred) => prepareDeferredEventSummaryFallback(deferred as never),
  },
  {
    name: "qualification evaluation assertion",
    make: eventSummary,
    run: (deferred) =>
      assertDeferredEventQualificationEvaluates(deferred as never),
  },
];

describe("advanced filter execution deferred qualification aborts", () => {
  it.each(preparers)(
    "aborts $name before reading when the request signal is already aborted",
    async ({ make, run }) => {
      const { deferred, controller, armable } = await make();
      const before = armable.completedStatements();
      controller.abort();
      await expect(run(deferred)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(armable.completedStatements()).toBe(before);
    },
  );

  it.each(preparers)(
    "aborts $name at every D1 statement boundary",
    async ({ make, run }) => {
      const probe = await make();
      const before = probe.armable.completedStatements();
      await run(probe.deferred);
      const statementCount = probe.armable.completedStatements() - before;
      expect(statementCount).toBeGreaterThan(0);
      for (let boundary = 1; boundary <= statementCount; boundary += 1) {
        const subject = await make();
        subject.armable.armAbortAfter(boundary, subject.controller);
        await expect(run(subject.deferred)).rejects.toMatchObject({
          name: "AbortError",
        });
      }
    },
  );

  it("refuses values that were not produced by the middleware", async () => {
    for (const forged of [
      undefined,
      null,
      {},
      { operation: "event-summary" },
    ]) {
      await expect(
        prepareDeferredEventQualificationFallback(forged as never),
      ).rejects.toThrow("deferred_event_qualification_untrusted");
      await expect(
        assertDeferredEventQualificationEvaluates(forged as never),
      ).rejects.toThrow("deferred_event_qualification_untrusted");
      await expect(
        prepareDeferredEventMembershipQualification(forged, "key", [
          "event-summary",
        ]),
      ).resolves.toBeUndefined();
      await expect(
        prepareDeferredPageVisitQualification(forged, "key"),
      ).resolves.toBeUndefined();
      await expect(
        prepareDeferredReferrersSummaryQualification(forged as never),
      ).resolves.toBeUndefined();
    }
  });

  it("declines deferred values outside the consumer's operations or shape", async () => {
    const summary = await eventSummary();
    await expect(
      prepareDeferredEventMembershipQualification(summary.deferred, "key", [
        "event-records",
      ]),
    ).resolves.toBeUndefined();
    const channelList = await pageVisitEventCandidate();
    await expect(
      prepareDeferredReferrersSummaryQualification(
        channelList.deferred as never,
      ),
    ).resolves.toBeUndefined();
    await expect(
      prepareDeferredPageVisitQualification(channelList.deferred, "key", {
        readerAudience: "api-v1",
      }),
    ).resolves.toBeUndefined();
    const entity = await pageVisitEntity();
    await expect(
      prepareDeferredPageVisitQualification(entity.deferred, "key", {
        readerAudience: "private-dashboard",
      }),
    ).resolves.toBeUndefined();
  });
});
