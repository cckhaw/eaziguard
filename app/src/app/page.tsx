"use client";

// Front page: sign-in until a session exists, then the dashboard (Overview, Alerts, Client zones).
// Interface follows Apple's Human Interface Guidelines; see globals.css and src/components.
import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppShell, type Tab } from "@/components/AppShell";
import { LoginSection } from "@/components/LoginSection";
import { StatusGlyph } from "@/components/ui";
import { AlertsView, OverviewView, ZonesView, alertSplit } from "@/components/Views";
import { formatAge } from "@/lib/format";
import { useMetrics } from "@/lib/useMetrics";
import type { ApiError } from "@/lib/types";

const GRAFANA_URL = process.env.NEXT_PUBLIC_GRAFANA_URL || undefined;
const TABS: Tab[] = ["overview", "alerts", "zones"];

function readTab(): Tab {
  const hash = typeof window === "undefined" ? "" : window.location.hash.slice(1);
  return (TABS as string[]).includes(hash) ? (hash as Tab) : "overview";
}

function ErrorGroup({ error, onRetry }: { error: ApiError | { error: "network"; message: string }; onRetry: () => void }) {
  const title =
    error.error === "not_configured" ? "Dashboard is not configured"
    : error.error === "backend_unreachable" ? "Monitoring backend unreachable"
    : "Dashboard unavailable";
  return (
    <div className="group empty rise" role="alert">
      <StatusGlyph kind="critical" size={44} />
      <h2 className="t-title3">{title}</h2>
      <p className="t-callout">{error.message}</p>
      <p className="t-subhead secondary" style={{ maxWidth: "34rem" }}>
        An unreachable backend is not a healthy campus. Check the monitoring server, its HTTPS address and the Vercel environment variables.
      </p>
      <button type="button" className="btn-text" onClick={onRetry}>
        <RotateCw size={18} aria-hidden="true" /> Try again
      </button>
    </div>
  );
}

function Dashboard({ canSignOut, onSignOut, onUnauthorized }: { canSignOut: boolean; onSignOut: () => void; onUnauthorized: () => void }) {
  const { state, refreshing, reload } = useMetrics(onUnauthorized);
  const [tab, setTab] = useState<Tab>("overview");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setTab(readTab());
    const onHash = () => {
      setTab(readTab());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Keep "updated 12 s ago" and alert ages live between fetches.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const data = state.kind === "ready" ? state.data : null;
  const stale = state.kind === "ready" && state.stale;
  const subtitle = data ? `Updated ${formatAge(data.generatedAt, now)} ago` : undefined;
  const { critical, other } = alertSplit(data?.alerts ?? []);

  return (
    <AppShell
      tab={tab}
      alertCount={data?.alerts.length ?? 0}
      refreshing={refreshing}
      onRefresh={() => void reload()}
      canSignOut={canSignOut}
      onSignOut={onSignOut}
      grafanaUrl={GRAFANA_URL}
      subtitle={subtitle}
    >
      {/* Announced to screen readers only when a refresh changes the picture, not every few seconds */}
      <p className="sr-only" role="status" aria-live="polite">
        {data ? `Status ${data.overall}. ${critical} critical and ${other} other alerts.` : ""}
      </p>

      {state.kind === "loading" && (
        <div className="group empty" role="status">
          <RotateCw size={28} className="spin secondary" aria-hidden="true" />
          <p className="t-callout secondary">Loading campus status</p>
        </div>
      )}

      {state.kind === "error" && <ErrorGroup error={state.error} onRetry={() => void reload()} />}

      {data?.demo && (
        <p className="banner banner-info t-subhead" role="note">
          <StatusGlyph kind="info" size={20} />
          <span>Demo mode: every value is sample data, not live network monitoring.</span>
        </p>
      )}
      {(stale || data?.degraded) && (
        <p className="banner banner-warning t-subhead" role="status">
          <StatusGlyph kind="warning" size={20} />
          <span>
            {stale
              ? "Live refresh is failing, so this is the last successful snapshot."
              : `Some monitoring queries failed (${data?.failedQueries}). Values shown as “—” may be incomplete.`}
          </span>
        </p>
      )}

      {data && tab === "overview" && <OverviewView data={data} onOpenAlerts={() => (window.location.hash = "alerts")} />}
      {data && tab === "alerts" && <AlertsView alerts={data.alerts} now={now} />}
      {data && tab === "zones" && <ZonesView zones={data.edgeProbes} />}
    </AppShell>
  );
}

type AuthState =
  | { kind: "checking" }
  | { kind: "signed-out"; notice?: string }
  | { kind: "unavailable"; message: string }
  | { kind: "signed-in"; canSignOut: boolean };

export default function HomePage() {
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });

  const check = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      const body = (await response.json()) as { mode: "configured" | "open" | "misconfigured"; authenticated: boolean };
      if (body.mode === "misconfigured") {
        setAuth({ kind: "unavailable", message: "Sign-in is not configured. Set DASHBOARD_USER and DASHBOARD_PASSWORD in the deployment's environment variables." });
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
      <main className="signin" role="status">
        <RotateCw size={28} className="spin secondary" aria-hidden="true" />
        <span className="sr-only">Loading</span>
      </main>
    );
  }
  if (auth.kind === "unavailable") {
    return (
      <main className="signin" id="content">
        <div className="signin-inner">
          <ErrorGroup error={{ error: "not_configured", message: auth.message }} onRetry={() => void check()} />
        </div>
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
