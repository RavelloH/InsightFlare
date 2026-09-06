import { sha256Hex } from "@/lib/edge/utils";
import { FILTER_DSL_MAX_LENGTH, parseFilterDsl } from "@/lib/filter-contract";

import { analyticsFilterRegistry } from "./filter-registry";
import { assertFilterAudience, filterFingerprint } from "./filters";

export const FUNNEL_CONFIG_VERSION = 2 as const;
export const FUNNEL_FILTER_DSL_VERSION = 1 as const;
export const MIN_FUNNEL_STEPS = 2;
export const MAX_FUNNEL_STEPS = 10;
export const MAX_FUNNEL_STEP_ID_LENGTH = 128;
export const MAX_FUNNEL_STEP_NAME_LENGTH = 120;

export type FunnelProgressionScope = "session" | "visitor";

export interface FunnelStepV2 {
  readonly id: string;
  readonly name?: string;
  /** Exact user-authored DSL. Validation must never rewrite this value. */
  readonly filterDsl: string;
}

export interface FunnelConfigV2 {
  readonly filterDslVersion: typeof FUNNEL_FILTER_DSL_VERSION;
  readonly progressionScope: FunnelProgressionScope;
  readonly conversionWindowMs: number | null;
  readonly steps: readonly FunnelStepV2[];
}

export interface EncodedFunnelConfig {
  readonly configVersion: typeof FUNNEL_CONFIG_VERSION;
  readonly configJson: string;
}

export class FunnelConfigDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunnelConfigDecodeError";
  }
}

export class FunnelConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunnelConfigValidationError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function decodeV1Steps(value: unknown): FunnelStepV2[] {
  const root = Array.isArray(value) ? value : record(value)?.steps;
  if (!Array.isArray(root)) {
    throw new FunnelConfigDecodeError("funnel_v1_steps_required");
  }

  return root.map((item, index) => {
    const step = record(item);
    if (!step || !exactKeys(step, ["type", "value"])) {
      throw new FunnelConfigDecodeError(`funnel_v1_step_invalid:${index}`);
    }
    if (step.type !== "pageview" && step.type !== "event") {
      throw new FunnelConfigDecodeError(`funnel_v1_step_type_invalid:${index}`);
    }
    if (typeof step.value !== "string" || !step.value.trim()) {
      throw new FunnelConfigDecodeError(
        `funnel_v1_step_value_invalid:${index}`,
      );
    }
    const valueText = step.value.trim();
    const field = step.type === "pageview" ? "page.path" : "event.name";
    return {
      id: `v1:${index}`,
      filterDsl: `${field} eq ${JSON.stringify(valueText)}`,
    };
  });
}

function decodeV2(value: unknown): FunnelConfigV2 {
  const root = record(value);
  if (
    !root ||
    !exactKeys(root, [
      "filterDslVersion",
      "progressionScope",
      "conversionWindowMs",
      "steps",
    ])
  ) {
    throw new FunnelConfigDecodeError("funnel_v2_config_invalid");
  }
  if (root.filterDslVersion !== FUNNEL_FILTER_DSL_VERSION) {
    throw new FunnelConfigDecodeError("funnel_filter_dsl_version_invalid");
  }
  if (
    root.progressionScope !== "session" &&
    root.progressionScope !== "visitor"
  ) {
    throw new FunnelConfigDecodeError("funnel_progression_scope_invalid");
  }
  if (
    root.conversionWindowMs !== null &&
    (typeof root.conversionWindowMs !== "number" ||
      !Number.isFinite(root.conversionWindowMs))
  ) {
    throw new FunnelConfigDecodeError("funnel_conversion_window_invalid");
  }
  if (!Array.isArray(root.steps)) {
    throw new FunnelConfigDecodeError("funnel_steps_required");
  }

  const steps = root.steps.map((item, index) => {
    const step = record(item);
    if (!step || !exactKeys(step, ["id", "filterDsl"], ["name"])) {
      throw new FunnelConfigDecodeError(`funnel_v2_step_invalid:${index}`);
    }
    if (typeof step.id !== "string" || !step.id.trim()) {
      throw new FunnelConfigDecodeError(`funnel_step_id_invalid:${index}`);
    }
    if (
      step.id.length > MAX_FUNNEL_STEP_ID_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(step.id)
    ) {
      throw new FunnelConfigDecodeError(`funnel_step_id_invalid:${index}`);
    }
    if (step.name !== undefined && typeof step.name !== "string") {
      throw new FunnelConfigDecodeError(`funnel_step_name_invalid:${index}`);
    }
    if (typeof step.filterDsl !== "string" || !step.filterDsl.trim()) {
      throw new FunnelConfigDecodeError(`funnel_filter_dsl_invalid:${index}`);
    }
    return {
      id: step.id,
      ...(step.name !== undefined ? { name: step.name } : {}),
      filterDsl: step.filterDsl,
    };
  });

  const ids = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (ids.has(step.id)) {
      throw new FunnelConfigDecodeError(`funnel_step_id_duplicate:${index}`);
    }
    ids.add(step.id);
  }

  return {
    filterDslVersion: FUNNEL_FILTER_DSL_VERSION,
    progressionScope: root.progressionScope,
    conversionWindowMs: root.conversionWindowMs,
    steps,
  };
}

