import { describe, expect, it, vi } from "vitest";

import { SUPPORTED_LOCALES } from "@/lib/i18n/config";
import errorPages from "@/lib/i18n/generated/error-pages";
import notificationEmail from "@/lib/i18n/generated/notification-email";
import { getMessages } from "@/lib/i18n/messages";

describe("route language dictionaries", () => {
  it("loads only the requested locale and coalesces concurrent imports", async () => {
    vi.resetModules();
    const { getRuntimeMessages, loadRuntimeMessages, preloadPathMessages } =
      await import("@/lib/i18n/runtime-messages");
    expect(() => getRuntimeMessages("ja")).toThrow(
      "Route language has not been loaded",
    );
    const first = loadRuntimeMessages("zh");
    expect(loadRuntimeMessages("zh")).toBe(first);
    expect(await first).toEqual(getMessages("zh"));
    expect(await loadRuntimeMessages("zh")).toBe(getRuntimeMessages("zh"));
    expect(() => getRuntimeMessages("ja")).toThrow();
    await preloadPathMessages("/ja/app");
    expect(getRuntimeMessages("ja")).toEqual(getMessages("ja"));
    await preloadPathMessages("/zh-tw/app");
    expect(getRuntimeMessages("zh-tw")).toEqual(getMessages("zh-tw"));
    await preloadPathMessages("/invalid");
    expect(getRuntimeMessages("en")).toEqual(getMessages("en"));
  });

  it("keeps the independently generated error and mail copy identical", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(errorPages[locale]).toEqual(getMessages(locale).errorPage);
      expect(notificationEmail[locale]).toEqual(
        getMessages(locale).notificationEmail,
      );
    }
  });
});
