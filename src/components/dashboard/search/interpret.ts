import type { LookupKind } from "@/lib/perception-search/runtime";

export const lookupPrefixes = [
  "page",
  "event",
  "referrer",
  "visitor",
  "session",
  "event-id",
] as const;
export type LookupPrefix = (typeof lookupPrefixes)[number];
export const lookupFields = {
  visitor: "visitor",
  session: "session",
  "event-id": "event-id",
  page: "page.path",
  event: "event.name",
  referrer: "referrer.domain",
} as const;
export type Lookup = { kind: LookupKind; value: string };
export type Interpretation = {
  query: string;
  lookups: Lookup[];
  focused?: boolean;
  prefix?: LookupPrefix;
  error?: "enterValue" | "invalid";
};

const domainPattern = /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]*$/iu;
/** Full domains or a fragment of one; the server matches by substring. */
const referrerPattern = /^[a-z\d](?:[a-z\d.-]{0,251}[a-z\d])?$/iu;
const uuidPattern = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu;
const sectionLookup: Record<string, LookupPrefix | undefined> = {
  pages: "page",
  events: "event",
  referrers: "referrer",
};

export function lookupUsesDate(kind: LookupKind) {
  return kind !== "visitor" && kind !== "session";
}

/** Splits an explicit `type:` prefix from the typed text. */
export function splitPrefix(text: string): {
  prefix?: LookupPrefix;
  rest: string;
} {
  const explicit = /^([a-z-]+):\s*(.*)$/iu.exec(text.trim());
  const prefix = lookupPrefixes.find(
    (type) => type === explicit?.[1]?.toLowerCase(),
  );
  return prefix
    ? { prefix, rest: explicit?.[2] ?? "" }
    : { rest: text.trimStart() };
}

/**
 * Works out which bounded server lookups a query can run. Nothing here sends a
 * request; lookups only run when the user activates the lookup row.
 */
export function interpret(
  queryText: string,
  section: string,
  siteDomain?: string,
  typeFilter?: LookupPrefix,
): Interpretation {
  const query = queryText.trim();
  const none = { query, lookups: [] };
  const split = splitPrefix(query);
  const prefix = split.prefix ?? typeFilter;
  const raw = split.prefix ? split.rest.trim() : query;
  const value =
    raw.startsWith('"') && raw.endsWith('"') && raw.length > 1
      ? raw.slice(1, -1).trim()
      : raw;
  if (!value)
    return {
      ...none,
      prefix,
      error: split.prefix ? "enterValue" : undefined,
    };
  if (value.length > 512 || /[\p{Cc}"]/u.test(value))
    return { ...none, prefix, error: "invalid" };

  let url: URL | undefined;
  if (/^https?:\/\//iu.test(value)) {
    try {
      url = new URL(value);
    } catch {
      return { ...none, prefix, error: "invalid" };
    }
  }
  if (prefix) {
    const candidate =
      prefix === "referrer"
        ? (url?.hostname ?? value).toLowerCase().replace(/\.$/u, "")
        : prefix === "page"
          ? (url?.pathname ?? value)
          : value;
    if (
      (prefix === "referrer" && !referrerPattern.test(candidate)) ||
      (prefix === "page" &&
        (candidate.length > 120 || /[?&#\\<>]/u.test(candidate)))
    ) {
      return { ...none, prefix, error: "invalid" };
    }
    return {
      query: candidate,
      prefix,
      lookups: [{ kind: prefix, value: candidate }],
      focused: true,
    };
  }
  if (uuidPattern.test(value)) {
    const id = value.toLowerCase();
    return {
      query: id,
      focused: true,
      lookups: [{ kind: "id", value: id }],
    };
  }
  if (/^[a-f\d]{64}$/iu.test(value)) {
    const id = value.toLowerCase();
    return {
      query: id,
      focused: true,
      lookups: [{ kind: "session", value: id }],
    };
  }
  const hostname = url?.hostname ?? value.toLowerCase().replace(/\.$/u, "");
  if (url && hostname === siteDomain?.toLowerCase().replace(/\.$/u, "")) {
    return {
      query: url.pathname,
      focused: true,
      lookups:
        url.pathname.length <= 120
          ? [{ kind: "page", value: url.pathname }]
          : [],
    };
  }
  if (domainPattern.test(hostname)) {
    return {
      query: hostname,
      lookups: [{ kind: "referrer", value: hostname }],
    };
  }
  if (value.startsWith("/") && !value.startsWith("//")) {
    if (value.length > 120 || /[?&#\\<>]/u.test(value))
      return { ...none, error: "invalid" };
    return { query: value, focused: true, lookups: [{ kind: "page", value }] };
  }
  if (url) return none;
  // Plain text matches page paths and event names by substring on the server.
  const kind = sectionLookup[section];
  return {
    query: value,
    lookups: (kind ? [kind] : (["page", "event"] as const)).map((item) => ({
      kind: item,
      value,
    })),
  };
}
