import { describe, expect, it } from "vitest";

import {
  classifyAdvancedCountFilter,
  classifyAdvancedEventCandidateCountFilter,
} from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";

const MISMATCH = "count_sql_selector_field_mismatch";
const SCALAR_REDUCER = "count_sql_event_candidate_scalar_reducer_unsupported";

function dsl(source: string): FilterDocument {
  return parseFilterDsl(source, analyticsFilterRegistry);
}

function session(source: string) {
  return classifyAdvancedCountFilter(dsl(source), "session");
}

function eventCandidate(source: string) {
  return classifyAdvancedEventCandidateCountFilter(dsl(source));
}

const root = (entity: string) => ({ kind: "entity-root", entity });
const count = (input: unknown) => ({
  kind: "reducer",
  reducer: "count",
  input,
});
const reduce = (reducer: string, input: unknown) => ({
  kind: "reducer",
  reducer,
  input,
});
const duration = { kind: "member", object: root("page"), member: "durationMs" };
const arithmetic = (operator: string, left: unknown, right: unknown) => ({
  kind: "arithmetic",
  operator,
  left,
  right,
});

function document(target: unknown, operator = "gt", value: unknown = 1) {
  return {
    version: 1,
    root: { kind: "condition", target, operator, value },
  } as unknown as FilterDocument;
}

describe("advanced count filter classification: arithmetic envelopes", () => {
  const pages = count(root("page"));
  const events = count(root("event"));

  it("accepts bounded arithmetic over page and event counts in both scopes", () => {
    for (const operator of ["add", "sub", "mul", "div"]) {
      const doc = document(arithmetic(operator, pages, events));
      expect(classifyAdvancedCountFilter(doc, "session")).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });
      expect(classifyAdvancedEventCandidateCountFilter(doc)).toMatchObject({
        kind: "supported",
        code: "supported_event_candidate_count_sql",
      });
    }
  });

  it("rejects a fractional denominator whose range can approach zero", () => {
    const result = classifyAdvancedCountFilter(
      document(arithmetic("div", pages, reduce("avg", duration))),
      "session",
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      code: "count_sql_unbounded_division",
      path: "root.target.right",
    });
  });

  it("rejects a denominator that crosses zero when it is itself a quotient", () => {
    const quotient = arithmetic("div", pages, events);
    const doc = document(arithmetic("div", quotient, quotient));
    for (const result of [
      classifyAdvancedCountFilter(doc, "session"),
      classifyAdvancedEventCandidateCountFilter(doc),
    ])
      expect(result).toMatchObject({
        kind: "unsupported",
        code: "count_sql_unbounded_division",
        path: "root.target.right",
      });
  });

  it("falls back when repeated multiplication can approach binary64 overflow", () => {
    let product: unknown = reduce("sum", duration);
    for (let i = 0; i < 12; i += 1)
      product = arithmetic("mul", product, product);
    const result = classifyAdvancedCountFilter(document(product), "session");
    expect(result).toMatchObject({
      kind: "unsupported",
      code: "count_sql_numeric_range_exceeds_binary64_margin",
    });
  });

  it("reports the first scalar reducer inside Event-candidate arithmetic", () => {
    const result = classifyAdvancedEventCandidateCountFilter(
      document(arithmetic("add", pages, reduce("sum", duration))),
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      code: SCALAR_REDUCER,
      path: "root.target.right",
    });
  });
});

describe("advanced count filter classification: selector support", () => {
  const badPredicate = 'page.path eq "/" and count(event) gt 1';

  it("propagates selector rejections from sum reducers and presence tests", () => {
    for (const source of [
      `sum(page { ${badPredicate} }.durationMs) gt 1`,
      `page { ${badPredicate} } exists`,
      `count(page { ${badPredicate} }) gt 1`,
    ])
      expect(session(source)).toMatchObject({
        kind: "unsupported",
        code: MISMATCH,
      });
  });

  it("supports the same reducers with a plain selector predicate", () => {
    for (const source of [
      'sum(page { page.path eq "/" }.durationMs) gt 1',
      'page { page.path eq "/" } exists',
      "min(page.durationMs) isNull",
    ])
      expect(session(source)).toMatchObject({
        kind: "supported",
        code: "supported_count_sql",
      });
  });

  it("rejects Event-candidate Count selectors outside Page and Event", () => {
    expect(
      eventCandidate('session { session.entryPath eq "/" } exists'),
    ).toEqual({
      kind: "unsupported",
      path: "root.target",
      code: "count_sql_event_candidate_selector_scope_unsupported",
      reason:
        "Event-candidate Count selectors are limited to Page and Event collections.",
    });
    expect(eventCandidate("session exists")).toMatchObject({
      kind: "unsupported",
      code: "count_sql_event_candidate_selector_scope_unsupported",
      path: "root.target",
    });
  });

  it("requires a Count in Event-candidate scope even for supported presence tests", () => {
    expect(eventCandidate('event { event.name eq "a" } exists')).toMatchObject({
      kind: "unsupported",
      code: "count_sql_event_candidate_requires_count",
      path: "root",
    });
    expect(eventCandidate("count(session) gt 1")).toMatchObject({
      kind: "unsupported",
      code: "count_sql_event_candidate_count_collection_unsupported",
    });
  });
});

describe("advanced count filter classification: validation gates", () => {
  it("surfaces filter validation failures as unsupported with their own code", () => {
    const pages = count(root("page"));
    const cases: readonly [FilterDocument, string, string][] = [
      [document(pages, "in", []), "invalid_set", "root.value"],
      [document(pages, "between", [3, 1]), "reversed_range", "root.value"],
      [document(pages, "between", [1]), "invalid_range", "root.value"],
      [document(pages, "isNull", 1), "unexpected_value", "root.value"],
      [document(root("page"), "exists", 1), "unexpected_value", "root.value"],
      [document(pages, "gt", Number.NaN), "invalid_number", "root.value"],
    ];
    for (const [doc, code, path] of cases)
      for (const result of [
        classifyAdvancedCountFilter(doc, "session"),
        classifyAdvancedEventCandidateCountFilter(doc),
      ])
        expect(result).toMatchObject({ kind: "unsupported", code, path });
  });

  it("rejects non-session scopes and empty documents", () => {
    expect(
      classifyAdvancedCountFilter(dsl("count(page) gt 1"), "event"),
    ).toMatchObject({
      kind: "unsupported",
      code: "count_sql_requires_session_or_visitor_scope",
    });
    expect(
      classifyAdvancedCountFilter(
        { version: 1 } as unknown as FilterDocument,
        "session",
      ),
    ).toMatchObject({ kind: "unsupported" });
  });

  it("accepts an all-NULL set and negated count predicates", () => {
    expect(session("count(page) in [null, null]")).toMatchObject({
      kind: "supported",
    });
    expect(session("not count(page) gt 1")).toMatchObject({
      kind: "supported",
    });
  });
});
