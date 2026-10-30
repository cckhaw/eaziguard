// GET /api/auth/session: tells the front page whether to show the login form.
import { NextResponse, type NextRequest } from "next/server";
import { authMode, readAuthConfig, SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const mode = authMode();
  const config = readAuthConfig();
  const authenticated =
    mode === "open" || (config !== null && (await verifySessionToken(config, request.cookies.get(SESSION_COOKIE)?.value)));
  return NextResponse.json({ mode, authenticated }, { headers: { "Cache-Control": "no-store" } });
}
