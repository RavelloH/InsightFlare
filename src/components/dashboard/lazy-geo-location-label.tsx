import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  type GeoStateTranslationBundle,
  type GeoStateTranslationResolution,
  isGeoLabelCountryMatch,
  isGeoRegionCountryMatch,
  isSameGeoLabel,
  resolveGeoStateTranslation,
  resolveGeoTranslationApiLocale,
  resolveLocalizedCityName,
} from "@/lib/dashboard/geo-translation";
import { resolveCountryFlagCode } from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";

export function useInViewOnce<TElement extends Element = HTMLSpanElement>(
  rootMargin = "0px",
): {
  ref: MutableRefObject<TElement | null>;
  isInView: boolean;
} {
  const ref = useRef<TElement | null>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    if (isInView) return;
    const target = ref.current;
    if (!target) return;

    if (typeof IntersectionObserver === "undefined") {
      setIsInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const visible = Boolean(
          entry?.isIntersecting || (entry?.intersectionRatio ?? 0) > 0,
        );
        if (!visible) return;
        setIsInView(true);
        observer.disconnect();
      },
      {
        root: null,
        rootMargin,
        threshold: 0.01,
      },
    );

    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [isInView, rootMargin]);

  return { ref, isInView };
}

export function useGeoStateTranslationResolution({
  locale,
  countryCode,
  stateCode,
  countryLabel = "",
  regionLabel = "",
  localityLabel = "",
  enabled,
}: {
  locale: Locale;
  countryCode: string;
  stateCode: string;
  countryLabel?: string;
  regionLabel?: string;
  localityLabel?: string;
  enabled: boolean;
}): GeoStateTranslationResolution | null {
  const [resolution, setResolution] =
    useState<GeoStateTranslationResolution | null>(null);

  useEffect(() => {
    if (!enabled) {
      setResolution(null);
      return;
    }

    const apiLocale = resolveGeoTranslationApiLocale(locale);
    if (!apiLocale) {
      setResolution(null);
      return;
    }

    const normalizedCountry = countryCode.trim().toUpperCase();
    const normalizedState = stateCode.trim().toUpperCase();
    const normalizedRegionLabel = regionLabel.trim();
    const normalizedLocalityLabel = localityLabel.trim();
    if (
      !normalizedCountry ||
      (!normalizedState && !normalizedRegionLabel && !normalizedLocalityLabel)
    ) {
      setResolution(null);
      return;
    }

    let active = true;
    resolveGeoStateTranslation(apiLocale, normalizedCountry, normalizedState, {
      countryLabel,
      regionLabel: normalizedRegionLabel,
      localityLabel: normalizedLocalityLabel,
    }).then((nextResolution) => {
      if (!active) return;
      setResolution(nextResolution);
    });

    return () => {
      active = false;
    };
  }, [
    countryCode,
    countryLabel,
    enabled,
    locale,
    localityLabel,
    regionLabel,
    stateCode,
  ]);

  return resolution;
}

export function useGeoStateTranslationBundle({
  locale,
  countryCode,
  stateCode,
  countryLabel = "",
  regionLabel = "",
  localityLabel = "",
  enabled,
}: {
  locale: Locale;
  countryCode: string;
  stateCode: string;
  countryLabel?: string;
  regionLabel?: string;
  localityLabel?: string;
  enabled: boolean;
}): GeoStateTranslationBundle | null {
  return (
    useGeoStateTranslationResolution({
      locale,
      countryCode,
      stateCode,
      countryLabel,
      regionLabel,
      localityLabel,
      enabled,
    })?.bundle ?? null
  );
}

interface LazyGeoBreadcrumbBaseProps {
  locale: Locale;
  countryLabel: string;
  countryIconName: string | null;
  regionLabel: string;
  countryCode: string;
  stateCode: string;
  hideRegion: boolean;
}

export function GeoCountryFlag({
  countryCode,
  locale,
  className,
}: {
  countryCode: string;
  locale: Locale;
  className?: string;
}) {
  const flagCode = resolveCountryFlagCode(countryCode, locale);
  if (!flagCode) return null;

  return (
    <Icon
      icon={`flagpack:${flagCode.toLowerCase()}`}
      style={{
        width: 16,
        height: 12,
      }}
      className={className ?? "block shrink-0"}
      aria-hidden="true"
    />
  );
}

export function GeoCountryBreadcrumbItem({
  countryLabel,
  countryIconName,
  countryCode,
  locale,
}: {
  countryLabel: string;
  countryIconName?: string | null;
  countryCode?: string;
  locale?: Locale;
}) {
  return (
    <BreadcrumbItem className="min-w-0">
      <BreadcrumbPage className="inline-flex min-w-0 items-center gap-2">
        {countryIconName ? (
          <Icon
            icon={countryIconName}
            style={{
              width: 16,
              height: 12,
            }}
            className="block shrink-0"
          />
        ) : null}
        {!countryIconName && countryCode && locale ? (
          <GeoCountryFlag countryCode={countryCode} locale={locale} />
        ) : null}
        <span className="truncate leading-5">{countryLabel}</span>
      </BreadcrumbPage>
    </BreadcrumbItem>
  );
}

