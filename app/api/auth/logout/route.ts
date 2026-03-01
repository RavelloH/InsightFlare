import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";

export async function POST(request: Request): Promise<NextResponse> {
  const response = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return response;
}
