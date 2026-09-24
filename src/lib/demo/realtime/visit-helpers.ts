// ---------------------------------------------------------------------------
//  Demo mock — visit-derived helpers
//
//  Pure functions that derive secondary properties (hash fragment, query
//  string, OS family label) from a single DemoVisitFact. Used by filter
//  matching, journey search, dimension breakdown, etc.
// ---------------------------------------------------------------------------

import { normalizePath } from "@/lib/demo/generators/utils";
import type { DemoVisitFact } from "@/lib/demo/realtime/types";
export const DEMO_EMPTY_HASH_VALUE = "__insightflare_empty_hash__";
export const DEMO_EMPTY_QUERY_VALUE = "__insightflare_empty_query__";
export function demoStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}
/** Map an "Android 15" / "Windows 11" string to its family label ("Android"). */
export function demoOperatingSystemLabel(osVersion: string): string {
  const normalized = String(osVersion ?? "").trim();
  if (!normalized) return "";
  const knownLabels = [
    "Chrome OS",
    "Windows",
    "HarmonyOS",
    "Android",
    "Ubuntu",
    "Fedora",
    "Debian",
    "macOS",
    "iOS",
  ];
  return (
    knownLabels.find((label) => normalized.startsWith(label)) ?? normalized
  );
}
export function demoQueryStringForVisit(visit: DemoVisitFact): string {
  const pathname = normalizePath(visit.pathname);
  const seed = `${visit.pathname}:${visit.title}:${visit.visitId}:query`;
  const magnitude = demoStringHash(seed);
  if (magnitude % 100 < 42) return "";

  let choices = [
    "?utm_source=newsletter",
    "?ref=nav",
    "?variant=a",
    "?theme=dark",
  ];
  if (pathname.includes("/pricing")) {
    choices = [
      "?plan=pro",
      "?billing=annual",
      "?utm_campaign=pricing",
      "?seat=team",
    ];
  } else if (pathname.includes("/docs") || pathname.includes("/guide")) {
    choices = ["?q=install", "?version=latest", "?tab=examples", "?lang=js"];
  } else if (pathname.includes("/news") || pathname.includes("/blog")) {
    choices = [
      "?utm_source=rss",
      "?comment=1",
      "?share=twitter",
      "?ref=homepage",
    ];
  } else if (pathname.includes("/product")) {
    choices = ["?sku=core", "?variant=trial", "?demo=1", "?review=latest"];
  }

  return choices[magnitude % choices.length] ?? "";
}
export function demoHashFragmentForVisit(visit: DemoVisitFact): string {
  const pathname = normalizePath(visit.pathname);
  if (!pathname || pathname === "/") return "";

  const seed = `${visit.pathname}:${visit.title}:${visit.visitId}`;
  const magnitude = demoStringHash(seed);
  if (magnitude % 100 < 46) return "";

  let choices = ["#overview", "#details", "#faq", "#cta"];
  if (pathname.includes("/pricing")) {
    choices = ["#plans", "#compare", "#faq", "#enterprise"];
  } else if (pathname.includes("/docs") || pathname.includes("/guide")) {
    choices = ["#install", "#usage", "#examples", "#api"];
  } else if (pathname.includes("/news") || pathname.includes("/blog")) {
    choices = ["#summary", "#timeline", "#quotes", "#comments"];
  } else if (pathname.includes("/product")) {
    choices = ["#features", "#demo", "#specs", "#reviews"];
  }

  return choices[magnitude % choices.length] ?? "";
}
