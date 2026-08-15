import { Hono } from "hono";

import { apiNoCacheMiddleware } from "./middleware/api-cache";
import { handleHonoError } from "./middleware/error-boundary";
import { observabilityMiddleware } from "./middleware/observability";
import { requestIdMiddleware } from "./middleware/request-id";
import { collectRoutes } from "./routes/collect";
import { e2eRoutes } from "./routes/e2e";
import { healthRoutes } from "./routes/health";
import { privateRoutes } from "./routes/private";
import { publicRoutes } from "./routes/public";
import { scriptRoutes } from "./routes/tracker-script";
import { v1Routes } from "./routes/v1";
import { wellKnownRoutes } from "./routes/well-known";
import type { AppEnv } from "./types";

export const apiApp = new Hono<AppEnv>();

apiApp.onError(handleHonoError);
apiApp.use("*", requestIdMiddleware());
apiApp.use("*", observabilityMiddleware());
apiApp.use("*", apiNoCacheMiddleware());

apiApp.route("/", healthRoutes);
apiApp.route("/", wellKnownRoutes);
apiApp.route("/", collectRoutes);
apiApp.route("/", scriptRoutes);
apiApp.route("/__e2e__", e2eRoutes);
apiApp.get("/api", (c) => c.redirect("/api/v1", 307));
apiApp.route("/api/private", privateRoutes);
apiApp.route("/api/public", publicRoutes);
apiApp.route("/api/v1", v1Routes);

export default apiApp;
