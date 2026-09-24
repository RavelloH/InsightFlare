export const CUSTOM_EVENT_DATA_MAX_JSON_LENGTH = 8 * 1024;
export const CUSTOM_EVENT_DATA_MAX_NODES = 200;
export const CUSTOM_EVENT_DATA_MAX_VALUES = 100;
export const CUSTOM_EVENT_DATA_MAX_DEPTH = 6;
export const CUSTOM_EVENT_DATA_MAX_ARRAY_LENGTH = 50;
export const CUSTOM_EVENT_DATA_MAX_KEY_LENGTH = 120;
export const CUSTOM_EVENT_DATA_MAX_STRING_LENGTH = 500;

export const CUSTOM_EVENT_JSON_TYPE = {
  null: 0,
  string: 1,
  number: 2,
  boolean: 3,
  object: 4,
  array: 5,
} as const;

export type CustomEventJsonType =
  (typeof CUSTOM_EVENT_JSON_TYPE)[keyof typeof CUSTOM_EVENT_JSON_TYPE];

export interface CustomEventJsonNode {
  nodeId: number;
  parentNodeId: number | null;
  key: string | null;
  path: string;
  valueType: CustomEventJsonType;
  memberOrder: number | null;
  arrayIndex: number | null;
  depth: number;
}

export interface CustomEventJsonValue {
  nodeId: number;
  path: string;
  scopeNodeId: number | null;
  valueType: CustomEventJsonType;
  stringValue: string | null;
  stringHash: string | null;
  numberValue: number | null;
  booleanValue: number | null;
}

export interface ExpandedCustomEventData {
  json: string;
  nodes: CustomEventJsonNode[];
  values: CustomEventJsonValue[];
  keys: string[];
  paths: string[];
}

export type CustomEventDataValidation =
  | { ok: true; data: ExpandedCustomEventData }
  | { ok: false; status: 413 | 422; error: string };

function isJsonObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function jsonPointerPath(segments: string[]): string {
  if (segments.length === 0) return "/";
  return `/${segments
    .map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
}

function valueTypeOf(input: unknown): CustomEventJsonType | null {
  if (input === null) return CUSTOM_EVENT_JSON_TYPE.null;
  if (Array.isArray(input)) return CUSTOM_EVENT_JSON_TYPE.array;
  switch (typeof input) {
    case "string":
      return CUSTOM_EVENT_JSON_TYPE.string;
    case "number":
      return CUSTOM_EVENT_JSON_TYPE.number;
    case "boolean":
      return CUSTOM_EVENT_JSON_TYPE.boolean;
    case "object":
      return CUSTOM_EVENT_JSON_TYPE.object;
    default:
      return null;
  }
}

function eventStringHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function hashCustomEventStringValue(input: string): string {
  return eventStringHash(input);
}

function collectUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function expandCustomEventData(
  input: unknown,
): CustomEventDataValidation {
  if (input === undefined) {
    return {
      ok: false,
      status: 422,
      error: "eventData is required",
    };
  }

  let json: string;
  try {
    const serialized = JSON.stringify(input);
    if (typeof serialized !== "string") {
      return {
        ok: false,
        status: 422,
        error: "eventData contains unsupported JSON value",
      };
    }
    json = serialized;
  } catch {
    return {
      ok: false,
      status: 422,
      error: "eventData must be JSON serializable",
    };
  }

  if (json.length > CUSTOM_EVENT_DATA_MAX_JSON_LENGTH) {
    return {
      ok: false,
      status: 413,
      error: "eventData is too large",
    };
  }

  if (!isJsonObject(input)) {
    return {
      ok: false,
      status: 422,
      error: "eventData must be a JSON object",
    };
  }

  const nodes: CustomEventJsonNode[] = [];
  const values: CustomEventJsonValue[] = [];
  let nextNodeId = 1;
  let error: string | null = null;

  function fail(message: string): false {
    error = message;
    return false;
  }

  function addValue(
    nodeId: number,
    path: string,
    scopeNodeId: number | null,
    valueType: CustomEventJsonType,
    value: unknown,
  ): boolean {
    if (values.length + 1 > CUSTOM_EVENT_DATA_MAX_VALUES) {
      return fail("eventData has too many scalar values");
    }

    if (valueType === CUSTOM_EVENT_JSON_TYPE.string) {
      const stringValue = String(value);
      if (stringValue.length > CUSTOM_EVENT_DATA_MAX_STRING_LENGTH) {
        return fail("eventData string value is too long");
      }
      values.push({
        nodeId,
        path,
        scopeNodeId,
        valueType,
        stringValue,
        stringHash: eventStringHash(stringValue),
        numberValue: null,
        booleanValue: null,
      });
      return true;
    }

    if (valueType === CUSTOM_EVENT_JSON_TYPE.number) {
      const numberValue = Number(value);
      if (
        !Number.isFinite(numberValue) ||
        Math.abs(numberValue) > Number.MAX_SAFE_INTEGER
      ) {
        return fail("eventData number value is not supported");
      }
      values.push({
        nodeId,
        path,
        scopeNodeId,
        valueType,
        stringValue: null,
        stringHash: null,
        numberValue,
        booleanValue: null,
      });
      return true;
    }

    if (valueType === CUSTOM_EVENT_JSON_TYPE.boolean) {
      values.push({
        nodeId,
        path,
        scopeNodeId,
        valueType,
        stringValue: null,
        stringHash: null,
        numberValue: null,
        booleanValue: value === true ? 1 : 0,
      });
      return true;
    }

    values.push({
      nodeId,
      path,
      scopeNodeId,
      valueType,
      stringValue: null,
      stringHash: null,
      numberValue: null,
      booleanValue: null,
    });
    return true;
  }

  function walk(
    value: unknown,
    parentNodeId: number | null,
    key: string | null,
    memberOrder: number | null,
    arrayIndex: number | null,
    depth: number,
    pathSegments: string[],
    scopeNodeId: number | null,
  ): boolean {
    if (depth > CUSTOM_EVENT_DATA_MAX_DEPTH) {
      return fail("eventData is too deeply nested");
    }

    const valueType = valueTypeOf(value);
    if (valueType === null) {
      return fail("eventData contains unsupported JSON value");
    }

    if (nodes.length + 1 > CUSTOM_EVENT_DATA_MAX_NODES) {
      return fail("eventData has too many nodes");
    }

    const nodeId = nextNodeId;
    nextNodeId += 1;
    const path = jsonPointerPath(pathSegments);
    nodes.push({
      nodeId,
      parentNodeId,
      key,
      path,
      valueType,
      memberOrder,
      arrayIndex,
      depth,
    });

    const nextScopeNodeId = arrayIndex === null ? scopeNodeId : nodeId;

    if (
      valueType === CUSTOM_EVENT_JSON_TYPE.null ||
      valueType === CUSTOM_EVENT_JSON_TYPE.string ||
      valueType === CUSTOM_EVENT_JSON_TYPE.number ||
      valueType === CUSTOM_EVENT_JSON_TYPE.boolean
    ) {
      return addValue(nodeId, path, nextScopeNodeId, valueType, value);
    }

    if (Array.isArray(value)) {
      if (value.length > CUSTOM_EVENT_DATA_MAX_ARRAY_LENGTH) {
        return fail("eventData array is too long");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (
          !walk(
            value[index],
            nodeId,
            null,
            null,
            index,
            depth + 1,
            [...pathSegments, "*"],
            nextScopeNodeId,
          )
        ) {
          return false;
        }
      }
      return true;
    }

    if (!isJsonObject(value)) {
      return fail("eventData contains unsupported JSON value");
    }

    const entries = Object.entries(value);
    for (let index = 0; index < entries.length; index += 1) {
      const [childKey, childValue] = entries[index]!;
      if (childKey.length > CUSTOM_EVENT_DATA_MAX_KEY_LENGTH) {
        return fail("eventData key is too long");
      }
      if (
        !walk(
          childValue,
          nodeId,
          childKey,
          index,
          null,
          depth + 1,
          [...pathSegments, childKey],
          nextScopeNodeId,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  if (!walk(input, null, null, null, null, 0, [], null)) {
    return {
      ok: false,
      status: 422,
      error: error ?? "eventData is invalid",
    };
  }

  return {
    ok: true,
    data: {
      json,
      nodes,
      values,
      keys: collectUnique(
        nodes.flatMap((node) => (node.key === null ? [] : [node.key])),
      ),
      paths: collectUnique(nodes.map((node) => node.path)),
    },
  };
}

export function expandCustomEventDataJson(
  json: string,
): CustomEventDataValidation {
  try {
    return expandCustomEventData(JSON.parse(json));
  } catch {
    return {
      ok: false,
      status: 422,
      error: "eventData must be valid JSON",
    };
  }
}
