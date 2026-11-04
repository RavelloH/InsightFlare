import { describe, expect, it } from "vitest";

import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/contract/catalog";
import {
  assertSemanticEventReportAttributeContracts,
  assertSemanticObservationAttributeContracts,
  assertSemanticPageReportAttributeContracts,
  isObservationKind,
  isSemanticEventReportAttribute,
  isSemanticPageReportAttribute,
  semanticAttribute,
  semanticAttributeCatalog,
  semanticEventReportAttributeCatalog,
  semanticObservationAttributeCatalog,
  semanticPageReportAttributeCatalog,
} from "@/lib/edge/analytics/engine/semantic/attributes";
import { validateSemanticCatalog } from "@/lib/edge/analytics/engine/semantic/catalog";
import { ADVANCED_COUNT_SELECTOR_FIELDS } from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
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

  it("catalogs an exact aggregate proof attribute for every numeric Page scalar", () => {
    const numericFields = ADVANCED_COUNT_SELECTOR_FIELDS.filter(
      (field) => field.kind === "number",
    );
    expect(numericFields).toHaveLength(6);
    for (const field of numericFields)
      expect(
        semanticObservationAttributeCatalog.find(
          ({ id }) => id === field.exactAggregateAttribute,
        ),
      ).toMatchObject({
        id: field.exactAggregateAttribute,
        nativeEntity: "observation",
        valueType: { kind: "scalar", scalar: "boolean" },
        nullable: false,
      });
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
        "observation.siteIdentityConsistent",
        "observation.ownerPageStartedAt",
        "observation.startedAt",
        "observation.perfCls",
        "observation.contextPagePathnameIsString",
        "observation.contextPageTitleIsString",
        "observation.contextPageQueryStringIsString",
        "observation.contextPageHashIsString",
        "observation.sameSiteEventNameIsString",
        "observation.contextPageDurationMsIsCountSafeNumber",
        "observation.contextPagePerfTtfbMsIsCountSafeNumber",
        "observation.contextPagePerfFcpMsIsCountSafeNumber",
        "observation.contextPagePerfLcpMsIsCountSafeNumber",
        "observation.contextPagePerfClsIsCountSafeNumber",
        "observation.contextPagePerfInpMsIsCountSafeNumber",
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
    expect(
      semanticAttribute("observation.siteIdentityConsistent"),
    ).toMatchObject({
      valueType: { kind: "scalar", scalar: "boolean" },
      nullable: false,
      nativeEntity: "observation",
    });
    for (const attributeId of [
      "observation.contextPagePathnameIsString",
      "observation.contextPageTitleIsString",
      "observation.contextPageQueryStringIsString",
      "observation.contextPageHashIsString",
    ])
      expect(semanticAttribute(attributeId)).toMatchObject({
        valueType: { kind: "scalar", scalar: "boolean" },
        nullable: false,
      });
    for (const attributeId of [
      "observation.contextPageDurationMsIsCountSafeNumber",
      "observation.contextPagePerfTtfbMsIsCountSafeNumber",
      "observation.contextPagePerfFcpMsIsCountSafeNumber",
      "observation.contextPagePerfLcpMsIsCountSafeNumber",
      "observation.contextPagePerfClsIsCountSafeNumber",
      "observation.contextPagePerfInpMsIsCountSafeNumber",
    ])
      expect(semanticAttribute(attributeId)).toMatchObject({
        valueType: { kind: "scalar", scalar: "boolean" },
        nullable: false,
      });
    expect(
      semanticAttribute("observation.contextPageDurationMs"),
    ).toMatchObject({
      valueType: { kind: "scalar", scalar: "number", unit: "ms" },
    });
    expect(semanticAttribute("observation.contextPagePerfCls")).toMatchObject({
      valueType: { kind: "scalar", scalar: "number", unit: "ratio" },
    });
    expect(
      semanticAttribute("observation.sameSiteEventNameIsString"),
    ).toMatchObject({
      valueType: { kind: "scalar", scalar: "boolean" },
      nullable: false,
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

  it("keeps optional Event report relationships internal and contract-checked", () => {
    expect(semanticEventReportAttributeCatalog.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "event.report.localId",
        "event.report.ownerPresent",
        "event.report.eventName",
        "event.report.ownerPreviousVisitId",
        "event.report.ownerPreviousVisitStartedAt",
      ]),
    );
    expect(isSemanticEventReportAttribute("event.report.eventName")).toBe(true);
    expect(analyticsFilterRegistry.has("event.report.eventName")).toBe(false);
    expect(
      semanticAttribute("event.report.eventName")?.derivation,
    ).toMatchObject({
      kind: "report-relationship",
      relationship: "event.name",
      cardinality: "zero-or-one",
      sourceAttribute: "event.report.nameId",
    });
    expect(
      semanticAttribute("event.report.ownerPreviousVisitId")?.derivation,
    ).toMatchObject({
      kind: "report-relationship",
      relationship: "event.ownerPage",
      sourceAttribute: "page.report.previousVisitId",
      dependencies: ["page.report.previousVisitId"],
    });
    const ownerPresent = semanticEventReportAttributeCatalog.find(
      ({ id }) => id === "event.report.ownerPresent",
    )!;
    expect(() =>
      assertSemanticEventReportAttributeContracts(
        [{ ...ownerPresent, nullable: true }],
        new Set(),
      ),
    ).toThrow(
      "invalid_event_report_attribute_contract:event.report.ownerPresent",
    );
  });
});
