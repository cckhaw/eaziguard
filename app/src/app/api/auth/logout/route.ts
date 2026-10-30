// POST /api/auth/logout: clears the session cookie.
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
