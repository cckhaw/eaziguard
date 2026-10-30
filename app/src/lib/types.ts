// Shapes shared by the API route (server) and the dashboard page (client).

export type Status = "ok" | "warning" | "critical" | "unknown";
export type Severity = "critical" | "warning" | "info";

export type ComponentId = "gateway" | "dns" | "dhcp" | "wifi" | "switch" | "aaa" | "portal";

export type MetricUnit = "ms" | "percent" | "count" | "state";

export interface MetricValue {
  label: string;
  /** null when Prometheus has no sample for the series (not the same as 0). */
  value: number | null;
  unit: MetricUnit;
  /** For unit "count": render as "value / total" when set. */
  total?: number | null;
  /** Thresholds used by the UI to tint the value; same unit as `value`. */
  warnAbove?: number;
  critAbove?: number;
}

export interface ComponentHealth {
  id: ComponentId;
  name: string;
  status: Status;
  /** One-line human summary of the worst active alert, or a healthy/unknown note. */
  summary: string;
  metrics: MetricValue[];
}

export interface ActiveAlert {
  name: string;
  severity: Severity;
  component: string;
  state: "firing" | "pending";
  summary: string;
  description: string;
  /** ISO timestamp the condition first became true. */
  activeAt: string;
  labels: Record<string, string>;
}

export interface EdgeProbeZone {
  zone: string;
  instance: string;
  up: boolean;
  dhcpOfferMs: number | null;
  dnsMs: number | null;
  portalUp: boolean | null;
  radiusMs: number | null;
}

export interface MetricsResponse {
  generatedAt: string;
  /** true when the data is built-in sample data (DEMO_MODE), not real monitoring. */
  demo?: boolean;
  /** true when some (not all) Prometheus queries failed. */
  degraded: boolean;
  failedQueries: number;
  overall: Status;
  components: ComponentHealth[];
  alerts: ActiveAlert[];
  edgeProbes: EdgeProbeZone[];
}

export interface ApiError {
  error: "not_configured" | "backend_unreachable" | "unauthorized";
  message: string;
}