export function GeoBreadcrumbSeparator() {
  return (
    <span className="shrink-0 text-muted-foreground" aria-hidden="true">
      {">"}
    </span>
  );
}

export function LazyGeoRegionBreadcrumbLabel({
  locale,
  countryLabel,
  countryIconName,
  regionLabel,
  countryCode,
  stateCode,
  hideRegion,
}: LazyGeoBreadcrumbBaseProps) {
  const { ref: visibilityRef, isInView } = useInViewOnce();
  const translationResolution = useGeoStateTranslationResolution({
    locale,
    countryCode,
    stateCode,
    countryLabel,
    regionLabel,
    enabled: isInView && !hideRegion,
  });
  const translationBundle = translationResolution?.bundle ?? null;
  const shouldHideRegion =
    hideRegion ||
    Boolean(translationResolution?.regionMatchesCountry) ||
    isGeoRegionCountryMatch({
      countryLabel,
      countryPayload: translationResolution?.countryPayload,
      regionLabel,
    });
  const localizedRegionLabel =
    translationBundle?.stateName.trim() || regionLabel;

  return (
    <span ref={visibilityRef} className="block">
      <Breadcrumb className="max-w-full">
        <BreadcrumbList className="flex-nowrap gap-1">
          <GeoCountryBreadcrumbItem
            countryLabel={countryLabel}
            countryIconName={countryIconName}
          />
          {shouldHideRegion ? null : (
            <BreadcrumbItem className="min-w-0">
              <GeoBreadcrumbSeparator />
              <BreadcrumbPage className="block truncate leading-5">
                <AutoTransition>{localizedRegionLabel}</AutoTransition>
              </BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>
    </span>
  );
}

export function LazyGeoCityBreadcrumbLabel({
  locale,
  countryLabel,
  countryIconName,
  regionLabel,
  cityLabel,
  countryCode,
  stateCode,
  cityNameDefault,
  hideRegion,
  hideCity,
}: LazyGeoBreadcrumbBaseProps & {
  cityLabel: string;
  cityNameDefault: string;
  hideCity: boolean;
}) {
  const { ref: visibilityRef, isInView } = useInViewOnce();
  const translationResolution = useGeoStateTranslationResolution({
    locale,
    countryCode,
    stateCode,
    countryLabel,
    regionLabel,
    localityLabel: cityNameDefault,
    enabled: isInView && (!hideRegion || !hideCity),
  });
  const translationBundle = translationResolution?.bundle ?? null;
  const shouldHideRegion =
    hideRegion ||
    Boolean(translationResolution?.regionMatchesCountry) ||
    isGeoRegionCountryMatch({
      countryLabel,
      countryPayload: translationResolution?.countryPayload,
      regionLabel,
    });
  const localizedRegionLabel =
    translationBundle?.stateName.trim() || regionLabel;
  const localizedCityLabel =
    resolveLocalizedCityName(translationBundle, cityNameDefault) || cityLabel;
  const shouldHideCity =
    hideCity ||
    Boolean(translationResolution?.localityMatchesCountry) ||
    isSameGeoLabel(regionLabel, cityNameDefault) ||
    isSameGeoLabel(regionLabel, cityLabel) ||
    (!shouldHideRegion &&
      isSameGeoLabel(localizedRegionLabel, localizedCityLabel)) ||
    (shouldHideRegion &&
      (isSameGeoLabel(countryLabel, localizedCityLabel) ||
        isGeoLabelCountryMatch({
          countryLabel,
          countryPayload: translationResolution?.countryPayload,
          label: cityNameDefault,
        })));

  return (
    <span ref={visibilityRef} className="block">
      <Breadcrumb className="max-w-full">
        <BreadcrumbList className="flex-nowrap gap-1">
          <GeoCountryBreadcrumbItem
            countryLabel={countryLabel}
            countryIconName={countryIconName}
          />
          <AutoTransition className="flex gap-1">
            {shouldHideRegion ? null : (
              <BreadcrumbItem className="min-w-0" key={localizedRegionLabel}>
                <GeoBreadcrumbSeparator />
                <BreadcrumbPage className="block truncate leading-5">
                  {localizedRegionLabel}
                </BreadcrumbPage>
              </BreadcrumbItem>
            )}
            {shouldHideCity ? null : (
              <BreadcrumbItem className="min-w-0">
                <GeoBreadcrumbSeparator />
                <BreadcrumbPage className="block truncate leading-5">
                  {localizedCityLabel}
                </BreadcrumbPage>
              </BreadcrumbItem>
            )}
          </AutoTransition>
        </BreadcrumbList>
      </Breadcrumb>
    </span>
  );
}
