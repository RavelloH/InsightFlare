import { Hono } from "hono";

import {
  handleLegacyArchiveFile,
  handleLegacyArchiveManifest,
} from "@/lib/edge/legacy-archive";
import type { AppEnv } from "@/lib/hono/types";

export const legacyArchiveRoutes = new Hono<AppEnv>();

legacyArchiveRoutes.get("/manifest", (c) =>
  handleLegacyArchiveManifest(c.req.raw, c.env),
);
legacyArchiveRoutes.get("/file", (c) =>
  handleLegacyArchiveFile(c.req.raw, c.env),
);
legacyArchiveRoutes.on("HEAD", "/file", (c) =>
  handleLegacyArchiveFile(c.req.raw, c.env),
);
