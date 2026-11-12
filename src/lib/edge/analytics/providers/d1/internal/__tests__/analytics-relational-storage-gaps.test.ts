import { describe, expect, it } from "vitest";

import { compileD1Query, param } from "@/lib/db";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { AnalyticsRelationalStorage } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";

const SITE = "storage-gaps-site";

function createBuilder(): LogicalPlanBuilder {
  return new LogicalPlanBuilder({
    subject: createSemanticSubjectDomain({
      origin: "site",
      siteIds: [SITE as never],
    }),
    time: createSemanticTemporalDomains({
      candidate: { startMs: 0 as never, endExclusiveMs: 1_000 as never },
      read: { kind: "retained-history" },
      reportingTimeZone: "UTC" as never,
      capturedAtMs: 0 as never,
    }),
    scope: resolveAnalyticsScope("auto"),
  });
}

function sourceFor(
  entity: "page" | "event" | "observation",
  attributes: readonly string[],
) {
  const builder = createBuilder();
  const source = builder.source(entity, {
    temporalDomain: "read",
    attributes,
  });
  builder.output("probe", source, []);
  const plan = builder.finish();
  const node = plan.nodes.find(
    (candidate): candidate is SourceNode => candidate.kind === "source",
  )!;
  const storage = new AnalyticsRelationalStorage({
    siteId: SITE,
    time: plan.context.time,
  });
  return { node, storage };
}

function withEntity(node: SourceNode, entity: string): SourceNode {
  return { ...node, entity } as unknown as SourceNode;
}

function withBindings(
  node: SourceNode,
  extra: readonly Record<string, unknown>[],
): SourceNode {
  return {
    ...node,
    values: [...node.values, ...extra],
  } as unknown as SourceNode;
}

describe("AnalyticsRelationalStorage.eventPayloadNodes value fields", () => {
  function eventInput() {
    const { node, storage } = sourceFor("event", [
      "event.report.localId",
      "event.report.internalPk",
      "event.report.nameId",
      "event.report.occurredAt",
      "event.report.ownerVisitId",
    ]);
    const lowered = storage.lowerSource(node, "probe");
    const relation = lowered.relation;
    const column = (name: string) => relation.columns[name]!;
    return { storage, relation, column };
  }

  it("projects typed value rows with compatibility proof for value fields", () => {
    const { storage, relation, column } = eventInput();
    const result = storage.eventPayloadNodes(
      relation,
      [column("site_pk"), column("event_id")],
      column("event_pk"),
      {
        siteId: param(SITE),
        eventNameId: column("event_name_id"),
        occurredAt: column("occurred_at"),
        visitId: column("visit_id"),
      },
      ["plan", "items"],
      ["eventKey", "valueType", "stringValue", "valueCompatible"],
    );
    expect(Object.keys(result.relation.columns)).toEqual(
      expect.arrayContaining([
        "eventPk",
        "nodeId",
        "valueType",
        "arrayIndex",
        "stringValue",
        "numberValue",
        "booleanValue",
        "valueCompatible",
        "eventKey0",
        "eventKey1",
      ]),
    );
    const sql = compileD1Query(result.relation).sql;
    expect(sql).toContain("custom_event_json_values");
    expect(sql).toContain("custom_event_json_paths");
  });

  it("uses the structural fast path without scanning value rows", () => {
    const { storage, relation, column } = eventInput();
    const result = storage.eventPayloadNodes(
      relation,
      [column("site_pk"), column("event_id")],
      column("event_pk"),
      {
        siteId: param(SITE),
        eventNameId: column("event_name_id"),
        occurredAt: column("occurred_at"),
        visitId: column("visit_id"),
      },
      ["plan"],
      ["eventPk", "nodeId", "parentNodeId", "key", "path", "eventKey"],
    );
    expect(compileD1Query(result.relation).sql).not.toContain(
      "custom_event_json_values",
    );
  });
});

