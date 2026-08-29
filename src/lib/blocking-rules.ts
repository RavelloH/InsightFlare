/**
 * Browser/Worker-safe blocking rule parser.
 *
 * This module has no dependency on the edge runtime, storage, React, or
 * localization so the collector and settings UI can share its semantics.
 */

import { parseDomainWhitelist, parsePathBlacklist } from "@/lib/site-settings";

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

const MAX_RULE_LAYERS = 16;
const MAX_RULE_LINES = 200;
const MAX_RULE_LINE_LENGTH = 1024;

const V1_FIELD_KEYS: Readonly<
  Partial<Record<BlockingFieldId, readonly string[]>>
> = {
  domains: ["domainWhitelist"],
  paths: ["pathBlacklist"],
};

const V2_FIELD_KEYS: Readonly<Record<BlockingFieldId, string>> = {
  domains: "domains",
  paths: "paths",
  queryParameters: "queryParameters",
  referrers: "referrers",
  userAgents: "userAgents",
  ips: "ips",
  asns: "asns",
  countries: "countries",
  regions: "regions",
};

const V2_FIELD_ALIASES: Readonly<Record<string, BlockingFieldId>> = {
  domains: "domains",
  allowedDomains: "domains",
  paths: "paths",
  pathRules: "paths",
  queryParameters: "queryParameters",
  queryParams: "queryParameters",
  referrers: "referrers",
  userAgents: "userAgents",
  userAgent: "userAgents",
  ips: "ips",
  ipRanges: "ips",
  asns: "asns",
  countries: "countries",
  regions: "regions",
};

interface ParsedFieldSource {
  readonly field: BlockingFieldId;
  readonly version: number;
  readonly source: BlockingRuleSource;
  readonly lines: readonly string[];
  readonly rules: readonly BlockingCompiledRule[];
  readonly errors: readonly BlockingRuleSyntaxError[];
}

interface ParsedLayer {
  readonly version: number;
  readonly fields: readonly ParsedFieldSource[];
  readonly errors: readonly BlockingRuleSyntaxError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function emptyField(field: BlockingFieldId): ResolvedBlockingField {
  return {
    field,
    present: false,
    source: "default",
    sourceVersion: null,
    lines: [],
    rules: [],
  };
}

function syntaxError(
  code: BlockingRuleSyntaxError["code"],
  message: string,
  input: Partial<BlockingRuleSyntaxError> = {},
): BlockingRuleSyntaxError {
  return { code, message, ...input };
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function globMatch(
  value: string,
  pattern: string,
  caseSensitive: boolean,
): boolean {
  const source = caseSensitive ? value : value.toLowerCase();
  const target = caseSensitive ? pattern : pattern.toLowerCase();
  let sourceIndex = 0;
  let patternIndex = 0;
  let lastStar = -1;
  let starSourceIndex = -1;

  while (sourceIndex < source.length) {
    const token = target[patternIndex];
    if (token === source[sourceIndex]) {
      sourceIndex += 1;
      patternIndex += 1;
      continue;
    }
    if (token === "*") {
      lastStar = patternIndex;
      starSourceIndex = sourceIndex;
      patternIndex += 1;
      continue;
    }
    if (lastStar >= 0) {
      patternIndex = lastStar + 1;
      starSourceIndex += 1;
      sourceIndex = starSourceIndex;
      continue;
    }
    return false;
  }

  while (target[patternIndex] === "*") patternIndex += 1;
  return patternIndex === target.length;
}

function normalizeDomainPattern(pattern: string): string | null {
  const value = pattern.trim().toLowerCase().replace(/\.+$/u, "");
  if (
    !value ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes(":")
  ) {
    return null;
  }
  if (!/^[a-z0-9*.-]+$/u.test(value) || !/[a-z0-9*]/u.test(value)) {
    return null;
  }
  if (value !== "*" && !value.includes(".")) return null;
  if (value.length > 253) return null;
  const labels = value.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9*](?:[a-z0-9*-]*[a-z0-9*])?$/u.test(label),
    )
  ) {
    return null;
  }
  return value;
}

