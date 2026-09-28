import { describe, expect, it } from "vitest";

import {
  MAX_SITE_IDS_PER_D1_QUERY,
  teamDeletionMutations,
} from "@/lib/edge/admin/teams/deletion";

const tableOrder = [
  "custom_event_json_values",
  "custom_event_json_nodes",
  "custom_events",
  "custom_event_names",
  "custom_event_json_keys",
  "custom_event_json_paths",
  "visits",
  "visit_hourly_rollups",
  "visit_hourly_aggregation_state",
  "configs",
] as const;

function targetTable(sql: string): string | undefined {
  return sql.match(/DELETE FROM "([^"]+)"/)?.[1];
}

describe("typed team deletion statements", () => {
  it("keeps category-outer order, tags, bindings, and legacy input order", () => {
    const mutations = teamDeletionMutations(["site-b", "site-a"]);

    expect(mutations.map(({ tag }) => tag)).toEqual(
      Array.from(
        { length: tableOrder.length },
        () => "admin.teams.delete_site_settings",
      ),
    );
    expect(mutations.map(({ sql }) => targetTable(sql))).toEqual(tableOrder);
    expect(mutations.map(({ bindings }) => bindings ?? [])).toEqual([
      ["site-b", "site-a"],
      ["site-b", "site-a"],
      ["site-b", "site-a"],
      ["site-b", "site-a"],
      ["site-b", "site-a"],
      ["site-b", "site-a"],
      ["site-b", "site-a"],
      ["site-b", "site-a"],
      ["site-b", "site-a"],
      ["site:site-b", "site:site-a"],
    ]);
    expect(mutations[1]?.sql).toContain(" IN (SELECT ");
    expect(teamDeletionMutations([])).toEqual([]);
  });

  it.each([1, 99, 100, 101])(
    "chunks %i site IDs without exceeding the D1 binding limit",
    (size) => {
      const siteIds = Array.from(
        { length: size },
        (_, index) => `site-${index}`,
      );
      const mutations = teamDeletionMutations(siteIds);
      const chunkCount = Math.ceil(size / MAX_SITE_IDS_PER_D1_QUERY);

      expect(mutations).toHaveLength(tableOrder.length * chunkCount);
      expect(
        mutations.every(
          ({ tag }) => tag === "admin.teams.delete_site_settings",
        ),
      ).toBe(true);
      expect(
        mutations.every(({ bindings }) => (bindings?.length ?? 0) <= 100),
      ).toBe(true);

      for (let category = 0; category < tableOrder.length; category++) {
        const categoryMutations = mutations.slice(
          category * chunkCount,
          (category + 1) * chunkCount,
        );
        expect(categoryMutations.map(({ sql }) => targetTable(sql))).toEqual(
          Array.from({ length: chunkCount }, () => tableOrder[category]),
        );
        expect(
          categoryMutations.map(({ bindings }) => bindings?.length ?? 0),
        ).toEqual(size > 100 ? [100, size - 100] : [size]);
      }
    },
  );
});
