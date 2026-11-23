import { describe, expect, it } from "vitest";

import { WIDGET_PALETTE_CSS, widgetPalette } from "@/lib/widgets/palette";

describe("complementary palette for independent widgets", () => {
  it("spans the complete inverted gradient at any series count", () => {
    const three = widgetPalette(3);
    const five = widgetPalette(5);
    const ten = widgetPalette(10);
    expect(three).toHaveLength(3);
    expect(five).toHaveLength(5);
    expect(ten).toHaveLength(10);
    expect(new Set(five).size).toBe(5);
    expect(new Set(ten).size).toBe(10);
    expect(five[0]).toBe(three[0]);
    expect(five.at(-1)).toBe(three.at(-1));
    expect(WIDGET_PALETTE_CSS).toContain("--widget-palette-5-5:");
    expect(WIDGET_PALETTE_CSS).toContain("--widget-palette-10-10:");
  });
});
