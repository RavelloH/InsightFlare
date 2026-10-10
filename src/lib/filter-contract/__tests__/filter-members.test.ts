import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  isEntityMemberNamespace,
  resolveEntityMember,
} from "@/lib/filter-contract";

describe("entity member registry", () => {
  it("resolves members against the selected entity and registered namespace", () => {
    expect(
      resolveEntityMember("event", "name", analyticsFilterRegistry),
    ).toMatchObject({
      entity: "event",
      memberPath: "name",
      fieldId: "event.name",
    });
    expect(
      resolveEntityMember("page", "path", analyticsFilterRegistry),
    ).toMatchObject({ entity: "page", fieldId: "page.path" });
    expect(
      resolveEntityMember("page", "geo.country", analyticsFilterRegistry),
    ).toMatchObject({ entity: "page", fieldId: "geo.country" });
  });

  it("rejects empty, unknown, unregistered, and entity-incompatible members", () => {
    expect(resolveEntityMember("event", "", analyticsFilterRegistry)).toBe(
      undefined,
    );
    expect(
      resolveEntityMember("unknown", "name", analyticsFilterRegistry),
    ).toBe(undefined);
    expect(
      resolveEntityMember("page", "name", analyticsFilterRegistry),
    ).toBeUndefined();
    expect(
      resolveEntityMember("visitor", "path", analyticsFilterRegistry),
    ).toBeUndefined();

    const restrictedRegistry = new Map(analyticsFilterRegistry);
    const country = restrictedRegistry.get("geo.country");
    if (!country) throw new Error("missing_geo_country_field");
    restrictedRegistry.set("geo.country", {
      ...country,
      conditionEntity: "page",
    });
    expect(
      resolveEntityMember("event", "geo.country", restrictedRegistry),
    ).toBeUndefined();
  });

  it("identifies only the namespaces that are legal in entity member paths", () => {
    for (const namespace of [
      "geo",
      "client",
      "referrer",
      "utm",
      "user",
      "performance",
    ]) {
      expect(isEntityMemberNamespace(namespace)).toBe(true);
    }
    expect(isEntityMemberNamespace("page")).toBe(false);
    expect(isEntityMemberNamespace("")).toBe(false);
  });
});
