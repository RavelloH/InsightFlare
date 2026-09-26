import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  type FilterDocument,
  type FilterExpression,
  type FilterFieldId,
  type FilterTargetExpression,
  validateFilterConditionDomains,
} from "@/lib/filter-contract";

function condition(target: FilterTargetExpression): FilterExpression {
  return {
    kind: "condition",
    target,
    operator: "eq",
    value: "value",
  };
}

function insideEventSelector(predicate: FilterExpression): FilterDocument {
  return {
    version: 1,
    root: {
      kind: "condition",
      target: {
        kind: "selector",
        collection: { kind: "entity-root", entity: "event" },
        predicate,
      },
      operator: "exists",
    },
  };
}

describe("Filter condition entity domains", () => {
  it("resolves nested registered fields through their entity-root member path", () => {
    const pagePath: FilterTargetExpression = {
      kind: "member",
      object: { kind: "entity-root", entity: "page" },
      member: "path",
    };

    expect(() =>
      validateFilterConditionDomains(
        insideEventSelector(condition(pagePath)),
        "visitor",
        analyticsFilterRegistry,
      ),
    ).toThrow(
      expect.objectContaining({ code: "invalid_condition_entity_domain" }),
    );
  });

  it("retains the parent entity for unregistered member paths", () => {
    const unknownPageMember: FilterTargetExpression = {
      kind: "member",
      object: { kind: "entity-root", entity: "page" },
      member: "unknown",
    };

    expect(() =>
      validateFilterConditionDomains(
        insideEventSelector(condition(unknownPageMember)),
        "visitor",
        analyticsFilterRegistry,
      ),
    ).toThrow(
      expect.objectContaining({ code: "invalid_condition_entity_domain" }),
    );
  });

  it("keeps shared context fields valid inside a single-activity selector", () => {
    const country: FilterTargetExpression = {
      kind: "field",
      field: "geo.country" as FilterFieldId,
    };

    expect(() =>
      validateFilterConditionDomains(
        insideEventSelector(condition(country)),
        "visitor",
        analyticsFilterRegistry,
      ),
    ).not.toThrow();
  });

  it("uses projected collection entity metadata for sibling checks", () => {
    const pagePathProjection: FilterTargetExpression = {
      kind: "projection",
      collection: { kind: "entity-root", entity: "page" },
      member: "path",
    };

    expect(() =>
      validateFilterConditionDomains(
        insideEventSelector(condition(pagePathProjection)),
        "visitor",
        analyticsFilterRegistry,
      ),
    ).toThrow(
      expect.objectContaining({ code: "invalid_condition_entity_domain" }),
    );
  });
});
