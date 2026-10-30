// POST /api/auth/login  { username, password }  ->  sets the signed session cookie.
import { NextResponse, type NextRequest } from "next/server";
import {
  authMode,
  checkCredentials,
  createSessionToken,
  readAuthConfig,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Best-effort brute-force brake. State is per serverless instance, so it slows guessing rather than
// guaranteeing a limit; the fixed delay below applies everywhere.
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

function reply(body: object, status: number, extra?: HeadersInit) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

export async function POST(request: NextRequest) {
  const mode = authMode();
  if (mode === "open") return reply({ ok: true }, 200);
  const config = readAuthConfig();
  if (mode === "misconfigured" || !config) {
    return reply({ error: "not_configured", message: "Sign-in is not configured on this deployment." }, 503);
  }

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return reply({ error: "bad_request", message: "Expected JSON." }, 400);
  }
  let username = "";
  let password = "";
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      username = typeof record.username === "string" ? record.username.slice(0, 200) : "";
      password = typeof record.password === "string" ? record.password.slice(0, 500) : "";
    }
  } catch {
    return reply({ error: "bad_request", message: "Expected JSON." }, 400);
  }

  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const entry = failures.get(client);
  if (entry && entry.resetAt > now && entry.count >= MAX_FAILURES) {
    return reply(
      { error: "rate_limited", message: "Too many attempts. Try again in a few minutes." },
      429,
      { "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)) },
    );
  }

  if (!(await checkCredentials(config, username, password))) {
    const current = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + WINDOW_MS };
    current.count += 1;
    failures.set(client, current);
    if (failures.size > 1000) failures.clear(); // bound memory
    await new Promise((resolve) => setTimeout(resolve, 700));
    return reply({ error: "invalid_credentials", message: "Incorrect username or password." }, 401);
  }

  failures.delete(client);
  const response = reply({ ok: true }, 200);
  response.cookies.set(SESSION_COOKIE, await createSessionToken(config), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return response;
}
