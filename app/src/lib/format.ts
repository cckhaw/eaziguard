import type { MetricValue } from "./types";

export function formatMetric(metric: MetricValue): string {
  if (metric.value === null) return "—";
  switch (metric.unit) {
    case "ms":
      return metric.value >= 1000 ? `${(metric.value / 1000).toFixed(2)} s` : `${Math.round(metric.value)} ms`;
    case "percent":
      return `${metric.value < 10 ? metric.value.toFixed(1) : Math.round(metric.value)}%`;
    case "state":
      return metric.value >= 1 ? "Up" : "Down";
    case "count":
      return metric.total === undefined || metric.total === null
        ? String(Math.round(metric.value))
        : `${Math.round(metric.value)} / ${Math.round(metric.total)}`;
  }
}

/** "3m", "2h 5m", "1d 4h" from an ISO timestamp. */
export function formatAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Tint class for a metric value based on its thresholds. */
export function metricTone(metric: MetricValue): "ok" | "warning" | "critical" | "muted" {
  if (metric.value === null) return "muted";
  if (metric.unit === "state") return metric.value >= 1 ? "ok" : "critical";
  if (metric.unit === "count" && metric.total !== undefined && metric.total !== null) {
    if (metric.total === 0) return "muted";
    if (metric.value >= metric.total) return "ok";
    return metric.value === 0 ? "critical" : "warning";
  }
  if (metric.critAbove !== undefined && metric.value > metric.critAbove) return "critical";
  if (metric.warnAbove !== undefined && metric.value > metric.warnAbove) return "warning";
  return "ok";
}
