import { resolveEdgeRuntime } from "@/lib/edge/runtime";
import apiApp from "@/lib/hono/app";

async function routeApiV1Request(request: Request): Promise<Response> {
  const {
    request: requestWithCf,
    env,
    ctx,
  } = await resolveEdgeRuntime(request);
  return apiApp.fetch(requestWithCf, env, ctx);
}

export async function GET(request: Request): Promise<Response> {
  return routeApiV1Request(request);
}

export async function POST(request: Request): Promise<Response> {
  return routeApiV1Request(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return routeApiV1Request(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return routeApiV1Request(request);
}
