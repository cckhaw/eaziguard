// Pure status logic (no I/O) so it can be unit-tested with `npm test`.
import type { ActiveAlert, ComponentId, Severity, Status } from "./types.ts";

const STATUS_RANK: Record<Status, number> = { unknown: 0, ok: 1, warning: 2, critical: 3 };

/** The worse of two statuses. "unknown" never masks a real problem but loses to "ok". */
export function worstStatus(a: Status, b: Status): Status {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** Alert `component` label for each dashboard card (see docker/prometheus/alerts.yml). */
export const COMPONENT_LABELS: Record<ComponentId, string> = {
  gateway: "gateway",
  dns: "dns",
  dhcp: "dhcp",
  wifi: "wifi",
  switch: "switch",
  aaa: "aaa",
  portal: "portal",
};

/**
 * How much an alert should colour its component:
 *  - firing critical -> critical, firing warning -> warning
 *  - pending alerts are early warnings: at most "warning"
 *  - info alerts never change a component's colour
 */
export function alertImpact(alert: Pick<ActiveAlert, "severity" | "state">): Status {
  if (alert.severity === "info") return "ok";
  if (alert.state === "pending") return "warning";
  return alert.severity === "critical" ? "critical" : "warning";
}

export function deriveComponentStatus(
  componentLabel: string,
  alerts: ActiveAlert[],
  hasData: boolean,
): { status: Status; worst: ActiveAlert | null } {
  let worst: ActiveAlert | null = null;
  for (const alert of alerts) {
    if (alert.component !== componentLabel || alertImpact(alert) === "ok") continue;
    if (worst === null || STATUS_RANK[alertImpact(alert)] > STATUS_RANK[alertImpact(worst)]) {
      worst = alert;
    }
  }
  const status: Status = worst ? alertImpact(worst) : hasData ? "ok" : "unknown";
  return { status, worst };
}

/** Overall campus status: worst component; "unknown" only when nothing reports at all. */
export function overallStatus(statuses: Status[]): Status {
  if (statuses.length === 0) return "unknown";
  const known = statuses.filter((s) => s !== "unknown");
  if (known.length === 0) return "unknown";
  return known.reduce<Status>((acc, s) => worstStatus(acc, s), "ok");
}

export function parseSeverity(value: string | undefined): Severity {
  return value === "critical" || value === "info" ? value : "warning";
}

export function alertSortKey(alert: ActiveAlert): number {
  const sev = alert.severity === "critical" ? 0 : alert.severity === "warning" ? 1 : 2;
  const state = alert.state === "firing" ? 0 : 1;
  return sev * 2 + state;
}
