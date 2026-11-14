import { spawnSync } from "node:child_process";

// Disable rename detection so moving an existing document to a new, disallowed
// path cannot evade the same rule that applies to newly created documents.
const result = spawnSync(
  "git",
  [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=A",
    "--no-renames",
    "--no-relative",
    "-z",
  ],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
);

if (result.error || result.status !== 0) {
  console.error("Unable to inspect staged files; refusing the commit.");
  process.exit(1);
}

const blocked = result.stdout.split("\0").filter((file) => {
  const markdown = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdx)$/i.test(file);
  return (
    markdown && !file.startsWith("changelog/") && !file.startsWith(".github/")
  );
});

if (blocked.length > 0) {
  console.error(
    "New Markdown documents are only allowed in changelog/ and .github/.",
  );
  for (const file of blocked) console.error("  " + JSON.stringify(file));
  console.error("Update an existing document or use an allowed directory.");
  process.exitCode = 1;
}
