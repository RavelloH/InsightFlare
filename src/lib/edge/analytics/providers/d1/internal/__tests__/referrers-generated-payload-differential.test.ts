// @vitest-environment node
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createD1DatabaseClient } from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  checkDifferentialFilterCase,
  generateDifferentialFilterCases,
} from "@/lib/edge/analytics/engine/__tests__/differential/filter-cases";
import * as countSupport from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { expandCustomEventData } from "@/lib/edge/ingest/custom-event-json";
import { prepareCustomEventMutations } from "@/lib/edge/ingest/custom-event-write-mutations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

import { COST_TIME } from "./remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "./remote-d1/seed";

const SAMPLES = generateDifferentialFilterCases(0x20261115, 12, [
  'count(event { event.payload("/value") eq "match" }) gte 1',
  'count(event { event.payload("/value") neq "match" }) eq 0',
  'count(event { event.payload("/number") gt 2 }) gte 1',
  'count(event { event.payload("/flag") eq true }) gte 1',
  'count(event { event.payload("/missing") notExists }) gte 1',
  'count(event { event.payload("/nested/name") eq "nested" }) gte 1',
]);

const PAYLOADS = [
  { value: "match", number: 3, flag: true, nested: { name: "nested" } },
  { value: "other", number: 1, flag: false, nested: { name: "other" } },
  { value: null, number: "3", flag: null },
  { value: 3, number: null, missing: "present" },
  { value: ["match"], number: 4, nested: null },
  {},
];

describe.each([18, 36])(
  "generated payload Referrers parity, %i visits",
  (visits) => {
    let database: DatabaseSync;
    let env: Env;
    const observedStrategies = new Set<string>();
    beforeAll(async () => {
      database = createMigratedDatabase();
      for (const sql of [
        ...buildSiteStatements(),
        ...buildDataStatements({ visits }),
      ])
        database.exec(sql);
      database.exec("DELETE FROM custom_events");
      const d1 = createSqliteD1Database(database);
      const writer = createD1DatabaseClient(d1);
      env = { DB: d1, MAIN_SECRET: "payload-generated-test" } as unknown as Env;
      const pathIds = new Map<string, number>();
      const keyIds = new Map<string, number>();
      for (let index = 0; index < visits; index += 1) {
        const expanded = expandCustomEventData(
          PAYLOADS[index % PAYLOADS.length],
        );
        if (!expanded.ok) throw new Error(expanded.error);
        for (const path of expanded.data.paths) {
          if (pathIds.has(path)) continue;
          const row = database
            .prepare(
              "INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at) VALUES (?, 1, ?, 0) RETURNING id",
            )
            .get(SEED_SITE_ID, path) as { id: number };
          pathIds.set(path, row.id);
        }
        for (const key of expanded.data.keys) {
          if (keyIds.has(key)) continue;
          const row = database
            .prepare(
              'INSERT INTO custom_event_json_keys (site_id, site_pk, "key", last_seen_at) VALUES (?, 1, ?, 0) RETURNING id',
            )
            .get(SEED_SITE_ID, key) as { id: number };
          keyIds.set(key, row.id);
        }
        const at =
          SEED_BASE_MS +
          Math.floor((index * SEED_DAYS * SEED_DAY_MS) / visits) +
          2;
        await writer.batch(
          prepareCustomEventMutations(
            {
              eventId: `payload-${index}`,
              siteId: SEED_SITE_ID,
              visitId: `v${index}`,
              eventName: "qualifier",
              eventDataJson: expanded.data.json,
              occurredAt: at,
              receivedAt: at,
              sequence: 1,
              userId: "",
              dirty: 1,
              flushAttempts: 0,
              createdAt: at,
            },
            expanded.data,
            { eventNameId: 1, pathIds, keyIds },
            1,
          ),
        );
      }
    });
    afterAll(() => {
      database?.close();
      expect(observedStrategies).toEqual(
        new Set(["sql-membership", "bounded-core"]),
      );
    });

    async function execute(
      scope: "session" | "visitor",
      dsl: string,
      forceCore: boolean,
    ) {
      const classification = forceCore
        ? vi
            .spyOn(countSupport, "classifyAdvancedCountFilter")
            .mockReturnValue({
              kind: "unsupported",
              path: "root",
              code: "forced_core_oracle",
              reason: "Generated payload Core oracle.",
            })
        : undefined;
      const core = vi.spyOn(evaluator, "evaluateFilterDocument");
      try {
        const diagnostics = createD1ReadDiagnostics();
        const provider = createD1SiteProviderRegistry({
          env,
          siteId: SEED_SITE_ID,
          diagnostics,
        }).resolve("referrers")!;
        const query = {
          ...prepareScopedQuery("referrers", {
            context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
            time: COST_TIME,
            filters: parseFilterDsl(dsl, analyticsFilterRegistry),
            scopePreference: scope,
          } as QueryInput & { time: typeof COST_TIME }),
          variant: "summary",
          topN: 10,
        };
        const result = await provider.execute(query as never);
        const decision = diagnostics.advancedFilterExecution;
        expect(decision).toBeDefined();
        const usedCore = core.mock.calls.length > 0;
        expect(usedCore).toBe(decision?.strategy === "bounded-core");
        if (forceCore) {
          expect(usedCore).toBe(true);
          expect(decision?.reason).toBe("forced_core_oracle");
        } else {
          observedStrategies.add(decision!.strategy);
          if (usedCore)
            expect(decision?.reason).toMatch(
              /^sql-runtime-|^count_sql_payload_selector_(?:path_unsupported|requires_string_literals|unsupported_operator)$/u,
            );
          else expect(decision?.strategy).toBe("sql-membership");
        }
        return result.value;
      } finally {
        classification?.mockRestore();
        core.mockRestore();
      }
    }

    for (const scope of ["session", "visitor"] as const)
      it.each(SAMPLES)(`${scope}, seed $seed case $index`, async (sample) => {
        await checkDifferentialFilterCase({
          sample,
          reference: async (dsl) => execute(scope, dsl, true),
          candidates: {
            sql: async (dsl) => execute(scope, dsl, false),
          },
        });
      });
  },
);
