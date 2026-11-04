import { describe, expect, it } from "vitest";

import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import {
  type QualificationCompatibilityField,
  qualificationCompatibilityFieldsFromNumeric,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-compatibility";
import {
  decodeQualificationControl,
  judgeQualificationControl,
  type QualificationControl,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-runtime";

const numericRequirements = [
  { fieldId: "z-field", invalidCountOutput: "zInvalidCount" },
  { fieldId: "a-field", invalidCountOutput: "aInvalidCount" },
] as const;

const numericFields =
  qualificationCompatibilityFieldsFromNumeric(numericRequirements);

const comparisonField = {
  kind: "comparison",
  fieldId: "page.path",
  outputName: "comparisonMismatchCount",
  semanticProfile: "case-folded-text",
  adapterDomain: "ascii-text-no-nul",
} as const satisfies QualificationCompatibilityField;

function controlValues(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rawCount: 4,
    nullActivityIdCount: 0,
    siteIdentityMismatchCount: 0,
    invalidIdentityCount: 0,
    duplicateIdentityCount: 0,
    ...overrides,
  };
}

function decode(
  fields: readonly QualificationCompatibilityField[],
  values: Record<string, unknown>,
): QualificationControl {
  return decodeQualificationControl({
    read: (name) => values[name],
    compatibilityFields: fields,
    errorLabel: (field) => "invalid:" + field,
  });
}

function judge(
  fields: readonly QualificationCompatibilityField[],
  values: Record<string, unknown>,
  reportRowCount = 0,
) {
  return judgeQualificationControl(decode(fields, values), {
    reportRowCount,
    gateViolation: () => new Error("report gate violation"),
    invalidIdentity: () => new Error("invalid identity"),
    duplicateIdentity: () => new Error("duplicate identity"),
  });
}

describe("qualification compatibility control protocol", () => {
  it("adapts numeric requirements without changing names, order, or empty sets", () => {
    expect(numericFields).toEqual([
      {
        kind: "numeric",
        fieldId: "z-field",
        outputName: "zInvalidCount",
      },
      {
        kind: "numeric",
        fieldId: "a-field",
        outputName: "aInvalidCount",
      },
    ]);
    expect(qualificationCompatibilityFieldsFromNumeric([])).toEqual([]);
  });

  it("preserves the numeric fallback reason and sorted field IDs", () => {
    expect(
      judge(numericFields, {
        ...controlValues(),
        zInvalidCount: 1,
        aInvalidCount: 2,
      }),
    ).toEqual({
      kind: "fallback",
      fallbackReason: {
        kind: "numeric-data-domain",
        fieldIds: ["a-field", "z-field"],
      },
    });
  });

  it("returns typed comparison evidence before identity rejection", () => {
    expect(
      judge([comparisonField], {
        ...controlValues({ invalidIdentityCount: 1 }),
        comparisonMismatchCount: 1,
      }),
    ).toEqual({
      kind: "fallback",
      fallbackReason: {
        kind: "comparison-data-domain",
        fields: [
          {
            fieldId: "page.path",
            semanticProfile: "case-folded-text",
            adapterDomain: "ascii-text-no-nul",
          },
        ],
      },
    });
  });

  it("keeps numeric fallback ahead of comparison fallback when both mismatch", () => {
    expect(
      judge([...numericFields, comparisonField], {
        ...controlValues(),
        zInvalidCount: 1,
        aInvalidCount: 1,
        comparisonMismatchCount: 1,
      }),
    ).toEqual({
      kind: "fallback",
      fallbackReason: {
        kind: "numeric-data-domain",
        fieldIds: ["a-field", "z-field"],
      },
    });
  });

  it("rejects over-cap controls before reporting any compatibility fallback", () => {
    let thrown: unknown;
    try {
      judge([comparisonField], {
        ...controlValues({
          rawCount: 20_001,
          invalidIdentityCount: 1,
        }),
        comparisonMismatchCount: 1,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AnalyticsProviderDomainError);
    expect((thrown as AnalyticsProviderDomainError).domainError).toEqual({
      kind: "invalid-input",
      issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
    });
  });

  it("treats any mismatch with report rows as a gate violation", () => {
    expect(() =>
      judge(
        [comparisonField],
        {
          ...controlValues(),
          comparisonMismatchCount: 1,
        },
        1,
      ),
    ).toThrow("report gate violation");
  });

  it.each([
    ["unknown kind", [{ kind: "future", fieldId: "x", outputName: "xCount" }]],
    [
      "unknown comparison profile",
      [
        {
          kind: "comparison",
          fieldId: "x",
          outputName: "xCount",
          semanticProfile: "locale-sensitive",
          adapterDomain: "ascii-text-no-nul",
        },
      ],
    ],
    [
      "unknown adapter domain",
      [
        {
          kind: "comparison",
          fieldId: "x",
          outputName: "xCount",
          semanticProfile: "case-folded-text",
          adapterDomain: "unicode",
        },
      ],
    ],
    [
      "duplicate field IDs",
      [
        { kind: "numeric", fieldId: "same", outputName: "leftCount" },
        { kind: "numeric", fieldId: "same", outputName: "rightCount" },
      ],
    ],
    [
      "conflicting output names",
      [
        { kind: "numeric", fieldId: "left", outputName: "sameCount" },
        { kind: "numeric", fieldId: "right", outputName: "sameCount" },
      ],
    ],
  ])("fails closed for %s metadata", (_label, metadata) => {
    expect(() =>
      decode(
        metadata as unknown as readonly QualificationCompatibilityField[],
        controlValues(),
      ),
    ).toThrow("qualification_compatibility_metadata_invalid");
  });

  it.each([
    ["missing output", undefined],
    ["NaN", Number.NaN],
    ["negative count", -1],
    ["fractional count", 0.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s compatibility counts", (_label, count) => {
    expect(() =>
      decode(
        [comparisonField],
        controlValues({ comparisonMismatchCount: count }),
      ),
    ).toThrow("invalid:comparisonMismatchCount");
  });
});
