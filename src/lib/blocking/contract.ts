export const BLOCKING_FIELD_IDS = [
  "domains",
  "paths",
  "queryParameters",
  "referrers",
  "userAgents",
  "ips",
  "asns",
  "countries",
  "regions",
] as const;

export type BlockingFieldId = (typeof BLOCKING_FIELD_IDS)[number];

export type BlockingRuleAction = "allow" | "block";

export type BlockingRuleSource = "legacy" | "versioned" | "default";

export interface BlockingRuleSyntaxError {
  code:
    | "invalid_document"
    | "invalid_layer"
    | "unsupported_version"
    | "invalid_data"
    | "unknown_field"
    | "duplicate_field"
    | "invalid_lines"
    | "invalid_line"
    | "line_too_long"
    | "too_many_lines"
    | "invalid_pattern";
  field?: BlockingFieldId;
  key?: string;
  line?: number;
  version?: number;
  message: string;
}

export interface BlockingRuleLine {
  readonly line: number;
  readonly raw: string;
  readonly pattern: string;
  readonly action: BlockingRuleAction;
}

export type BlockingMatcher =
  | {
      readonly kind: "glob";
      readonly pattern: string;
      readonly caseSensitive: boolean;
    }
  | {
      readonly kind: "query";
      readonly key: string;
      readonly value?: string;
    }
  | { readonly kind: "ip-any" }
  | {
      readonly kind: "ip-range";
      readonly start: bigint;
      readonly end: bigint;
      readonly bits: 32 | 128;
    }
  | { readonly kind: "asn"; readonly value: number }
  | { readonly kind: "asn-any" };

export interface BlockingCompiledRule extends BlockingRuleLine {
  readonly normalizedPattern: string;
  readonly matcher: BlockingMatcher;
  readonly sourceVersion: number;
  readonly source: BlockingRuleSource;
}

export interface ResolvedBlockingField {
  readonly field: BlockingFieldId;
  readonly present: boolean;
  readonly source: BlockingRuleSource;
  readonly sourceVersion: number | null;
  /** Canonical v2 source lines used by the UI and v2 serializer. */
  readonly lines: readonly string[];
  readonly rules: readonly BlockingCompiledRule[];
}

export interface ParsedBlockingRules {
  readonly ok: boolean;
  readonly fields: Readonly<Record<BlockingFieldId, ResolvedBlockingField>>;
  readonly errors: readonly BlockingRuleSyntaxError[];
}

export interface BlockingRulesLayer {
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface BlockingRulesDocument {
  readonly blockingRules?: readonly unknown[];
  readonly domainWhitelist?: unknown;
  readonly pathBlacklist?: unknown;
  readonly [key: string]: unknown;
}

export type BlockingRulesV2Values = Partial<
  Record<BlockingFieldId, readonly string[]>
>;

export interface BlockingRequestContext {
  readonly hostname?: unknown;
  /** The request Origin hostname, used to preserve v1 whitelist semantics. */
  readonly originHostname?: unknown;
  readonly pathname?: unknown;
  readonly query?: unknown;
  readonly referrer?: unknown;
  readonly userAgent?: unknown;
  readonly ip?: unknown;
  readonly asn?: unknown;
  readonly country?: unknown;
  readonly region?: unknown;
}

export interface BlockingMatchReason {
  readonly field: BlockingFieldId;
  readonly source: BlockingRuleSource;
  readonly version: number | null;
  readonly line?: number;
  readonly raw: string;
  readonly pattern: string;
  readonly value: string;
  readonly action: BlockingRuleAction;
  readonly reasonCode: "matched_rule";
  readonly message: string;
}

export interface BlockingFieldMatchResult {
  readonly field: BlockingFieldId;
  readonly decision: BlockingRuleAction;
  readonly matched: readonly BlockingMatchReason[];
  readonly blockedBy: readonly BlockingMatchReason[];
}

export interface BlockingMatchResult {
  readonly allowed: boolean;
  readonly fields: Readonly<Record<BlockingFieldId, BlockingFieldMatchResult>>;
  readonly matched: readonly BlockingMatchReason[];
  readonly blockedBy: readonly BlockingMatchReason[];
}

export class BlockingRulesValidationError extends Error {
  readonly errors: readonly BlockingRuleSyntaxError[];

  constructor(errors: readonly BlockingRuleSyntaxError[]) {
    super(errors.map((error) => error.message).join("; "));
    this.name = "BlockingRulesValidationError";
    this.errors = errors;
  }
}
