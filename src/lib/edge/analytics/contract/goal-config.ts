import { sha256Hex } from "@/lib/edge/utils";
import {
  FILTER_DSL_MAX_LENGTH,
  type FilterDocument,
  parseFilterDsl,
} from "@/lib/filter-contract";

import { analyticsFilterRegistry } from "./filter-registry";
import { assertFilterAudience, filterFingerprint } from "./filters";
import { assertObservationFilterCompatible } from "./observation-planner";

export const GOAL_CONFIG_VERSION = 1 as const;
export const GOAL_FILTER_DSL_VERSION = 1 as const;

export interface GoalConfigV1 {
  readonly filterDslVersion: typeof GOAL_FILTER_DSL_VERSION;
  /** Exact user-authored DSL. Validation must never rewrite this value. */
  readonly filterDsl: string;
}

export interface EncodedGoalConfig {
  readonly configVersion: typeof GOAL_CONFIG_VERSION;
  readonly configJson: string;
}

export class GoalConfigDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalConfigDecodeError";
  }
}

export class GoalConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalConfigValidationError";
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
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key))
  );
}

function configFields(value: unknown): GoalConfigV1 {
  const root = record(value);
  return {
    filterDslVersion:
      root?.filterDslVersion as GoalConfigV1["filterDslVersion"],
    filterDsl: root?.filterDsl as string,
  };
}

function parseAndAssertGoalFilter(filterDsl: string): FilterDocument {
  const document = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  assertFilterAudience(document, analyticsFilterRegistry, "private-dashboard");
  assertObservationFilterCompatible(document);
  return document;
}

function decodeV1(value: unknown): GoalConfigV1 {
  const root = record(value);
  if (
    !root ||
    !exactKeys(root, ["filterDslVersion", "filterDsl"]) ||
    root.filterDslVersion !== GOAL_FILTER_DSL_VERSION ||
    typeof root.filterDsl !== "string"
  ) {
    throw new GoalConfigDecodeError("goal_v1_config_invalid");
  }

  const config: GoalConfigV1 = {
    filterDslVersion: GOAL_FILTER_DSL_VERSION,
    filterDsl: root.filterDsl,
  };
  try {
    return validateGoalConfigForWrite(config);
  } catch (error) {
    throw new GoalConfigDecodeError(
      error instanceof GoalConfigValidationError
        ? error.message
        : "goal_v1_config_invalid",
    );
  }
}

/** Decode a stored Goal config using its storage config version. */
export function decodeGoalConfig(version: number, json: string): GoalConfigV1 {
  if (!Number.isSafeInteger(version)) {
    throw new GoalConfigDecodeError("goal_config_version_invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GoalConfigDecodeError("goal_config_json_invalid");
  }

  if (version === GOAL_CONFIG_VERSION) return decodeV1(parsed);
  throw new GoalConfigDecodeError(`goal_config_version_unknown:${version}`);
}

/** Validate a Goal config for a new or updated definition write. */
export function validateGoalConfigForWrite(config: GoalConfigV1): GoalConfigV1 {
  const root = record(config);
  if (!root || !exactKeys(root, ["filterDslVersion", "filterDsl"])) {
    throw new GoalConfigValidationError("goal_config_invalid");
  }
  if (root.filterDslVersion !== GOAL_FILTER_DSL_VERSION) {
    throw new GoalConfigValidationError("goal_filter_dsl_version_invalid");
  }
  if (
    typeof root.filterDsl !== "string" ||
    !root.filterDsl.trim() ||
    root.filterDsl.length > FILTER_DSL_MAX_LENGTH
  ) {
    throw new GoalConfigValidationError("goal_filter_dsl_invalid");
  }

  try {
    parseAndAssertGoalFilter(root.filterDsl);
  } catch {
    throw new GoalConfigValidationError("goal_filter_dsl_invalid");
  }

  return {
    filterDslVersion: GOAL_FILTER_DSL_VERSION,
    filterDsl: root.filterDsl,
  };
}

export function encodeGoalConfig(config: GoalConfigV1): EncodedGoalConfig {
  const validated = validateGoalConfigForWrite(config);
  return {
    configVersion: GOAL_CONFIG_VERSION,
    configJson: JSON.stringify(validated),
  };
}

export function parseGoalFilter(config: GoalConfigV1): FilterDocument {
  const validated = validateGoalConfigForWrite(configFields(config));
  return parseAndAssertGoalFilter(validated.filterDsl);
}

function semanticPayload(config: GoalConfigV1): string {
  return JSON.stringify({
    configVersion: GOAL_CONFIG_VERSION,
    filterDslVersion: config.filterDslVersion,
    filter: filterFingerprint(parseGoalFilter(config), analyticsFilterRegistry),
  });
}

/** Backend-computed Goal semantics; definition display metadata is absent. */
export async function goalSemanticFingerprint(
  config: GoalConfigV1,
): Promise<string> {
  const validated = validateGoalConfigForWrite(configFields(config));
  return `goal-v${GOAL_CONFIG_VERSION}:${await sha256Hex(semanticPayload(validated))}`;
}
