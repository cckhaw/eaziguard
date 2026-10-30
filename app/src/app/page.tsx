"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe,
  HelpCircle,
  KeyRound,
  LogIn,
  LogOut,
  Lock,
  Network,
  Radio,
  RefreshCw,
  Router,
  Server,
  ShieldAlert,
  Wifi,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatAge, formatMetric, metricTone } from "@/lib/format";
import type {
  ActiveAlert,
  ApiError,
  ComponentHealth,
  ComponentId,
  EdgeProbeZone,
  MetricsResponse,
  Status,
} from "@/lib/types";

const REFRESH_MS = 15_000;
const GRAFANA_URL = process.env.NEXT_PUBLIC_GRAFANA_URL;

const COMPONENT_ICONS: Record<ComponentId, LucideIcon> = {
  gateway: Router,
  dns: Globe,
  dhcp: Server,
  wifi: Wifi,
  switch: Network,
  aaa: KeyRound,
  portal: LogIn,
};

// Status is always conveyed by icon + label as well as colour (colour-blind safe).
const STATUS_STYLES: Record<Status, { label: string; icon: LucideIcon; badge: string; ring: string; dot: string }> = {
  ok: {
    label: "Healthy",
    icon: CheckCircle2,
    badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    ring: "border-emerald-200 dark:border-emerald-900",
    dot: "bg-emerald-500",
  },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    badge: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
    ring: "border-amber-300 dark:border-amber-800",
    dot: "bg-amber-500",
  },
  critical: {
    label: "Critical",
    icon: XCircle,
    badge: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    ring: "border-red-300 dark:border-red-800",
    dot: "bg-red-500",
  },
  unknown: {
    label: "No data",
    icon: HelpCircle,
    badge: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    ring: "border-slate-200 dark:border-slate-800",
    dot: "bg-slate-400",
  },
};

const TONE_CLASS = {
  ok: "text-slate-900 dark:text-slate-100",
  warning: "text-amber-700 dark:text-amber-400",
  critical: "text-red-700 dark:text-red-400",
  muted: "text-slate-400 dark:text-slate-500",
} as const;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: MetricsResponse; stale: boolean }
  | { kind: "error"; error: ApiError | { error: "network"; message: string } };

function useMetrics(onUnauthorized: () => void) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const lastGood = useRef<MetricsResponse | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch("/api/metrics", { cache: "no-store", signal: controller.signal });
      if (response.status === 401) {
        lastGood.current = null;
        unauthorized.current();
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && body && typeof body === "object" && "components" in body) {
        lastGood.current = body as MetricsResponse;
        setState({ kind: "ready", data: lastGood.current, stale: false });
      } else if (body && typeof body === "object" && "error" in body) {
        throw Object.assign(new Error("api"), { api: body as ApiError });
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const api = (error as { api?: ApiError }).api;
      if (lastGood.current) {
        setState({ kind: "ready", data: lastGood.current, stale: true });
      } else {
        setState({
          kind: "error",
          error: api ?? { error: "network", message: "Could not reach the dashboard API." },
        });
      }
    } finally {
      if (inFlight.current === controller) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    // Refresh immediately when a backgrounded wall display / phone wakes up.
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      inFlight.current?.abort();
    };
  }, [load]);

  return { state, refreshing, reload: load };
}

function StatusBadge({ status }: { status: Status }) {
  const style = STATUS_STYLES[status];
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.badge}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {style.label}
    </span>
  );
}

