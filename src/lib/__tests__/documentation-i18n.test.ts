import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const readmeLocales = ["en", "zh", "ja", "zh-tw"] as const;
const changelogLocales = ["zh", "zh-tw", "ja"] as const;

describe("documentation localization coverage", () => {
  it("provides README switcher links for every supported locale", () => {
    for (const locale of readmeLocales) {
      const path = join(
        repositoryRoot,
        ".github",
        "readme",
        "README." + locale + ".md",
      );
      expect(existsSync(path), "Missing README for locale " + locale).toBe(
        true,
      );

      const content = readFileSync(path, "utf8");
      expect(content).toContain("<!-- auto-readme-i18n-switcher start -->");
      for (const otherLocale of readmeLocales) {
        if (otherLocale === locale) continue;
        expect(content).toContain("README." + otherLocale + ".md");
      }
    }
  });

  it("provides localized changelogs for every indexed release", () => {
    const indexPath = join(
      repositoryRoot,
      ".github",
      "releases",
      "version.json",
    );
    const releases = JSON.parse(readFileSync(indexPath, "utf8")) as Array<{
      tagName: string;
    }>;

    expect(releases.length).toBeGreaterThan(0);
    for (const locale of changelogLocales) {
      for (const release of releases) {
        const path = join(
          repositoryRoot,
          ".github",
          "releases",
          "i18n",
          locale,
          release.tagName + ".md",
        );
        expect(
          existsSync(path),
          "Missing " + locale + " changelog for " + release.tagName,
        ).toBe(true);
        expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(0);
      }
    }
  });
});
