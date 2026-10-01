import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { RiArrowRightLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";

import {
  getUiGalleryCategoryLabel,
  getUiGalleryCopy,
} from "@/components/ui-gallery/copy";
import { formatUiGalleryMessage } from "@/components/ui-gallery/format-copy";
import {
  listUiGalleryCategories,
  uiGalleryRegistry,
} from "@/components/ui-gallery/registry";
import { resolveLocale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";

export const Route = createFileRoute("/$locale/ui/")({
  component: UiGalleryIndex,
});

function UiGalleryIndex() {
  const locale = resolveLocale(Route.useParams().locale);
  const messages = getMessages(locale).uiGallery;
  const categories = listUiGalleryCategories();
  const counts = new Map(
    categories.map((category) => [
      category,
      uiGalleryRegistry.filter(
        (entry) => entry.contract.categoryId === category,
      ).length,
    ]),
  );
  const propValueCount = uiGalleryRegistry.reduce(
    (total, entry) =>
      total +
      entry.contract.propCards.reduce(
        (cardTotal, card) => cardTotal + card.values.length,
        0,
      ),
    0,
  );
  const catalogSummary = formatUiGalleryMessage(messages.catalogSummary, {
    components: uiGalleryRegistry.length,
    states: propValueCount,
  });

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden border bg-card p-6 sm:p-9">
        <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-[linear-gradient(135deg,transparent_49%,color-mix(in_oklch,var(--primary)_10%,transparent)_50%)] sm:block" />
        <div className="relative max-w-2xl space-y-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-primary">
            {messages.designSystem}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {messages.pageTitle}
          </h1>
          <p className="font-mono text-xs text-muted-foreground">
            {catalogSummary}
          </p>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {messages.browseCategories}
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {categories.map((category) => {
            const first = uiGalleryRegistry.find(
              (entry) => entry.contract.categoryId === category,
            );
            if (!first) return null;
            const firstCopy = getUiGalleryCopy(first, locale);

            return (
              <Link
                key={category}
                href={"/" + locale + "/ui/" + first.slug}
                className="group block"
              >
                <Card className="h-full transition-colors group-hover:border-primary/50">
                  <CardHeader>
                    <CardTitle className="text-base">
                      {getUiGalleryCategoryLabel(category, locale)}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {formatUiGalleryMessage(messages.componentsCount, {
                        count: counts.get(category) ?? 0,
                      })}
                    </p>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {firstCopy.title}
                    </span>
                    <RiArrowRightLine className="size-4 transition-transform group-hover:translate-x-1" />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          {messages.featuredComponents}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {uiGalleryRegistry.map((entry) => {
            const { slug, apiEntry, contract } = entry;
            const copy = getUiGalleryCopy(entry, locale);
            return (
              <Link
                key={slug}
                href={"/" + locale + "/ui/" + slug}
                className="group block"
              >
                <Card className="h-full transition-colors group-hover:border-primary/50">
                  <CardHeader>
                    <CardTitle className="text-base">{copy.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between text-xs">
                    <span className="min-w-0 truncate font-mono text-muted-foreground">
                      {apiEntry}
                    </span>
                    <span className="inline-flex items-center gap-2">
                      {formatUiGalleryMessage(messages.statesCount, {
                        count: contract.propCards.reduce(
                          (total, card) => total + card.values.length,
                          0,
                        ),
                      })}
                      <RiArrowRightLine className="size-4 transition-transform group-hover:translate-x-1" />
                    </span>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
