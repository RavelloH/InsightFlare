import { describe, expect, it } from "vitest";

import {
  applyBlockingRulesPatch,
  BlockingRulesValidationError,
  fieldIdForLegacyKey,
  matchBlockingRules,
  parseBlockingRules,
  serializeBlockingRulesV2,
  validateBlockingRules,
} from "@/lib/blocking-rules";

describe("blocking rules parser", () => {
  it("converts v1 settings into canonical v2-style fields", () => {
    const parsed = parseBlockingRules({
      domainWhitelist: ["Example.com", "docs.example.com"],
      pathBlacklist: ["admin"],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.fields.domains).toMatchObject({
      present: true,
      source: "legacy",
      sourceVersion: 1,
      lines: ["*", "-example.com", "-docs.example.com"],
    });
    expect(parsed.fields.paths).toMatchObject({
      present: true,
      source: "legacy",
      sourceVersion: 1,
      lines: ["/admin", "/admin/*"],
    });
  });

  it("resolves each field from the highest available version and preserves empty overrides", () => {
    const parsed = parseBlockingRules({
      pathBlacklist: ["/legacy"],
      blockingRules: [
        { version: 1, data: { pathBlacklist: ["/v1"] } },
        {
          version: 2,
          data: {
            allowedDomains: ["*", "-example.com"],
            paths: [],
          },
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.fields.domains).toMatchObject({
      source: "versioned",
      sourceVersion: 2,
      lines: ["*", "-example.com"],
    });
    expect(parsed.fields.paths).toMatchObject({
      present: true,
      source: "versioned",
      sourceVersion: 2,
      lines: [],
      rules: [],
    });
  });

  it("reports invalid v1/v2 lines with field and line information", () => {
    const errors = validateBlockingRules({
      domainWhitelist: ["*.example.com", "valid.example.com"],
      blockingRules: [
        {
          version: 2,
          data: {
            ips: ["10.0.0.0/99", "10.0.0.1..10.0.0.2"],
            paths: ["/ok", "-"],
          },
        },
      ],
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "domains",
          line: 1,
          code: "invalid_pattern",
          version: 1,
        }),
        expect.objectContaining({
          field: "ips",
          line: 1,
          code: "invalid_pattern",
          version: 2,
        }),
        expect.objectContaining({
          field: "paths",
          line: 2,
          code: "invalid_line",
          version: 2,
        }),
      ]),
    );
  });

  it("rejects domain values without a hostname suffix in v1 and v2", () => {
    const errors = validateBlockingRules({
      domainWhitelist: ["abc"],
      blockingRules: [
        {
          version: 2,
          data: {
            domains: ["abc", "valid.example.com", "foo..example.com"],
          },
        },
      ],
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "domains",
          line: 1,
          code: "invalid_pattern",
          version: 1,
        }),
        expect.objectContaining({
          field: "domains",
          line: 1,
          code: "invalid_pattern",
          version: 2,
        }),
        expect.objectContaining({
          field: "domains",
          line: 3,
          code: "invalid_pattern",
          version: 2,
        }),
      ]),
    );
  });

  it("serializes canonical v2 arrays while retaining comments and blank lines", () => {
    expect(
      serializeBlockingRulesV2({
        domains: [" Example.COM ", "", "# keep this", "-*.Example.COM"],
        paths: [],
      }),
    ).toEqual({
      version: 2,
      data: {
        domains: ["example.com", "", "# keep this", "-*.example.com"],
        paths: [],
      },
    });

    expect(() =>
      serializeBlockingRulesV2({
        domains: ["ok.example.com"],
        typoField: [],
      } as never),
    ).toThrow(BlockingRulesValidationError);
  });

  it("patches fields without leaving legacy or duplicate logical fields behind", () => {
    const next = applyBlockingRulesPatch(
      {
        domainWhitelist: ["legacy.example.com"],
        pathBlacklist: ["/legacy"],
        unrelated: true,
        blockingRules: [
          {
            version: 1,
            data: {
              domainWhitelist: ["v1.example.com"],
              pathBlacklist: ["/v1"],
              keep: "yes",
            },
          },
          {
            version: 2,
            data: {
              allowedDomains: ["old.example.com"],
              queryParameters: ["utm_*"],
            },
          },
        ],
      },
      { domains: ["*", "-new.example.com"], paths: [] },
    );

    expect(next).toMatchObject({ unrelated: true });
    expect(next).not.toHaveProperty("domainWhitelist");
    expect(next).not.toHaveProperty("pathBlacklist");
    expect(next.blockingRules).toEqual([
      {
        version: 2,
        data: {
          queryParameters: ["utm_*"],
          domains: ["*", "-new.example.com"],
          paths: [],
        },
      },
      { version: 1, data: { keep: "yes" } },
    ]);
  });
});

