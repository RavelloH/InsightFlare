import {
  BLOCKING_FIELD_IDS,
  type BlockingCompiledRule,
  type BlockingFieldId,
  type BlockingFieldMatchResult,
  type BlockingMatcher,
  type BlockingMatchReason,
  type BlockingMatchResult,
  type BlockingRequestContext,
  type BlockingRuleSyntaxError,
  type ParsedBlockingRules,
  type ResolvedBlockingField,
} from "./contract";
import {
  globMatch,
  normalizedString,
  parseBlockingRules,
  parseIpAddress,
} from "./parser";
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
