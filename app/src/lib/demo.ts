// Sample data for DEMO_MODE=true: lets the dashboard be shown (e.g. on a Vercel preview)
// without a monitoring backend. It answers the same PromQL strings that
// /api/metrics sends, so the real query, status and rendering code paths are exercised.
// Never enable it for real monitoring: the numbers are invented.

import type { RawAlert, VectorSample } from "./prometheus.ts";

type Rule = [needle: string, samples: Array<[value: number, labels?: Record<string, string>]>];

const jitter = (v: number): number => (v > 5 || !Number.isInteger(v) ? Math.round(v * (0.9 + Math.random() * 0.2) * 100) / 100 : v);

// First rule whose needle is contained in the query wins (most specific first).
const RULES: Rule[] = [
  ['min(probe_success{job="blackbox-icmp-gateway"})', [[1]]],
  ["campus:gateway_packet_loss", [[1.7]]],
  ["probe_icmp_duration_seconds", [[8.4]]],
  ['sum(probe_success{job=~"blackbox-dns', [[4]]],
  ['count(probe_success{job=~"blackbox-dns', [[4]]],
  ["max(probe_duration_seconds", [[21]]],
  ["max(edgeprobe_dns_resolution_seconds) *", [[34]]],
  ["campus:dhcp_scope_usage", [[88.2]]],
  ["max(edgeprobe_dhcp_offer_seconds) *", [[180]]],
  ["count(edgeprobe_dhcp_success == 0)", [[0]]],
  ["count(edgeprobe_dhcp_success)", [[3]]],
  ['sum(probe_success{job="blackbox-icmp-ap"})', [[41]]],
  ['count(probe_success{job="blackbox-icmp-ap"})', [[42]]],
  ['role="wifi-controller"', [[1]]],
  ['sum(probe_success{job="blackbox-icmp-infra",role=~"core', [[5]]],
  ['count(probe_success{job="blackbox-icmp-infra",role=~"core', [[5]]],
  ['ALERTS{alertname="CoreSwitchInterfaceErrors"', [[1]]],
  ["max(edgeprobe_radius_response_seconds) *", [[120]]],
  ['sum(probe_success{job="blackbox-icmp-infra",role="radius', [[2]]],
  ['count(probe_success{job="blackbox-icmp-infra",role="radius', [[2]]],
  ["blackbox-http-portal-redirect", [[1]]],
  ["blackbox-http-portal-page", [[1]]],
  ["sum(edgeprobe_captive_portal_up)", [[2]]],
  ["count(edgeprobe_captive_portal_up)", [[3]]],
  ["max(edgeprobe_captive_portal_response_seconds)", [[640]]],
  ['max by (zone) (up{job="edge-probe"})', [[1, { zone: "dorm-a" }], [1, { zone: "library" }], [0, { zone: "lecture-hall-1" }]]],
  ["max by (zone) (edgeprobe_dhcp_offer_seconds)", [[120, { zone: "dorm-a" }], [180, { zone: "library" }]]],
  ["max by (zone) (edgeprobe_dns_resolution_seconds)", [[30, { zone: "dorm-a" }], [34, { zone: "library" }]]],
  ["min by (zone) (edgeprobe_captive_portal_up)", [[1, { zone: "dorm-a" }], [0, { zone: "library" }]]],
  ["max by (zone) (edgeprobe_radius_response_seconds)", [[110, { zone: "dorm-a" }]]],
];

export function demoQuery(query: string): VectorSample[] {
  const rule = RULES.find(([needle]) => query.includes(needle));
  return (rule?.[1] ?? []).map(([value, labels]) => ({ labels: labels ?? {}, value: jitter(value) }));
}

export function demoAlerts(now: number = Date.now()): RawAlert[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return [
    {
      labels: { alertname: "HighGatewayPacketLoss", severity: "critical", component: "gateway", instance: "10.0.0.1" },
      annotations: {
        summary: "1.7% packet loss to gateway 10.0.0.1",
        description: "More than 1% of probes to the internet gateway/firewall were lost over the last 3 minutes.",
      },
      state: "firing",
      activeAt: ago(12),
    },
    {
      labels: { alertname: "ZoneCaptivePortalFailure", severity: "critical", component: "portal", zone: "library" },
      annotations: {
        summary: "Captive portal broken as seen from library",
        description: "The probe in library sees no portal redirect or the portal page does not load.",
      },
      state: "firing",
      activeAt: ago(9),
    },
    {
      labels: { alertname: "APOffline", severity: "critical", component: "wifi", instance: "10.10.3.21" },
      annotations: {
        summary: "Access point ap-hall-101-01 (10.10.3.21) offline",
        description: "No ICMP heartbeat from 10.10.3.21 in Lecture Hall 1 for over 90 seconds.",
      },
      state: "pending",
      activeAt: ago(1),
    },
    {
      labels: { alertname: "DHCPPoolExhaustionWarning", severity: "warning", component: "dhcp", subnet: "10.20.0.0/22" },
      annotations: {
        summary: "DHCP scope 10.20.0.0/22 is 88% full",
        description: "Scope has stayed above 85% lease usage for 5 minutes.",
      },
      state: "firing",
      activeAt: ago(34),
    },
    {
      labels: { alertname: "CoreSwitchInterfaceErrors", severity: "warning", component: "switch", instance: "10.0.2.12" },
      annotations: {
        summary: "crc on 10.0.2.12 Gi1/0/24 (0.45/s)",
        description: "Sustained CRC errors usually mean a bad cable, SFP or duplex mismatch.",
      },
      state: "firing",
      activeAt: ago(47),
    },
  ];
}
