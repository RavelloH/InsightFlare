import { afterEach, describe, expect, it, vi } from "vitest";

const requestAdminService = vi.hoisted(() => vi.fn());

vi.mock("@/lib/dashboard-api/client/admin-service", () => ({
  requestAdminService,
}));

import {
  failureCount,
  formatCount,
  formatMs,
  formatRate,
  formatWeighted,
  shortVersion,
} from "@/components/dashboard/admin/system-performance/model";
import type {
  TabbedDataTableColumn,
  TabbedDataTableRowBase,
  TabbedDataTableTab,
} from "@/components/dashboard/common/tabbed-data-table-card/types";
import {
  buildCsv,
  createTabRecord,
  csvCell,
  defaultNormalizeRows,
  downloadCsv,
  exportRowLabelFallback,
  firstSortableColumnKey,
  getColumnsForTab,
  sanitizeCsvFilename,
} from "@/components/dashboard/common/tabbed-data-table-card/utils";
import {
  allowedFields,
  directEventName,
  fieldLabel,
  isSelectablePayloadFieldType,
  payloadFieldTypeLabel,
  registryFieldGroups,
} from "@/components/dashboard/filters/filter-editor/field-catalog";
import {
  formatEventDetailBoolean,
  formatEventDetailCity,
  formatEventDetailDateTime,
  formatEventDetailDateTimeOrAbsent,
  formatEventDetailPath,
  formatEventDetailPerformance,
  formatEventDetailScreen,
  formatEventDetailStatus,
  formatEventDetailText,
  hasValidEventCoordinate,
  isInsideDetailDrawer,
} from "@/components/dashboard/site-pages/events/event-detail-utils";
import {
  leadingLabelLetter,
  resolveFaviconUrlForLabel,
  sanitizeHostname,
  toAbsoluteHttpsUrl,
} from "@/components/dashboard/site-pages/overview/overview-url";
import {
  blockingEditorLines,
  blockingEditorValues,
  type BlockingRuleDialogCopy,
  blockingRuleErrorMessage,
  type BlockingRuleFieldCopy,
  blockingTestContext,
  formatSampleRateValue,
  postJson,
  randomPublicSlug,
  resolveSiteSlug,
} from "@/components/dashboard/site-pages/settings/settings-model";
import type { BlockingFieldId, BlockingRuleSyntaxError } from "@/lib/blocking";
import type { SiteData } from "@/lib/dashboard-api/client/edge";
import type { AppMessages } from "@/lib/i18n/messages";

