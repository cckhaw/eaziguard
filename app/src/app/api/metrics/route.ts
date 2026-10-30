// GET /api/metrics
//
// Server-side proxy between the dashboard and the campus Prometheus instance.
// Reads PROMETHEUS_URL and PROMETHEUS_BEARER_TOKEN from the environment, runs a
// fixed set of PromQL queries (the browser can never send its own), and returns a
// compact JSON snapshot. The query set matches the metric names defined in
// docker/prometheus/{prometheus,alerts,blackbox}.yml and edge-probe/probe.py.

import { NextResponse } from "next/server";
import {
  BackendConfigError,
  fetchAlerts,
  queryVector,
  readBackendConfig,
  type BackendConfig,
} from "@/lib/prometheus";
import {
  alertSortKey,
  COMPONENT_LABELS,
  deriveComponentStatus,
  overallStatus,
  parseSeverity,
} from "@/lib/status";
import type {
  ActiveAlert,
  ApiError,
  ComponentHealth,
  ComponentId,
  EdgeProbeZone,
  MetricValue,
  MetricsResponse,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Snapshot cache: many browsers polling must not multiply load on Prometheus.
// Per serverless instance; concurrent requests share one in-flight build.
// ---------------------------------------------------------------------------
let cached: { at: number; body: MetricsResponse } | null = null;
let inflight: Promise<MetricsResponse> | null = null;

function cacheTtlMs(): number {
  const seconds = Number(process.env.METRICS_CACHE_SECONDS ?? "5");
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : 5_000;
}

export async function GET(): Promise<NextResponse<MetricsResponse | ApiError>> {
  let config: BackendConfig;
  try {
    config = readBackendConfig();
  } catch (error) {
    const message = error instanceof BackendConfigError ? error.message : "invalid backend configuration";
    console.error("[api/metrics] configuration error:", message);
    return json({ error: "not_configured", message }, 503);
  }

  const ttl = cacheTtlMs();
  if (cached && Date.now() - cached.at < ttl) {
    return json(cached.body, 200);
  }

  try {
    inflight ??= buildSnapshot(config).finally(() => {
      inflight = null;
    });
    const body = await inflight;
    cached = { at: Date.now(), body };
    return json(body, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "backend unreachable";
    console.error("[api/metrics] backend failure:", message);
    // Serve the last good snapshot (marked degraded) rather than blanking the wall display.
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      return json({ ...cached.body, degraded: true }, 200);
    }
    return json({ error: "backend_unreachable", message }, 502);
  }
}

function json<T>(body: T, status: number): NextResponse<T> {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Query layer
// ---------------------------------------------------------------------------
class Querier {
  failed = 0;
  attempted = 0;
  lastError: string | null = null;
  constructor(private readonly config: BackendConfig) {}

  /** First sample of a query, or null when there is no data or the query failed. */
  async scalar(query: string): Promise<number | null> {
    this.attempted++;
    try {
      const samples = await queryVector(this.config, query);
      return samples[0]?.value ?? null;
    } catch (error) {
      this.noteFailure(query, error);
      return null;
    }
  }

  async byLabel(query: string, label: string): Promise<Map<string, number>> {
    this.attempted++;
    const out = new Map<string, number>();
    try {
      for (const sample of await queryVector(this.config, query)) {
        const key = sample.labels[label];
        if (key !== undefined) out.set(key, sample.value);
      }
    } catch (error) {
      this.noteFailure(query, error);
    }
    return out;
  }

  private noteFailure(query: string, error: unknown): void {
    this.failed++;
    this.lastError = error instanceof Error ? error.message : "query failed";
    console.error("[api/metrics] query failed:", query, this.lastError);
  }
}

async function buildSnapshot(config: BackendConfig): Promise<MetricsResponse> {
  const q = new Querier(config);

  const alertsPromise = fetchAlerts(config).then(
    (raw) => ({ ok: true as const, raw }),
    (error: unknown) => {
      console.error("[api/metrics] alerts fetch failed:", error instanceof Error ? error.message : error);
      return { ok: false as const, raw: [] };
    },
  );

  const [
    gwUp, gwLoss, gwRtt,
    dnsUp, dnsTotal, dnsVpsMs, dnsEdgeMs,
    dhcpScope, dhcpOfferMs, dhcpEdgeTotal, dhcpEdgeFailing,
    apUp, apTotal, wlcUp,
    swUp, swTotal, swErrPorts,
    radiusMs, radiusUp, radiusTotal,
    portalRedirect, portalPage, portalEdgeUp, portalEdgeTotal, portalPageMs,
    edgeUp, edgeDhcp, edgeDns, edgePortal, edgeRadius,
    alertsResult,
  ] = await Promise.all([
    // --- gateway
    q.scalar(`min(probe_success{job="blackbox-icmp-gateway"})`),
    q.scalar(`max(campus:gateway_packet_loss:percent3m)`),
    q.scalar(`max(probe_icmp_duration_seconds{job="blackbox-icmp-gateway",phase="rtt"}) * 1000`),
    // --- dns
    q.scalar(`sum(probe_success{job=~"blackbox-dns-(internal|external)"})`),
    q.scalar(`count(probe_success{job=~"blackbox-dns-(internal|external)"})`),
    q.scalar(`max(probe_duration_seconds{job=~"blackbox-dns-(internal|external)"}) * 1000`),
    q.scalar(`max(edgeprobe_dns_resolution_seconds) * 1000`),
    // --- dhcp
    q.scalar(`max(campus:dhcp_scope_usage:ratio) * 100`),
    q.scalar(`max(edgeprobe_dhcp_offer_seconds) * 1000`),
    q.scalar(`count(edgeprobe_dhcp_success)`),
    q.scalar(`count(edgeprobe_dhcp_success == 0) or vector(0)`),
    // --- wifi
    q.scalar(`sum(probe_success{job="blackbox-icmp-ap"})`),
    q.scalar(`count(probe_success{job="blackbox-icmp-ap"})`),
    q.scalar(`min(probe_success{job="blackbox-icmp-infra",role="wifi-controller"})`),
    // --- switches
    q.scalar(`sum(probe_success{job="blackbox-icmp-infra",role=~"core-switch|distribution-switch"})`),
    q.scalar(`count(probe_success{job="blackbox-icmp-infra",role=~"core-switch|distribution-switch"})`),
    q.scalar(`count(ALERTS{alertname="CoreSwitchInterfaceErrors",alertstate="firing"}) or vector(0)`),
    // --- aaa
    q.scalar(`max(edgeprobe_radius_response_seconds) * 1000`),
    q.scalar(`sum(probe_success{job="blackbox-icmp-infra",role="radius-server"})`),
    q.scalar(`count(probe_success{job="blackbox-icmp-infra",role="radius-server"})`),
    // --- captive portal
    q.scalar(`min(probe_success{job="blackbox-http-portal-redirect"})`),
    q.scalar(`min(probe_success{job="blackbox-http-portal-page"})`),
    q.scalar(`sum(edgeprobe_captive_portal_up)`),
    q.scalar(`count(edgeprobe_captive_portal_up)`),
    q.scalar(`max(edgeprobe_captive_portal_response_seconds) * 1000`),
    // --- edge probes per zone
    q.byLabel(`max by (zone) (up{job="edge-probe"})`, "zone"),
    q.byLabel(`max by (zone) (edgeprobe_dhcp_offer_seconds) * 1000`, "zone"),
    q.byLabel(`max by (zone) (edgeprobe_dns_resolution_seconds) * 1000`, "zone"),
    q.byLabel(`min by (zone) (edgeprobe_captive_portal_up)`, "zone"),
    q.byLabel(`max by (zone) (edgeprobe_radius_response_seconds) * 1000`, "zone"),
    alertsPromise,
  ]);

  // Every query failing means the backend is down, not that the campus is healthy.
  if (q.failed === q.attempted && !alertsResult.ok) {
    throw new Error(q.lastError ?? "backend unreachable");
  }

  const alerts: ActiveAlert[] = alertsResult.raw
    .filter((a) => (a.state === "firing" || a.state === "pending") && a.labels.alertname !== "Watchdog")
    .map((a) => ({
      name: a.labels.alertname ?? "UnnamedAlert",
      severity: parseSeverity(a.labels.severity),
      component: a.labels.component ?? "platform",
      state: a.state === "firing" ? ("firing" as const) : ("pending" as const),
      summary: a.annotations.summary ?? a.labels.alertname ?? "Alert",
      description: a.annotations.description ?? "",
      activeAt: a.activeAt,
      labels: a.labels,
    }))
    .sort((x, y) => alertSortKey(x) - alertSortKey(y) || x.activeAt.localeCompare(y.activeAt));

  const state = (v: number | null): MetricValue["value"] => v;
  const defs: Array<{ id: ComponentId; name: string; hasData: boolean; metrics: MetricValue[] }> = [
    {
      id: "gateway",
      name: "Internet Gateway",
      hasData: gwUp !== null,
      metrics: [
        { label: "Reachable", value: state(gwUp), unit: "state" },
        { label: "Packet loss (3 min)", value: gwLoss, unit: "percent", warnAbove: 0.5, critAbove: 1 },
        { label: "Round-trip time", value: gwRtt, unit: "ms", warnAbove: 50, critAbove: 150 },
      ],
    },
    {
      id: "dns",
      name: "DNS",
      hasData: (dnsTotal ?? 0) > 0 || dnsEdgeMs !== null,
      metrics: [
        { label: "Resolver checks passing", value: dnsUp, unit: "count", total: dnsTotal },
        { label: "Lookup latency (server)", value: dnsVpsMs, unit: "ms", warnAbove: 250, critAbove: 500 },
        { label: "Lookup latency (client zones)", value: dnsEdgeMs, unit: "ms", warnAbove: 250, critAbove: 500 },
      ],
    },
    {
      id: "dhcp",
      name: "DHCP",
      hasData: dhcpScope !== null || (dhcpEdgeTotal ?? 0) > 0,
      metrics: [
        { label: "Busiest scope usage", value: dhcpScope, unit: "percent", warnAbove: 85, critAbove: 95 },
        { label: "Offer latency (client zones)", value: dhcpOfferMs, unit: "ms", warnAbove: 1000, critAbove: 2000 },
        { label: "Zones failing to get a lease", value: dhcpEdgeFailing, unit: "count", warnAbove: 0.5 },
      ],
    },
    {
      id: "wifi",
      name: "Wi-Fi Access Points",
      hasData: (apTotal ?? 0) > 0 || wlcUp !== null,
      metrics: [
        { label: "APs online", value: apUp, unit: "count", total: apTotal },
        { label: "Controller reachable", value: wlcUp, unit: "state" },
      ],
    },
    {
      id: "switch",
      name: "Core / Distribution Switches",
      hasData: (swTotal ?? 0) > 0,
      metrics: [
        { label: "Switches online", value: swUp, unit: "count", total: swTotal },
        { label: "Ports with sustained errors", value: swErrPorts, unit: "count", warnAbove: 0.5 },
      ],
    },
    {
      id: "aaa",
      name: "AAA / RADIUS",
      hasData: radiusMs !== null || (radiusTotal ?? 0) > 0,
      metrics: [
        { label: "Auth response time", value: radiusMs, unit: "ms", warnAbove: 300, critAbove: 500 },
        { label: "Servers reachable", value: radiusUp, unit: "count", total: radiusTotal },
      ],
    },
    {
      id: "portal",
      name: "Captive Portal",
      hasData: portalRedirect !== null || portalPage !== null || (portalEdgeTotal ?? 0) > 0,
      metrics: [
        { label: "HTTP redirect", value: portalRedirect, unit: "state" },
        { label: "Login page", value: portalPage, unit: "state" },
        { label: "Client zones OK", value: portalEdgeUp, unit: "count", total: portalEdgeTotal },
        { label: "Login page load", value: portalPageMs, unit: "ms", warnAbove: 1500, critAbove: 4000 },
      ],
    },
  ];

  const components: ComponentHealth[] = defs.map((def) => {
    const { status, worst } = deriveComponentStatus(COMPONENT_LABELS[def.id], alerts, def.hasData);
    const summary = worst
      ? worst.summary
      : def.hasData
        ? "All checks passing"
        : "No data received from the monitoring backend";
    return { id: def.id, name: def.name, status, summary, metrics: def.metrics };
  });

  const edgeProbes: EdgeProbeZone[] = [...edgeUp.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([zone, up]) => {
      const portal = edgePortal.get(zone);
      return {
        zone,
        instance: zone,
        up: up === 1,
        dhcpOfferMs: edgeDhcp.get(zone) ?? null,
        dnsMs: edgeDns.get(zone) ?? null,
        portalUp: portal === undefined ? null : portal === 1,
        radiusMs: edgeRadius.get(zone) ?? null,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    degraded: q.failed > 0 || !alertsResult.ok,
    failedQueries: q.failed + (alertsResult.ok ? 0 : 1),
    overall: overallStatus(components.map((c) => c.status)),
    components,
    alerts,
    edgeProbes,
  };
}
