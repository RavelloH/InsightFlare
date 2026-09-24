import {
  BLOCKING_FIELD_IDS,
  type BlockingFieldId,
  type BlockingRulesDocument,
  type BlockingRulesLayer,
  BlockingRulesValidationError,
  type BlockingRuleSyntaxError,
} from "./contract";
import {
  hasOwn,
  isRecord,
  layerData,
  MAX_RULE_LAYERS,
  parseV2Lines,
  syntaxError,
  V1_FIELD_KEYS,
  V2_FIELD_KEYS,
  V2_VERSION_PARSER,
  VERSION_PARSERS,
} from "./parser";
function canonicalV2Lines(
  field: BlockingFieldId,
  value: unknown,
): {
  readonly lines: readonly string[];
  readonly errors: readonly BlockingRuleSyntaxError[];
} {
  const parsed = parseV2Lines(field, value, 2);
  const rulesByLine = new Map(parsed.rules.map((rule) => [rule.line, rule]));
  const lines = parsed.lines.map((raw, index) => {
    const rule = rulesByLine.get(index + 1);
    if (!rule) return raw;
    return rule.action === "allow"
      ? "-" + rule.normalizedPattern
      : rule.normalizedPattern;
  });
  return { lines, errors: parsed.errors };
}
/**
 * Serializes sparse logical fields as one v2 layer. JSON field names are owned
 * by the v2 parser registry rather than by callers.
 */
export function serializeBlockingRulesV2(values: unknown): BlockingRulesLayer {
  const data: Record<string, unknown> = {};
  const errors: BlockingRuleSyntaxError[] = [];
  if (!isRecord(values)) {
    throw new BlockingRulesValidationError([
      syntaxError("invalid_data", "v2 blocking rule values must be an object", {
        version: 2,
      }),
    ]);
  }
  const source = values as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!hasOwn(V2_FIELD_KEYS, key)) {
      errors.push(
        syntaxError(
          "unknown_field",
          "v2 blocking rule values have unknown field " + key,
          {
            key,
            version: 2,
          },
        ),
      );
    }
  }
  for (const field of BLOCKING_FIELD_IDS) {
    if (!hasOwn(values, field)) continue;
    const serialized = canonicalV2Lines(field, source[field]);
    errors.push(...serialized.errors);
    const key = V2_VERSION_PARSER.canonicalKey(field);
    if (key) data[key] = [...serialized.lines];
  }
  if (errors.length > 0) throw new BlockingRulesValidationError(errors);
  return { version: 2, data };
}
type MutableLayer = {
  version: number;
  data: Record<string, unknown>;
};
function cloneLayerData(
  layer: Record<string, unknown>,
): Record<string, unknown> {
  const result = layerData(layer);
  if (!result.data) {
    throw new BlockingRulesValidationError([
      {
        ...(result.error as BlockingRuleSyntaxError),
        version: Number(layer.version),
      },
    ]);
  }
  return result.data ? { ...result.data } : {};
}
export function keysForField(
  version: number,
  field: BlockingFieldId,
): readonly string[] {
  return VERSION_PARSERS[version]?.keysForField(field) ?? [];
}
function removeFieldFromLayer(
  layer: MutableLayer,
  field: BlockingFieldId,
): void {
  const keys = new Set(keysForField(layer.version, field));
  layer.data = Object.fromEntries(
    Object.entries(layer.data).filter(([key]) => !keys.has(key)),
  );
}
function omitRecordKey(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const { [key]: _ignored, ...rest } = record;
  return rest;
}
/**
 * Applies a field-level v2 patch. Patched logical fields are removed from the
 * legacy fallback and from every known version before being written once into
 * the v2 layer.
 */
export function applyBlockingRulesPatch(
  input: unknown,
  patch: unknown,
): BlockingRulesDocument {
  let document = isRecord(input) ? { ...input } : {};
  const rawLayers = document.blockingRules;
  if (rawLayers !== undefined && !Array.isArray(rawLayers)) {
    throw new BlockingRulesValidationError([
      syntaxError("invalid_document", "blockingRules must be an array"),
    ]);
  }
  if (Array.isArray(rawLayers) && rawLayers.length > MAX_RULE_LAYERS) {
    throw new BlockingRulesValidationError([
      syntaxError(
        "invalid_document",
        "blockingRules has more than " + String(MAX_RULE_LAYERS) + " layers",
      ),
    ]);
  }

  const layers: MutableLayer[] = (
    Array.isArray(rawLayers) ? rawLayers : []
  ).map((layer) => {
    if (!isRecord(layer)) {
      throw new BlockingRulesValidationError([
        syntaxError("invalid_layer", "blockingRules contains an invalid layer"),
      ]);
    }
    const version = Number(layer.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new BlockingRulesValidationError([
        syntaxError(
          "invalid_layer",
          "blockingRules contains an invalid version",
        ),
      ]);
    }
    if (version !== 1 && version !== 2) {
      throw new BlockingRulesValidationError([
        syntaxError(
          "unsupported_version",
          "blockingRules version " + String(version) + " is not supported",
          { version },
        ),
      ]);
    }
    return { version, data: cloneLayerData(layer) };
  });

  const serialized = serializeBlockingRulesV2(patch);
  const patchRecord = patch as Record<string, unknown>;
  const fields = BLOCKING_FIELD_IDS.filter((field) =>
    hasOwn(patchRecord, field),
  );
  let target = layers.find((layer) => layer.version === 2);
  if (!target) {
    target = { version: 2, data: {} };
    layers.push(target);
  }

  for (const field of fields) {
    const legacyKey = V1_FIELD_KEYS[field]?.[0];
    if (legacyKey) document = omitRecordKey(document, legacyKey);
    for (const layer of layers) removeFieldFromLayer(layer, field);

    const key = V2_VERSION_PARSER.canonicalKey(field);
    if (key) {
      const value = serialized.data[key];
      if (value !== undefined) target.data[key] = value;
    }
  }

  const nextLayers = layers
    .filter((layer) => Object.keys(layer.data).length > 0)
    .sort((a, b) => b.version - a.version)
    .map((layer) => ({ version: layer.version, data: layer.data }));
  if (nextLayers.length > 0) document.blockingRules = nextLayers;
  else delete document.blockingRules;
  return document;
}