describe("AnalyticsRelationalStorage.lowerSource contract rejections", () => {
  const pageBase = () => sourceFor("page", ["page.report.status"]);
  const eventBase = () => sourceFor("event", ["event.report.eventName"]);
  const obsBase = () => sourceFor("observation", ["observation.kind"]);

  const attr = (attribute: string, slot = 90) => ({
    kind: "attribute",
    slot,
    attribute,
  });
  const rel = (relationship: string, slot = 91) => ({
    kind: "related-entity",
    slot,
    relationship,
  });

  it("rejects invalid provider source binding requests", () => {
    const { node, storage } = eventBase();
    expect(() =>
      storage.lowerSource(node, "p", new Set(node.output), [
        { kind: "bogus" } as never,
      ]),
    ).toThrow("p: Provider source binding request is invalid.");
  });

  it("rejects report attributes on the wrong source entity", () => {
    const { node, storage } = eventBase();
    expect(() =>
      storage.lowerSource(
        withBindings(node, [attr("page.report.status")]),
        "p",
      ),
    ).toThrow("Internal Page report attributes are available only on Page.");
    const page = pageBase();
    expect(() =>
      page.storage.lowerSource(
        withBindings(page.node, [attr("event.report.eventName")]),
        "p",
      ),
    ).toThrow("Internal Event report attributes are available only on Event.");
  });

  it("rejects unregistered attributes and unsupported entities", () => {
    const { node, storage } = eventBase();
    expect(() =>
      storage.lowerSource(withBindings(node, [attr("no.such.attribute")]), "p"),
    ).toThrow("No registered D1 primitive storage mapping exists for");
    const bare = { ...node, values: [] } as unknown as SourceNode;
    expect(() => storage.lowerSource(withEntity(bare, "journey"), "p")).toThrow(
      "D1 lowering supports Page, Event, Observation, and canonical Session/Visitor count-fact sources only.",
    );
  });

  it("rejects session and visitor sources that request occurrence time", () => {
    const { node, storage } = sourceFor("observation", ["observation.kind"]);
    const session = {
      ...node,
      entity: "session",
      values: [{ kind: "occurrence-time", slot: 90 }],
    } as unknown as SourceNode;
    expect(() => storage.lowerSource(session, "p")).toThrow(
      "Occurrence time is not available on Session or Visitor fact sources.",
    );
  });

  it("rejects relationships that do not belong to the source entity", () => {
    const { node, storage } = obsBase();
    for (const relationship of [
      "page.observation",
      "page.session",
      "page.visitor",
      "event.observation",
      "event.session",
      "event.visitor",
    ]) {
      expect(() =>
        storage.lowerSource(withBindings(node, [rel(relationship)]), "p"),
      ).toThrow();
    }
    for (const relationship of ["observation.session", "observation.visitor"]) {
      const event = eventBase();
      expect(() =>
        event.storage.lowerSource(
          withBindings(event.node, [rel(relationship)]),
          "p",
        ),
      ).toThrow();
    }
  });

  it("rejects relationships with no D1 mapping", () => {
    const { node, storage } = obsBase();
    expect(() =>
      storage.lowerSource(
        withBindings(node, [rel("observation.nothing")]),
        "p",
      ),
    ).toThrow();
  });

  it("rejects unsupported binding kinds", () => {
    const { node, storage } = pageBase();
    expect(() =>
      storage.lowerSource(
        withBindings(node, [{ kind: "mystery", slot: 95 }]),
        "p",
        new Set([...node.output, 95 as never]),
      ),
    ).toThrow("p.values: Unsupported source binding.");
  });

  it("rejects mixed or cross-entity native field bindings", () => {
    const page = pageBase();
    const mixedPage = withBindings(page.node, [attr("page.path")]);
    expect(() => page.storage.lowerSource(mixedPage, "p")).toThrow(
      "Internal Page report attributes cannot be mixed with native primitive fields.",
    );
    const barePage = {
      ...page.node,
      values: page.node.values.slice(0, 1),
    } as SourceNode;
    expect(() =>
      page.storage.lowerSource(
        withBindings(barePage, [attr("event.name")]),
        "p",
      ),
    ).toThrow("A Page source cannot bind Event fields.");

    const event = eventBase();
    const bareEvent = {
      ...event.node,
      values: event.node.values.slice(0, 1),
    } as SourceNode;
    expect(() =>
      event.storage.lowerSource(
        withBindings(bareEvent, [attr("page.path")]),
        "p",
      ),
    ).toThrow("An Event source cannot bind Page fields.");
    expect(() =>
      event.storage.lowerSource(
        withBindings(event.node, [attr("event.name")]),
        "p",
      ),
    ).toThrow(
      "Internal Event report attributes cannot be mixed with native primitive fields.",
    );

    const obs = obsBase();
    const bareObs = {
      ...obs.node,
      values: obs.node.values.slice(0, 1),
    } as SourceNode;
    expect(() =>
      obs.storage.lowerSource(
        withBindings(bareObs, [attr("page.path", 90), attr("event.name", 91)]),
        "p",
      ),
    ).toThrow(
      "Mixed Page/Event bindings do not define one native Observation carrier.",
    );
    expect(() =>
      obs.storage.lowerSource(withBindings(obs.node, [attr("page.path")]), "p"),
    ).toThrow(
      "Report Observation attributes cannot be mixed with native primitive fields.",
    );
  });

  it("rejects Observation-only and scope-fact attributes on other entities", () => {
    const page = pageBase();
    expect(() =>
      page.storage.lowerSource(
        withBindings(page.node, [attr("observation.kind")]),
        "p",
      ),
    ).toThrow("Report attributes are available only on Observation.");
    expect(() =>
      page.storage.lowerSource(
        withBindings(page.node, [attr("session.views")]),
        "p",
      ),
    ).toThrow(
      "session.views is available only on its native Session or Visitor entity.",
    );
    expect(() =>
      page.storage.lowerSource(
        withBindings(page.node, [attr("observation.sessionId", 90)]),
        "p",
        new Set([...page.node.output, 90 as never]),
      ),
    ).toThrow("Report attributes are available only on Observation.");
  });

  it("rejects Event payload key requests that do not match the canonical Source", () => {
    const page = pageBase();
    expect(() =>
      page.storage.lowerSource(page.node, "p", new Set(page.node.output), [
        {
          kind: "event-payload-key",
          id: "k",
          sourceId: page.node.id,
          eventKeySlot: page.node.output[0],
        } as never,
      ]),
    ).toThrow(
      "p: Provider Event payload key request does not match the canonical Source.",
    );
  });
});
