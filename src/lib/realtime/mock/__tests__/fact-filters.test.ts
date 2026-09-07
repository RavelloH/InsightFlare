import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  type FilterCondition,
  type FilterExpression,
  parseFilterDsl,
} from "@/lib/filter-contract";
import { emptyDemoFactDataset } from "@/lib/realtime/mock/fact-dataset";
import {
  applyDemoFilters,
  buildCanonicalDemoFacts,
  canonicalFieldValue,
  demoConditionMatches,
  demoExpressionMatchesForEntity,
  demoExpressionMatchesOnVisit,
  demoExpressionMayMatchForEntity,
  demoExpressionMayMatchOnVisit,
  demoScalarEqual,
} from "@/lib/realtime/mock/fact-filters";
import type {
  DemoFactDataset,
  DemoQueryFilters,
  DemoVisitFact,
} from "@/lib/realtime/mock/types";
import { demoQueryStringForVisit } from "@/lib/realtime/mock/visit-helpers";

describe("mock/fact-filters", () => {
  it("builds canonical session and visitor aggregates", () => {
    const dataset = makeDataset([
      makeVisit({
        visitId: "pageview",
        sessionId: "s1",
        visitorId: "u1",
        pathname: "/start",
        durationMs: 10,
        eventType: "pageview",
      }),
      makeVisit({
        visitId: "event",
        sessionId: "s1",
        visitorId: "u1",
        pathname: "/finish",
        durationMs: 20,
        eventType: " Signup ",
      }),
      makeVisit({
        visitId: "second-session",
        sessionId: "s2",
        visitorId: "u1",
        durationMs: 5,
        eventType: "pageview",
      }),
    ]);

    const facts = buildCanonicalDemoFacts(dataset);
    expect(facts.sessions.get("s1")).toEqual({
      sessionId: "s1",
      visitorId: "u1",
      entryPath: "/start",
      exitPath: "/finish",
      durationMs: 30,
      views: 2,
      events: 1,
      bounce: false,
    });
    expect(facts.sessions.get("s2")).toMatchObject({
      durationMs: 5,
      views: 1,
      events: 0,
      bounce: true,
    });
    expect(facts.visitors.get("u1")).toEqual({
      visitorId: "u1",
      sessions: 2,
      views: 3,
      events: 1,
    });
  });

  it("resolves every canonical field source and unknown fields safely", () => {
    const visit = makeVisit({
      pathname: "/finish?tab=details#summary",
      title: "Finish",
      hostname: "app.example.com",
      referrerHost: "Google.com",
      referrerUrl: "https://google.com/search",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "spring",
      browser: "Chrome",
      browserVersion: "138",
      osVersion: "Windows 11",
      deviceType: "Desktop",
      language: "en-US",
      screenSize: "1920x1080",
      screenWidth: 1920,
      screenHeight: 1080,
      country: "US",
      region: "California",
      city: "San Francisco",
      continent: "North America",
      timezone: "America/Los_Angeles",
      organization: "Example ISP",
      isEU: false,
      eventType: "purchase",
      durationMs: 42,
      perfTtfbMs: 1,
      perfFcpMs: 2,
      perfLcpMs: 3,
      perfCls: 0.1,
      perfInpMs: 4,
      userId: "user-1",
      userName: "Ravello",
    });
    const dataset = makeDataset([visit]);
    const facts = buildCanonicalDemoFacts(dataset);
    const expected: Record<string, string | number | boolean> = {
      "page.path": visit.pathname,
      "page.title": visit.title,
      "page.hostname": visit.hostname,
      "page.query": demoQueryStringForVisit(visit),
      "page.hash": "",
      "session.entryPath": visit.pathname,
      "session.exitPath": visit.pathname,
      "referrer.domain": visit.referrerHost,
      "referrer.url": visit.referrerUrl,
      "utm.source": "google",
      "utm.medium": "cpc",
      "utm.campaign": "spring",
      "utm.term": "",
      "utm.content": "",
      "client.browser": visit.browser,
      "client.browserVersion": visit.browserVersion,
      "client.os": "",
      "client.osVersion": visit.osVersion,
      "client.deviceType": visit.deviceType,
      "client.language": visit.language,
      "client.screenSize": visit.screenSize,
      "client.screenWidth": visit.screenWidth!,
      "client.screenHeight": visit.screenHeight!,
      "geo.country": visit.country,
      "geo.region": visit.region,
      "geo.city": visit.city,
      "geo.continent": visit.continent,
      "geo.timeZone": visit.timezone,
      "geo.organization": visit.organization,
      "geo.isEU": false,
      "event.name": visit.eventType,
      "page.durationMs": visit.durationMs,
      "session.durationMs": visit.durationMs,
      "session.views": 1,
      "session.events": 1,
      "session.bounce": true,
      "visitor.sessions": 1,
      "visitor.views": 1,
      "visitor.events": 1,
      "performance.ttfbMs": 1,
      "performance.fcpMs": 2,
      "performance.lcpMs": 3,
      "performance.cls": 0.1,
      "performance.inpMs": 4,
      "user.id": "user-1",
      "user.name": "Ravello",
    };
    for (const [field, value] of Object.entries(expected)) {
      expect(canonicalFieldValue(visit, field, facts), field).toBe(value);
    }
    expect(canonicalFieldValue(visit, "traffic.channel", facts)).toBeTruthy();
    expect(canonicalFieldValue(visit, "missing.field", facts)).toBeUndefined();
    expect(
      canonicalFieldValue(
        { ...visit, eventType: "pageview" },
        "event.name",
        facts,
      ),
    ).toBeUndefined();
  });

  it("evaluates scalar equality and every canonical condition operator", () => {
    const visit = makeVisit({
      pathname: " /Docs/Guide ",
      country: " us ",
      durationMs: 20,
      eventType: "signup",
    });
    const dataset = makeDataset([visit]);
    const facts = buildCanonicalDemoFacts(dataset);
    const condition = (source: string) =>
      parseFilterDsl(source, analyticsFilterRegistry).root as FilterCondition;

    expect(demoScalarEqual("geo.country", " us ", "US")).toBe(true);
    expect(demoScalarEqual("page.path", " /Docs ", "/docs")).toBe(false);
    expect(demoScalarEqual("referrer.domain", "", "__direct__")).toBe(true);
    expect(demoScalarEqual("page.durationMs", 20, 20)).toBe(true);
    expect(demoScalarEqual("page.durationMs", undefined, 20)).toBe(false);
    expect(demoScalarEqual("page.durationMs", null, 20)).toBe(false);

    const cases: Array<[string, boolean]> = [
      ['page.path eq " /Docs/Guide "', true],
      ['page.path neq "/other"', true],
      ['page.path in ["/other", " /Docs/Guide "]', true],
      ['page.path notIn ["/other"]', true],
      ['page.path contains "guide"', true],
      ['page.path startsWith " /Docs"', true],
      ['page.path endsWith "Guide "', true],
      ["page.durationMs gt 10", true],
      ["page.durationMs gte 20", true],
      ["page.durationMs lt 30", true],
      ["page.durationMs lte 20", true],
      ["page.durationMs between [10, 30]", true],
      ["page.path exists", true],
      ["page.path notExists", false],
      ["utm.term isEmpty", true],
      ["page.path notEmpty", true],
    ];
    for (const [source, expected] of cases) {
      expect(
        demoConditionMatches(visit, condition(source), facts),
        source,
      ).toBe(expected);
    }
    expect(
      demoConditionMatches(
        { ...visit, eventType: "pageview" },
        condition("event.name notExists"),
        facts,
      ),
    ).toBe(true);
    expect(
      demoConditionMatches(
        visit,
        {
          ...condition('page.path eq "/Docs"'),
          operator: "between",
          value: ["low", "high"],
        },
        facts,
      ),
    ).toBe(false);
    expect(
      demoConditionMatches(
        visit,
        {
          ...condition('page.path eq "/Docs"'),
          operator: "contains",
          value: 1,
        },
        facts,
      ),
    ).toBe(false);
    expect(
      demoConditionMatches(
        visit,
        { ...condition("page.durationMs eq 20"), operator: "eq", value: "20" },
        facts,
      ),
    ).toBe(false);
    expect(
      demoConditionMatches(
        { ...visit, eventType: "pageview", userId: undefined },
        condition('event.name eq "signup"'),
        facts,
      ),
    ).toBe(false);
    expect(
      demoConditionMatches(
        visit,
        { ...condition('page.path eq "/Docs"'), operator: "gt", value: "x" },
        facts,
      ),
    ).toBe(false);
    expect(
      demoConditionMatches(
        visit,
        {
          ...condition("page.durationMs eq 20"),
          operator: "unsupported" as FilterCondition["operator"],
        },
        facts,
      ),
    ).toBe(false);
    expect(
      demoConditionMatches(
        visit,
        {
          kind: "condition",
          target: { kind: "event-payload", path: "/metadata/plan" as never },
          operator: "eq",
          value: "pro",
        },
        facts,
      ),
    ).toBe(true);
  });

  it("evaluates nested expressions and payload-aware candidate expressions", () => {
    const visit = makeVisit({ pathname: "/pricing", durationMs: 20 });
    const facts = buildCanonicalDemoFacts(makeDataset([visit]));
    const parse = (source: string) =>
      parseFilterDsl(source, analyticsFilterRegistry).root as FilterExpression;
    const payload = parse('event.payload("/metadata/plan") eq "pro"');
    const matching = parse('page.path eq "/pricing"');
    const missing = parse('page.path eq "/missing"');

    expect(demoExpressionMatchesOnVisit(visit, null, facts)).toBe(true);
    expect(
      demoExpressionMatchesOnVisit(
        visit,
        { kind: "not", child: missing },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMatchesOnVisit(
        visit,
        {
          kind: "and",
          children: [matching, { kind: "not", child: missing }],
        },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMatchesOnVisit(
        visit,
        { kind: "or", children: [missing, matching] },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMatchesForEntity(
        [visit],
        { kind: "or", children: [missing, matching] },
        facts,
      ),
    ).toBe(true);
    expect(demoExpressionMatchesForEntity([], null, facts)).toBe(true);
    expect(demoExpressionMatchesForEntity([], missing, facts)).toBe(false);

    expect(demoExpressionMayMatchOnVisit(visit, payload, facts)).toBe(true);
    expect(
      demoExpressionMayMatchOnVisit(
        visit,
        { kind: "not", child: payload },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMayMatchOnVisit(
        visit,
        {
          kind: "and",
          children: [missing, payload],
        },
        facts,
      ),
    ).toBe(false);
    expect(
      demoExpressionMayMatchOnVisit(
        visit,
        {
          kind: "or",
          children: [missing, payload],
        },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMayMatchOnVisit(
        visit,
        { kind: "and", children: [matching, payload] },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMayMatchOnVisit(
        visit,
        { kind: "or", children: [missing] },
        facts,
      ),
    ).toBe(false);
    expect(
      demoExpressionMayMatchOnVisit(
        visit,
        { kind: "not", child: matching },
        facts,
      ),
    ).toBe(false);
    expect(demoExpressionMayMatchForEntity([], payload, facts)).toBe(true);
    expect(
      demoExpressionMayMatchForEntity(
        [],
        { kind: "not", child: missing },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMayMatchForEntity(
        [visit],
        {
          kind: "and",
          children: [missing, payload],
        },
        facts,
      ),
    ).toBe(false);
    expect(
      demoExpressionMayMatchForEntity(
        [visit],
        { kind: "or", children: [matching, payload] },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMayMatchForEntity(
        [visit],
        { kind: "or", children: [missing] },
        facts,
      ),
    ).toBe(false);
    expect(
      demoExpressionMayMatchForEntity(
        [visit],
        { kind: "and", children: [matching, payload] },
        facts,
      ),
    ).toBe(true);
    expect(
      demoExpressionMayMatchForEntity(
        [visit],
        { kind: "not", child: matching },
        facts,
      ),
    ).toBe(false);
  });

  it("applies canonical filters with event, session, and visitor scope expansion", () => {
    const dataset = makeDataset([
      makeVisit({
        visitId: "s1-a",
        sessionId: "s1",
        visitorId: "u1",
        pathname: "/match",
      }),
      makeVisit({
        visitId: "s1-b",
        sessionId: "s1",
        visitorId: "u1",
        pathname: "/other",
      }),
      makeVisit({
        visitId: "s2",
        sessionId: "s2",
        visitorId: "u1",
        pathname: "/other",
      }),
      makeVisit({
        visitId: "s3",
        sessionId: "s3",
        visitorId: "u2",
        pathname: "/other",
      }),
    ]);
    const filterDocument = parseFilterDsl(
      'page.path eq "/match"',
      analyticsFilterRegistry,
    );

    expect(
      applyDemoFilters(dataset, { filterDocument, scope: "event" }).visits.map(
        (v) => v.visitId,
      ),
    ).toEqual(["s1-a"]);
    expect(
      applyDemoFilters(dataset, {
        filterDocument,
        scope: "session",
      }).visits.map((v) => v.visitId),
    ).toEqual(["s1-a", "s1-b"]);
    expect(
      applyDemoFilters(dataset, {
        filterDocument,
        scope: "visitor",
      }).visits.map((v) => v.visitId),
    ).toEqual(["s1-a", "s1-b", "s2"]);
    expect(
      applyDemoFilters(dataset, { filterDocument: { version: 1, root: null } })
        .visits,
    ).toHaveLength(4);
    expect(
      applyDemoFilters(dataset, {
        path: "/match",
        scope: "session",
      }).visits.map((v) => v.visitId),
    ).toEqual(["s1-a", "s1-b"]);
    expect(
      applyDemoFilters(dataset, {
        path: "/match",
        scope: "visitor",
      }).visits.map((v) => v.visitId),
    ).toEqual(["s1-a", "s1-b", "s2"]);
  });

  it("matches trimmed page, client, geo, and session dimensions", () => {
    const dataset = makeDataset([
      makeVisit({
        visitId: "match-1",
        sessionId: "s-match",
        visitorId: "u-match",
        pathname: " /pricing ",
        title: " Pricing ",
        hostname: " App.Example.Com ",
        browser: " Chrome ",
        osVersion: " Windows 11 ",
        deviceType: " Desktop ",
        language: " en-US ",
        screenSize: " 1920x1080 ",
        country: " us ",
        regionCode: " ca ",
        regionName: " California ",
        cityName: " San Francisco ",
        continent: " North America ",
        timezone: " America/Los_Angeles ",
        organization: " Cloudflare Inc. ",
      }),
      makeVisit({
        visitId: "miss-1",
        sessionId: "s-miss",
        visitorId: "u-miss",
        pathname: "/docs",
        title: "Docs",
        hostname: "docs.example.com",
        browser: "Safari",
        osVersion: "iOS 18",
        deviceType: "Mobile",
        language: "fr-FR",
        screenSize: "390x844",
        country: "FR",
        regionCode: "IDF",
        regionName: "Ile-de-France",
        cityName: "Paris",
        continent: "Europe",
        timezone: "Europe/Paris",
        organization: "Demo ISP",
      }),
    ]);
    dataset.sessions.set("s-match", {
      sessionId: "s-match",
      visitorId: "u-match",
      entryPath: " /pricing ",
      exitPath: " /checkout ",
      weight: 1,
    });
    dataset.sessions.set("s-miss", {
      sessionId: "s-miss",
      visitorId: "u-miss",
      entryPath: "/docs",
      exitPath: "/docs",
      weight: 1,
    });

    const filtered = applyDemoFilters(dataset, {
      country: "US",
      device: "Desktop",
      browser: "Chrome",
      path: "/pricing",
      title: "Pricing",
      hostname: "app.example.com",
      entry: "/pricing",
      exit: "/checkout",
      clientBrowser: "Chrome",
      clientOsVersion: "Windows 11",
      clientDeviceType: "Desktop",
      clientLanguage: "en-US",
      clientScreenSize: "1920x1080",
      geo: "US::CA::California::San Francisco",
      geoContinent: "North America",
      geoTimezone: "America/Los_Angeles",
      geoOrganization: "Cloudflare Inc.",
    });

    expect(filtered.visits.map((visit) => visit.visitId)).toEqual(["match-1"]);
    expect(filtered.sessions).toEqual(new Set(["s-match"]));
    expect(filtered.visitors).toEqual(new Set(["u-match"]));
    expect(filtered.visitsBySession.get("s-match")).toBe(1);
  });

  it.each([
    ["device", { device: "Mobile" }],
    ["path", { path: "/missing" }],
    ["title", { title: "Missing" }],
    ["hostname", { hostname: "other.example.com" }],
    ["clientBrowser", { clientBrowser: "Safari" }],
    ["clientOsVersion", { clientOsVersion: "macOS 15" }],
    ["clientDeviceType", { clientDeviceType: "Mobile" }],
    ["clientLanguage", { clientLanguage: "fr-FR" }],
    ["clientScreenSize", { clientScreenSize: "390x844" }],
    ["geoContinent", { geoContinent: "Europe" }],
    ["geoTimezone", { geoTimezone: "Europe/Paris" }],
    ["geoOrganization", { geoOrganization: "Other ISP" }],
    ["geo city", { geo: "US::CA::California::Los Angeles" }],
  ] satisfies Array<[string, DemoQueryFilters]>)(
    "excludes visits for a mismatched %s filter",
    (_label, filters) => {
      const dataset = makeDataset([
        makeVisit({
          visitId: "v1",
          sessionId: "s1",
          visitorId: "u1",
          pathname: "/pricing",
          title: "Pricing",
          hostname: "app.example.com",
          browser: "Chrome",
          osVersion: "Windows 11",
          deviceType: "Desktop",
          language: "en-US",
          screenSize: "1920x1080",
          country: "US",
          regionCode: "CA",
          regionName: "California",
          cityName: "San Francisco",
          continent: "North America",
          timezone: "America/Los_Angeles",
          organization: "Cloudflare Inc.",
        }),
      ]);

      expect(applyDemoFilters(dataset, filters).visits).toEqual([]);
    },
  );

  it("excludes visits when entry or exit filters point at missing sessions", () => {
    const dataset = emptyDemoFactDataset(0, 1);
    dataset.visits.push(
      makeVisit({ visitId: "v1", sessionId: "missing-session" }),
    );

    expect(applyDemoFilters(dataset, { entry: "/home" }).visits).toEqual([]);
    expect(applyDemoFilters(dataset, { exit: "/done" }).visits).toEqual([]);
  });

  it("filters source links by direct sentinel, host equality, URL fallback, and invalid URLs", () => {
    const dataset = makeDataset([
      makeVisit({
        visitId: "direct",
        referrerHost: "",
        referrerUrl: "",
      }),
      makeVisit({
        visitId: "url",
        referrerHost: "news.example.com",
        referrerUrl: "https://news.example.com/story",
      }),
      makeVisit({
        visitId: "host",
        referrerHost: "social.example.com",
        referrerUrl: "https://l.example.net/redirect",
      }),
      makeVisit({
        visitId: "other",
        referrerHost: "other.example.com",
        referrerUrl: "https://other.example.com/",
      }),
    ]);

    expect(
      applyDemoFilters(dataset, { sourceLink: "__direct__" }).visits.map(
        (visit) => visit.visitId,
      ),
    ).toEqual(["direct"]);
    expect(
      applyDemoFilters(dataset, {
        sourceLink: "https://news.example.com/story",
      }).visits.map((visit) => visit.visitId),
    ).toEqual(["url"]);
    expect(
      applyDemoFilters(dataset, {
        sourceLink: "social.example.com",
      }).visits.map((visit) => visit.visitId),
    ).toEqual(["host"]);
    expect(
      applyDemoFilters(dataset, {
        sourceLink: "https://social.example.com/somewhere",
      }).visits.map((visit) => visit.visitId),
    ).toEqual(["host"]);
    expect(
      applyDemoFilters(dataset, { sourceLink: "not a url" }).visits,
    ).toEqual([]);
  });

  it("filters generated query-string values exactly", () => {
    const matchingVisit = makeVisit({
      visitId: "q-match",
      pathname: "/pricing",
      title: "Pricing",
    });
    const dataset = makeDataset([
      matchingVisit,
      makeVisit({ visitId: "q-miss", pathname: "/", title: "Home" }),
    ]);

    let query = "";
    for (let index = 0; !query && index < 100; index += 1) {
      matchingVisit.visitId = `q-match-${index}`;
      query = demoQueryStringForVisit(matchingVisit);
    }
    expect(query).toBeTruthy();

    expect(
      applyDemoFilters(dataset, { query }).visits.map((visit) => visit.visitId),
    ).toEqual([matchingVisit.visitId]);
    expect(applyDemoFilters(dataset, { query: "?missing=1" }).visits).toEqual(
      [],
    );
  });
});

function makeDataset(visits: DemoVisitFact[]): DemoFactDataset {
  const dataset = emptyDemoFactDataset(0, 1);
  dataset.visits.push(...visits);
  for (const visit of visits) {
    dataset.sessions.set(visit.sessionId, {
      sessionId: visit.sessionId,
      visitorId: visit.visitorId,
      entryPath: visit.pathname,
      exitPath: visit.pathname,
      weight: 1,
    });
    dataset.visitors.set(visit.visitorId, {
      visitorId: visit.visitorId,
      weight: 1,
    });
  }
  return dataset;
}

function makeVisit(overrides: Partial<DemoVisitFact> = {}): DemoVisitFact {
  return {
    visitId: "v1",
    sessionId: "s1",
    visitorId: "u1",
    startedAt: 0,
    pathname: "/home",
    title: "Home",
    hostname: "example.com",
    referrerHost: "",
    referrerUrl: "",
    browser: "Chrome",
    browserVersion: "138",
    osVersion: "Windows 11",
    deviceType: "Desktop",
    language: "en-US",
    screenSize: "1920x1080",
    country: "US",
    regionCode: "",
    regionName: "",
    region: "",
    cityName: "",
    city: "",
    continent: "",
    timezone: "",
    organization: "",
    latitude: 0,
    longitude: 0,
    eventType: "pageview",
    durationMs: 0,
    ...overrides,
  };
}
