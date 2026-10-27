import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGeoTranslationApiUrl,
  fetchGeoCountryTranslationPayload,
  fetchGeoStateTranslationPayload,
  matchesGeoLabelRecord,
  parseGeoStateTranslationBundle,
  pickLocaleGeoLabel,
  resolveLocalizedCityName,
} from "@/lib/dashboard/geo-translation";

describe("Traditional Chinese names from Simplified Chinese geographic data", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches zh-CN data but displays Traditional Chinese without changing raw match fields", async () => {
    const fetchSpy = vi.fn(
      async (_url: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            country: {
              code: "CN",
              name: "中国",
              native: "中国",
              name_default: "China",
            },
            states: ["GD"],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    expect(buildGeoTranslationApiUrl("zh-TW", "CN")).toBe(
      "https://locale.ravelloh.com/zh-CN/CN/",
    );
    const payload = await fetchGeoCountryTranslationPayload("zh-TW", "CN");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://locale.ravelloh.com/zh-CN/CN/",
    );
    expect(payload?.country?.name).toBe("中国");
    expect(pickLocaleGeoLabel("zh-tw", payload?.country)).toBe("中國");
    expect(matchesGeoLabelRecord(payload?.country, "中国")).toBe(true);
  });

  it("converts provinces and cities while preserving original identifiers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              country: { name: "中国", name_default: "China" },
              state: {
                code: "GD",
                name: "广东省",
                native: "广东省",
                name_default: "Guangdong",
              },
              cities: [
                {
                  name: "深圳市",
                  native: "深圳市",
                  name_default: "Shenzhen",
                },
              ],
            }),
          ),
      ),
    );
    const payload = await fetchGeoStateTranslationPayload("zh-TW", "CN", "GD");
    const bundle = parseGeoStateTranslationBundle(payload, "zh-TW");
    expect(bundle?.stateName).toBe("廣東省");
    expect(resolveLocalizedCityName(bundle, "Shenzhen")).toBe("深圳市");
    expect(matchesGeoLabelRecord(payload?.state, "广东省")).toBe(true);
  });
});