function normalizePathPattern(pattern: string): string | null {
  const value = pattern.trim();
  if (!value || value.includes("://") || /[?#]/u.test(value)) return null;
  const withSlash = value.startsWith("/") ? value : "/" + value;
  const normalized = withSlash.replace(/\/{2,}/gu, "/");
  if (!/^\/[A-Za-z0-9*/\-._~%!$&'()+,;=:@]*$/u.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeQueryPattern(pattern: string): {
  readonly key: string;
  readonly value?: string;
  readonly normalized: string;
} | null {
  const separator = pattern.indexOf("=");
  const key = (separator >= 0 ? pattern.slice(0, separator) : pattern).trim();
  if (!key || /\s/u.test(key) || key.includes("#")) return null;
  if (separator < 0) return { key, normalized: key };
  const value = pattern.slice(separator + 1).trim();
  if (value.includes("#") || /\s/u.test(value)) return null;
  return { key, value, normalized: key + "=" + value };
}

function parseIpv4(value: string): bigint | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function parseIpv6(value: string): bigint | null {
  let source = value;
  if (source.includes(".")) {
    const separator = source.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = parseIpv4(source.slice(separator + 1));
    if (ipv4 === null) return null;
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    source = source.slice(0, separator) + ":" + high + ":" + low;
  }

  const doubleSeparator = source.indexOf("::");
  if (doubleSeparator >= 0 && source.indexOf("::", doubleSeparator + 2) >= 0) {
    return null;
  }

  const parseParts = (part: string): number[] | null => {
    if (!part) return [];
    const result: number[] = [];
    for (const token of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/iu.test(token)) return null;
      result.push(Number.parseInt(token, 16));
    }
    return result;
  };

  let parts: number[];
  if (doubleSeparator >= 0) {
    const left = parseParts(source.slice(0, doubleSeparator));
    const right = parseParts(source.slice(doubleSeparator + 2));
    if (!left || !right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    parts = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  } else {
    const exact = parseParts(source);
    if (!exact || exact.length !== 8) return null;
    parts = exact;
  }
  if (parts.length !== 8) return null;
  return parts.reduce((result, part) => (result << 16n) | BigInt(part), 0n);
}

function parseIpAddress(
  value: string,
): { readonly value: bigint; readonly bits: 32 | 128 } | null {
  if (value.includes(":")) {
    const parsed = parseIpv6(value.toLowerCase());
    return parsed === null ? null : { value: parsed, bits: 128 };
  }
  const parsed = parseIpv4(value);
  return parsed === null ? null : { value: parsed, bits: 32 };
}

function parseIpMatcher(
  pattern: string,
): { readonly matcher: BlockingMatcher; readonly normalized: string } | null {
  if (pattern === "*") {
    return { matcher: { kind: "ip-any" }, normalized: "*" };
  }
  const intervalSeparator = pattern.indexOf("..");
  if (intervalSeparator >= 0) {
    const start = parseIpAddress(pattern.slice(0, intervalSeparator).trim());
    const end = parseIpAddress(pattern.slice(intervalSeparator + 2).trim());
    if (!start || !end || start.bits !== end.bits || start.value > end.value) {
      return null;
    }
    return {
      matcher: {
        kind: "ip-range",
        start: start.value,
        end: end.value,
        bits: start.bits,
      },
      normalized:
        pattern.slice(0, intervalSeparator).trim() +
        ".." +
        pattern.slice(intervalSeparator + 2).trim(),
    };
  }
  const cidrSeparator = pattern.indexOf("/");
  if (cidrSeparator >= 0) {
    const address = parseIpAddress(pattern.slice(0, cidrSeparator).trim());
    const prefix = Number(pattern.slice(cidrSeparator + 1).trim());
    if (
      !address ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > address.bits
    ) {
      return null;
    }
    const hostBits = address.bits - prefix;
    const blockSize = 1n << BigInt(hostBits);
    const start = (address.value / blockSize) * blockSize;
    return {
      matcher: {
        kind: "ip-range",
        start,
        end: start + blockSize - 1n,
        bits: address.bits,
      },
      normalized: pattern.slice(0, cidrSeparator).trim() + "/" + String(prefix),
    };
  }
  const address = parseIpAddress(pattern);
  if (!address) return null;
  return {
    matcher: {
      kind: "ip-range",
      start: address.value,
      end: address.value,
      bits: address.bits,
    },
    normalized: pattern,
  };
}

function normalizeAsnPattern(
  pattern: string,
): { readonly matcher: BlockingMatcher; readonly normalized: string } | null {
  if (pattern === "*") return { matcher: { kind: "asn-any" }, normalized: "*" };
  if (!/^\d+$/u.test(pattern)) return null;
  const value = Number(pattern);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return { matcher: { kind: "asn", value }, normalized: String(value) };
}

function compilePattern(
  field: BlockingFieldId,
  pattern: string,
): { readonly matcher: BlockingMatcher; readonly normalized: string } | null {
  switch (field) {
    case "domains":
    case "referrers": {
      const normalized = normalizeDomainPattern(pattern);
      return normalized === null
        ? null
        : {
            matcher: {
              kind: "glob",
              pattern: normalized,
              caseSensitive: false,
            },
            normalized,
          };
    }
    case "paths": {
      const normalized = normalizePathPattern(pattern);
      return normalized === null
        ? null
        : {
            matcher: { kind: "glob", pattern: normalized, caseSensitive: true },
            normalized,
          };
    }
    case "queryParameters": {
      const normalized = normalizeQueryPattern(pattern);
      return normalized === null
        ? null
        : {
            matcher: {
              kind: "query",
              key: normalized.key,
              ...(normalized.value === undefined
                ? {}
                : { value: normalized.value }),
            },
            normalized: normalized.normalized,
          };
    }
    case "userAgents":
      return pattern.length > 0
        ? {
            matcher: { kind: "glob", pattern, caseSensitive: false },
            normalized: pattern,
          }
        : null;
    case "ips":
      return parseIpMatcher(pattern);
    case "asns":
      return normalizeAsnPattern(pattern);
    case "countries":
    case "regions": {
      const normalized =
        pattern === "*"
          ? "*"
          : field === "countries"
            ? /^[a-z]{2}$/iu.test(pattern)
              ? pattern.toUpperCase()
              : null
            : /^[a-z]{2}-[a-z0-9]{1,3}$/iu.test(pattern)
              ? pattern.toUpperCase()
              : null;
      return normalized === null
        ? null
        : {
            matcher: {
              kind: "glob",
              pattern: normalized,
              caseSensitive: false,
            },
            normalized,
          };
    }
  }
}

function parseV2Lines(
  field: BlockingFieldId,
  value: unknown,
  version: number,
): {
  readonly lines: readonly string[];
  readonly errors: readonly BlockingRuleSyntaxError[];
  readonly rules: readonly BlockingCompiledRule[];
} {
  let sourceLines: readonly string[];
  const errors: BlockingRuleSyntaxError[] = [];
  if (Array.isArray(value)) {
    sourceLines = value.map((raw, index) => {
      if (typeof raw === "string") return raw;
      errors.push(
        syntaxError(
          "invalid_line",
          field + " line " + String(index + 1) + " must be a string",
          { field, line: index + 1, version },
        ),
      );
      return "";
    });
  } else if (typeof value === "string") {
    // Reading a string is intentionally tolerant for hand-written or early
    // preview configs. The v2 serializer always writes string arrays.
    sourceLines = value.split(/\r?\n/u);
  } else {
    return {
      lines: [],
      rules: [],
      errors: [
        syntaxError(
          "invalid_lines",
          field + " must be an array of source lines",
          {
            field,
            version,
          },
        ),
      ],
    };
  }

  if (sourceLines.length > MAX_RULE_LINES) {
    errors.push(
      syntaxError(
        "too_many_lines",
        field + " has more than " + String(MAX_RULE_LINES) + " lines",
        { field, version },
      ),
    );
  }

  const rules: BlockingCompiledRule[] = [];
  const lines = sourceLines.slice(0, MAX_RULE_LINES);
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.length > MAX_RULE_LINE_LENGTH) {
      errors.push(
        syntaxError(
          "line_too_long",
          field +
            " line " +
            String(line) +
            " exceeds " +
            String(MAX_RULE_LINE_LENGTH) +
            " characters",
          { field, line, version },
        ),
      );
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const allow = trimmed.startsWith("-");
    const pattern = (allow ? trimmed.slice(1) : trimmed).trim();
    if (!pattern) {
      errors.push(
        syntaxError(
          "invalid_line",
          field + " line " + String(line) + " has no pattern",
          {
            field,
            line,
            version,
          },
        ),
      );
      continue;
    }
    const compiled = compilePattern(field, pattern);
    if (!compiled) {
      errors.push(
        syntaxError(
          "invalid_pattern",
          field + " line " + String(line) + " has an invalid pattern",
          { field, line, version },
        ),
      );
      continue;
    }
    rules.push({
      line,
      raw,
      pattern,
      action: allow ? "allow" : "block",
      normalizedPattern: compiled.normalized,
      matcher: compiled.matcher,
      sourceVersion: version,
      source: "versioned",
    });
  }
  return { lines, errors, rules };
}

interface LegacyItem {
  readonly value: string;
  readonly line: number;
}

function legacyItems(value: unknown): readonly LegacyItem[] {
  if (Array.isArray(value)) {
    return value
      .map((item, index) => ({
        value: String(item ?? "").trim(),
        line: index + 1,
      }))
      .filter((item) => item.value.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]+/u)
      .map((item, index) => ({ value: item.trim(), line: index + 1 }))
      .filter((item) => item.value.length > 0);
  }
  return [];
}

function parseLegacySource(
  field: "domains" | "paths",
  value: unknown,
  source: BlockingRuleSource = "legacy",
): ParsedFieldSource {
  const normalizedItems: { readonly value: string; readonly line: number }[] =
    [];
  const errors: BlockingRuleSyntaxError[] = [];
  if (!Array.isArray(value) && typeof value !== "string") {
    errors.push(
      syntaxError(
        "invalid_lines",
        field + " must be an array or a string in v1",
        { field, version: 1 },
      ),
    );
  }
  const sourceItems = legacyItems(value);
  if (sourceItems.length > MAX_RULE_LINES) {
    errors.push(
      syntaxError(
        "too_many_lines",
        field + " has more than " + String(MAX_RULE_LINES) + " lines",
        { field, version: 1 },
      ),
    );
  }
  const seen = new Set<string>();
  for (const item of sourceItems.slice(0, MAX_RULE_LINES)) {
    const parsed =
      field === "domains"
        ? parseDomainWhitelist([item.value])
        : parsePathBlacklist([item.value]);
    if (parsed.length === 0) {
      errors.push(
        syntaxError(
          "invalid_pattern",
          field + " line " + String(item.line) + " has an invalid pattern",
          { field, line: item.line, version: 1 },
        ),
      );
      continue;
    }
    for (const parsedValue of parsed) {
      if (!compilePattern(field, parsedValue)) {
        errors.push(
          syntaxError(
            "invalid_pattern",
            field + " line " + String(item.line) + " has an invalid pattern",
            { field, line: item.line, version: 1 },
          ),
        );
        continue;
      }
      if (seen.has(parsedValue)) continue;
      seen.add(parsedValue);
      normalizedItems.push({ value: parsedValue, line: item.line });
    }
  }

  const lines: string[] = [];
  const rules: BlockingCompiledRule[] = [];
  if (field === "domains") {
    if (normalizedItems.length > 0) {
      lines.push("*");
      rules.push({
        line: 0,
        raw: "*",
        pattern: "*",
        action: "block",
        normalizedPattern: "*",
        matcher: { kind: "glob", pattern: "*", caseSensitive: false },
        sourceVersion: 1,
        source,
      });
      for (const item of normalizedItems) {
        const raw = "-" + item.value;
        lines.push(raw);
        rules.push({
          line: item.line,
          raw,
          pattern: item.value,
          action: "allow",
          normalizedPattern: item.value,
          matcher: {
            kind: "glob",
            pattern: item.value,
            caseSensitive: false,
          },
          sourceVersion: 1,
          source,
        });
      }
    }
  } else {
    for (const item of normalizedItems) {
      const exact = compilePattern(field, item.value);
      if (!exact) continue;
      lines.push(item.value);
      rules.push({
        line: item.line,
        raw: item.value,
        pattern: item.value,
        action: "block",
        normalizedPattern: exact.normalized,
        matcher: exact.matcher,
        sourceVersion: 1,
        source,
      });

      if (item.value !== "/" && !item.value.endsWith("/")) {
        const descendant = item.value + "/*";
        const compiled = compilePattern(field, descendant);
        if (compiled) {
          lines.push(descendant);
          rules.push({
            line: item.line,
            raw: descendant,
            pattern: descendant,
            action: "block",
            normalizedPattern: compiled.normalized,
            matcher: compiled.matcher,
            sourceVersion: 1,
            source,
          });
        }
      }
    }
  }
  return {
    field,
    version: 1,
    source,
    lines,
    rules,
    errors,
  };
}

interface BlockingVersionParser {
  readonly version: number;
  resolveField(key: string): BlockingFieldId | undefined;
  keysForField(field: BlockingFieldId): readonly string[];
  canonicalKey(field: BlockingFieldId): string | undefined;
  parseField(
    field: BlockingFieldId,
    value: unknown,
    source: BlockingRuleSource,
  ): ParsedFieldSource;
}

const V1_VERSION_PARSER: BlockingVersionParser = {
  version: 1,
  resolveField(key) {
    for (const [field, keys] of Object.entries(V1_FIELD_KEYS)) {
      if (keys?.includes(key)) return field as BlockingFieldId;
    }
    return undefined;
  },
  keysForField(field) {
    return V1_FIELD_KEYS[field] ?? [];
  },
  canonicalKey() {
    return undefined;
  },
  parseField(field, value, source) {
    if (field !== "domains" && field !== "paths") {
      throw new Error("v1 does not define field " + field);
    }
    return parseLegacySource(field, value, source);
  },
};

const V2_VERSION_PARSER: BlockingVersionParser = {
  version: 2,
  resolveField(key) {
    return V2_FIELD_ALIASES[key];
  },
  keysForField(field) {
    return Object.entries(V2_FIELD_ALIASES)
      .filter(([, mapped]) => mapped === field)
      .map(([key]) => key);
  },
  canonicalKey(field) {
    return V2_FIELD_KEYS[field];
  },
  parseField(field, value) {
    const parsed = parseV2Lines(field, value, 2);
    return {
      field,
      version: 2,
      source: "versioned",
      lines: parsed.lines,
      rules: parsed.rules,
      errors: parsed.errors,
    };
  },
};

const VERSION_PARSERS: Readonly<Record<number, BlockingVersionParser>> = {
  1: V1_VERSION_PARSER,
  2: V2_VERSION_PARSER,
};

function layerData(layer: Record<string, unknown>): {
  readonly data: Record<string, unknown> | null;
  readonly error?: BlockingRuleSyntaxError;
} {
  if (hasOwn(layer, "data")) {
    if (!isRecord(layer.data)) {
      return {
        data: null,
        error: syntaxError(
          "invalid_data",
          "blockingRules layer data must be an object",
        ),
      };
    }
    return { data: layer.data };
  }
  const data = { ...layer };
  delete data.version;
  return { data };
}

function parseLayer(layer: unknown, index: number): ParsedLayer {
  if (!isRecord(layer)) {
    return {
      version: 0,
      fields: [],
      errors: [
        syntaxError(
          "invalid_layer",
          "blockingRules[" + String(index) + "] must be an object",
        ),
      ],
    };
  }
  const version = Number(layer.version);
  if (!Number.isInteger(version) || version < 1) {
    return {
      version: 0,
      fields: [],
      errors: [
        syntaxError(
          "invalid_layer",
          "blockingRules[" + String(index) + "] has an invalid version",
        ),
      ],
    };
  }
  const dataResult = layerData(layer);
  if (!dataResult.data) {
    return {
      version,
      fields: [],
      errors: [
        {
          ...(dataResult.error as BlockingRuleSyntaxError),
          version,
        },
      ],
    };
  }
  if (version !== 1 && version !== 2) {
    return {
      version,
      fields: [],
      errors: [
        syntaxError(
          "unsupported_version",
          "blockingRules version " + String(version) + " is not supported",
          { version },
        ),
      ],
    };
  }

  const parser = VERSION_PARSERS[version];
  const fields: ParsedFieldSource[] = [];
  const errors: BlockingRuleSyntaxError[] = [];
  const seen = new Set<BlockingFieldId>();
  for (const [key, value] of Object.entries(dataResult.data)) {
    const field = parser.resolveField(key);
    if (!field) {
      errors.push(
        syntaxError(
          "unknown_field",
          "blockingRules version " +
            String(version) +
            " has unknown field " +
            key,
          { key, version },
        ),
      );
      continue;
    }
    if (seen.has(field)) {
      errors.push(
        syntaxError(
          "duplicate_field",
          "blockingRules version " +
            String(version) +
            " defines " +
            field +
            " more than once",
          { field, key, version },
        ),
      );
      continue;
    }
    seen.add(field);
    const parsed = parser.parseField(field, value, "versioned");
    fields.push(parsed);
    errors.push(...parsed.errors);
  }
  return { version, fields, errors };
}

function parseLegacyFields(
  document: Record<string, unknown>,
): readonly ParsedFieldSource[] {
  const parser = VERSION_PARSERS[1];
  const fields: ParsedFieldSource[] = [];
  for (const [field, keys] of Object.entries(V1_FIELD_KEYS)) {
    const key = keys?.[0];
    if (key && hasOwn(document, key)) {
      fields.push(
        parser.parseField(field as BlockingFieldId, document[key], "legacy"),
      );
    }
  }
  return fields;
}

export function parseBlockingRules(input: unknown): ParsedBlockingRules {
  const document = isRecord(input) ? input : {};
  const errors: BlockingRuleSyntaxError[] = isRecord(input)
    ? []
    : [
        syntaxError(
          "invalid_document",
          "blocking rules document must be an object",
        ),
      ];
  const sources = new Map<BlockingFieldId, ParsedFieldSource>();
  const rawLayers = document.blockingRules;
  if (rawLayers !== undefined && !Array.isArray(rawLayers)) {
    errors.push(
      syntaxError("invalid_document", "blockingRules must be an array"),
    );
  }
  const layers = Array.isArray(rawLayers) ? rawLayers : [];
  if (layers.length > MAX_RULE_LAYERS) {
    errors.push(
      syntaxError(
        "invalid_document",
        "blockingRules has more than " + String(MAX_RULE_LAYERS) + " layers",
      ),
    );
  }

  const parsedLayers = layers
    .slice(0, MAX_RULE_LAYERS)
    .map((layer, index) => parseLayer(layer, index))
    .sort((a, b) => b.version - a.version);
  for (const layer of parsedLayers) {
    errors.push(...layer.errors);
    for (const field of layer.fields) {
      if (!sources.has(field.field)) sources.set(field.field, field);
    }
  }
  for (const field of parseLegacyFields(document)) {
    errors.push(...field.errors);
    if (!sources.has(field.field)) sources.set(field.field, field);
  }

  const fields = {} as Record<BlockingFieldId, ResolvedBlockingField>;
  for (const field of BLOCKING_FIELD_IDS) {
    const source = sources.get(field);
    if (!source) {
      fields[field] = emptyField(field);
      continue;
    }
    fields[field] = {
      field,
      present: true,
      source: source.source,
      sourceVersion: source.version,
      lines: source.lines,
      rules: source.rules,
    };
  }
  return { ok: errors.length === 0, fields, errors };
}

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

function keysForField(
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

function normalizeHostname(value: unknown): string {
  const raw = normalizedString(value);
  if (!raw) return "";
  try {
    if (raw.includes("://")) {
      return new URL(raw).hostname.toLowerCase().replace(/\.+$/u, "");
    }
  } catch {
    return "";
  }
  return raw.toLowerCase().replace(/\.+$/u, "");
}

function normalizePathname(value: unknown): string {
  const raw = normalizedString(value);
  if (!raw) return "/";
  try {
    if (raw.includes("://")) {
      return (new URL(raw).pathname || "/").replace(/\/{2,}/gu, "/");
    }
  } catch {
    return "";
  }
  const pathname = (raw.split(/[?#]/u)[0] || "/").trim();
  const withSlash = pathname.startsWith("/") ? pathname : "/" + pathname;
  return withSlash.replace(/\/{2,}/gu, "/");
}

function normalizeReferrer(value: unknown): string {
  const raw = normalizedString(value);
  if (!raw) return "";
  try {
    if (raw.includes("://")) {
      return new URL(raw).hostname.toLowerCase().replace(/\.+$/u, "");
    }
  } catch {
    return "";
  }
  return raw.toLowerCase().replace(/\.+$/u, "");
}

function queryEntries(value: unknown): readonly [string, string][] {
  if (value instanceof URLSearchParams) return Array.from(value.entries());
  if (typeof value === "string") {
    const query = value.startsWith("?") ? value.slice(1) : value;
    return Array.from(new URLSearchParams(query).entries());
  }
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        entry.length >= 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    );
  }
  return [];
}

function normalizeIp(
  value: unknown,
): { readonly value: bigint; readonly bits: 32 | 128 } | null {
  return parseIpAddress(normalizedString(value));
}

function normalizeAsn(value: unknown): number | null {
  const raw = normalizedString(value).replace(/^AS/iu, "");
  if (!/^\d+$/u.test(raw)) return null;
  const result = Number(raw);
  return Number.isSafeInteger(result) ? result : null;
}

function matcherMatches(matcher: BlockingMatcher, value: string): boolean {
  switch (matcher.kind) {
    case "glob":
      return globMatch(value, matcher.pattern, matcher.caseSensitive);
    case "ip-any":
    case "asn-any":
      return true;
    case "ip-range": {
      const parsed = normalizeIp(value);
      return Boolean(
        parsed &&
        parsed.bits === matcher.bits &&
        parsed.value >= matcher.start &&
        parsed.value <= matcher.end,
      );
    }
    case "asn":
      return normalizeAsn(value) === matcher.value;
    case "query":
      return false;
  }
}

function toReason(
  field: BlockingFieldId,
  source: ResolvedBlockingField,
  rule: BlockingCompiledRule,
  value: string,
): BlockingMatchReason {
  const actionText = rule.action === "block" ? "blocked" : "allowed";
  return {
    field,
    source: source.source,
    version: source.sourceVersion,
    line: rule.line > 0 ? rule.line : undefined,
    raw: rule.raw,
    pattern: rule.normalizedPattern,
    value,
    action: rule.action,
    reasonCode: "matched_rule",
    message:
      field +
      " " +
      actionText +
      " by rule " +
      JSON.stringify(rule.normalizedPattern),
  };
}

function matchScalar(
  field: BlockingFieldId,
  source: ResolvedBlockingField,
  value: string,
): BlockingFieldMatchResult {
  const matched: BlockingMatchReason[] = [];
  if (!value) {
    return {
      field,
      decision: "allow",
      matched,
      blockedBy: [],
    };
  }
  let final: BlockingMatchReason | undefined;
  for (const rule of source.rules) {
    if (!matcherMatches(rule.matcher, value)) continue;
    final = toReason(field, source, rule, value);
    matched.push(final);
  }
  const blockedBy = final?.action === "block" && final ? [final] : [];
  return {
    field,
    decision: blockedBy.length > 0 ? "block" : "allow",
    matched,
    blockedBy,
  };
}

function matchQuery(
  field: BlockingFieldId,
  source: ResolvedBlockingField,
  value: unknown,
): BlockingFieldMatchResult {
  const matched: BlockingMatchReason[] = [];
  const blockedBy: BlockingMatchReason[] = [];
  const queryRules = source.rules.filter(
    (rule) => rule.matcher.kind === "query",
  );

  for (const [key, parameterValue] of queryEntries(value)) {
    const displayValue = key + "=" + parameterValue;
    let final: BlockingMatchReason | undefined;
    for (const rule of queryRules) {
      if (rule.matcher.kind !== "query") continue;
      if (!globMatch(key, rule.matcher.key, true)) continue;
      if (
        rule.matcher.value !== undefined &&
        !globMatch(parameterValue, rule.matcher.value, true)
      ) {
        continue;
      }
      final = toReason(field, source, rule, displayValue);
      matched.push(final);
    }
    if (final?.action === "block") blockedBy.push(final);
  }
  return {
    field,
    decision: blockedBy.length > 0 ? "block" : "allow",
    matched,
    blockedBy,
  };
}

export function matchBlockingRules(
  parsed: ParsedBlockingRules,
  context: BlockingRequestContext,
): BlockingMatchResult {
  const values: Record<BlockingFieldId, unknown> = {
    domains: normalizeHostname(
      parsed.fields.domains.sourceVersion === 1
        ? context.originHostname
        : context.hostname,
    ),
    paths:
      context.pathname === undefined || context.pathname === null
        ? ""
        : normalizePathname(context.pathname),
    queryParameters: context.query,
    referrers: normalizeReferrer(context.referrer),
    userAgents: normalizedString(context.userAgent),
    ips: normalizedString(context.ip),
    asns: normalizedString(context.asn),
    countries: normalizedString(context.country).toUpperCase(),
    regions: normalizedString(context.region).toUpperCase(),
  };
  const fields = {} as Record<BlockingFieldId, BlockingFieldMatchResult>;
  const matched: BlockingMatchReason[] = [];
  const blockedBy: BlockingMatchReason[] = [];

  for (const field of BLOCKING_FIELD_IDS) {
    const source = parsed.fields[field];
    const result =
      field === "queryParameters"
        ? matchQuery(field, source, values[field])
        : matchScalar(field, source, String(values[field] ?? ""));
    fields[field] = result;
    matched.push(...result.matched);
    blockedBy.push(...result.blockedBy);
  }

  return {
    allowed: blockedBy.length === 0,
    fields,
    matched,
    blockedBy,
  };
}

export function validateBlockingRules(
  input: unknown,
): readonly BlockingRuleSyntaxError[] {
  return parseBlockingRules(input).errors;
}

export function fieldIdForLegacyKey(key: string): BlockingFieldId | null {
  return V1_VERSION_PARSER.resolveField(key) ?? null;
}
