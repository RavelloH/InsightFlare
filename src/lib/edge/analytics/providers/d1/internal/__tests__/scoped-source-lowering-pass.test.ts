import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { buildEventRecordPagePlan } from "@/lib/edge/analytics/engine/event-record-page-plan";
import type { SourceNode } from "@/lib/edge/analytics/engine/logical/nodes";
import {
  createSemanticScopedSourceSelection,
  type SemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { preparedMembershipFromIds } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import type {
  AnalyticsRelationalStorageContext,
  LoweredAnalyticsSource,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { ScopedSourceLoweringPass } from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/scoped-source-lowering-pass";
import {
  entityQualificationCacheKey,
  pageEventOwnerPairCacheKey,
} from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/selection-compatibility";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "legacy-scoped-storage-site";
const OTHER_SITE_ID = "legacy-scoped-storage-other-site";
const TIME = semanticTemporalDomainsFromQueryTime(
  createQueryTime(0, 100, "UTC", 100),
);

function ownerFilter(path = "/page", payloadPath = "/owner") {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "and",
        children: [
          {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "eq",
            value: path,
          },
          {
            kind: "condition",
            target: { kind: "event-payload", path: payloadPath },
            operator: "exists",
          },
        ],
      },
    } as never,
    analyticsFilterRegistry,
  );
}

function sessionFactFilter(): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "session.views" },
        operator: "gte",
        value: 1,
      },
    } as never,
    analyticsFilterRegistry,
  );
}

function selection(
  profile: "direct-page-analytics-v1" | "direct-page-session-compat-v1",
  filters = ownerFilter(),
  subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [SITE_ID as never],
  }),
  time = TIME,
) {
  return createSemanticScopedSourceSelection({
    profile,
    filters,
    subject,
    time,
  });
}

const plan = buildEventRecordPagePlan({
  siteId: "legacy-scoped-storage-site",
  queryTime: createQueryTime(0, 100, "UTC", 100),
  filters: EMPTY_FILTER_DOCUMENT,
  options: {
    limit: 10,
    sort: { key: "occurredAt", direction: "desc" },
  },
});
const eventSource = plan.nodes.find(
  (node): node is SourceNode => node.kind === "source",
)!;
const storage = new ScopedSourceLoweringPass(
  {} as AnalyticsRelationalStorageContext,
);
const source = {
  relation: {} as LoweredAnalyticsSource["relation"],
  values: new Map(),
  providerBindings: [],
} satisfies LoweredAnalyticsSource;

