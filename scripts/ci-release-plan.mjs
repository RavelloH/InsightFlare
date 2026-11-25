import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import process from "node:process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const base = process.env.BASE_SHA;
const validBase = base && !/^0+$/.test(base);
const changed = validBase
  ? git("diff", "--name-only", "-z", base, "HEAD").split("\0").filter(Boolean)
  : [];
const added = validBase
  ? git("diff", "--name-only", "--diff-filter=A", "-z", base, "HEAD")
      .split("\0")
      .filter(Boolean)
  : [];
const releases = added.filter((file) =>
  /^changelog\/v\d+\.\d+\.\d+\.md$/u.test(file),
);
if (releases.length > 1)
  throw new Error("Submit one formal release version per PR.");
const requested = process.env.RELEASE_VERSION?.trim();
const version = requested
  ? requested.startsWith("v")
    ? requested
    : "v" + requested
  : (releases[0]?.slice("changelog/".length, -3) ?? "");
if (version) {
  if (!/^v\d+\.\d+\.\d+$/u.test(version))
    throw new Error("Invalid release version");
  const changelog = "changelog/" + version + ".md";
  if (!existsSync(changelog)) throw new Error("Missing " + changelog);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if ("v" + pkg.version !== version)
    throw new Error(
      "Update package.json version and generated specs in the release PR.",
    );
  const index = JSON.parse(
    readFileSync(".github/releases/version.json", "utf8"),
  );
  if (
    !index.some(
      (entry) => entry.tagName === version && entry.changelogPath === changelog,
    )
  ) {
    throw new Error("Generate and commit the release index in the release PR.");
  }
}
const readme = changed.some((file) =>
  /^(?:README\.md$|\.github\/readme\/README\.|\.github\/workflows\/readme-switcher\.yml$)/u.test(
    file,
  ),
);
appendFileSync(
  process.env.GITHUB_OUTPUT,
  "version=" + version + "\nreadme=" + readme + "\n",
);
