import { describe, expect, it } from "vitest";

import { parseFilterPanelExpression } from "@/lib/dashboard/filter-panel-expression";
import {
  SYSTEM_FILTER_PRESETS,
  systemFilterPresetFromOptionValue,
  systemFilterPresetOptionValue,
} from "@/lib/dashboard/system-filter-presets";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
} from "@/lib/filter-contract";

describe("system filter presets", () => {
  it("contains unique, public-share-compatible expressions", () => {
    const ids = new Set<string>();

    for (const preset of SYSTEM_FILTER_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);

      const document = parseFilterPanelExpression(
        preset.filterDsl,
        analyticsFilterRegistry,
      );
      expect(() =>
        assertFilterAudience(document, analyticsFilterRegistry, "public-share"),
      ).not.toThrow();
    }
  });

  it("uses the direct sentinel only with equality operators", () => {
    for (const preset of SYSTEM_FILTER_PRESETS) {
      expect(preset.filterDsl).not.toContain('in ["__direct__"');
      expect(preset.filterDsl).not.toContain('notIn ["__direct__"');
    }
  });

  it("round-trips selector option values", () => {
    for (const preset of SYSTEM_FILTER_PRESETS) {
      expect(
        systemFilterPresetFromOptionValue(
          systemFilterPresetOptionValue(preset.id),
        ),
      ).toEqual(preset);
    }
    expect(systemFilterPresetFromOptionValue("saved:example")).toBeUndefined();
  });
});
