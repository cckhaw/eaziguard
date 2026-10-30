// Minimal, server-side-only Prometheus HTTP API client.
//
// Used by /api/metrics. The bearer token never leaves the server: browsers talk
// to the Next.js route, and only the route talks to Prometheus (through the
// Caddy gateway described in docker/caddy/Caddyfile).

import { demoAlerts, demoQuery } from "./demo.ts";

export class BackendConfigError extends Error {}
export class BackendRequestError extends Error {}

export interface BackendConfig {
  baseUrl: string;
  token: string;
  /** DEMO_MODE: serve built-in sample data instead of contacting Prometheus. */
  demo?: boolean;
}

export interface VectorSample {
  labels: Record<string, string>;
  value: number;
}

const REQUEST_TIMEOUT_MS = 8_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Validates PROMETHEUS_URL / PROMETHEUS_BEARER_TOKEN; throws BackendConfigError with an operator-facing message. */
export function readBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  if (env.DEMO_MODE === "true") {
    return { baseUrl: "demo", token: "", demo: true };
  }

  const rawUrl = env.PROMETHEUS_URL?.trim();
  if (!rawUrl) {
    throw new BackendConfigError("PROMETHEUS_URL is not set");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BackendConfigError("PROMETHEUS_URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BackendConfigError("PROMETHEUS_URL must start with https:// (or http:// for local development)");
  }
  if (url.username || url.password) {
    throw new BackendConfigError("PROMETHEUS_URL must not embed credentials; use PROMETHEUS_BEARER_TOKEN");
  }

  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !isLocal && env.ALLOW_INSECURE_PROMETHEUS !== "true") {
    throw new BackendConfigError(
      "PROMETHEUS_URL must use https:// so the bearer token is not sent in clear text " +
        "(set ALLOW_INSECURE_PROMETHEUS=true only for a private test network)",
    );
  }

  const token = env.PROMETHEUS_BEARER_TOKEN?.trim() ?? "";
  if (!token && !isLocal) {
    throw new BackendConfigError("PROMETHEUS_BEARER_TOKEN is not set");
  }

  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, ""), token };
}

async function call(config: BackendConfig, path: string, body?: URLSearchParams): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body?.toString(),
      cache: "no-store",
      redirect: "error", // never forward the bearer token to a redirect target
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Deliberately generic: the underlying error can contain the backend URL.
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new BackendRequestError(timedOut ? "backend timed out" : "backend unreachable");
  }

  if (response.status === 401 || response.status === 403) {
    throw new BackendRequestError("backend rejected the bearer token");
  }
  if (!response.ok) {
    throw new BackendRequestError(`backend returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BackendRequestError("backend returned invalid JSON");
  }
  if (!isRecord(payload) || payload.status !== "success") {
    throw new BackendRequestError("backend reported an error");
  }
  return payload.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runs an instant query and returns every sample of the resulting vector. */
export async function queryVector(config: BackendConfig, query: string): Promise<VectorSample[]> {
  if (config.demo) return demoQuery(query);
  const data = await call(config, "/api/v1/query", new URLSearchParams({ query }));
  if (!isRecord(data) || data.resultType !== "vector" || !Array.isArray(data.result)) {
    throw new BackendRequestError("unexpected query result shape");
  }
  const samples: VectorSample[] = [];
  for (const item of data.result) {
    if (!isRecord(item) || !isRecord(item.metric) || !Array.isArray(item.value)) continue;
    const value = Number(item.value[1]);
    if (!Number.isFinite(value)) continue; // NaN / +Inf from 0/0 divisions
    const labels: Record<string, string> = {};
    for (const [key, label] of Object.entries(item.metric)) {
      if (typeof label === "string") labels[key] = label;
    }
    samples.push({ labels, value });
  }
  return samples;
}

export interface RawAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: string;
  activeAt: string;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") out[key] = item;
    }
  }
  return out;
}

/** GET /api/v1/alerts: every pending or firing alert. */
export async function fetchAlerts(config: BackendConfig): Promise<RawAlert[]> {
  if (config.demo) return demoAlerts();
  const data = await call(config, "/api/v1/alerts");
  if (!isRecord(data) || !Array.isArray(data.alerts)) {
    throw new BackendRequestError("unexpected alerts result shape");
  }
  const alerts: RawAlert[] = [];
  for (const item of data.alerts) {
    if (!isRecord(item) || typeof item.state !== "string") continue;
    alerts.push({
      labels: stringMap(item.labels),
      annotations: stringMap(item.annotations),
      state: item.state,
      activeAt: typeof item.activeAt === "string" ? item.activeAt : new Date().toISOString(),
    });
  }
  return alerts;
}
