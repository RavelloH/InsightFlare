export type EventPayloadValueTypeCode = 0 | 1 | 2 | 3 | 4 | 5;

/** The finite legacy custom-event JSON type-code mapping. */
export function eventPayloadValueTypeCode(
  valueType: string,
): EventPayloadValueTypeCode | null {
  switch (valueType) {
    case "null":
      return 0;
    case "string":
      return 1;
    case "number":
      return 2;
    case "boolean":
      return 3;
    case "object":
      return 4;
    case "array":
      return 5;
    default:
      return null;
  }
}

/** The existing display label for a stored custom-event JSON type code. */
export function eventPayloadValueTypeLabel(valueType: number): string {
  switch (valueType) {
    case 1:
      return "string";
    case 2:
      return "number";
    case 3:
      return "boolean";
    case 4:
      return "object";
    case 5:
      return "array";
    default:
      return "null";
  }
}
