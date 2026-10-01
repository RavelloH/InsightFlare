import { describe, expect, it } from "vitest";

import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/contract/catalog";
import {
  assertSemanticObservationAttributeContracts,
  assertSemanticPageReportAttributeContracts,
  isObservationKind,
  isSemanticPageReportAttribute,
  semanticAttribute,
  semanticAttributeCatalog,
  semanticObservationAttributeCatalog,
  semanticPageReportAttributeCatalog,
} from "@/lib/edge/analytics/engine/semantic/attributes";
import { validateSemanticCatalog } from "@/lib/edge/analytics/engine/semantic/catalog";
import {
  semanticDimension,
  semanticDimensionCatalog,
} from "@/lib/edge/analytics/engine/semantic/dimensions";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

describe("semantic attribute and dimension catalogs", () => {
  it("recognizes only supported Observation kinds", () => {
    expect(isObservationKind("page")).toBe(true);
    expect(isObservationKind("event")).toBe(true);
    expect(isObservationKind("session")).toBe(false);
  });

  it("rejects duplicate and malformed Observation attribute contracts", () => {
    const attribute = semanticObservationAttributeCatalog[0]!;
    expect(() =>
      assertSemanticObservationAttributeContracts(
        [attribute],
        new Set([attribute.id]),
      ),
    ).toThrow(`duplicate_semantic_attribute:${attribute.id}`);
    expect(() =>
      assertSemanticObservationAttributeContracts(
        [{ ...attribute, observationKinds: ["page"] }],
        new Set(),
      ),
    ).toThrow(`invalid_observation_attribute_contract:${attribute.id}`);
  });

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

  it("keeps raw Observation identities internal to semantic plans", () => {
    expect(semanticAttributeCatalog).toHaveLength(analyticsFilterRegistry.size);
    expect(semanticObservationAttributeCatalog.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "observation.sessionId",
        "observation.visitorId",
        "observation.kind",
        "observation.id",
        "observation.eventName",
        "observation.ownerPageStartedAt",
        "observation.startedAt",
        "observation.perfCls",
      ]),
    );
    for (const attribute of semanticObservationAttributeCatalog) {
      const { id } = attribute;
      expect(analyticsFilterRegistry.has(id)).toBe(false);
      expect(semanticAttribute(id)).toEqual({
        id,
        nativeEntity: "observation",
        observationKinds: ["event", "page"],
        valueType: attribute.valueType,
        nullable: attribute.nullable,
        evaluation: "observation",
        presence: "non-null",
        empty:
          attribute.valueType.kind === "scalar" &&
          attribute.valueType.scalar === "string"
            ? "empty-string-is-value"
            : "unsupported",
        comparison: "case-sensitive",
      });
    }
    expect(semanticAttribute("observation.perfTtfbMs")).toMatchObject({
      valueType: { kind: "scalar", scalar: "number", unit: "ms" },
      nullable: true,
    });
    expect(semanticAttribute("observation.perfCls")).toMatchObject({
      valueType: { kind: "scalar", scalar: "number", unit: "ratio" },
      nullable: true,
    });
  });

  it("keeps Page report fields outside the public Filter Registry", () => {
    expect(semanticAttributeCatalog).toHaveLength(analyticsFilterRegistry.size);
    expect(semanticPageReportAttributeCatalog.map(({ id }) => id)).toContain(
      "page.report.previousVisitStartedAt",
    );
    expect(semanticAttribute("page.report.latitude")).toMatchObject({
      nativeEntity: "page",
      evaluation: "page-report",
      valueType: { kind: "scalar", scalar: "number" },
      nullable: true,
    });
    expect(
      semanticAttribute("page.report.previousVisitId")?.derivation,
    ).toMatchObject({
      kind: "report-relationship",
      relationship: "page.previous",
      selection: "latest-strictly-earlier-same-session-page",
      dependencies: [
        "page.report.sessionId",
        "page.report.startedAt",
        "page.report.localId",
      ],
      orderBy: [
        { attribute: "page.report.startedAt", direction: "desc" },
        { attribute: "page.report.localId", direction: "desc" },
      ],
    });
    expect(isSemanticPageReportAttribute("page.report.latitude")).toBe(true);
    expect(analyticsFilterRegistry.has("page.report.latitude")).toBe(false);
    expect(isSemanticPageReportAttribute("page.latitude")).toBe(false);
    const previousId = semanticPageReportAttributeCatalog.find(
      ({ id }) => id === "page.report.previousVisitId",
    )!;
    expect(() =>
      assertSemanticPageReportAttributeContracts(
        [{ ...previousId, nullable: false }],
        new Set(),
      ),
    ).toThrow(
      "invalid_page_report_attribute_contract:page.report.previousVisitId",
    );
    expect(() =>
      assertSemanticPageReportAttributeContracts(
        [semanticPageReportAttributeCatalog[0]!],
        new Set([semanticPageReportAttributeCatalog[0]!.id]),
      ),
    ).toThrow(
      `duplicate_semantic_attribute:${semanticPageReportAttributeCatalog[0]!.id}`,
    );
  });
});
