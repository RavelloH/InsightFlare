import { describe, expect, it } from "vitest";

import {
  aggregate,
  callFunction,
  caseWhen,
  constant,
  count,
  eq,
  filter,
  gt,
  inList,
  join,
  lowerLogicalPlan,
  max,
  min,
  or,
  param,
  project,
  scan,
  sum,
} from "@/lib/db";
import { hasOrderStableConsumers } from "@/lib/db/query/physical/consumer-order-stability";
import {
  isSingletonCatalogLookup,
  sharedSingletonLookupReuse,
} from "@/lib/db/query/physical/shared-singleton-lookup-reuse";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";

function owner() {
  const sites = scan(schema.site_identities);
  const selected = filter(sites, inList(sites.columns.site_id, ["singleton"]));
  return project(selected, {
    site_pk: selected.columns.site_pk,
    site_id: selected.columns.site_id,
  });
}

function groupedLookup(
  mode: "canonical-min" | "canonical-max" | "raw-min" | "sum" = "canonical-min",
) {
  const selectedOwner = owner();
  const visits = scan(schema.visits);
  const owned = join(
    visits,
    selectedOwner,
    eq(visits.columns.site_pk, selectedOwner.columns.site_pk),
  );
  const pages = project(owned, {
    visitor: owned.columns.left_visitor_id,
    bucket: caseWhen(
      [
        {
          when: gt(owned.columns.left_started_at, constant(1)),
          then: constant(1),
        },
      ],
      constant(0),
    ),
    raw: owned.columns.left_duration_ms,
  });
  const cohorts = aggregate(pages, {
    groupBy: { visitor: pages.columns.visitor },
    aggregates: {
      cohort:
        mode === "canonical-max"
          ? max(pages.columns.bucket)
          : mode === "raw-min"
            ? min(pages.columns.raw)
            : min(pages.columns.bucket),
    },
  });
  const trackingVisits = scan(schema.visits);
  const trackingOwned = join(
    trackingVisits,
    selectedOwner,
    eq(trackingVisits.columns.site_pk, selectedOwner.columns.site_pk),
  );
  const tracking = project(trackingOwned, {
    visitor: trackingOwned.columns.left_visitor_id,
    bucket: caseWhen(
      [
        {
          when: gt(trackingOwned.columns.left_started_at, constant(1)),
          then: constant(1),
        },
      ],
      constant(0),
    ),
    raw: trackingOwned.columns.left_duration_ms,
  });
  const selected = join(
    tracking,
    cohorts,
    eq(tracking.columns.visitor, cohorts.columns.visitor),
  );
  const unique = aggregate(selected, {
    groupBy: {
      visitor: selected.columns.left_visitor,
      cohort: selected.columns.right_cohort,
      visit: selected.columns.left_bucket,
    },
    aggregates: {},
  });
  const result: Relation =
    mode === "sum"
      ? aggregate(selected, {
          groupBy: {},
          aggregates: { total: sum(selected.columns.left_raw) },
        })
      : aggregate(unique, {
          groupBy: {
            cohort: unique.columns.cohort,
            visit: unique.columns.visit,
          },
          aggregates: { visitors: count() },
        });
  return { owner: selectedOwner, result, cohorts };
}

describe("shared singleton catalog lookup reuse", () => {
  it("recognizes only a closed direct unique catalog seek", () => {
    const sites = scan(schema.site_identities);
    expect(isSingletonCatalogLookup(owner().node)).toBe(true);
    expect(isSingletonCatalogLookup(sites.node)).toBe(false);
    expect(
      isSingletonCatalogLookup(
        filter(sites, inList(sites.columns.site_id, ["one", "two"])).node,
      ),
    ).toBe(false);
    expect(
      isSingletonCatalogLookup(
        filter(
          sites,
          or(
            eq(sites.columns.site_id, param("one")),
            eq(sites.columns.site_id, param("two")),
          ),
        ).node,
      ),
    ).toBe(false);
    const other = scan(schema.site_identities);
    expect(
      isSingletonCatalogLookup(
        filter(sites, eq(other.columns.site_id, param("one"))).node,
      ),
    ).toBe(false);
    const selected = owner();
    expect(
      isSingletonCatalogLookup(
        project(selected, {
          changed: callFunction("lower", selected.columns.site_id),
        }).node,
      ),
    ).toBe(false);
  });

  it.each(["canonical-min", "canonical-max"] as const)(
    "propagates %s only through its fresh canonical operand and grouped lookup consumers",
    (mode) => {
      const query = groupedLookup(mode);
      expect(hasOrderStableConsumers(query.owner.node, query.result.node)).toBe(
        true,
      );
      expect(
        sharedSingletonLookupReuse(query.owner.node, query.result.node),
      ).toBe(true);
      const physical = lowerLogicalPlan(query.result);
      expect(
        physical.sharedRelations.some(
          (definition) =>
            definition.node === query.owner.node &&
            definition.materialization === "materialized",
        ),
      ).toBe(true);
    },
  );

  it.each(["raw-min", "sum"] as const)(
    "keeps %s on the original conservative consumer path",
    (mode) => {
      const query = groupedLookup(mode);
      expect(hasOrderStableConsumers(query.owner.node, query.result.node)).toBe(
        false,
      );
      expect(
        sharedSingletonLookupReuse(query.owner.node, query.result.node),
      ).toBe(false);
    },
  );

  it("does not materialize an otherwise harmless singleton without a grouped-key fanout opportunity", () => {
    const selected = owner();
    const counted = aggregate(selected, {
      groupBy: {},
      aggregates: { rows: count() },
    });
    expect(hasOrderStableConsumers(selected.node, counted.node)).toBe(true);
    expect(sharedSingletonLookupReuse(selected.node, counted.node)).toBe(false);
  });
});
