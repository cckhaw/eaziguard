// Stateless login sessions: a signed, expiring cookie. Uses only Web Crypto, so the same code
// runs in the Edge middleware and in Node route handlers.
//
// Credentials come from DASHBOARD_USER / DASHBOARD_PASSWORD, falling back to the older
// DASHBOARD_BASIC_AUTH_USER / DASHBOARD_BASIC_AUTH_PASSWORD names. Cookies are signed with
// SESSION_SECRET when set, otherwise with a key derived from the credentials (so changing the
// password signs everyone out).

export const SESSION_COOKIE = "eaziguard_session";
export const SESSION_SECONDS = 8 * 60 * 60;

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
}

/**
 * "configured": credentials are set, login is required.
 * "open": no credentials and not production (local development), no login.
 * "misconfigured": production without credentials. Fail closed rather than expose the dashboard.
 */
export type AuthMode = "configured" | "open" | "misconfigured";

export function readAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig | null {
  const username = (env.DASHBOARD_USER ?? env.DASHBOARD_BASIC_AUTH_USER ?? "").trim();
  const password = env.DASHBOARD_PASSWORD ?? env.DASHBOARD_BASIC_AUTH_PASSWORD ?? "";
  if (!username || !password) return null;
  const secret = env.SESSION_SECRET?.trim() || `eaziguard-session\u0000${username}\u0000${password}`;
  return { username, password, secret };
}

export function authMode(env: Record<string, string | undefined> = process.env): AuthMode {
  if (readAuthConfig(env)) return "configured";
  return env.NODE_ENV === "production" ? "misconfigured" : "open";
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function checkCredentials(config: AuthConfig, username: string, password: string): Promise<boolean> {
  // Evaluate both so the response time does not reveal which one was wrong.
  const userOk = safeEqual(username.trim(), config.username);
  const passOk = safeEqual(password, config.password);
  return userOk && passOk;
}

export async function createSessionToken(config: AuthConfig, now: number = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${await sign(config.secret, `v1.${expires}`)}`;
}

export async function verifySessionToken(
  config: AuthConfig,
  token: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expires = Number(token.slice(0, dot));
  if (!Number.isInteger(expires) || expires * 1000 <= now) return false;
  return safeEqual(token.slice(dot + 1), await sign(config.secret, `v1.${expires}`));
}