/** Decode a stored config without truncating historical over-limit funnels. */
export function decodeFunnelConfig(
  version: number,
  json: string,
): FunnelConfigV2 {
  if (!Number.isSafeInteger(version)) {
    throw new FunnelConfigDecodeError("funnel_config_version_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new FunnelConfigDecodeError("funnel_config_json_invalid");
  }
  if (version === 1) {
    return {
      filterDslVersion: FUNNEL_FILTER_DSL_VERSION,
      progressionScope: "session",
      conversionWindowMs: null,
      steps: decodeV1Steps(parsed),
    };
  }
  if (version === FUNNEL_CONFIG_VERSION) return decodeV2(parsed);
  throw new FunnelConfigDecodeError(`funnel_config_version_unknown:${version}`);
}

function assertFinitePositiveWindow(config: FunnelConfigV2): void {
  if (config.progressionScope === "session") {
    if (config.conversionWindowMs !== null) {
      throw new FunnelConfigValidationError(
        "session_funnel_conversion_window_must_be_null",
      );
    }
    return;
  }
  if (
    config.conversionWindowMs === null ||
    !Number.isFinite(config.conversionWindowMs) ||
    config.conversionWindowMs <= 0
  ) {
    throw new FunnelConfigValidationError(
      "visitor_funnel_conversion_window_must_be_positive",
    );
  }
}

/** Validate a decoded config for a new V2 write. */
export function validateFunnelConfigForWrite(
  config: FunnelConfigV2,
): FunnelConfigV2 {
  if (!config || typeof config !== "object") {
    throw new FunnelConfigValidationError("funnel_config_invalid");
  }
  if (!Array.isArray(config.steps)) {
    throw new FunnelConfigValidationError("funnel_steps_required");
  }
  if (config.steps.length < MIN_FUNNEL_STEPS) {
    throw new FunnelConfigValidationError("funnel_requires_two_steps");
  }
  if (config.steps.length > MAX_FUNNEL_STEPS) {
    throw new FunnelConfigValidationError("funnel_has_too_many_steps");
  }
  if (config.filterDslVersion !== FUNNEL_FILTER_DSL_VERSION) {
    throw new FunnelConfigValidationError("funnel_filter_dsl_version_invalid");
  }
  assertFinitePositiveWindow(config);

  const ids = new Set<string>();
  for (const [index, step] of config.steps.entries()) {
    if (!step || typeof step !== "object") {
      throw new FunnelConfigValidationError(`funnel_step_invalid:${index}`);
    }
    if (
      typeof step.id !== "string" ||
      !step.id ||
      step.id.length > MAX_FUNNEL_STEP_ID_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(step.id) ||
      ids.has(step.id)
    ) {
      throw new FunnelConfigValidationError(`funnel_step_id_invalid:${index}`);
    }
    ids.add(step.id);
    if (
      step.name !== undefined &&
      (typeof step.name !== "string" ||
        step.name.length > MAX_FUNNEL_STEP_NAME_LENGTH)
    ) {
      throw new FunnelConfigValidationError(
        `funnel_step_name_invalid:${index}`,
      );
    }
    if (
      typeof step.filterDsl !== "string" ||
      !step.filterDsl.trim() ||
      step.filterDsl.length > FILTER_DSL_MAX_LENGTH
    ) {
      throw new FunnelConfigValidationError(
        `funnel_filter_dsl_invalid:${index}`,
      );
    }
    try {
      const document = parseFilterDsl(step.filterDsl, analyticsFilterRegistry);
      assertFilterAudience(
        document,
        analyticsFilterRegistry,
        "private-dashboard",
      );
    } catch {
      throw new FunnelConfigValidationError(
        `funnel_filter_dsl_invalid:${index}`,
      );
    }
  }
  return config;
}

export function encodeFunnelConfig(
  config: FunnelConfigV2,
): EncodedFunnelConfig {
  const validated = validateFunnelConfigForWrite(config);
  return {
    configVersion: FUNNEL_CONFIG_VERSION,
    configJson: JSON.stringify(validated),
  };
}

export function parseFunnelStepFilter(step: FunnelStepV2) {
  const document = parseFilterDsl(step.filterDsl, analyticsFilterRegistry);
  assertFilterAudience(document, analyticsFilterRegistry, "private-dashboard");
  return document;
}

function semanticPayload(config: FunnelConfigV2): string {
  const steps = config.steps.map((step) => ({
    id: step.id,
    filter: filterFingerprint(
      parseFunnelStepFilter(step),
      analyticsFilterRegistry,
    ),
  }));
  return JSON.stringify({
    filterDslVersion: config.filterDslVersion,
    progressionScope: config.progressionScope,
    conversionWindowMs: config.conversionWindowMs,
    steps,
  });
}

/** Backend-computed analysis semantics; display metadata is intentionally absent. */
export async function funnelSemanticFingerprint(
  config: FunnelConfigV2,
): Promise<string> {
  return `funnel-v${FUNNEL_CONFIG_VERSION}:${await sha256Hex(semanticPayload(config))}`;
}
