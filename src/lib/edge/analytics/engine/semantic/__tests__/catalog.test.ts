import { describe, expect, it } from "vitest";

import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/contract/catalog";
import {
  semanticAttribute,
  semanticAttributeCatalog,
} from "@/lib/edge/analytics/engine/semantic/attributes";
import { validateSemanticCatalog } from "@/lib/edge/analytics/engine/semantic/catalog";
import {
  semanticDimension,
  semanticDimensionCatalog,
} from "@/lib/edge/analytics/engine/semantic/dimensions";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

describe("semantic attribute and dimension catalogs", () => {
  it("derives every registered filter field without copying compiler strategies", () => {
    expect(semanticAttributeCatalog).toHaveLength(analyticsFilterRegistry.size);
    for (const [id, field] of analyticsFilterRegistry) {
      const attribute = semanticAttribute(id);
      expect(attribute).toMatchObject({
        id,
        nullable: field.nullable,
        evaluation: field.evaluation,
        presence:
          field.presence === "non-null-column"
            ? "non-null"
            : field.presence === "derived-session-value"
              ? "derived-value"
              : "json-path",
      });
      expect(attribute).not.toHaveProperty("compilerStrategy");
      expect(attribute).not.toHaveProperty("source");
    }
    expect(semanticAttribute("page.path")).toMatchObject({
      nativeEntity: "page",
      observationKinds: ["event", "page"],
    });
    expect(semanticAttribute("event.name")).toMatchObject({
      nativeEntity: "event",
      observationKinds: ["event"],
      nullable: false,
    });
  });

  it("keeps semantic derivations limited to their declared attribute dependencies", () => {
    expect(semanticAttribute("traffic.channel")?.derivation).toEqual({
      kind: "semantic-function",
      function: "traffic-channel",
      dependencies: [
        "referrer.domain",
        "referrer.url",
        "utm.source",
        "utm.medium",
        "utm.campaign",
        "utm.term",
        "utm.content",
      ],
    });
    expect(semanticAttribute("client.browserEngine")?.derivation).toEqual({
      kind: "semantic-function",
      function: "browser-engine",
      dependencies: ["client.browser"],
    });
    expect(validateSemanticCatalog()).toEqual([]);
  });

  it("maps every contract dimension to a registered semantic attribute", () => {
    expect(semanticDimensionCatalog.map(({ id }) => id)).toEqual(
      ANALYTICS_DIMENSIONS,
    );
    for (const id of ANALYTICS_DIMENSIONS) {
      expect(semanticDimension(id)).toEqual({ id, attribute: id });
      expect(semanticAttribute(id)).toBeDefined();
    }
  });
});
