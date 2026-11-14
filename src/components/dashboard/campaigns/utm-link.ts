export interface UtmParameters {
  source: string;
  medium: string;
  campaign: string;
  content: string;
  term: string;
}

export type UtmLinkResult =
  { url: string; error: null } | { url: null; error: "url" | "required" };

export function buildUtmLink(
  destination: string,
  parameters: UtmParameters,
): UtmLinkResult {
  let url: URL;
  try {
    url = new URL(destination.trim());
  } catch {
    return { url: null, error: "url" };
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    return { url: null, error: "url" };
  }
  if (
    !parameters.source.trim() ||
    !parameters.medium.trim() ||
    !parameters.campaign.trim()
  ) {
    return { url: null, error: "required" };
  }
  for (const key of [
    "source",
    "medium",
    "campaign",
    "content",
    "term",
  ] as const) {
    const value = parameters[key].trim();
    const name = `utm_${key}`;
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
  }
  return { url: url.href, error: null };
}
