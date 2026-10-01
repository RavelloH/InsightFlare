import type { ComponentCategoryId } from "@insightflare/ui/contracts";

import type { Locale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

import type { UiGalleryEntry } from "./registry";

export interface ResolvedUiGalleryCopy {
  readonly title: string;
  readonly category: string;
}

export function getUiGalleryCopy(
  entry: UiGalleryEntry,
  locale: Locale,
): ResolvedUiGalleryCopy {
  return {
    title: entry.contract.title,
    category:
      getMessages(locale).uiGallery.categories[entry.contract.categoryId],
  };
}

export function getUiGalleryCategoryLabel(
  category: string,
  locale: Locale,
): string {
  return (
    getMessages(locale).uiGallery.categories[category as ComponentCategoryId] ??
    category
  );
}
