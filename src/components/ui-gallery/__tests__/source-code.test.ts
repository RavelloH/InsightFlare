import { describe, expect, it } from "vitest";

import { uiGalleryRegistry } from "@/components/ui-gallery/registry";
import { createUiGallerySource } from "@/components/ui-gallery/source-code";

describe("ui gallery source generation", () => {
  for (const entry of uiGalleryRegistry) {
    it(`generates source for every ${entry.slug} prop value`, () => {
      for (const card of entry.contract.propCards) {
        for (const value of card.values) {
          const node = entry.contract.renderSourceValue(
            card.id,
            value.id,
            true,
          );
          expect(
            () => createUiGallerySource(entry, node),
            `${entry.slug}: ${card.id}=${value.id}`,
          ).not.toThrow();
        }
      }
    });
  }
});
