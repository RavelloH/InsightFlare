import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleWikiSummaryRequest } from "@/lib/edge/wiki-summary";

describe("wiki summary route", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects invalid or missing wikidata ids", async () => {
    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=bad",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: "Invalid or missing wikidataId",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 404 when Wikidata does not contain the requested entity", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ entities: {} })),
    );

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=q42",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Wikidata entity not found",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses locale language fallback and returns Wikidata-only entities without labels or sitelinks", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entities: {
            Q99: {
              id: "Q99",
            },
          },
        }),
      ),
    );

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=Q99&locale=zh",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({
      ok: true,
      wikidataId: "Q99",
      requestedLanguage: "zh",
      resolvedLanguage: null,
      fallback: false,
      wikidata: {
        id: "Q99",
        label: "Q99",
        description: null,
      },
      wikipedia: null,
    });
  });

  it("normalizes invalid explicit languages and preserves non-Chinese page URLs", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entities: {
              Q5: {
                labels: {
                  en: { value: "Human" },
                },
                descriptions: {
                  en: { value: "Wikidata concept" },
                },
                sitelinks: {
                  enwiki: {
                    title: "Human",
                    url: "https://en.wikipedia.org/wiki/Human",
                  },
                },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "",
            description: "",
            extract: "",
            extract_html: "",
            content_urls: {
              desktop: {
                page: "https://en.wikipedia.org/wiki/Homo_sapiens",
              },
            },
          }),
        ),
      );

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=Q5&lang=1",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      wikidataId: "Q5",
      requestedLanguage: "en",
      resolvedLanguage: "en",
      fallback: false,
      wikidata: {
        label: "Human",
        description: "Wikidata concept",
      },
      wikipedia: {
        language: "en",
        title: "Human",
        description: "Wikidata concept",
        extract: null,
        extractHtml: null,
        thumbnailUrl: null,
        pageUrl: "https://en.wikipedia.org/wiki/Homo_sapiens",
      },
    });
  });

  it("uses simplified Chinese variants and falls back to sitelink URLs", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entities: {
              Q42: {
                labels: {
                  en: { value: "Douglas Adams" },
                },
                sitelinks: {
                  zhwiki: {
                    title: "Douglas Adams",
                    url: "https://zh.wikipedia.org/wiki/Douglas_Adams",
                  },
                },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({})));

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=Q42&lang=zh-CN",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://zh.wikipedia.org/api/rest_v1/page/summary/Douglas%20Adams",
      expect.objectContaining({
        headers: expect.objectContaining({
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        }),
      }),
    );
    expect(await response.json()).toMatchObject({
      requestedLanguage: "zh",
      resolvedLanguage: "zh",
      fallback: false,
      wikipedia: {
        title: "Douglas Adams",
        pageUrl: "https://zh.wikipedia.org/wiki/Douglas_Adams?variant=zh-cn",
      },
    });
  });

  it("falls back to English sitelinks when the requested language is unavailable", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entities: {
              Q123: {
                id: "Q123",
                labels: {
                  en: { value: "Fallback Entity" },
                },
                descriptions: {
                  en: { value: "English description" },
                },
                sitelinks: {
                  enwiki: {
                    title: "Fallback Entity",
                    url: "https://en.wikipedia.org/wiki/Fallback_Entity",
                  },
                },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Fallback Entity",
            description: "Summary description",
            extract: "Summary text",
            content_urls: {
              desktop: {
                page: "https://en.wikipedia.org/wiki/Fallback_Entity",
              },
            },
          }),
        ),
      );

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=Q123&lang=fr",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://en.wikipedia.org/api/rest_v1/page/summary/Fallback%20Entity",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          "accept-language": expect.any(String),
        }),
      }),
    );
    expect(await response.json()).toMatchObject({
      requestedLanguage: "fr",
      resolvedLanguage: "en",
      fallback: true,
      wikidata: {
        label: "Fallback Entity",
        description: "English description",
      },
      wikipedia: {
        language: "en",
        description: "Summary description",
        extract: "Summary text",
        pageUrl: "https://en.wikipedia.org/wiki/Fallback_Entity",
      },
    });
  });

  it("uses locale-derived Chinese accept-language when lang is omitted", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entities: {
              Q88: {
                labels: {
                  zh: { value: "Locale Entity zh" },
                  en: { value: "Locale Entity" },
                },
                sitelinks: {
                  zhwiki: {
                    title: "Locale Entity",
                    url: "https://zh.wikipedia.org/wiki/Locale_Entity",
                  },
                },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content_urls: {
              desktop: {
                page: "https://zh.wikipedia.org/wiki/Locale_Entity?old=1",
              },
            },
          }),
        ),
      );

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=Q88&locale=zh",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://zh.wikipedia.org/api/rest_v1/page/summary/Locale%20Entity",
      expect.objectContaining({
        headers: expect.objectContaining({
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        }),
      }),
    );
    expect(await response.json()).toMatchObject({
      requestedLanguage: "zh",
      resolvedLanguage: "zh",
      fallback: false,
      wikidata: {
        label: "Locale Entity zh",
      },
      wikipedia: {
        pageUrl:
          "https://zh.wikipedia.org/wiki/Locale_Entity?old=1&variant=zh-cn",
      },
    });
  });

  it("resolves Wikidata labels, Wikipedia summary, and Chinese URL variants", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entities: {
              Q42: {
                id: "Q42",
                labels: {
                  zh: { value: "Douglas Adams zh" },
                  en: { value: "Douglas Adams" },
                },
                descriptions: {
                  zh: { value: "Writer zh" },
                  en: { value: "English writer" },
                },
                sitelinks: {
                  zhwiki: {
                    title: "Douglas Adams",
                    url: "https://zh.wikipedia.org/wiki/Douglas_Adams",
                  },
                },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            title: "Douglas Adams",
            description: "Author summary",
            extract: "Summary extract",
            extract_html: "<p>Summary extract</p>",
            thumbnail: {
              source: "https://upload.example.test/thumb.jpg",
            },
            content_urls: {
              desktop: {
                page: "https://zh.wikipedia.org/wiki/Douglas_Adams",
              },
            },
          }),
        ),
      );

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=q42&lang=zh-TW",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        href: expect.stringContaining("ids=Q42"),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "application/json",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://zh.wikipedia.org/api/rest_v1/page/summary/Douglas%20Adams",
      expect.objectContaining({
        headers: expect.objectContaining({
          "accept-language": "zh-TW,zh;q=0.9,en;q=0.8",
        }),
      }),
    );
    expect(await response.json()).toEqual({
      ok: true,
      wikidataId: "Q42",
      requestedLanguage: "zh",
      resolvedLanguage: "zh",
      fallback: false,
      wikidata: {
        id: "Q42",
        label: "Douglas Adams zh",
        description: "Writer zh",
      },
      wikipedia: {
        language: "zh",
        title: "Douglas Adams",
        description: "Author summary",
        extract: "Summary extract",
        extractHtml: "<p>Summary extract</p>",
        thumbnailUrl: "https://upload.example.test/thumb.jpg",
        pageUrl: "https://zh.wikipedia.org/wiki/Douglas_Adams?variant=zh-tw",
      },
    });
  });

  it("falls back to Wikidata-only payloads when Wikipedia has no page", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entities: {
              Q7: {
                labels: {
                  en: { value: "Entity Seven" },
                },
                descriptions: {},
                sitelinks: {
                  enwiki: {
                    title: "Entity Seven",
                  },
                },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=Q7",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      wikidataId: "Q7",
      requestedLanguage: "en",
      resolvedLanguage: "en",
      wikidata: {
        id: "Q7",
        label: "Entity Seven",
        description: null,
      },
      wikipedia: {
        language: "en",
        title: "Entity Seven",
        description: null,
        extract: null,
        extractHtml: null,
        thumbnailUrl: null,
        pageUrl: null,
      },
    });
  });

  it("returns 502 when upstream requests fail", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("rate limited", { status: 429 }),
    );

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=Q42",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Wiki upstream unavailable",
    });
  });

  it("returns 502 when Wikipedia summary requests fail", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            entities: {
              Q42: {
                labels: { en: { value: "Douglas Adams" } },
                sitelinks: { enwiki: { title: "Douglas Adams" } },
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("upstream error", { status: 500 }));

    const response = await handleWikiSummaryRequest(
      new Request(
        "https://app.test/api/public/resources/wiki-summary?wikidataId=Q42",
        {
          headers: { origin: "https://app.test" },
        },
      ),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Wiki upstream unavailable",
    });
  });
});
