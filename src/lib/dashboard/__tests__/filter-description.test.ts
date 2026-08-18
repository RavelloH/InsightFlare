import { describe, expect, it } from "vitest";

import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import {
  analyticsFilterRegistry,
  type CanonicalJsonPath,
  type FilterFieldId,
} from "@/lib/filter-contract";

const fieldId = (value: string) => value as FilterFieldId;
const jsonPath = (value: string) => value as CanonicalJsonPath;

const messages = {
  conditionDescription: {
    and: "and",
    or: "or",
    not: "not ({description})",
    emptyFilter: "No filter conditions",
    filterEquals: "{field} equals {value}",
    filterNotEquals: "{field} does not equal {value}",
    filterAnyOf: "{field} is one of {values}",
    filterNoneOf: "{field} is none of {values}",
    filterBetween: "{field} is between {from} and {to}",
    filterStartsWith: "{field} starts with {value}",
    filterEndsWith: "{field} ends with {value}",
  },
  filterBuilder: {
    fieldLabels: {
      "page.path": "Page path",
      "referrer.domain": "Referrer domain",
      "client.deviceType": "Device type",
      "event.payload": "Event payload",
    },
    operatorLabels: {
      eq: "equals",
      in: "is one of",
      between: "is between",
      exists: "exists",
    },
  },
} as never;

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
      'Page path equals "/pricing" and not (Referrer domain equals "google.com" or Device type is one of "Mobile" or "Tablet") and Event payload (/score) is between 120 and 130',
    );
  });

  it("uses the localized empty description", () => {
    expect(
      describeFilterExpression(null, analyticsFilterRegistry, messages),
    ).toBe("No filter conditions");
  });

  it("uses localized word order for value collections", () => {
    const chineseMessages = {
      conditionDescription: {
        and: "且",
        or: "或",
        not: "不满足（{description}）",
        emptyFilter: "尚未设置筛选条件",
        filterEquals: "{field} 为 {value}",
        filterNotEquals: "{field} 不为 {value}",
        filterAnyOf: "{field} 属于 {values} 中的任一值",
        filterNoneOf: "{field} 不属于 {values} 中的任何值",
        filterBetween: "{field} 介于 {from} 与 {to} 之间",
        filterStartsWith: "{field} 以 {value} 开头",
        filterEndsWith: "{field} 以 {value} 结尾",
      },
      filterBuilder: {
        fieldLabels: {
          "page.path": "页面路径",
          "referrer.domain": "来源域名",
        },
        operatorLabels: {},
      },
    } as never;

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
      '页面路径 以 "/docs" 开头 且 来源域名 属于 "google.com" 或 "news.example.com" 中的任一值',
    );
  });
});
