import { describe, expect, it } from "vitest";

import { siteDeletionMutations } from "@/lib/edge/sites/site-deletion";

describe("typed site deletion statements", () => {
  it("keeps the legacy run order, tags, and one-site bindings", () => {
    const mutations = siteDeletionMutations("site-a");

    expect(mutations.map(({ tag }) => tag)).toEqual([
      "admin.sites.delete_config",
      "admin.sites.delete_custom_event_json_values",
      "admin.sites.delete_custom_event_json_nodes",
      "admin.sites.delete_custom_events",
      "admin.sites.delete_custom_event_names",
      "admin.sites.delete_custom_event_json_keys",
      "admin.sites.delete_custom_event_json_paths",
      "admin.sites.delete_visits",
      "admin.sites.delete_hourly_rollups",
      "admin.sites.delete_hourly_aggregation_state",
      "admin.sites.delete",
    ]);
    expect(mutations.map(({ bindings }) => bindings)).toEqual([
      ["site:site-a"],
      ["site-a"],
      ["site-a"],
      ["site-a"],
      ["site-a"],
      ["site-a"],
      ["site-a"],
      ["site-a"],
      ["site-a"],
      ["site-a"],
      ["site-a"],
    ]);
    expect(mutations[2]?.sql).toContain(" IN (SELECT ");
    expect(mutations.every(({ kind }) => kind === "mutation")).toBe(true);
  });
});
