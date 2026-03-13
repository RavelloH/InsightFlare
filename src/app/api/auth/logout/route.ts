import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({
    ok: true,
    data: {
      next: "/login",
    },
  });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return response;
}
