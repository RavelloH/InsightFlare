import { describe, expect, it } from "vitest";

import {
  countryFilterLabel,
  countryFilterOptions,
  countryFilterSelection,
} from "@/lib/dashboard/filter-country-values";
import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import {
  analyticsFilterRegistry,
  formatFilterDsl,
  parseFilterDsl,
} from "@/lib/filter-contract";
import { getMessages } from "@/lib/i18n/messages";

describe("country filter presentation", () => {
  it("searches localized names, English names and codes without traffic observations", () => {
    for (const query of ["中国", "China", "CN", "cn"]) {
      const results = countryFilterOptions("zh", [], [], query);
      expect(
        results.some(
          (option) => option.value === "CN" && option.label === "中国",
        ),
      ).toBe(true);
    }
    expect(
      countryFilterSelection(countryFilterOptions("zh", [], [], "中国"), "中国")
        ?.value,
    ).toBe("CN");
    expect(
      countryFilterSelection(countryFilterOptions("ja", [], [], "日本"), "日本")
        ?.value,
    ).toBe("JP");
    expect(
      countryFilterSelection(countryFilterOptions("en", [], [], "US"), "US")
        ?.value,
    ).toBe("US");
  });
  it("prioritizes observed traffic and keeps unknown/legacy selected codes", () => {
    const options = countryFilterOptions(
      "en",
      [
        { value: "US", occurrences: 10 },
        { value: "JP", occurrences: 20 },
      ],
      ["ZZ", "UK"],
      "",
    );
    expect(options.slice(0, 2).map((option) => option.value)).toEqual([
      "JP",
      "US",
    ]);
    expect(options.find((option) => option.value === "ZZ")?.label).toBe("ZZ");
    expect(options.find((option) => option.value === "UK")?.value).toBe("UK");
    expect(
      options.find((option) => option.value === "CN")?.occurrences,
    ).toBeUndefined();
    expect(options.length).toBeGreaterThanOrEqual(249);
    expect(new Set(options.map((option) => option.value)).size).toBe(
      options.length,
    );
    expect(
      countryFilterSelection(countryFilterOptions("en", [], [], "C"), "C"),
    ).toBeUndefined();
  });
  it.each(["en", "zh", "zh-tw", "ja"] as const)(
    "describes country values in %s while preserving raw DSL",
    (locale) => {
      const source = 'geo.country in ["US", "JP"]';
      const doc = parseFilterDsl(source, analyticsFilterRegistry);
      const description = describeFilterExpression(
        doc.root,
        analyticsFilterRegistry,
        getMessages(locale),
      );
      expect(description).toContain(countryFilterLabel("US", locale));
      expect(description).toContain(countryFilterLabel("JP", locale));
      expect(description).not.toContain('"US"');
      expect(formatFilterDsl(doc)).toBe(source);
    },
  );
  it("localizes advanced member operands, but never arbitrary strings that resemble country codes", () => {
    const messages = getMessages("zh");
    for (const source of [
      'first(PAGE).geo.country eq "US"',
      'PAGE { $.geo.country eq "JP" } exists',
    ]) {
      const doc = parseFilterDsl(source, analyticsFilterRegistry);
      expect(
        describeFilterExpression(doc.root, analyticsFilterRegistry, messages),
      ).toContain(source.includes('"US"') ? "美国" : "日本");
    }
    const other = parseFilterDsl('event.name eq "US"', analyticsFilterRegistry);
    expect(
      describeFilterExpression(other.root, analyticsFilterRegistry, messages),
    ).toContain('"US"');
  });
});