describe("scoped Event storage lowering guards", () => {
  it("leaves sources without a selection untouched", () => {
    const node = { ...eventSource, selection: undefined };
    expect(storage.lowerEventReportSource(node, "source", source)).toBe(source);
  });

  it("rejects unsupported entities", () => {
    expect(() =>
      storage.lowerEventReportSource(
        { ...eventSource, entity: "page" } as unknown as SourceNode,
        "source",
        source,
      ),
    ).toThrow(
      "source.selection: Scoped selection is currently supported only on Event report Sources.",
    );
  });

  it("rejects selected Sources outside the candidate temporal domain", () => {
    expect(() =>
      storage.lowerEventReportSource(
        { ...eventSource, temporalDomain: "read" },
        "source",
        source,
      ),
    ).toThrow(
      "source.temporalDomain: Scoped Event report Sources currently require the candidate domain.",
    );
  });

  it("rejects Page reader-window selections on Event Sources", () => {
    const pageReaderSelection = {
      ...selection("direct-page-analytics-v1"),
      profile: "prepared-page-reader-window-v1",
      preparationTime: TIME,
    } as SemanticScopedSourceSelection;
    expect(() =>
      storage.lowerEventReportSource(
        { ...eventSource, selection: pageReaderSelection },
        "source",
        source,
      ),
    ).toThrow(
      "source.selection: Page reader-window selections are unsupported on Event report Sources.",
    );
  });

  it("keys only the proven Page owner-pair equivalence class", () => {
    const direct = selection("direct-page-analytics-v1");
    const compatibility = selection("direct-page-session-compat-v1");
    const key = pageEventOwnerPairCacheKey(direct);
    expect(key).not.toBeNull();
    expect(pageEventOwnerPairCacheKey(compatibility)).toBe(key);
    expect(
      pageEventOwnerPairCacheKey(
        selection("direct-page-analytics-v1", ownerFilter("/different")),
      ),
    ).not.toBe(key);
    expect(
      pageEventOwnerPairCacheKey(
        selection(
          "direct-page-analytics-v1",
          ownerFilter(),
          createSemanticSubjectDomain({
            origin: "site",
            siteIds: [OTHER_SITE_ID as never],
          }),
        ),
      ),
    ).not.toBe(key);
    expect(
      pageEventOwnerPairCacheKey(
        selection(
          "direct-page-analytics-v1",
          ownerFilter(),
          undefined,
          semanticTemporalDomainsFromQueryTime(
            createQueryTime(0, 100, "America/New_York", 100),
          ),
        ),
      ),
    ).not.toBe(key);
    expect(
      pageEventOwnerPairCacheKey(
        selection(
          "direct-page-analytics-v1",
          ownerFilter(),
          undefined,
          semanticTemporalDomainsFromQueryTime(
            createQueryTime(0, 100, "UTC", 101),
          ),
        ),
      ),
    ).not.toBe(key);
    expect(
      pageEventOwnerPairCacheKey(
        selection(
          "direct-page-analytics-v1",
          ownerFilter(),
          undefined,
          semanticTemporalDomainsFromQueryTime(
            createQueryTime(1, 101, "UTC", 101),
          ),
        ),
      ),
    ).not.toBe(key);

    expect(
      pageEventOwnerPairCacheKey({
        ...direct,
        authorizedSiteIds: [OTHER_SITE_ID],
      }),
    ).toBeNull();
    expect(
      pageEventOwnerPairCacheKey({
        ...direct,
        authorizedSiteIds: [SITE_ID, OTHER_SITE_ID],
      }),
    ).toBeNull();
    expect(
      pageEventOwnerPairCacheKey({
        ...direct,
        preparedMembership: preparedMembershipFromIds({
          visitIds: [{ siteId: SITE_ID, id: "prepared" }],
        }),
      }),
    ).toBeNull();
    expect(
      pageEventOwnerPairCacheKey({
        ...direct,
        profile: "prepared-scoped-reader-window-v1",
        preparationTime: TIME,
      }),
    ).toBeNull();
    expect(
      pageEventOwnerPairCacheKey({
        ...direct,
        eventNameGate: {
          value: "signup",
          semantics: "direct-subject-local-exact-name-v1",
        },
      }),
    ).toBeNull();
    expect(
      pageEventOwnerPairCacheKey(
        selection("direct-page-session-compat-v1", sessionFactFilter()),
      ),
    ).toBeNull();
    expect(
      pageEventOwnerPairCacheKey(
        selection(
          "direct-page-analytics-v1",
          ownerFilter(),
          createSemanticSubjectDomain({
            origin: "team",
            teamId: "legacy-scoped-storage-team" as never,
            siteIds: [SITE_ID as never, OTHER_SITE_ID as never],
          }),
        ),
      ),
    ).toBeNull();
  });

  it("keys shared entity qualification by the complete candidate selection", () => {
    const direct = selection(
      "direct-page-session-compat-v1",
      sessionFactFilter(),
    );
    const key = entityQualificationCacheKey(direct, "candidate");
    expect(key).not.toBeNull();
    expect(entityQualificationCacheKey(direct, "filter")).toBeNull();
    expect(entityQualificationCacheKey(direct, "read")).toBeNull();

    expect(
      entityQualificationCacheKey(
        selection("direct-page-session-compat-v1", sessionFactFilter(), {
          origin: "site",
          siteIds: [OTHER_SITE_ID as never],
        }),
        "candidate",
      ),
    ).not.toBe(key);
    expect(
      entityQualificationCacheKey(
        selection(
          "direct-page-session-compat-v1",
          sessionFactFilter(),
          undefined,
          semanticTemporalDomainsFromQueryTime(
            createQueryTime(1, 101, "UTC", 101),
          ),
        ),
        "candidate",
      ),
    ).not.toBe(key);
    expect(
      entityQualificationCacheKey(
        selection(
          "direct-page-session-compat-v1",
          normalizeFilterDocument(
            {
              version: 1,
              root: {
                kind: "condition",
                target: { kind: "field", field: "session.views" },
                operator: "gte",
                value: 2,
              },
            } as never,
            analyticsFilterRegistry,
          ),
        ),
        "candidate",
      ),
    ).not.toBe(key);
    expect(
      entityQualificationCacheKey(
        { ...direct, entityKind: "visitor" },
        "candidate",
      ),
    ).not.toBe(key);
    expect(
      entityQualificationCacheKey(
        { ...direct, authorizedSiteIds: [SITE_ID, OTHER_SITE_ID] },
        "candidate",
      ),
    ).not.toBe(key);
    expect(
      entityQualificationCacheKey(
        {
          ...direct,
          preparedMembership: preparedMembershipFromIds({
            entityIds: [{ siteId: SITE_ID, id: "one" }],
          }),
        },
        "candidate",
      ),
    ).not.toBe(key);
    expect(
      entityQualificationCacheKey(
        {
          ...direct,
          preparedMembership: preparedMembershipFromIds({
            entityIds: [
              { siteId: SITE_ID, id: "one" },
              { siteId: SITE_ID, id: "two" },
            ],
          }),
        },
        "candidate",
      ),
    ).not.toBe(
      entityQualificationCacheKey(
        {
          ...direct,
          preparedMembership: preparedMembershipFromIds({
            entityIds: [{ siteId: SITE_ID, id: "one" }],
          }),
        },
        "candidate",
      ),
    );
    expect(
      entityQualificationCacheKey(
        {
          ...direct,
          profile: "prepared-scoped-reader-window-v1",
          preparationTime: TIME,
        },
        "candidate",
      ),
    ).not.toBe(key);
    expect(
      entityQualificationCacheKey(
        {
          ...direct,
          eventNameGate: {
            value: "signup",
            semantics: "prepared-defined-raw-value-v1",
          },
        },
        "candidate",
      ),
    ).toBeNull();
    expect(
      entityQualificationCacheKey(
        {
          ...direct,
          postObservationFilter: {
            semantics: "legacy-projected-observation-v1",
            filter: EMPTY_FILTER_DOCUMENT,
          },
        },
        "candidate",
      ),
    ).toBeNull();
    expect(
      entityQualificationCacheKey(
        { ...direct, profile: "direct-page-entity-only-compat-v1" },
        "candidate",
      ),
    ).toBeNull();
  });
});
