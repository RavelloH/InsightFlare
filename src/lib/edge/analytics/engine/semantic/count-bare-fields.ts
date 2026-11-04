import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import {
  type AdvancedCountSelectorField,
  advancedCountSelectorField,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import type { TemporalDomainRef } from "@/lib/edge/analytics/engine/semantic/time";
import { canonicalizeFilterValue } from "@/lib/filter-contract/filter-value-semantics";
import type { FilterCondition } from "@/lib/filter-contract/filters";

export interface QualifiedGeoBareField {
  readonly fieldId: "geo.country" | "geo.region";
  readonly collection: "page";
  readonly kind: "string";
  readonly valueAttribute:
    "observation.contextPageCountry" | "observation.contextPageRegion";
  readonly semanticProfile: "case-folded-text";
}

export type CountBareField = AdvancedCountSelectorField | QualifiedGeoBareField;

const QUALIFIED_GEO_BARE_FIELDS: readonly QualifiedGeoBareField[] = [
  {
    fieldId: "geo.country",
    collection: "page",
    kind: "string",
    valueAttribute: "observation.contextPageCountry",
    semanticProfile: "case-folded-text",
  },
  {
    fieldId: "geo.region",
    collection: "page",
    kind: "string",
    valueAttribute: "observation.contextPageRegion",
    semanticProfile: "case-folded-text",
  },
];

export function countBareField(
  fieldId: string,
  allowQualifiedGeo: boolean,
): CountBareField | undefined {
  const registered = advancedCountSelectorField(fieldId);
  if (registered) return registered;
  if (!allowQualifiedGeo) return undefined;
  return QUALIFIED_GEO_BARE_FIELDS.find((field) => field.fieldId === fieldId);
}

export function isQualifiedGeoBareField(
  field: CountBareField,
): field is QualifiedGeoBareField {
  return QUALIFIED_GEO_BARE_FIELDS.some(
    (candidate) => candidate.fieldId === field.fieldId,
  );
}

export interface QualifiedGeoLiteralProof {
  readonly fieldId: QualifiedGeoBareField["fieldId"];
  readonly operator: "eq" | "in";
  readonly values: readonly string[];
}

export interface QualifiedGeoRawCountEligibilityWitness {
  readonly kind: "candidate-eligible-activity-count";
  readonly siteId: string;
  readonly scope: "session" | "visitor";
  readonly subjectSiteIds: readonly string[];
  readonly candidateRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly readRange: {
    readonly startMs: number;
    readonly endExclusiveMs: number;
  };
  readonly rawCountMaximum: 20_000;
  readonly rawCountObservationLimit: 20_001;
  readonly activityEligibility: "page-or-same-site-event";
}

export interface QualifiedGeoComparisonProvenance {
  readonly fieldId: QualifiedGeoBareField["fieldId"];
  readonly attributeId: QualifiedGeoBareField["valueAttribute"];
  readonly relationId: RelationId;
  readonly slotId: SlotId;
  readonly semanticProfile: "case-folded-text";
  readonly normalization: "trim-case-fold";
  readonly operator: "eq" | "in";
  readonly literalValues: readonly string[];
  readonly temporalDomains: readonly TemporalDomainRef[];
  readonly rawCountEligibilityWitness: QualifiedGeoRawCountEligibilityWitness;
}

export type QualifiedGeoConditionSupport =
  | { readonly kind: "supported"; readonly proof: QualifiedGeoLiteralProof }
  | {
      readonly kind: "unsupported";
      readonly path: string;
      readonly code: string;
      readonly reason: string;
    };

function unsupported(
  path: string,
  code: string,
  reason: string,
): QualifiedGeoConditionSupport {
  return { kind: "unsupported", path, code, reason };
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isAsciiWithoutNul(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code > 0x7f) return false;
  }
  return true;
}

/** Static Filter literals admitted by the private qualified Geo comparison adapter. */
export function qualifiedGeoConditionSupport(
  condition: FilterCondition,
  path: string,
  field: QualifiedGeoBareField,
): QualifiedGeoConditionSupport {
  if (condition.operator !== "eq" && condition.operator !== "in")
    return unsupported(
      path,
      "count_sql_geo_bare_unsupported_operator",
      "Qualified Geo bare fields support only eq and in.",
    );

  const rawValues =
    condition.operator === "in" ? condition.value : [condition.value];
  if (
    !Array.isArray(rawValues) ||
    rawValues.length === 0 ||
    rawValues.some((value) => typeof value !== "string")
  )
    return unsupported(
      `${path}.value`,
      "count_sql_geo_bare_requires_string_literals",
      "Qualified Geo comparisons require a string literal or non-empty string set.",
    );

  const values: string[] = [];
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string" || hasUnpairedUtf16Surrogate(rawValue))
      return unsupported(
        `${path}.value`,
        "count_sql_geo_bare_invalid_string_literal",
        "Qualified Geo comparison literals must be well-formed strings.",
      );
    const canonical = canonicalizeFilterValue(
      rawValue,
      field.fieldId,
      condition.operator,
    );
    if (typeof canonical !== "string" || !isAsciiWithoutNul(canonical))
      return unsupported(
        `${path}.value`,
        "count_sql_geo_bare_literal_outside_adapter_domain",
        "Qualified Geo comparison literals must canonicalize to ASCII without NUL.",
      );
    values.push(canonical);
  }

  return {
    kind: "supported",
    proof: Object.freeze({
      fieldId: field.fieldId,
      operator: condition.operator,
      values: Object.freeze(values),
    }),
  };
}
