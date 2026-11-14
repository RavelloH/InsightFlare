import { describe, expect, it } from "vitest";

import { SUPPORTED_LOCALES } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { productUiLabelBuilders } from "@/lib/product-ui-labels/manifest";

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

describe("productUiLabelBuilders", () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`builds non-empty labels for ${locale}`, () => {
      const messages = getMessages(locale);
      for (const [name, build] of Object.entries(productUiLabelBuilders)) {
        const strings = collectStrings(build(messages));
        expect(strings.length, name).toBeGreaterThan(0);
        for (const text of strings) {
          expect(text.trim(), `${name} (${locale})`).not.toBe("");
        }
      }
    });
  }
});
