import { describe, expect, it } from "vitest";

import {
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { LegacyScalarFilterLoweringError } from "@/lib/edge/analytics/providers/d1/internal/analytics-legacy-scalar-filter-lowering";
import {
  observationEventMatches,
  scalarContext,
  selectedEventRelation,
} from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/membership";

import { preparedMembershipFromIds } from "./prepared-membership-fixture";

// Qualification evidence is validated before any dataset relation is touched,
// so the dataset can be an inert placeholder.
const dataset = {} as never;
const baseSelection = { mode: "observation", filter: { root: null } };

function observationMatches(
  extra: Record<string, unknown>,
  relations?: ReadonlyMap<string, unknown>,
) {
  return () =>
    observationEventMatches(
      dataset,
      { ...baseSelection, ...extra } as never,
      relations as never,
    );
}

describe("observation event qualification evidence guards", () => {
  it("rejects a prepared membership handle that was never registered", () => {
    expect(observationMatches({ preparedMembership: {} })).toThrow(
      "prepared_membership_unregistered",
    );
  });

  it("rejects a registered membership that carries no Event identities", () => {
    const handle = preparedMembershipFromIds({
      entityIds: [{ siteId: "site-1", id: "entity-1" }],
    });
    expect(observationMatches({ preparedMembership: handle })).toThrow(
      "prepared_membership_role_missing",
    );
  });

  it("requires exactly one qualification dependency reference", () => {
    expect(
      observationMatches({
        qualificationDependencyRefs: [
          EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
          EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
        ],
      }),
    ).toThrow("qualification_execution_dependency_cardinality_mismatch");
    expect(observationMatches({ qualificationDependencyRefs: [] })).toThrow(
      "qualification_execution_dependency_cardinality_mismatch",
    );
  });

  it("rejects a dependency reference for another role", () => {
    expect(
      observationMatches({
        qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
      }),
    ).toThrow("qualification_execution_dependency_unexpected");
  });

  it("rejects a dependency reference with no bound relation", () => {
    const refs = [EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY];
    expect(observationMatches({ qualificationDependencyRefs: refs })).toThrow(
      "qualification_execution_dependency_unbound",
    );
    expect(
      observationMatches({ qualificationDependencyRefs: refs }, new Map()),
    ).toThrow("qualification_execution_dependency_unbound");
  });

  it("rejects a bound relation without the (site_id, event_id) schema", () => {
    const refs = [EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY];
    for (const columns of [{}, { site_id: {} }, { event_id: {} }]) {
      expect(
        observationMatches(
          { qualificationDependencyRefs: refs },
          new Map([[refs[0]!, { columns }]]),
        ),
      ).toThrow("qualification_execution_relation_schema_mismatch");
    }
  });
});

describe("scalarContext forged row guards", () => {
  const pageRow = {
    relation: {},
    visitColumns: { pathname: undefined },
  } as never;
  const eventRow = {
    relation: {},
    eventPk: {},
    eventName: "event-name-expression",
    ownerVisitColumns: { pathname: undefined },
  } as never;
  const selection = { mode: "observation", filter: { root: null } } as never;

  it("skips visit columns that the row did not project", () => {
    expect(scalarContext(selection, pageRow, {} as never).visitColumns).toEqual(
      {},
    );
    const event = scalarContext(selection, eventRow, {} as never);
    expect(event.visitColumns).toEqual({});
    expect(event.eventName).toBe("event-name-expression");
  });

  it("rejects Event payload predicates on Page rows", () => {
    const context = scalarContext(selection, pageRow, {} as never);
    expect(() =>
      context.resolveTypedCondition!(
        {
          kind: "condition",
          target: { kind: "event-payload", path: "/plan" },
          operator: "eq",
          value: "pro",
        } as never,
        "root",
      ),
    ).toThrow(
      new TypeError("Event-payload predicates require an Event source."),
    );
  });

  it("rejects unknown legacy fields and non-field targets", () => {
    const context = scalarContext(selection, pageRow, {} as never);
    expect(() =>
      context.resolveTypedCondition!(
        {
          kind: "condition",
          target: { kind: "field", field: "no.such.field" },
          operator: "eq",
          value: "x",
        } as never,
        "root",
      ),
    ).toThrow(new TypeError("Unknown legacy Filter field no.such.field."));
    expect(() =>
      context.resolveTypedCondition!(
        {
          kind: "condition",
          target: { kind: "entity-root", entity: "event" },
          operator: "exists",
        } as never,
        "root",
      ),
    ).toThrow(
      new TypeError("The Filter condition requires prepared Advanced matches."),
    );
  });

  it("reports session-boundary fields as missing on direct Event record sources", () => {
    const direct = {
      mode: "observation",
      profile: "direct-event-records-v1",
      filter: { root: null },
    } as never;
    const context = scalarContext(direct, eventRow, {} as never);
    let failure: unknown;
    try {
      context.resolveTypedCondition!(
        {
          kind: "condition",
          target: { kind: "field", field: "session.entryPath" },
          operator: "eq",
          value: "/",
        } as never,
        "root",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LegacyScalarFilterLoweringError);
    expect((failure as LegacyScalarFilterLoweringError).code).toBe(
      "missing_dependency",
    );
    expect((failure as LegacyScalarFilterLoweringError).message).toContain(
      "did not project session.entryPath",
    );
  });
});

describe("selectedEventRelation", () => {
  it("requires the report to expose the legacy owner column", () => {
    expect(() =>
      selectedEventRelation({ columns: {} } as never, {} as never),
    ).toThrow("legacy_scoped_event_owner_presence_missing");
  });
});
