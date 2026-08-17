import { describe, expect, it } from "vitest";

import {
  FilterAdapterError,
  parseApiV1FilterDocument,
  parseApiV1FilterUrl,
  parsePrivateFilterUrl,
  parsePublicFilterUrl,
} from "@/lib/edge/query-contract";

describe("filter protocol adapters", () => {
  it("gives private and API v1 the same typed URL document", () => {
    const query = "filter[page.path]=sw:/docs&filter[geo.country]=in:US,JP";
    expect(parsePrivateFilterUrl(query)).toEqual(parseApiV1FilterUrl(query));
  });

  it("fails public-sensitive fields before a reader can run", () => {
    expect(() =>
      parsePublicFilterUrl("filter[page.query]=campaign=spring"),
    ).toThrow(FilterAdapterError);
    expect(() =>
      parsePublicFilterUrl("filter[event.payload][/plan]=pro"),
    ).toThrow(FilterAdapterError);
    expect(() => parsePublicFilterUrl("filter[geo.region]=Ontario")).toThrow(
      FilterAdapterError,
    );
  });

  it("accepts API v1 structured AST documents and applies the same policy", () => {
    expect(
      parseApiV1FilterDocument({
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "event-payload", path: "/paid" },
          operator: "eq",
          value: false,
        },
      }),
    ).toMatchObject({ version: 1 });
    expect(() =>
      parseApiV1FilterDocument({
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "unknown.field" },
          operator: "eq",
          value: "x",
        },
      }),
    ).toThrow(FilterAdapterError);
  });
});
