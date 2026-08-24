import { describe, expect, it } from "vitest";

import { CheckProgress, formatDuration } from "./progress";

describe("formatDuration", () => {
  it("switches from milliseconds to seconds at one second", () => {
    expect(formatDuration(13)).toBe("13ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.00s");
    expect(formatDuration(1234)).toBe("1.23s");
  });
});

describe("CheckProgress", () => {
  it("renders a completed task tree in non-interactive environments", () => {
    const output: string[] = [];
    const progress = new CheckProgress(
      [
        {
          name: "Format",
          steps: [{ name: "Format" }, { name: "Verification" }],
        },
        { name: "Typecheck", steps: [{ name: "Typecheck" }] },
      ],
      {
        interactive: false,
        write: (text) => output.push(text),
      },
    );

    progress.startTask("Format");
    progress.startStep("Format", "Format");
    progress.completeStep("Format", "Format", 4);
    progress.startStep("Format", "Verification");
    progress.completeStep("Format", "Verification", 6);
    progress.completeTask("Format", 11);
    progress.startTask("Typecheck");
    progress.startStep("Typecheck", "Typecheck");
    progress.completeStep("Typecheck", "Typecheck", 13);
    progress.completeTask("Typecheck", 13);
    progress.finish();

    expect(output).toEqual([
      [
        "✓ Checks complete",
        "  ✓ Format (11ms)",
        "    ✓ Format (4ms)",
        "    ✓ Verification (6ms)",
        "  ✓ Typecheck (13ms)",
        "",
      ].join("\n"),
    ]);
  });

  it("marks failed steps and their task", () => {
    const output: string[] = [];
    const progress = new CheckProgress(
      [{ name: "Lint", steps: [{ name: "Lint fix" }, { name: "Lint" }] }],
      {
        interactive: false,
        write: (text) => output.push(text),
      },
    );

    progress.startTask("Lint");
    progress.startStep("Lint", "Lint fix");
    progress.failStep("Lint", "Lint fix", 7);
    progress.failTask("Lint", 9);
    progress.finish();

    expect(output.join("\n")).toContain("x Checks failed");
    expect(output.join("\n")).toContain("  x Lint (9ms)");
    expect(output.join("\n")).toContain("    x Lint fix (7ms)");
    expect(output.join("\n")).toContain("    - Lint");
  });
});
