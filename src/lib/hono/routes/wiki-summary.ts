import { Hono } from "hono";

import { handleWikiSummaryRequest } from "@/lib/edge/wiki-summary";
import type { AppEnv } from "@/lib/hono/types";

export const wikiSummaryRoutes = new Hono<AppEnv>();

wikiSummaryRoutes.get("/wiki-summary", (c) =>
  handleWikiSummaryRequest(c.req.raw, c.env),
);
