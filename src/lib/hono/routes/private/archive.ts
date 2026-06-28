import { Hono } from "hono";

import {
  handlePrivateArchiveFile,
  handlePrivateArchiveManifest,
} from "@/lib/edge/archive-query";
import type { AppEnv } from "@/lib/hono/types";
import { requestUrl } from "@/lib/hono/utils/context";
import { nf as notFound } from "@/lib/response";

export const privateArchiveRoutes = new Hono<AppEnv>();

privateArchiveRoutes.all("/manifest", (c) =>
  handlePrivateArchiveManifest(c.req.raw, c.env, requestUrl(c)),
);
privateArchiveRoutes.all("/file", (c) =>
  handlePrivateArchiveFile(c.req.raw, c.env, requestUrl(c)),
);
privateArchiveRoutes.all("/*", () => notFound());
