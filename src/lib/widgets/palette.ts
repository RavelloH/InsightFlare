import { buildComplementaryOklchPalette } from "@insightflare/product-ui/chart-colors";

/**
 * Match the application's complementary / inverted-color chart system.
 * The full gradient is recomputed for each series count, never cycled
 * through a fixed list of accents.
 */
export function widgetPalette(count: number): string[] {
  return buildComplementaryOklchPalette(
    Math.min(10, Math.max(2, Math.floor(count))),
  );
}

export const WIDGET_PALETTE_CSS = `:root {
${Array.from({ length: 9 }, (_, index) => {
  const count = index + 2;
  return widgetPalette(count)
    .map((color, i) => `  --widget-palette-${count}-${i + 1}: ${color};`)
    .join("\n");
}).join("\n")}
}`;
