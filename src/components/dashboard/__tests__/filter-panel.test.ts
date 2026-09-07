import { describe, expect, it } from "vitest";

import { allowedFields } from "@/components/dashboard/filter-editor-internals";
import {
  systemPresetGroupLabel,
  systemPresetMatchesScope,
  systemPresetScopeForApply,
} from "@/components/dashboard/filter-panel";
import { resolveSuggestionScope } from "@/lib/dashboard/filter-suggestion-scope";
import {
  SYSTEM_FILTER_PRESETS,
  systemFilterPresetFromOptionValue,
  systemFilterPresetOptionValue,
} from "@/lib/dashboard/system-filter-presets";
import { getMessages } from "@/lib/i18n/messages";

describe("resolveSuggestionScope", () => {
  it.each([
    ["auto", "event", "event"],
    ["auto", "session", "session"],
    ["auto", "visitor", "visitor"],
    ["event", "session", "event"],
    ["event", "visitor", "event"],
    ["session", "event", "session"],
    ["visitor", "event", "visitor"],
  ] as const)(
    "uses %s preference with page scope %s as %s",
    (scopePreference, pageResolvedScope, expected) => {
      expect(resolveSuggestionScope(scopePreference, pageResolvedScope)).toBe(
        expected,
      );
    },
  );

  it("leaves Auto unresolved when the page has no concrete scope", () => {
    expect(resolveSuggestionScope("auto")).toBeUndefined();
  });
});

describe("system preset scope behavior", () => {
  it("uses a fixed scope when applying a preset", () => {
    const preset = SYSTEM_FILTER_PRESETS.find(
      (item) => item.id === "deepSessions",
    )!;
    expect(systemPresetScopeForApply(preset, "auto")).toBe("session");
    expect(systemPresetScopeForApply(preset, "visitor")).toBe("session");
  });

  it("preserves the active scope for preserve presets", () => {
    const preset = SYSTEM_FILTER_PRESETS.find(
      (item) => item.id === "directTraffic",
    )!;
    expect(systemPresetScopeForApply(preset, "auto")).toBe("auto");
    expect(systemPresetScopeForApply(preset, "visitor")).toBe("visitor");
    expect(systemPresetMatchesScope(preset, "visitor")).toBe(true);
  });

  it("matches fixed presets only after the fixed scope is selected", () => {
    const preset = SYSTEM_FILTER_PRESETS.find(
      (item) => item.id === "returningVisitors",
    )!;
    expect(systemPresetMatchesScope(preset, "auto")).toBe(false);
    expect(systemPresetMatchesScope(preset, "session")).toBe(false);
    expect(systemPresetMatchesScope(preset, "visitor")).toBe(true);
  });

  it("keeps legacy preset option values readable", () => {
    expect(
      systemFilterPresetFromOptionValue(
        systemFilterPresetOptionValue("mobileOrganicDiscovery"),
      )?.id,
    ).toBe("mobileOrganicDiscovery");
  });
});

describe("registry-driven editor metadata", () => {
  it("keeps fields in the explicit product order", () => {
    expect(allowedFields("private-dashboard").map((field) => field.id)).toEqual(
      [
        "referrer.domain",
        "referrer.url",
        "traffic.channel",
        "utm.source",
        "utm.medium",
        "utm.campaign",
        "utm.term",
        "utm.content",
        "page.path",
        "page.title",
        "page.hostname",
        "page.durationMs",
        "page.query",
        "page.hash",
        "event.name",
        "event.payload",
        "session.entryPath",
        "session.exitPath",
        "session.durationMs",
        "session.views",
        "session.events",
        "session.bounce",
        "visitor.sessions",
        "visitor.views",
        "visitor.events",
        "client.deviceType",
        "client.browser",
        "client.browserVersion",
        "client.browserEngine",
        "client.os",
        "client.osVersion",
        "client.language",
        "client.screenSize",
        "client.screenWidth",
        "client.screenHeight",
        "geo.country",
        "geo.region",
        "geo.city",
        "geo.continent",
        "geo.timeZone",
        "geo.organization",
        "geo.isEU",
        "performance.lcpMs",
        "performance.inpMs",
        "performance.cls",
        "performance.ttfbMs",
        "performance.fcpMs",
        "user.id",
        "user.name",
      ],
    );
  });

  it("formats every system preset group with its localized prefix", () => {
    expect(systemPresetGroupLabel(getMessages("en"), "acquisition")).toBe(
      "System presets · Acquisition",
    );
    expect(systemPresetGroupLabel(getMessages("zh"), "performance")).toBe(
      "系统预设 · 性能",
    );
    expect(systemPresetGroupLabel(getMessages("ja"), "dataQuality")).toBe(
      "システムプリセット · データ品質",
    );
  });

  it("exposes number fields with registry group and no-suggestion metadata", () => {
    const field = allowedFields("public-share").find(
      (field) => field.id === "performance.cls",
    );
    expect(field?.group).toBe("performance");
    expect(field?.suggestionMode).toBe("none");
    expect(field?.unit).toBe("ratio");
    expect(field?.number).toEqual({ min: 0 });
  });
});
