// Protects the data endpoint. The page itself is public on purpose: it renders the login form
// when there is no valid session, and contains no network data.
import { NextResponse, type NextRequest } from "next/server";
import { authMode, readAuthConfig, SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const mode = authMode();
  if (mode === "open") return NextResponse.next();

  if (mode === "misconfigured") {
    return NextResponse.json(
      { error: "not_configured", message: "Set DASHBOARD_USER and DASHBOARD_PASSWORD to enable sign-in." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const config = readAuthConfig()!;
  if (await verifySessionToken(config, request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }
  return NextResponse.json(
    { error: "unauthorized", message: "Sign in to view the dashboard." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

export const config = {
  matcher: ["/api/metrics"],
};
