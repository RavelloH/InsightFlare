interface AdvancedCountStringSelectorField {
  readonly fieldId: string;
  readonly collection: "page" | "event";
  readonly kind: "string";
  readonly valueAttribute: string;
  readonly stringClassAttribute: string;
}

export interface AdvancedCountNumberSelectorField {
  readonly fieldId: string;
  readonly collection: "page";
  readonly kind: "number";
  readonly valueAttribute: string;
  readonly safeRangeAttribute: string;
  readonly exactAggregateAttribute: string;
  readonly invalidCountOutput: string;
}

export const ADVANCED_COUNT_SELECTOR_FIELDS = [
  {
    fieldId: "page.path",
    collection: "page",
    kind: "string",
    valueAttribute: "observation.contextPagePathname",
    stringClassAttribute: "observation.contextPagePathnameIsString",
  },
  {
    fieldId: "page.title",
    collection: "page",
    kind: "string",
    valueAttribute: "observation.contextPageTitle",
    stringClassAttribute: "observation.contextPageTitleIsString",
  },
  {
    fieldId: "page.query",
    collection: "page",
    kind: "string",
    valueAttribute: "observation.contextPageQueryString",
    stringClassAttribute: "observation.contextPageQueryStringIsString",
  },
  {
    fieldId: "page.hash",
    collection: "page",
    kind: "string",
    valueAttribute: "observation.contextPageHash",
    stringClassAttribute: "observation.contextPageHashIsString",
  },
  {
    fieldId: "event.name",
    collection: "event",
    kind: "string",
    valueAttribute: "observation.sameSiteEventName",
    stringClassAttribute: "observation.sameSiteEventNameIsString",
  },
  {
    fieldId: "page.durationMs",
    collection: "page",
    kind: "number",
    valueAttribute: "observation.contextPageDurationMs",
    safeRangeAttribute: "observation.contextPageDurationMsIsCountSafeNumber",
    exactAggregateAttribute:
      "observation.contextPageDurationMsIsExactAggregateNumber",
    invalidCountOutput: "invalidContextPageDurationMsCount",
  },
  {
    fieldId: "performance.ttfbMs",
    collection: "page",
    kind: "number",
    valueAttribute: "observation.contextPagePerfTtfbMs",
    safeRangeAttribute: "observation.contextPagePerfTtfbMsIsCountSafeNumber",
    exactAggregateAttribute:
      "observation.contextPagePerfTtfbMsIsExactAggregateNumber",
    invalidCountOutput: "invalidContextPagePerfTtfbMsCount",
  },
  {
    fieldId: "performance.fcpMs",
    collection: "page",
    kind: "number",
    valueAttribute: "observation.contextPagePerfFcpMs",
    safeRangeAttribute: "observation.contextPagePerfFcpMsIsCountSafeNumber",
    exactAggregateAttribute:
      "observation.contextPagePerfFcpMsIsExactAggregateNumber",
    invalidCountOutput: "invalidContextPagePerfFcpMsCount",
  },
  {
    fieldId: "performance.lcpMs",
    collection: "page",
    kind: "number",
    valueAttribute: "observation.contextPagePerfLcpMs",
    safeRangeAttribute: "observation.contextPagePerfLcpMsIsCountSafeNumber",
    exactAggregateAttribute:
      "observation.contextPagePerfLcpMsIsExactAggregateNumber",
    invalidCountOutput: "invalidContextPagePerfLcpMsCount",
  },
  {
    fieldId: "performance.cls",
    collection: "page",
    kind: "number",
    valueAttribute: "observation.contextPagePerfCls",
    safeRangeAttribute: "observation.contextPagePerfClsIsCountSafeNumber",
    exactAggregateAttribute:
      "observation.contextPagePerfClsIsExactAggregateNumber",
    invalidCountOutput: "invalidContextPagePerfClsCount",
  },
  {
    fieldId: "performance.inpMs",
    collection: "page",
    kind: "number",
    valueAttribute: "observation.contextPagePerfInpMs",
    safeRangeAttribute: "observation.contextPagePerfInpMsIsCountSafeNumber",
    exactAggregateAttribute:
      "observation.contextPagePerfInpMsIsExactAggregateNumber",
    invalidCountOutput: "invalidContextPagePerfInpMsCount",
  },
] as const satisfies readonly (
  AdvancedCountStringSelectorField | AdvancedCountNumberSelectorField
)[];

export type AdvancedCountSelectorField =
  (typeof ADVANCED_COUNT_SELECTOR_FIELDS)[number];

export type AdvancedCountSelectorCollection =
  AdvancedCountSelectorField["collection"];

const RAW_PRESENCE_OPERATORS = new Set([
  "isNull",
  "notNull",
  "exists",
  "notExists",
]);

export function advancedCountSelectorUsesRawPresence(
  operator: string,
): boolean {
  return RAW_PRESENCE_OPERATORS.has(operator);
}

export function advancedCountSelectorNeedsStringClass(
  field: AdvancedCountSelectorField,
  operator: string,
): field is Extract<AdvancedCountSelectorField, { readonly kind: "string" }> {
  return (
    field.kind === "string" && !advancedCountSelectorUsesRawPresence(operator)
  );
}

export function advancedCountSelectorRequiresSafeRange(
  field: AdvancedCountSelectorField,
  operator: string,
): field is Extract<AdvancedCountSelectorField, { readonly kind: "number" }> {
  return (
    field.kind === "number" && !advancedCountSelectorUsesRawPresence(operator)
  );
}

export function advancedCountSelectorField(
  fieldId: string,
): AdvancedCountSelectorField | undefined {
  return ADVANCED_COUNT_SELECTOR_FIELDS.find(
    (field) => field.fieldId === fieldId,
  );
}

export function advancedCountSelectorStringClassField(
  attributeId: string,
):
  Extract<AdvancedCountSelectorField, { readonly kind: "string" }> | undefined {
  return ADVANCED_COUNT_SELECTOR_FIELDS.find(
    (field) =>
      field.kind === "string" && field.stringClassAttribute === attributeId,
  ) as
    | Extract<AdvancedCountSelectorField, { readonly kind: "string" }>
    | undefined;
}

export function advancedCountSelectorSafeRangeField(
  attributeId: string,
):
  Extract<AdvancedCountSelectorField, { readonly kind: "number" }> | undefined {
  return ADVANCED_COUNT_SELECTOR_FIELDS.find(
    (field) =>
      field.kind === "number" && field.safeRangeAttribute === attributeId,
  ) as
    | Extract<AdvancedCountSelectorField, { readonly kind: "number" }>
    | undefined;
}

export function advancedCountSelectorExactAggregateField(
  attributeId: string,
):
  Extract<AdvancedCountSelectorField, { readonly kind: "number" }> | undefined {
  return ADVANCED_COUNT_SELECTOR_FIELDS.find(
    (field) =>
      field.kind === "number" && field.exactAggregateAttribute === attributeId,
  ) as
    | Extract<AdvancedCountSelectorField, { readonly kind: "number" }>
    | undefined;
}

export function advancedCountSelectorBooleanField(
  attributeId: string,
): AdvancedCountSelectorField | undefined {
  return (
    advancedCountSelectorStringClassField(attributeId) ??
    advancedCountSelectorSafeRangeField(attributeId) ??
    advancedCountSelectorExactAggregateField(attributeId)
  );
}
