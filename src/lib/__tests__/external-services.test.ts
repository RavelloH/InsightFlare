import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXTERNAL_SERVICES,
  externalServices,
  normalizeServiceBaseUrl,
  resolveExternalServices,
  setExternalServices,
} from "@/lib/external-services";

describe("resolveExternalServices", () => {
  it("uses the hosted defaults when nothing is configured", () => {
    expect(resolveExternalServices(undefined)).toEqual(
      DEFAULT_EXTERNAL_SERVICES,
    );
    expect(resolveExternalServices({})).toEqual(DEFAULT_EXTERNAL_SERVICES);
  });

  it("applies HTTPS overrides and keeps sub-paths without a trailing slash", () => {
    expect(
      resolveExternalServices({
        CANIUSE_API_BASE_URL: "https://caniuse.example.com/",
        GEO_LOCALE_API_BASE_URL: " https://example.com/geo/locale/ ",
        SITE_META_API_BASE_URL: "https://meta.example.com",
      }),
    ).toEqual({
      caniuseBaseUrl: "https://caniuse.example.com",
      geoLocaleBaseUrl: "https://example.com/geo/locale",
      siteMetaBaseUrl: "https://meta.example.com",
    });
  });

  it("falls back to the default for invalid, non-HTTPS, or query-bearing values", () => {
    const fallback = DEFAULT_EXTERNAL_SERVICES.caniuseBaseUrl;
    expect(normalizeServiceBaseUrl("not-a-url", fallback)).toBe(fallback);
    expect(
      normalizeServiceBaseUrl("http://caniuse.example.com", fallback),
    ).toBe(fallback);
    expect(
      normalizeServiceBaseUrl("https://caniuse.example.com/?x=1", fallback),
    ).toBe(fallback);
  });
});

describe("externalServices store", () => {
  afterEach(() => setExternalServices(DEFAULT_EXTERNAL_SERVICES));

  it("returns the stored services and ignores empty updates", () => {
    const custom = resolveExternalServices({
      CANIUSE_API_BASE_URL: "https://caniuse.example.com",
    });
    setExternalServices(custom);
    setExternalServices(undefined);
    expect(externalServices()).toEqual(custom);
  });
});
