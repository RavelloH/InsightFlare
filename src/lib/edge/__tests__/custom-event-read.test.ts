import { describe, expect, it, vi } from "vitest";

import { CUSTOM_EVENT_JSON_TYPE } from "@/lib/edge/custom-event-json";
import {
  readCustomEventDetail,
  readCustomEventsForVisit,
  readCustomEventVisitId,
} from "@/lib/edge/custom-event-read";
import type { Env } from "@/lib/edge/types";

interface MockStatement {
  bind: ReturnType<typeof vi.fn>;
  all?: ReturnType<typeof vi.fn>;
  first?: ReturnType<typeof vi.fn>;
}

function statement(input: { all?: unknown[]; first?: unknown }): MockStatement {
  const stmt: MockStatement = {
    bind: vi.fn(function (this: MockStatement) {
      return this;
    }),
  };
  if ("all" in input) {
    stmt.all = vi.fn().mockResolvedValue({ results: input.all });
  }
  if ("first" in input) {
    stmt.first = vi.fn().mockResolvedValue(input.first);
  }
  return stmt;
}

function envWithStatements(statements: MockStatement[]): {
  env: Env;
  prepare: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const prepare = vi.fn(() => statements[index++]);
  return {
    env: {
      DB: { prepare } as unknown as D1Database,
    } as Env,
    prepare,
  };
}