const messages = {
  common: { noData: "No data", unknown: "Unknown" },
  sessionDetail: { yes: "Yes", no: "No" },
  realtime: {
    statusLabels: { connected: "Connected" },
    customEvent: "Custom event",
    viewPage: "Page view",
  },
  dashboardHeader: {
    previousPeriod: "Previous period",
    compareButton: "Compare",
  },
  filterBuilder: {
    fieldLabels: { "page.path": "Page path" },
    expressionHelpOtherFields: "Other fields",
    fieldGroups: { page: "Page fields" },
    valueKinds: { string: "String", number: "Number", boolean: "Boolean" },
  },
} as unknown as AppMessages;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("recently split dashboard helpers", () => {
  it("formats event detail values and validates coordinates and drawer targets", () => {
    expect(formatEventDetailDateTime("en", null, "Unknown", "Missing")).toBe(
      "Missing",
    );
    expect(formatEventDetailDateTime("en", 0, "Unknown")).toBe("Unknown");
    expect(
      formatEventDetailDateTime("en", 1_704_067_200_000, "Unknown"),
    ).not.toBe("Unknown");
    expect(
      formatEventDetailDateTimeOrAbsent("en", null, false, "Unknown", "Absent"),
    ).toBe("Absent");
    expect(
      formatEventDetailDateTimeOrAbsent("en", null, true, "Unknown", "Absent"),
    ).toBe("Unknown");

    expect(formatEventDetailBoolean(undefined, messages)).toBe("No data");
    expect(formatEventDetailBoolean(true, messages)).toBe("Yes");
    expect(formatEventDetailBoolean(false, messages)).toBe("No");
    expect(formatEventDetailStatus(" connected ", messages)).toBe("Connected");
    expect(formatEventDetailStatus("mystery", messages)).toBe("Unknown");
    expect(formatEventDetailStatus("  ", messages)).toBe("No data");
    expect(formatEventDetailText("  ok  ", "Missing")).toBe("ok");
    expect(formatEventDetailText(" NULL ", "Missing", "Unknown")).toBe(
      "Unknown",
    );
    expect(formatEventDetailText("  ", "Missing")).toBe("Missing");
    expect(formatEventDetailPath("/pricing", "Missing", "Unknown")).toBe(
      "/pricing",
    );
    expect(formatEventDetailPath("undefined", "Missing", "Unknown")).toBe(
      "Unknown",
    );
    expect(formatEventDetailPath("", "Missing", "Unknown")).toBe("Missing");
    expect(formatEventDetailCity(" New York, NY ", "Missing", "Unknown")).toBe(
      "New York, NY",
    );
    expect(formatEventDetailScreen(null, null, "Unknown", "Missing")).toBe(
      "Missing",
    );
    expect(formatEventDetailScreen(1920, null, "Unknown")).toBe("Unknown");
    expect(formatEventDetailScreen(1920, 1080, "Unknown")).not.toBe("Unknown");
    expect(
      formatEventDetailPerformance("en", null, "ttfb", "Unknown", "Missing"),
    ).toBe("Missing");
    expect(
      formatEventDetailPerformance("en", Number.NaN, "ttfb", "Unknown"),
    ).toBe("Unknown");
    expect(
      formatEventDetailPerformance("en", 0.125, "cls", "Unknown"),
    ).not.toContain("ms");
    expect(
      formatEventDetailPerformance("en", 125, "ttfb", "Unknown"),
    ).toContain("ms");

    expect(hasValidEventCoordinate(90, 180)).toBe(true);
    expect(hasValidEventCoordinate(-91, 0)).toBe(false);
    expect(hasValidEventCoordinate(0, Number.NaN)).toBe(false);
    const inside = document.createElement("div");
    inside.innerHTML = "<span data-detail-drawer-root><button></button></span>";
    expect(isInsideDetailDrawer(inside.querySelector("button"))).toBe(true);
    expect(isInsideDetailDrawer(inside)).toBe(false);
    expect(isInsideDetailDrawer(null)).toBe(false);
  });

  it("normalizes host and favicon URLs and labels", () => {
    expect(sanitizeHostname(" HTTPS://Example.com/path?q=1 ")).toBe(
      "Example.com",
    );
    expect(sanitizeHostname("example.com///")).toBe("example.com");
    expect(toAbsoluteHttpsUrl(" ")).toBeNull();
    expect(toAbsoluteHttpsUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(toAbsoluteHttpsUrl("//example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(toAbsoluteHttpsUrl("example.com")).toBe("https://example.com/");
    expect(toAbsoluteHttpsUrl("https://[invalid")).toBeNull();
    expect(resolveFaviconUrlForLabel(" ")).toBeNull();
    expect(resolveFaviconUrlForLabel("/local/icon.png")).toBeNull();
    expect(resolveFaviconUrlForLabel("https://example.com/path")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(resolveFaviconUrlForLabel("//example.com/path")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(resolveFaviconUrlForLabel("example.com/path")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(resolveFaviconUrlForLabel("https://[invalid")).toBeNull();
    expect(leadingLabelLetter("  insight ")).toBe("I");
    expect(leadingLabelLetter(" ")).toBe("?");
  });

  it("covers settings helpers and blocking-rule editor conversions", async () => {
    const site = {
      id: "12345678-90",
      name: "Example",
      domain: "www.example.com",
      publicSlug: "x",
    } as SiteData;
    expect(resolveSiteSlug(site)).toBe("www-example-com");
    expect(resolveSiteSlug({ ...site, domain: "!!!" })).toBe("12345678");
    expect(randomPublicSlug()).toMatch(/^[a-z0-9]{8}$/);
    expect(formatSampleRateValue(25)).toBe("25%");
    expect(formatSampleRateValue(12.5)).toBe("12.5%");
    expect(formatSampleRateValue(12.3)).toBe("12.3%");
    expect(blockingEditorLines("")).toEqual([]);
    expect(blockingEditorLines("one\r\ntwo")).toEqual(["one", "two"]);
    expect(
      blockingEditorValues({
        domainWhitelist: ["example.com"],
        pathBlacklist: ["/admin"],
      }),
    ).toMatchObject({
      domains: expect.any(String),
      paths: expect.any(String),
    });

    const dialog = {
      errorInvalidLines: "{field} lines {line}",
      errorInvalidLine: "{field} line {line}",
      errorLineTooLong: "{field} too long {line}",
      errorTooManyLines: "Too many",
      errorInvalidPattern: "{field} pattern {line}",
      errorInvalidRule: "Invalid rule",
    } as BlockingRuleDialogCopy;
    const field = { title: "Domains" } as BlockingRuleFieldCopy;
    const error = (code: string) =>
      ({ code, line: 3 }) as BlockingRuleSyntaxError;
    expect(
      blockingRuleErrorMessage(error("invalid_lines"), field, dialog),
    ).toBe("Domains lines 3");
    expect(blockingRuleErrorMessage(error("invalid_line"), field, dialog)).toBe(
      "Domains line 3",
    );
    expect(
      blockingRuleErrorMessage(error("line_too_long"), field, dialog),
    ).toBe("Domains too long 3");
    expect(
      blockingRuleErrorMessage(error("too_many_lines"), field, dialog),
    ).toBe("Too many");
    expect(
      blockingRuleErrorMessage(error("invalid_pattern"), field, dialog),
    ).toBe("Domains pattern 3");
    expect(blockingRuleErrorMessage(error("other"), field, dialog)).toBe(
      "Invalid rule",
    );

    const contexts: Array<[BlockingFieldId, Record<string, string>]> = [
      ["domains", { hostname: "example.com" }],
      ["paths", { pathname: "/a" }],
      ["queryParameters", { query: "x=1" }],
      ["referrers", { referrer: "https://example.com" }],
      ["userAgents", { userAgent: "Agent" }],
      ["ips", { ip: "127.0.0.1" }],
      ["asns", { asn: "AS123" }],
      ["countries", { country: "US" }],
      ["regions", { region: "CA" }],
    ];
    for (const [id, expected] of contexts) {
      expect(
        blockingTestContext(id, ` ${Object.values(expected)[0]} `),
      ).toEqual(expected);
    }

    requestAdminService.mockReset().mockResolvedValue({ ok: true });
    await expect(postJson("sites", { teamId: "team-1" })).resolves.toEqual({
      ok: true,
    });
    expect(requestAdminService).toHaveBeenLastCalledWith("sites", {
      method: "POST",
      body: { teamId: "team-1" },
    });
    await postJson("teams", { teamId: "team-1" }, "PATCH");
    expect(requestAdminService).toHaveBeenLastCalledWith("teams", {
      method: "PATCH",
      body: { teamId: "team-1" },
    });
  });

  it("formats system performance values across units and coverage", () => {
    expect(formatCount("en", null)).toBe("—");
    expect(formatCount("en", 12.6)).toBe("13");
    expect(formatCount("en", 2_500_000)).toBe("2.5M");
    expect(formatMs("en", undefined)).toBe("—");
    expect(formatMs("en", 4.25)).toBe("4.3 ms");
    expect(formatMs("en", 999)).toBe("999 ms");
    expect(formatMs("en", 1250)).toBe("1.25 s");
    expect(formatMs("en", 90_000)).toBe("1.5 min");
    expect(formatMs("en", 5_400_000)).toBe("1.5 h");
    expect(formatRate("en", null)).toBe("—");
    expect(formatRate("en", 0.125)).toBe("12.5%");
    expect(formatRate("en", 0.0004)).toBe("0.04%");
    const metric = {
      applicable: 10,
      complete: 6,
      partial: 4,
      observed: 1200,
      value: 1200,
      coverage: "partial" as const,
      lowerBound: true,
    };
    expect(formatWeighted("en", metric, "count")).toBe("≥ 1,200");
    expect(
      formatWeighted("en", { ...metric, coverage: "unavailable" }, "ms"),
    ).toBe("—");
    expect(shortVersion("0.7.1+abc123")).toBe("0.7.1");
    expect(shortVersion(null)).toBe("—");
    expect(
      failureCount([
        { resultClass: "failure", estimatedInvocations: 3 },
        { resultClass: "client_error", estimatedInvocations: 5 },
        { resultClass: "failure", estimatedInvocations: 2 },
      ] as never),
    ).toBe(5);
  });

  it("provides filter catalog labels, groups, and event-name detection", () => {
    expect(fieldLabel("page.path", messages)).toBe("Page path");
    expect(fieldLabel("unknown.field", messages)).toBe("unknown.field");
    const fields = allowedFields("private-dashboard");
    expect(fields.length).toBeGreaterThan(0);
    expect(allowedFields("private-dashboard", true).length).toBeLessThanOrEqual(
      fields.length,
    );
    expect(
      registryFieldGroups(
        [
          { id: "page.path", group: "page" },
          { id: "custom", group: "other" },
          { id: "ungrouped" },
        ] as never,
        messages,
      ),
    ).toEqual([
      {
        key: "page",
        label: "Page fields",
        fields: [{ id: "page.path", group: "page" }],
      },
      {
        key: "other",
        label: "Other fields",
        fields: [{ id: "custom", group: "other" }, { id: "ungrouped" }],
      },
    ]);
    const condition = (
      field: string,
      valueText: string,
      options: Partial<{ negated: boolean; operator: string }> = {},
    ) => ({
      kind: "condition",
      field,
      valueText,
      negated: options.negated ?? false,
      operator: options.operator ?? "eq",
    });
    expect(
      directEventName({
        children: [condition("event.name", " Purchase ")],
      } as never),
    ).toBe("Purchase");
    expect(
      directEventName({
        children: [
          condition("event.name", "Purchase"),
          condition("event.name", "Signup"),
        ],
      } as never),
    ).toBeUndefined();
    expect(
      directEventName({
        children: [condition("event.name", "Purchase", { negated: true })],
      } as never),
    ).toBeUndefined();
    expect(
      directEventName({
        children: [condition("event.name", "Purchase", { operator: "in" })],
      } as never),
    ).toBeUndefined();
    expect(isSelectablePayloadFieldType("string")).toBe(true);
    expect(isSelectablePayloadFieldType("number")).toBe(true);
    expect(isSelectablePayloadFieldType("boolean")).toBe(true);
    expect(isSelectablePayloadFieldType("object")).toBe(false);
    expect(payloadFieldTypeLabel("string", messages)).toBe("String");
    expect(payloadFieldTypeLabel("object", messages)).toBe("object");
  });

  it("creates tabs, selects columns, exports labels, and serializes CSV", () => {
    type Row = TabbedDataTableRowBase & {
      label?: string;
      displayLabel?: string;
      rawLabel?: string;
    };
    const tabs: TabbedDataTableTab<"all" | "bot">[] = [
      { value: "all", label: "All" },
      { value: "bot", label: "Bot" },
    ];
    const rows: Row[] = [{ key: "k" }];
    expect(defaultNormalizeRows(rows)).toBe(rows);
    expect(createTabRecord(tabs, (tab) => tab.label)).toEqual({
      all: "All",
      bot: "Bot",
    });
    const columns: TabbedDataTableColumn<
      Row,
      "name" | "count",
      "all" | "bot"
    >[] = [
      { key: "name", label: "Name", sortable: false, getValue: () => 0 },
      { key: "count", label: "Count", getValue: () => 1 },
    ];
    expect(getColumnsForTab(columns, "all")).toBe(columns);
    expect(
      getColumnsForTab(
        (tab) => (tab === "bot" ? columns.slice(1) : columns),
        "bot",
      ),
    ).toEqual(columns.slice(1));
    expect(firstSortableColumnKey(columns)).toBe("count");
    expect(firstSortableColumnKey(columns.slice(0, 1))).toBe("name");
    expect(sanitizeCsvFilename("  ")).toBe("table-export.csv");
    expect(sanitizeCsvFilename("Some <report>?.CSV")).toBe("Some-report-.CSV");
    expect(sanitizeCsvFilename("already.csv")).toBe("already.csv");
    expect(csvCell(null)).toBe("");
    expect(csvCell(4)).toBe("4");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"\nnext')).toBe('"a,""b""\nnext"');
    expect(
      buildCsv([
        ["a", 2],
        [null, "b"],
      ]),
    ).toBe("a,2\r\n,b");
    expect(
      exportRowLabelFallback({ displayLabel: " Display ", key: "k" }),
    ).toBe(" Display ");
    expect(exportRowLabelFallback({ label: "Label", key: "k" })).toBe("Label");
    expect(exportRowLabelFallback({ rawLabel: 42, key: "k" })).toBe("42");
    expect(exportRowLabelFallback({ rawLabel: Number.NaN, key: "k" })).toBe(
      "k",
    );

    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    downloadCsv("unsafe?.csv", "a,b");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download="unsafe-.csv"]')).toBeNull();
  });
});
