import { renderToString } from "react-dom/server";
import {
  FlagAssetProvider,
  FlagIcon,
} from "@insightflare/product-ui/flag-icon";
import { expect, it } from "vitest";

import { createFlagAssetResolver } from "@/lib/flag-assets";

it("renders a same-origin image during SSR without loading a client module", () => {
  const resolve = createFlagAssetResolver({
    base: "/images/flags",
    names: ["us"],
  });
  const html = renderToString(
    <FlagAssetProvider resolve={resolve}>
      <FlagIcon icon="flagpack:us" className="block" />
    </FlagAssetProvider>,
  );
  expect(html).toContain('src="/images/flags/us.svg"');
  expect(html).toContain('width="16"');
  expect(html).toContain('height="12"');
  expect(html).not.toContain("api.iconify");
  const missing = renderToString(
    <FlagAssetProvider resolve={resolve}>
      <FlagIcon icon="flagpack:unknown" />
    </FlagAssetProvider>,
  );
  expect(missing).not.toContain("<img");
  expect(missing).toContain('aria-hidden="true"');
});
