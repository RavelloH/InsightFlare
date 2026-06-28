import { Hono } from "hono";

import {
  handleCollectOptionsRequest,
  handleCollectRequest,
} from "@/lib/edge/collect";
import type { AppEnv } from "@/lib/hono/types";

export const collectRoutes = new Hono<AppEnv>();

collectRoutes.options("/collect", (c) =>
  handleCollectOptionsRequest(c.req.raw),
);

collectRoutes.post("/collect", (c) =>
  handleCollectRequest(
    c.req.raw,
    c.env,
    c.executionCtx as unknown as ExecutionContext,
    new URL(c.req.raw.url),
  ),
);
