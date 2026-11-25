import { describe, expect, it } from "vitest";

import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import { SYSTEM_FILTER_PRESETS } from "@/lib/dashboard/system-filter-presets";
import {
  analyticsFilterRegistry,
  type CanonicalJsonPath,
  type FilterExpression,
  type FilterFieldId,
  parseFilterDsl,
} from "@/lib/filter-contract";
import { getMessages } from "@/lib/i18n/messages";

const fieldId = (value: string) => value as FilterFieldId;
const jsonPath = (value: string) => value as CanonicalJsonPath;

const messages = getMessages("en");

describe("filter descriptions", () => {
  it("describes nested filters with typed list and range values", () => {
    expect(
      describeFilterExpression(
        {
          kind: "and",
          children: [
            {
              kind: "condition",
              target: { kind: "field", field: fieldId("page.path") },
              operator: "eq",
              value: "/pricing",
            },
            {
              kind: "not",
              child: {
                kind: "or",
                children: [
                  {
                    kind: "condition",
                    target: {
                      kind: "field",
                      field: fieldId("referrer.domain"),
                    },
                    operator: "eq",
                    value: "google.com",
                  },
                  {
                    kind: "condition",
                    target: {
                      kind: "field",
                      field: fieldId("client.deviceType"),
                    },
                    operator: "in",
                    value: ["Mobile", "Tablet"],
                  },
                ],
              },
            },
            {
              kind: "condition",
              target: { kind: "event-payload", path: jsonPath("/score") },
              operator: "between",
              value: [120, 130],
            },
          ],
        },
        analyticsFilterRegistry,
        messages,
      ),
    ).toBe(
      'All of the following hold: Page path equals "/pricing"; (The following condition does not hold: (At least one of the following holds: Referrer domain equals "google.com"; Device type is one of "Mobile" or "Tablet")); event property “/score” is between 120 and 130',
    );
  });

  it("uses the localized empty description", () => {
    expect(
      describeFilterExpression(null, analyticsFilterRegistry, messages),
    ).toBe("No filter conditions");
  });

  it("uses localized word order for value collections", () => {
    const chineseMessages = getMessages("zh");

    expect(
      describeFilterExpression(
        {
          kind: "and",
          children: [
            {
              kind: "condition",
              target: { kind: "field", field: fieldId("page.path") },
              operator: "startsWith",
              value: "/docs",
            },
            {
              kind: "condition",
              target: { kind: "field", field: fieldId("referrer.domain") },
              operator: "in",
              value: ["google.com", "news.example.com"],
            },
          ],
        },
        analyticsFilterRegistry,
        chineseMessages,
      ),
    ).toBe(
      '同时满足以下条件：页面路径 以 "/docs" 开头；来源域名 是以下任一值："google.com" 或 "news.example.com"',
    );
  });

  it("naturalizes scalar comparisons and valueless operators", () => {
    const expression: FilterExpression = {
      kind: "and",
      children: [
        {
          kind: "condition",
          target: { kind: "field", field: fieldId("page.path") },
          operator: "contains",
          value: "docs",
        },
        {
          kind: "condition",
          target: { kind: "field", field: fieldId("page.durationMs") },
          operator: "gte",
          value: 1000,
        },
        {
          kind: "condition",
          target: { kind: "field", field: fieldId("event.name") },
          operator: "exists",
        },
        {
          kind: "condition",
          target: { kind: "field", field: fieldId("page.path") },
          operator: "notEmpty",
        },
      ],
    };

    expect(
      describeFilterExpression(expression, analyticsFilterRegistry, messages),
    ).toBe(
      'All of the following hold: Page path contains "docs"; Time on page is greater than or equal to 1000 milliseconds; Event name exists; Page path is not empty',
    );
  });

  it("formats advanced targets and expression values without exposing AST JSON", () => {
    expect(
      describeFilterExpression(
        {
          kind: "condition",
          target: {
            kind: "member",
            object: { kind: "context-root", context: "current" },
            member: "time",
          },
          operator: "gte",
          value: { kind: "time-anchor", anchor: "range.start" },
        },
        analyticsFilterRegistry,
        messages,
      ),
    ).toBe("Time is greater than or equal to the start of the query period");
  });

  it("describes every legacy operator and retains typed advanced operands", () => {
    const legacyCases = [
      ["neq", "alpha", "does not equal"],
      ["startsWith", "alpha", "starts with"],
      ["endsWith", "alpha", "ends with"],
      ["gt", 1, "greater than"],
      ["lt", 2, "less than"],
      ["lte", 2, "less than or equal to"],
      ["notExists", undefined, "does not exist"],
      ["isNull", undefined, "is null"],
      ["notNull", undefined, "is not null"],
      ["isEmpty", undefined, "is empty"],
      ["notEmpty", undefined, "is not empty"],
      ["notIn", ["a", "b"], "is none of"],
    ] as const;

    for (const [operator, value, expected] of legacyCases) {
      const description = describeFilterExpression(
        {
          kind: "condition",
          target: { kind: "field", field: fieldId("unknown.field") },
          operator,
          ...(value === undefined ? {} : { value }),
        } as FilterExpression,
        analyticsFilterRegistry,
        messages,
      );
      expect(description).toContain(expected);
      expect(description).toContain("unknown.field");
    }

    const dynamic = describeFilterExpression(
      {
        kind: "condition",
        target: {
          kind: "arithmetic",
          operator: "sub",
          left: {
            kind: "reducer",
            reducer: "count",
            input: { kind: "entity-root", entity: "event" },
          },
          right: { kind: "duration", amount: 1, unit: "h" },
        },
        operator: "between",
        value: [1, 2],
      },
      analyticsFilterRegistry,
      messages,
    );
    expect(dynamic).toContain("the number of events minus 1 hour");
    expect(dynamic).toContain("between 1 and 2");
  });
});

