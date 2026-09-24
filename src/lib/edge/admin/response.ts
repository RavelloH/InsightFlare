export { bad, forb, j, jsonResponseFor, na, nf, una } from "@/lib/response";

import type { JsonRecord } from "@/lib/response";

export type { JsonRecord };

export const toRole = (v: unknown): "admin" | "user" =>
  String(v || "user").toLowerCase() === "admin" ? "admin" : "user";

export const bool = (v: unknown, fb = false) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string")
    return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  return fb;
};

export const parseJson = async (r: Request): Promise<JsonRecord> => {
  try {
    const p = (await r.json()) as unknown;
    if (p && typeof p === "object") return p as JsonRecord;
  } catch {}
  return {};
};
