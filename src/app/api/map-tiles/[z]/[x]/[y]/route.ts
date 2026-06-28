import { handleMapTileRequest } from "@/lib/edge/map-tiles";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ z: string; x: string; y: string }>;
  },
): Promise<Response> {
  return handleMapTileRequest(request, await context.params);
}
