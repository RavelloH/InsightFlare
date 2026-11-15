import { pageMembershipDimensionContract } from "@/lib/edge/analytics/engine/page-channel-membership-reader-contract";
import {
  type PageReaderConsumer,
  pageReaderProfile,
} from "@/lib/edge/analytics/engine/page-membership-reader-catalog";

/** Original registry operation, captured by completion rather than chosen by a reader. */
export type PageWholeOriginalFamily =
  | "pages"
  | "referrers"
  | "channels"
  | "dimension"
  | "geo-points"
  | "performance"
  | "radar"
  | "share-trend"
  | "cross-dimension";

/** Exact finite single-plan readers. This describes shape only; the original
 * private one-site S/V admission and opaque completion remain mandatory. */
export function pageWholeOriginalFamilyAccepts(
  family: PageWholeOriginalFamily,
  consumer: PageReaderConsumer,
): boolean {
  const profile = pageReaderProfile(consumer);
  if (!profile || profile.stage !== "request") return false;
  switch (family) {
    case "pages":
      return (
        consumer.kind === "pages-top" ||
        consumer.kind === "pages-page" ||
        consumer.kind === "pages-with-tabs" ||
        consumer.kind === "page-tabs"
      );
    case "referrers":
      return (
        consumer.kind === "referrers-top" ||
        consumer.kind === "referrers-page" ||
        consumer.kind === "referrers-summary"
      );
    case "channels":
      return consumer.kind === "channels-list";
    case "dimension":
      return (
        consumer.kind === "dimension-page" ||
        consumer.kind === "boundary-top" ||
        consumer.kind === "boundary-page"
      );
    case "geo-points":
      return false; // Old ordinary reader is two sequential canonical plans.
    case "performance":
      return (
        consumer.kind === "performance-summary" ||
        consumer.kind === "performance-trend" ||
        consumer.kind === "performance-all-trends" ||
        consumer.kind === "performance-routes" ||
        consumer.kind === "performance-countries" ||
        consumer.kind === "performance-dashboard"
      );
    case "radar":
      return (
        consumer.kind === "technology-radar" ||
        consumer.kind === "technology-browser-version"
      );
    case "share-trend":
      return (
        consumer.kind === "technology-share" ||
        consumer.kind === "technology-referrer-channel"
      );
    case "cross-dimension":
      return consumer.kind === "technology-client-cross"; // Ordinary browser-cross is two parallel plans.
  }
}

/** Side-effect-free own data layout probe; no default/URL normalization is moved
 * before whole-filter evaluation. Missing, accessor or unknown layout declines. */
export function pageWholeOriginalFamilyFromQuery(
  operation: string,
  query: object,
): PageWholeOriginalFamily | undefined {
  if (
    ![
      "pages",
      "dimension",
      "referrers",
      "channels",
      "performance",
      "radar",
      "share-trend",
      "cross-dimension",
    ].includes(operation)
  )
    return undefined;
  const own = (key: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(query, key);
    return d && "value" in d ? d.value : undefined;
  };
  const page = own("page"),
    variant = own("variant");
  const hasPage =
    page !== null && typeof page === "object" && !Array.isArray(page);
  if (
    operation === "pages" &&
    (hasPage ||
      variant === "list" ||
      variant === "tabs" ||
      own("includeTabs") === true)
  )
    return "pages";
  if (
    operation === "referrers" &&
    (hasPage || variant === "list" || variant === "summary")
  )
    return "referrers";
  if (
    operation === "performance" &&
    ["summary", "timeseries", "breakdown", "dashboard"].some(
      (mode) => mode === own("mode"),
    )
  )
    return "performance";
  if (operation === "dimension") {
    const mode = Object.getOwnPropertyDescriptor(query, "mode");
    const dimension = own("dimension");
    if (
      (!mode || "value" in mode) &&
      own("mode") !== "overview-tab" &&
      typeof dimension === "string" &&
      (dimension === "session.entryPath" ||
        dimension === "session.exitPath" ||
        pageMembershipDimensionContract(dimension) !== undefined)
    )
      return "dimension";
  }
  if (operation === "channels" && own("mode") === "list") return "channels";
  if (
    operation === "radar" &&
    ["browser", "version", "referrer"].some((v) => v === variant)
  )
    return "radar";
  if (
    operation === "share-trend" &&
    typeof variant === "string" &&
    [
      "browser",
      "browser-engine",
      "client",
      "utm",
      "referrer-channel",
      "referrer",
    ].includes(variant)
  )
    return "share-trend";
  if (operation === "cross-dimension" && variant === "browser")
    return "cross-dimension";
  if (
    operation === "cross-dimension" &&
    variant !== "browser" &&
    typeof own("primaryDimension") === "string" &&
    typeof own("secondaryDimension") === "string"
  )
    return "cross-dimension";
  return undefined;
}