function ComponentCard({ component }: { component: ComponentHealth }) {
  const Icon = COMPONENT_ICONS[component.id];
  const style = STATUS_STYLES[component.status];
  return (
    <article
      className={`flex flex-col gap-3 rounded-xl border bg-white p-4 shadow-sm dark:bg-slate-900 ${style.ring}`}
      aria-label={`${component.name}: ${style.label}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-slate-100 p-2 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <h2 className="text-sm font-semibold leading-tight">{component.name}</h2>
        </div>
        <StatusBadge status={component.status} />
      </header>
      <p className="text-sm text-slate-600 dark:text-slate-400">{component.summary}</p>
      <dl className="mt-auto grid grid-cols-1 gap-1.5 border-t border-slate-100 pt-3 dark:border-slate-800">
        {component.metrics.map((metric) => (
          <div key={metric.label} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="text-slate-500 dark:text-slate-400">{metric.label}</dt>
            <dd className={`font-mono font-semibold tabular-nums ${TONE_CLASS[metricTone(metric)]}`}>
              {formatMetric(metric)}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function AlertRow({ alert, now }: { alert: ActiveAlert; now: number }) {
  const critical = alert.severity === "critical";
  const Icon = critical ? XCircle : alert.severity === "warning" ? AlertTriangle : Activity;
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon
        className={`mt-0.5 h-5 w-5 shrink-0 ${critical ? "text-red-600 dark:text-red-400" : alert.severity === "warning" ? "text-amber-600 dark:text-amber-400" : "text-slate-400"}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{alert.name}</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {alert.severity}
          </span>
          {alert.state === "pending" && (
            <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-sky-800 dark:bg-sky-950 dark:text-sky-300">
              pending
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
            <Clock className="h-3 w-3" aria-hidden />
            {formatAge(alert.activeAt, now)}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">{alert.summary}</p>
        {alert.description && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{alert.description}</p>
        )}
      </div>
    </li>
  );
}

function ms(value: number | null): string {
  return value === null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function EdgeProbeTable({ zones }: { zones: EdgeProbeZone[] }) {
  if (zones.length === 0) {
    return <p className="px-4 py-6 text-sm text-slate-500 dark:text-slate-400">No edge probes are reporting.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full whitespace-nowrap text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Zone</th>
            <th scope="col" className="px-3 py-2 font-medium">Probe</th>
            <th scope="col" className="px-3 py-2 font-medium">DHCP offer</th>
            <th scope="col" className="px-3 py-2 font-medium">DNS</th>
            <th scope="col" className="px-3 py-2 font-medium">Portal</th>
            <th scope="col" className="px-3 py-2 font-medium">RADIUS</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {zones.map((zone) => (
            <tr key={zone.zone}>
              <th scope="row" className="px-3 py-2 font-medium">{zone.zone}</th>
              <td className="px-3 py-2">
                {zone.up ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Up
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-semibold text-red-700 dark:text-red-400">
                    <XCircle className="h-3.5 w-3.5" aria-hidden /> Down
                  </span>
                )}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums">{ms(zone.dhcpOfferMs)}</td>
              <td className="px-3 py-2 font-mono tabular-nums">{ms(zone.dnsMs)}</td>
              <td className="px-3 py-2">
                {zone.portalUp === null ? "—" : zone.portalUp ? "OK" : <span className="font-semibold text-red-700 dark:text-red-400">Failing</span>}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums">{ms(zone.radiusMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorPanel({ error, onRetry }: { error: ApiError | { error: "network"; message: string }; onRetry: () => void }) {
  const title =
    error.error === "not_configured"
      ? "Dashboard is not configured"
      : error.error === "backend_unreachable"
        ? "Monitoring backend unreachable"
        : "Dashboard API unavailable";
  return (
    <div role="alert" className="mx-auto mt-16 max-w-xl rounded-xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900 dark:bg-slate-900">
      <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
        <ShieldAlert className="h-5 w-5" aria-hidden />
        <h2 className="font-semibold">{title}</h2>
      </div>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{error.message}</p>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        An unreachable backend is not a healthy campus: check the monitoring server, its TLS endpoint and the
        Vercel environment variables.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
      >
        <RefreshCw className="h-4 w-4" aria-hidden /> Retry
      </button>
    </div>
  );
}

function Dashboard({
  canSignOut,
  onSignOut,
  onUnauthorized,
}: {
  canSignOut: boolean;
  onSignOut: () => void;
  onUnauthorized: () => void;
}) {
  const { state, refreshing, reload } = useMetrics(onUnauthorized);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second-ish so "updated 12s ago" and alert ages stay live between fetches.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const data = state.kind === "ready" ? state.data : null;
  const overall: Status = data?.overall ?? "unknown";
  const overallStyle = STATUS_STYLES[overall];
  const critical = data?.alerts.filter((a) => a.severity === "critical" && a.state === "firing").length ?? 0;
  const warnings = data ? data.alerts.filter((a) => a.severity !== "critical" || a.state === "pending").length : 0;

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3" aria-hidden>
            {overall === "critical" && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${overallStyle.dot}`} />}
            <span className={`relative inline-flex h-3 w-3 rounded-full ${overallStyle.dot}`} />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">eaziguard</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">Campus network early-warning dashboard</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={overall} />
          {data && (
            <span className="text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
              Updated {formatAge(data.generatedAt, now)} ago
            </span>
          )}
          {GRAFANA_URL && (
            <a
              href={GRAFANA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Grafana <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
          <button
            type="button"
            onClick={() => void reload()}
            disabled={refreshing}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden /> Refresh
          </button>
          {canSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
            </button>
          )}
        </div>
      </header>

      {data?.demo && (
        <div role="note" className="mt-4 flex items-start gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
          <Activity className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Demo mode: all values below are sample data, not live network monitoring.</span>
        </div>
      )}

      {state.kind === "loading" && (
        <div className="mt-16 flex items-center justify-center gap-2 text-slate-500" role="status">
          <RefreshCw className="h-5 w-5 animate-spin" aria-hidden /> Loading campus status…
        </div>
      )}

      {state.kind === "error" && <ErrorPanel error={state.error} onRetry={() => void reload()} />}

      {data && (
        <>
          {(state.kind === "ready" && state.stale) || data.degraded ? (
            <div role="status" className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                {state.kind === "ready" && state.stale
                  ? "Live refresh is failing; showing the last successful snapshot."
                  : `Some monitoring queries failed (${data.failedQueries}); values marked “—” may be incomplete.`}
              </span>
            </div>
          ) : null}

          <section aria-label="Summary" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Overall", value: overallStyle.label },
              { label: "Critical alerts", value: String(critical) },
              { label: "Warnings / pending", value: String(warnings) },
              { label: "Edge probes up", value: `${data.edgeProbes.filter((z) => z.up).length} / ${data.edgeProbes.length}` },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{item.label}</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{item.value}</p>
              </div>
            ))}
          </section>

          <section aria-label="System status" className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {data.components.map((component) => (
              <ComponentCard key={component.id} component={component} />
            ))}
          </section>

          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <section aria-label="Active alerts" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <h2 className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">
                <AlertTriangle className="h-4 w-4" aria-hidden /> Active warnings
                <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">{data.alerts.length}</span>
              </h2>
              {data.alerts.length === 0 ? (
                <p className="flex items-center gap-2 px-4 py-6 text-sm text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> No active alerts.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.alerts.map((alert, index) => (
                    <AlertRow key={`${alert.name}-${index}-${alert.activeAt}-${alert.labels.instance ?? ""}`} alert={alert} now={now} />
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Edge probes" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <h2 className="flex items-center gap-2 border-b border-slate-100 px-4 py-3 text-sm font-semibold dark:border-slate-800">
                <Radio className="h-4 w-4" aria-hidden /> Client-zone probes
              </h2>
              <EdgeProbeTable zones={data.edgeProbes} />
            </section>
          </div>
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Front page: sign-in section until a session exists, then the dashboard.
// ---------------------------------------------------------------------------
type AuthState =
  | { kind: "checking" }
  | { kind: "signed-out"; notice?: string }
  | { kind: "unavailable"; message: string }
  | { kind: "signed-in"; canSignOut: boolean };

function LoginSection({ notice, onSignedIn }: { notice?: string; onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        setPassword("");
        onSignedIn();
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setError(body?.message ?? `Sign-in failed (HTTP ${response.status}).`);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const field =
    "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40 dark:border-slate-700 dark:bg-slate-950";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <section aria-labelledby="login-title" className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <span className="rounded-lg bg-slate-100 p-2 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <Lock className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h1 id="login-title" className="text-xl font-bold tracking-tight">eaziguard</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">Campus network early-warning dashboard</p>
          </div>
        </div>

        {notice && (
          <p role="status" className="mt-4 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-200">
            {notice}
          </p>
        )}

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="username" className="text-sm font-medium">Username</label>
            <input id="username" name="username" type="text" autoComplete="username" required autoFocus
              value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
          </div>
          <div>
            <label htmlFor="password" className="text-sm font-medium">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
          </div>
          {error && (
            <p role="alert" className="flex items-start gap-2 text-sm text-red-700 dark:text-red-400">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
          >
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
            Sign in
          </button>
        </form>
      </section>
    </main>
  );
}

export default function HomePage() {
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });

  const check = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      const body = (await response.json()) as { mode: "configured" | "open" | "misconfigured"; authenticated: boolean };
      if (body.mode === "misconfigured") {
        setAuth({
          kind: "unavailable",
          message: "Sign-in is not configured. Set DASHBOARD_USER and DASHBOARD_PASSWORD in the deployment's environment variables.",
        });
      } else if (body.authenticated) {
        setAuth({ kind: "signed-in", canSignOut: body.mode === "configured" });
      } else {
        setAuth({ kind: "signed-out" });
      }
    } catch {
      setAuth({ kind: "unavailable", message: "Could not reach the server." });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setAuth({ kind: "signed-out" });
  }

  if (auth.kind === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-500" role="status">
        <RefreshCw className="mr-2 h-5 w-5 animate-spin" aria-hidden /> Loading…
      </main>
    );
  }
  if (auth.kind === "unavailable") {
    return (
      <main className="mx-auto max-w-xl px-4">
        <ErrorPanel error={{ error: "not_configured", message: auth.message }} onRetry={() => void check()} />
      </main>
    );
  }
  if (auth.kind === "signed-out") {
    return <LoginSection notice={auth.notice} onSignedIn={() => void check()} />;
  }
  return (
    <Dashboard
      canSignOut={auth.canSignOut}
      onSignOut={() => void signOut()}
      onUnauthorized={() => setAuth({ kind: "signed-out", notice: "Your session has expired. Please sign in again." })}
    />
  );
}
