export type QualificationCompatibilityField =
  | {
      readonly kind: "numeric";
      readonly fieldId: string;
      readonly outputName: string;
    }
  | {
      readonly kind: "comparison";
      readonly fieldId: string;
      readonly outputName: string;
      readonly semanticProfile: "case-folded-text";
      readonly adapterDomain: "ascii-text-no-nul";
    };

export type QualificationCompatibilityMismatch =
  | { readonly kind: "numeric"; readonly fieldId: string }
  | {
      readonly kind: "comparison";
      readonly fieldId: string;
      readonly semanticProfile: "case-folded-text";
      readonly adapterDomain: "ascii-text-no-nul";
    };

type NumericCompatibilityFieldInput = {
  readonly fieldId: string;
  readonly invalidCountOutput: string;
};

const INVALID_METADATA = "qualification_compatibility_metadata_invalid";
const RESERVED_CONTROL_NAMES = new Set([
  "rawCount",
  "nullActivityIdCount",
  "siteIdentityMismatchCount",
  "entityKind",
  "invalidIdentityCount",
  "duplicateIdentityCount",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record).sort();
  const orderedExpected = [...expected].sort();
  return (
    actual.length === orderedExpected.length &&
    actual.every((key, index) => key === orderedExpected[index])
  );
}

function invalidMetadata(): never {
  throw new Error(INVALID_METADATA);
}

/** Adapt the unchanged Engine numeric declaration to the provider control contract. */
export function qualificationCompatibilityFieldsFromNumeric(
  fields: readonly NumericCompatibilityFieldInput[],
): readonly QualificationCompatibilityField[] {
  if (!Array.isArray(fields)) return invalidMetadata();
  const mapped = fields.map((field) => {
    if (!isRecord(field)) return invalidMetadata();
    const { fieldId, invalidCountOutput } = field;
    if (typeof fieldId !== "string" || typeof invalidCountOutput !== "string")
      return invalidMetadata();
    return {
      kind: "numeric" as const,
      fieldId,
      outputName: invalidCountOutput,
    };
  });
  return validateQualificationCompatibilityFields(mapped);
}

/** Validate runtime metadata before any control row can be trusted. */
export function validateQualificationCompatibilityFields(
  fields: readonly unknown[],
): readonly QualificationCompatibilityField[] {
  if (!Array.isArray(fields)) return invalidMetadata();
  const seenFieldIds = new Set<string>();
  const seenOutputNames = new Set<string>();
  const validated: QualificationCompatibilityField[] = [];

  for (const candidate of fields) {
    if (!isRecord(candidate)) return invalidMetadata();
    const { kind, fieldId, outputName } = candidate;
    if (
      typeof fieldId !== "string" ||
      fieldId.length === 0 ||
      typeof outputName !== "string" ||
      outputName.length === 0 ||
      RESERVED_CONTROL_NAMES.has(outputName) ||
      seenFieldIds.has(fieldId) ||
      seenOutputNames.has(outputName)
    )
      return invalidMetadata();

    if (kind === "numeric") {
      if (!hasExactKeys(candidate, ["kind", "fieldId", "outputName"]))
        return invalidMetadata();
      validated.push(Object.freeze({ kind, fieldId, outputName }));
    } else if (kind === "comparison") {
      const { semanticProfile, adapterDomain } = candidate;
      if (
        !hasExactKeys(candidate, [
          "kind",
          "fieldId",
          "outputName",
          "semanticProfile",
          "adapterDomain",
        ]) ||
        semanticProfile !== "case-folded-text" ||
        adapterDomain !== "ascii-text-no-nul"
      )
        return invalidMetadata();
      validated.push(
        Object.freeze({
          kind,
          fieldId,
          outputName,
          semanticProfile,
          adapterDomain,
        }),
      );
    } else {
      return invalidMetadata();
    }

    seenFieldIds.add(fieldId);
    seenOutputNames.add(outputName);
  }

  return Object.freeze(validated);
}

export function qualificationCompatibilityOutputNames(
  fields: readonly unknown[],
): readonly string[] {
  return Object.freeze(
    validateQualificationCompatibilityFields(fields).map(
      ({ outputName }) => outputName,
    ),
  );
}
