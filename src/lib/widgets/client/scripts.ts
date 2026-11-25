import type { WidgetConfig } from "@/lib/widgets/contract";

import { BREAKDOWN_CLIENT_FRAGMENT } from "./breakdown";
import { WIDGET_CLIENT_CORE } from "./core";
import { GEO_CLIENT_FRAGMENT } from "./geo";
import { REALTIME_CLIENT_FRAGMENT } from "./realtime";
import { WIDGET_CLIENT_RUNTIME } from "./runtime";

export const WIDGET_SCRIPT_VARIANTS = [
  "base",
  "breakdown",
  "geo",
  "realtime",
] as const;
export type WidgetScriptVariant = (typeof WIDGET_SCRIPT_VARIANTS)[number];

/** Fragments are concatenated in order; each only registers renderers. */
const VARIANT_FRAGMENTS: Readonly<
  Record<WidgetScriptVariant, readonly string[]>
> = {
  base: [],
  breakdown: [BREAKDOWN_CLIENT_FRAGMENT],
  geo: [GEO_CLIENT_FRAGMENT],
  // The realtime map layout reuses the geo renderer.
  realtime: [GEO_CLIENT_FRAGMENT, REALTIME_CLIENT_FRAGMENT],
};

export function widgetScriptVariant(
  type: WidgetConfig["type"],
): WidgetScriptVariant {
  if (type === "distribution") return "breakdown";
  if (type === "geo") return "geo";
  if (type === "realtime") return "realtime";
  return "base";
}

const compiled = new Map<WidgetScriptVariant, string>();

export function widgetClientScript(variant: WidgetScriptVariant): string {
  const cached = compiled.get(variant);
  if (cached !== undefined) return cached;
  const script =
    "\n(function () {" +
    WIDGET_CLIENT_CORE +
    VARIANT_FRAGMENTS[variant].join("") +
    WIDGET_CLIENT_RUNTIME +
    "})();\n";
  compiled.set(variant, script);
  return script;
}
