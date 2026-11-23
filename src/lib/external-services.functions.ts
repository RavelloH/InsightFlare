import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import {
  type ExternalServices,
  resolveExternalServices,
} from "@/lib/external-services";

/** Resolves the external service base URLs from the Worker environment. */
export const loadExternalServices = createServerFn({ method: "GET" }).handler(
  async (): Promise<ExternalServices> => {
    const runtime = await resolveEdgeRuntime(getRequest());
    return resolveExternalServices(runtime.env);
  },
);
