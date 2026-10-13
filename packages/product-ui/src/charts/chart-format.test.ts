import { describe, expect, it } from "vitest";

import { durationFormat } from "./chart-format";

describe("chart durationFormat", () => {
  it("uses the locale's Chinese hour unit", () => {
    expect(durationFormat("zh", 3_600_000)).toBe("1小时");
    expect(durationFormat("zh-tw", 3_600_000)).toBe("1小時");
    expect(durationFormat("ja", 3_600_000)).toBe("1時間");
  });
});