describe("localized natural filter descriptions", () => {
  it.each(["zh", "zh-tw", "en", "ja"] as const)(
    "describes all 110 presets in %s without raw DSL functions",
    (locale) => {
      const localized = getMessages(locale);
      for (const preset of SYSTEM_FILTER_PRESETS) {
        const doc = parseFilterDsl(preset.filterDsl, analyticsFilterRegistry);
        const result = describeFilterExpression(
          doc.root,
          analyticsFilterRegistry,
          localized,
        );
        expect(result, preset.id).toBeTruthy();
        expect(result, preset.id).not.toMatch(
          /(?:undefined|\[object Object\]|\b(?:countDistinct|count|sequence|window|periods|bucket|sum|avg|first|last|nth|adjacent|without)\(|\$\.|\$span|@now|@range\.)/,
        );
      }
    },
  );
  it("describes sequence order, constraints and absence without implying the wrong scope", () => {
    const source =
      'sequence([EVENT { $.name eq "signup" }, EVENT { $.name eq "purchase" }]) { $span lte 14d } exists';
    const doc = parseFilterDsl(source, analyticsFilterRegistry);
    const result = describeFilterExpression(
      doc.root,
      analyticsFilterRegistry,
      getMessages("zh"),
    );
    expect(result).toContain(
      '依次发生过以下行为：名为 "signup" 的事件，随后名为 "purchase" 的事件',
    );
    expect(result).toContain("14 天");
    expect(result).not.toContain("访客");
  });
  it("preserves temporal range endpoints, list membership, and explicit negation", () => {
    const source =
      'NOT (time(last(PAGE)) between [@now-7d, @now] OR page.path in ["/a", "/b"])';
    const doc = parseFilterDsl(source, analyticsFilterRegistry);
    const result = describeFilterExpression(
      doc.root,
      analyticsFilterRegistry,
      getMessages("zh"),
    );
    expect(result).toContain("不满足以下条件");
    expect(result).toContain("至少满足以下一项");
    expect(result).toContain("7 天前");
    expect(result).toContain("当前时间");
    expect(result).toContain('"/a"');
    expect(result).toContain('"/b"');
  });
});