describe("custom event read helpers", () => {
  it("reads custom event list items and clamps limits", async () => {
    const listStatement = statement({
      all: [
        {
          eventId: "event-1",
          visitId: "visit-1",
          eventName: "signup",
          occurredAt: "100",
          receivedAt: 110,
          sequence: "2",
          nodeCount: "5",
          valueCount: null,
        },
      ],
    });
    const { env } = envWithStatements([listStatement]);

    await expect(
      readCustomEventsForVisit(env, "site-1", "visit-1", 999),
    ).resolves.toEqual([
      {
        eventId: "event-1",
        visitId: "visit-1",
        eventName: "signup",
        occurredAt: 100,
        receivedAt: 110,
        sequence: 2,
        nodeCount: 5,
        valueCount: 0,
      },
    ]);

    expect(listStatement.bind).toHaveBeenCalledWith("site-1", "visit-1", 500);
  });

  it("clamps fractional and non-positive list limits to one", async () => {
    const fractionalStatement = statement({ all: [] });
    const zeroStatement = statement({ all: [] });
    const { env } = envWithStatements([fractionalStatement, zeroStatement]);

    await readCustomEventsForVisit(env, "site-1", "visit-1", 1.9);
    await readCustomEventsForVisit(env, "site-1", "visit-1", 0);

    expect(fractionalStatement.bind).toHaveBeenCalledWith(
      "site-1",
      "visit-1",
      1,
    );
    expect(zeroStatement.bind).toHaveBeenCalledWith("site-1", "visit-1", 1);
  });

  it("uses empty and zero fallbacks for missing custom event list columns", async () => {
    const listStatement = statement({
      all: [
        {
          eventId: null,
          visitId: undefined,
          eventName: null,
          occurredAt: null,
          receivedAt: undefined,
          sequence: null,
          nodeCount: undefined,
          valueCount: null,
        },
      ],
    });
    const { env } = envWithStatements([listStatement]);

    await expect(
      readCustomEventsForVisit(env, "site-1", "visit-1"),
    ).resolves.toEqual([
      {
        eventId: "",
        visitId: "",
        eventName: "",
        occurredAt: 0,
        receivedAt: 0,
        sequence: 0,
        nodeCount: 0,
        valueCount: 0,
      },
    ]);
    expect(listStatement.bind).toHaveBeenCalledWith("site-1", "visit-1", 100);
  });

  it("reads the visit id for a custom event", async () => {
    const hit = statement({ first: { visitId: "visit-1" } });
    const miss = statement({ first: null });
    const { env } = envWithStatements([hit, miss]);

    await expect(
      readCustomEventVisitId(env, "site-1", "event-1"),
    ).resolves.toBe("visit-1");
    await expect(
      readCustomEventVisitId(env, "site-1", "missing"),
    ).resolves.toBe(null);
    expect(hit.bind).toHaveBeenCalledWith("site-1", "event-1");
    expect(miss.bind).toHaveBeenCalledWith("site-1", "missing");
  });

  it("returns null when a custom event detail row is absent", async () => {
    const detailStatement = statement({ first: null });
    const { env, prepare } = envWithStatements([detailStatement]);

    await expect(readCustomEventDetail(env, "site-1", "missing")).resolves.toBe(
      null,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(detailStatement.bind).toHaveBeenCalledWith("site-1", "missing");
  });

  it("rebuilds custom event detail JSON from node rows", async () => {
    const eventStatement = statement({
      first: {
        eventPk: 42,
        eventId: "event-1",
        siteId: "site-1",
        visitId: "visit-1",
        eventName: "checkout",
        occurredAt: 100,
        receivedAt: 120,
        sequence: 3,
        nodeCount: 9,
        valueCount: 6,
      },
    });
    const nodesStatement = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.object,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 3,
          parentNodeId: 1,
          key: "total",
          valueType: CUSTOM_EVENT_JSON_TYPE.number,
          memberOrder: 2,
          arrayIndex: null,
          stringValue: null,
          numberValue: 42.5,
          booleanValue: null,
        },
        {
          nodeId: 2,
          parentNodeId: 1,
          key: "items",
          valueType: CUSTOM_EVENT_JSON_TYPE.array,
          memberOrder: 1,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 4,
          parentNodeId: 1,
          key: "paid",
          valueType: CUSTOM_EVENT_JSON_TYPE.boolean,
          memberOrder: 3,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: 1,
        },
        {
          nodeId: 5,
          parentNodeId: 1,
          key: "coupon",
          valueType: CUSTOM_EVENT_JSON_TYPE.null,
          memberOrder: 4,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 7,
          parentNodeId: 2,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: 1,
          stringValue: "second",
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 6,
          parentNodeId: 2,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: 0,
          stringValue: "first",
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 8,
          parentNodeId: 1,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: 5,
          arrayIndex: null,
          stringValue: "ignored missing key",
          numberValue: null,
          booleanValue: null,
        },
      ],
    });
    const { env } = envWithStatements([eventStatement, nodesStatement]);

    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toEqual({
      eventId: "event-1",
      siteId: "site-1",
      visitId: "visit-1",
      eventName: "checkout",
      occurredAt: 100,
      receivedAt: 120,
      sequence: 3,
      nodeCount: 9,
      valueCount: 6,
      eventData: {
        items: ["first", "second"],
        total: 42.5,
        paid: true,
        coupon: null,
      },
    });
    expect(nodesStatement.bind).toHaveBeenCalledWith(42);
  });

  it("uses an empty object when detail nodes do not contain a root", async () => {
    const eventStatement = statement({
      first: {
        eventPk: 42,
        eventId: "event-1",
        siteId: "site-1",
        visitId: "visit-1",
        eventName: "checkout",
        occurredAt: 100,
        receivedAt: 120,
        sequence: 3,
        nodeCount: 0,
        valueCount: 0,
      },
    });
    const nodesStatement = statement({ all: [] });
    const { env } = envWithStatements([eventStatement, nodesStatement]);

    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({
      eventData: {},
    });
  });

  it("materializes primitive root values with null storage fallbacks", async () => {
    const baseEvent = {
      eventPk: 42,
      eventId: "event-1",
      siteId: "site-1",
      visitId: "visit-1",
      eventName: "checkout",
      occurredAt: 100,
      receivedAt: 120,
      sequence: 3,
      nodeCount: 1,
      valueCount: 1,
    };
    const stringEvent = statement({ first: baseEvent });
    const stringNodes = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
      ],
    });
    const numberEvent = statement({ first: baseEvent });
    const numberNodes = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.number,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
      ],
    });
    const booleanEvent = statement({ first: baseEvent });
    const booleanNodes = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.boolean,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: 0,
        },
      ],
    });
    const { env } = envWithStatements([
      stringEvent,
      stringNodes,
      numberEvent,
      numberNodes,
      booleanEvent,
      booleanNodes,
    ]);

    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({ eventData: "" });
    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({ eventData: 0 });
    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({ eventData: false });
  });

  it("uses zero ordering fallbacks when rebuilding object and array children", async () => {
    const eventStatement = statement({
      first: {
        eventPk: 42,
        eventId: "event-1",
        siteId: "site-1",
        visitId: "visit-1",
        eventName: "checkout",
        occurredAt: 100,
        receivedAt: 120,
        sequence: 3,
        nodeCount: 8,
        valueCount: 4,
      },
    });
    const nodesStatement = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.object,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 2,
          parentNodeId: 1,
          key: "fallback",
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: null,
          stringValue: "first",
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 3,
          parentNodeId: 1,
          key: "later",
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: 2,
          arrayIndex: null,
          stringValue: "second",
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 4,
          parentNodeId: 1,
          key: "items",
          valueType: CUSTOM_EVENT_JSON_TYPE.array,
          memberOrder: 3,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 6,
          parentNodeId: 4,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: 2,
          stringValue: "last",
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 5,
          parentNodeId: 4,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: null,
          stringValue: "fallback",
          numberValue: null,
          booleanValue: null,
        },
      ],
    });
    const { env } = envWithStatements([eventStatement, nodesStatement]);

    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({
      eventData: {
        fallback: "first",
        later: "second",
        items: ["fallback", "last"],
      },
    });
  });

  it("applies zero ordering when all object and array children lack ordering", async () => {
    const objectEvent = statement({
      first: {
        eventPk: 42,
        eventId: "event-1",
        siteId: "site-1",
        visitId: "visit-1",
        eventName: "checkout",
        occurredAt: 100,
        receivedAt: 120,
        sequence: 3,
        nodeCount: 3,
        valueCount: 2,
      },
    });
    const objectNodes = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.object,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 2,
          parentNodeId: 1,
          key: "a",
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: null,
          stringValue: "first",
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 3,
          parentNodeId: 1,
          key: "b",
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: null,
          stringValue: "second",
          numberValue: null,
          booleanValue: null,
        },
      ],
    });
    const arrayEvent = statement({
      first: {
        eventPk: 42,
        eventId: "event-1",
        siteId: "site-1",
        visitId: "visit-1",
        eventName: "checkout",
        occurredAt: 100,
        receivedAt: 120,
        sequence: 3,
        nodeCount: 3,
        valueCount: 2,
      },
    });
    const arrayNodes = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.array,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 2,
          parentNodeId: 1,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: null,
          stringValue: "first",
          numberValue: null,
          booleanValue: null,
        },
        {
          nodeId: 3,
          parentNodeId: 1,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.string,
          memberOrder: null,
          arrayIndex: null,
          stringValue: "second",
          numberValue: null,
          booleanValue: null,
        },
      ],
    });
    const { env } = envWithStatements([
      objectEvent,
      objectNodes,
      arrayEvent,
      arrayNodes,
    ]);

    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({
      eventData: { a: "first", b: "second" },
    });
    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({
      eventData: ["first", "second"],
    });
  });

  it("materializes object and array roots without children", async () => {
    const baseEvent = {
      eventPk: 42,
      eventId: "event-1",
      siteId: "site-1",
      visitId: "visit-1",
      eventName: "checkout",
      occurredAt: 100,
      receivedAt: 120,
      sequence: 3,
      nodeCount: 1,
      valueCount: 0,
    };
    const objectEvent = statement({ first: baseEvent });
    const objectNodes = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.object,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
      ],
    });
    const arrayEvent = statement({ first: baseEvent });
    const arrayNodes = statement({
      all: [
        {
          nodeId: 1,
          parentNodeId: null,
          key: null,
          valueType: CUSTOM_EVENT_JSON_TYPE.array,
          memberOrder: null,
          arrayIndex: null,
          stringValue: null,
          numberValue: null,
          booleanValue: null,
        },
      ],
    });
    const { env } = envWithStatements([
      objectEvent,
      objectNodes,
      arrayEvent,
      arrayNodes,
    ]);

    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({ eventData: {} });
    await expect(
      readCustomEventDetail(env, "site-1", "event-1"),
    ).resolves.toMatchObject({ eventData: [] });
  });
});