describe("blocking rule matching", () => {
  it("returns the matching rules and the final blocking reasons", () => {
    const parsed = parseBlockingRules({
      blockingRules: [
        {
          version: 2,
          data: {
            domains: ["*", "-example.com", "example.com"],
            paths: ["/admin/*", "-/admin/ok"],
            queryParameters: ["utm_*", "-utm_source=internal"],
            ips: ["10.0.0.0/8", "10.0.0.1..10.0.0.5", "-10.0.0.3"],
            asns: ["*", "-64500"],
            countries: ["*", "-US"],
            regions: ["US-CA", "-US-CA"],
            userAgents: ["*bot*", "-goodbot"],
            referrers: ["partner.example.com"],
          },
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    const result = matchBlockingRules(parsed, {
      hostname: "example.com",
      pathname: "/admin/ok",
      query: "utm_source=internal&utm_campaign=launch",
      referrer: "https://partner.example.com/article",
      userAgent: "goodbot",
      ip: "10.0.0.3",
      asn: "AS64500",
      country: "US",
      region: "US-CA",
    });

    expect(result.allowed).toBe(false);
    expect(result.fields.domains.decision).toBe("block");
    expect(result.fields.paths.decision).toBe("allow");
    expect(result.fields.queryParameters.decision).toBe("block");
    expect(result.fields.ips.decision).toBe("allow");
    expect(result.fields.asns.decision).toBe("allow");
    expect(result.fields.countries.decision).toBe("allow");
    expect(result.fields.regions.decision).toBe("allow");
    expect(result.fields.userAgents.decision).toBe("allow");
    expect(result.fields.referrers.decision).toBe("block");
    expect(result.fields.domains.blockedBy[0]).toMatchObject({
      field: "domains",
      version: 2,
      line: 3,
      pattern: "example.com",
      value: "example.com",
      action: "block",
      reasonCode: "matched_rule",
    });
    expect(result.fields.paths.matched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "block", pattern: "/admin/*" }),
        expect.objectContaining({ action: "allow", pattern: "/admin/ok" }),
      ]),
    );
    expect(result.blockedBy.map((reason) => reason.field)).toEqual([
      "domains",
      "queryParameters",
      "referrers",
    ]);
  });

  it("does not let wildcard rules match missing request attributes", () => {
    const parsed = parseBlockingRules({
      blockingRules: [
        {
          version: 2,
          data: {
            domains: ["*"],
            ips: ["*"],
            countries: ["*"],
            userAgents: ["*"],
          },
        },
      ],
    });

    const result = matchBlockingRules(parsed, {});
    expect(result.allowed).toBe(true);
    expect(result.matched).toEqual([]);
  });

  it("covers the supported field syntaxes and defensive input validation", () => {
    const parsed = parseBlockingRules({
      blockingRules: [
        {
          version: 2,
          data: {
            domains: ["*.Example.com", "# comment", "-admin.example.com"],
            paths: ["checkout/*", "-/checkout/confirm"],
            queryParameters: ["utm_*", "-campaign=launch"],
            referrers: ["https://partner.example.com"],
            userAgents: ["*Bot*"],
            ips: ["192.0.2.1", "192.0.2.0/24", "2001:db8::/32"],
            asns: ["0", "64500"],
            countries: ["de"],
            regions: ["de-be"],
          },
        },
      ],
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.fields.domains.lines).toEqual([
      "*.Example.com",
      "# comment",
      "-admin.example.com",
    ]);
    expect(parsed.fields.paths.rules).toHaveLength(2);
    expect(parsed.fields.queryParameters.rules).toHaveLength(2);
    expect(parsed.fields.ips.rules).toHaveLength(3);
    expect(parsed.fields.countries.rules[0]).toMatchObject({
      normalizedPattern: "DE",
    });
    expect(parsed.fields.regions.rules[0]).toMatchObject({
      normalizedPattern: "DE-BE",
    });
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "referrers",
          code: "invalid_pattern",
          line: 1,
        }),
      ]),
    );

    const malformed = parseBlockingRules({
      blockingRules: [
        null,
        { version: 0, data: {} },
        { version: 2, data: null },
        { version: 99, data: {} },
        {
          version: 2,
          data: {
            unknown: [],
            domains: ["foo@bar.com"],
            allowedDomains: [],
            paths: ["ok", 42],
            queryParameters: "key=value\n",
            userAgents: 42,
            ips: [
              "not-an-ip",
              "1.2.foo.4",
              "1.2.3.999",
              "10.0.0.2..10.0.0.1",
              "10.0.0.1/99",
              "::ffff:192.0.2.1",
              "::1::2",
              "2001:0db8:0000:0000:0000:0000:0000:0001",
            ],
            asns: ["AS64500", "9007199254740992"],
            countries: ["USA"],
            regions: ["US"],
          },
        },
        { version: 2, domains: [], paths: ["/bad^"] },
      ],
    });

    expect(malformed.ok).toBe(false);
    expect(malformed.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_layer" }),
        expect.objectContaining({ code: "invalid_data" }),
        expect.objectContaining({ code: "unsupported_version" }),
        expect.objectContaining({ code: "unknown_field", key: "unknown" }),
        expect.objectContaining({ code: "duplicate_field", field: "domains" }),
        expect.objectContaining({ code: "invalid_lines", field: "userAgents" }),
        expect.objectContaining({ code: "invalid_line", field: "paths" }),
        expect.objectContaining({ code: "invalid_pattern", field: "ips" }),
        expect.objectContaining({ code: "invalid_pattern", field: "asns" }),
        expect.objectContaining({
          code: "invalid_pattern",
          field: "countries",
        }),
        expect.objectContaining({ code: "invalid_pattern", field: "regions" }),
      ]),
    );

    expect(parseBlockingRules(null).errors[0]).toMatchObject({
      code: "invalid_document",
    });
    expect(
      parseBlockingRules({ blockingRules: "invalid" }).errors[0],
    ).toMatchObject({
      code: "invalid_document",
    });
    expect(
      parseBlockingRules({
        blockingRules: Array.from({ length: 17 }, () => ({
          version: 2,
          data: {},
        })),
      }).errors,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_document" }),
      ]),
    );
    expect(
      parseBlockingRules({ blockingRules: [{ version: 2, domains: [] }] }).ok,
    ).toBe(true);
    expect(fieldIdForLegacyKey("domainWhitelist")).toBe("domains");
    expect(fieldIdForLegacyKey("unknown")).toBeNull();
  });

  it("accepts legacy strings, preserves comments, and reports limits", () => {
    const legacy = parseBlockingRules({
      domainWhitelist: "example.com, docs.example.com\nexample.com",
      pathBlacklist: "/admin\n/\n/checkout/",
    });

    expect(legacy.ok).toBe(true);
    expect(legacy.fields.domains.lines).toEqual([
      "*",
      "-example.com",
      "-docs.example.com",
    ]);
    expect(legacy.fields.paths.lines).toEqual([
      "/admin",
      "/admin/*",
      "/",
      "/checkout/",
    ]);

    const invalid = validateBlockingRules({
      domainWhitelist: { invalid: true },
      pathBlacklist: Array.from({ length: 201 }, (_, index) => `/p${index}`),
      blockingRules: [
        {
          version: 2,
          data: {
            domains: ["x".repeat(1025)],
            paths: Array.from({ length: 201 }, () => "/too-many"),
          },
        },
      ],
    });

    expect(invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_lines", version: 1 }),
        expect.objectContaining({ code: "too_many_lines", version: 1 }),
        expect.objectContaining({ code: "too_many_lines", version: 2 }),
        expect.objectContaining({ code: "line_too_long", version: 2 }),
      ]),
    );
  });

  it("normalizes request values and matches every matcher kind", () => {
    const parsed = parseBlockingRules({
      blockingRules: [
        {
          version: 2,
          data: {
            domains: ["*.example.com"],
            paths: ["/admin/*"],
            queryParameters: ["utm_*", "-campaign=launch"],
            referrers: ["partner.example.com"],
            userAgents: ["*bot*"],
            ips: ["10.0.0.0/8", "2001:db8::/32"],
            asns: ["64500"],
            countries: ["DE"],
            regions: ["DE-BE"],
          },
        },
      ],
    });

    const result = matchBlockingRules(parsed, {
      hostname: "https://WWW.Example.com//admin?x=1",
      pathname: "https://example.com//admin//edit?x=1",
      query: new URLSearchParams("utm_source=ads&campaign=other"),
      referrer: "not a URL",
      userAgent: "FriendlyBot",
      ip: "2001:db8::1",
      asn: "AS64500",
      country: "de",
      region: "de-be",
    });

    expect(result.allowed).toBe(false);
    expect(result.fields.domains.decision).toBe("block");
    expect(result.fields.paths.decision).toBe("block");
    expect(result.fields.queryParameters.decision).toBe("block");
    expect(result.fields.userAgents.decision).toBe("block");
    expect(result.fields.ips.decision).toBe("block");
    expect(result.fields.asns.decision).toBe("block");
    expect(result.fields.countries.decision).toBe("block");
    expect(result.fields.regions.decision).toBe("block");

    const arrayQuery = matchBlockingRules(parsed, {
      hostname: "example.net",
      pathname: "/public",
      query: [["campaign", "launch"], ["invalid"], ["ok", 42] as never],
      referrer: "https://partner.example.com/article",
      ip: "192.0.2.1",
    });
    expect(arrayQuery.fields.queryParameters.decision).toBe("allow");
    expect(arrayQuery.fields.referrers.decision).toBe("block");
    expect(arrayQuery.fields.ips.decision).toBe("allow");

    const legacy = parseBlockingRules({ domainWhitelist: ["example.com"] });
    expect(
      matchBlockingRules(legacy, {
        hostname: "other.example.com",
        originHostname: "example.com",
      }).fields.domains.decision,
    ).toBe("allow");
    expect(matchBlockingRules(legacy, {}).allowed).toBe(true);
    expect(
      matchBlockingRules(
        parseBlockingRules({}).fields ? parseBlockingRules({}) : legacy,
        {
          hostname: "example.com",
        },
      ).allowed,
    ).toBe(true);
  });

  it("rejects invalid serializer and patch inputs", () => {
    expect(() => serializeBlockingRulesV2(null)).toThrow(
      BlockingRulesValidationError,
    );
    expect(() =>
      serializeBlockingRulesV2({
        domains: ["abc"],
        paths: ["?bad"],
        queryParameters: ["bad value"],
        userAgents: [""],
        ips: ["bad"],
        asns: ["bad"],
        countries: ["USA"],
        regions: ["US"],
      }),
    ).toThrow(BlockingRulesValidationError);

    expect(() => applyBlockingRulesPatch({}, null)).toThrow(
      BlockingRulesValidationError,
    );
    expect(() =>
      applyBlockingRulesPatch({ blockingRules: "invalid" }, { domains: [] }),
    ).toThrow(BlockingRulesValidationError);
    expect(() =>
      applyBlockingRulesPatch(
        { blockingRules: [{ version: 3, data: {} }] },
        { domains: [] },
      ),
    ).toThrow(BlockingRulesValidationError);
    expect(() =>
      applyBlockingRulesPatch(
        { blockingRules: [{ version: 0, data: {} }] },
        { domains: [] },
      ),
    ).toThrow(BlockingRulesValidationError);
    expect(() =>
      applyBlockingRulesPatch(
        {
          blockingRules: Array.from({ length: 17 }, () => ({
            version: 2,
            data: {},
          })),
        },
        { domains: [] },
      ),
    ).toThrow(BlockingRulesValidationError);
    expect(() =>
      applyBlockingRulesPatch({ blockingRules: [null] }, { domains: [] }),
    ).toThrow(BlockingRulesValidationError);
    expect(() =>
      applyBlockingRulesPatch(
        { blockingRules: [{ version: 2, data: null }] },
        { domains: [] },
      ),
    ).toThrow(BlockingRulesValidationError);

    expect(
      applyBlockingRulesPatch({}, { domains: ["example.com"] }),
    ).toMatchObject({
      blockingRules: [{ version: 2, data: { domains: ["example.com"] } }],
    });
    expect(applyBlockingRulesPatch({}, { domains: [] })).toMatchObject({
      blockingRules: [{ version: 2, data: { domains: [] } }],
    });
    expect(applyBlockingRulesPatch({}, {})).not.toHaveProperty("blockingRules");
  });
});
