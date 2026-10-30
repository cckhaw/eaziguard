"use client";

// Overview, Alerts and Client zones, built from inset grouped lists (content layer: solid surfaces, no glass).
// Per Apple HIG: hierarchy through size and weight, 44pt rows, status as glyph + word. Audit by HIG Compliance Auditor (Omraj Kumar).
import { ChevronRight, Globe, KeyRound, LogIn, Network, Router, Server, type LucideIcon, Wifi } from "lucide-react";
import { useState } from "react";
import { formatAge, formatMetric, metricTone } from "@/lib/format";
import type { ActiveAlert, ComponentHealth, ComponentId, EdgeProbeZone, MetricsResponse } from "@/lib/types";
import { Section, severityGlyph, StatusGlyph, StatusPill, statusLabel, ToneMark } from "./ui";

const COMPONENT_ICONS: Record<ComponentId, LucideIcon> = {
  gateway: Router, dns: Globe, dhcp: Server, wifi: Wifi, switch: Network, aaa: KeyRound, portal: LogIn,
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function alertSplit(alerts: ActiveAlert[]) {
  const critical = alerts.filter((a) => a.severity === "critical" && a.state === "firing").length;
  return { critical, other: alerts.length - critical };
}

// ---------------------------------------------------------------- Overview
function ComponentCard({ component }: { component: ComponentHealth }) {
  const Icon = COMPONENT_ICONS[component.id];
  return (
    <article className="group" aria-label={`${component.name}: ${statusLabel(component.status)}`}>
      <div className="row card-head">
        <span className="tile"><Icon size={18} strokeWidth={1.75} aria-hidden="true" /></span>
        <div className="row-grow">
          <h3 className="t-headline">{component.name}</h3>
          <p className="t-subhead secondary" style={{ marginTop: "0.125rem" }}>{component.summary}</p>
        </div>
        <StatusPill status={component.status} />
      </div>
      {component.metrics.map((metric) => {
        const tone = metricTone(metric);
        return (
          <div className="row" key={metric.label}>
            <span className="row-grow t-callout">{metric.label}</span>
            <span className={`row-value t-callout num tone-${tone}`} style={{ fontWeight: tone === "ok" ? 400 : 600 }}>
              <ToneMark tone={tone} />
              {formatMetric(metric)}
            </span>
          </div>
        );
      })}
    </article>
  );
}

export function OverviewView({ data, onOpenAlerts }: { data: MetricsResponse; onOpenAlerts: () => void }) {
  const { critical, other } = alertSplit(data.alerts);
  const probesUp = data.edgeProbes.filter((z) => z.up).length;
  const headline =
    data.overall === "unknown" ? "Waiting for data"
    : critical > 0 ? `${plural(critical, "critical alert")}`
    : other > 0 ? plural(other, "warning")
    : "All systems healthy";
  const detail = [
    data.alerts.length > 0 ? `${critical} critical, ${other} other` : "No active alerts",
    data.edgeProbes.length > 0 ? `${probesUp} of ${data.edgeProbes.length} client-zone probes up` : null,
  ].filter(Boolean).join(" · ");

  const inner = (
    <>
      <StatusGlyph kind={data.overall} size={40} />
      <div className="row-grow">
        <p className="t-title3">{headline}</p>
        <p className="t-subhead secondary" style={{ marginTop: "0.125rem" }}>{detail}</p>
      </div>
    </>
  );

  return (
    <>
      <Section>
        <div className="group">
          {data.alerts.length > 0 ? (
            <button type="button" className="hero-button" onClick={onOpenAlerts} aria-label={`${headline}. ${detail}. View alerts`}>
              {inner}
              <ChevronRight size={20} strokeWidth={2} className="secondary" aria-hidden="true" />
            </button>
          ) : (
            <div className="row hero">{inner}</div>
          )}
        </div>
      </Section>
      <Section title="Services">
        <div className="grid">
          {data.components.map((c) => <ComponentCard key={c.id} component={c} />)}
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Alerts
type Filter = "all" | "critical" | "other";

function AlertRow({ alert, now }: { alert: ActiveAlert; now: number }) {
  return (
    <li className="row" style={{ alignItems: "flex-start" }}>
      <span style={{ paddingTop: "0.125rem" }}><StatusGlyph kind={severityGlyph(alert.severity)} size={22} /></span>
      <div className="row-grow">
        <p className="t-headline">{alert.name}</p>
        <p className="t-callout" style={{ marginTop: "0.125rem" }}>{alert.summary}</p>
        {alert.description && <p className="t-footnote secondary" style={{ marginTop: "0.25rem" }}>{alert.description}</p>}
        <p className="t-footnote secondary" style={{ marginTop: "0.375rem" }}>
          <span className="caps" style={{ fontWeight: 600 }}>{alert.severity}</span>
          {alert.state === "pending" ? " · pending" : ""}
          {alert.component ? ` · ${alert.component}` : ""}
        </p>
      </div>
      <span className="t-footnote secondary num" style={{ flex: "none" }}>{formatAge(alert.activeAt, now)}</span>
    </li>
  );
}

export function AlertsView({ alerts, now }: { alerts: ActiveAlert[]; now: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const { critical, other } = alertSplit(alerts);
  const shown = alerts.filter((a) => filter === "all" || (filter === "critical" ? a.severity === "critical" && a.state === "firing" : !(a.severity === "critical" && a.state === "firing")));
  const options: Array<{ id: Filter; label: string }> = [
    { id: "all", label: `All ${alerts.length}` },
    { id: "critical", label: `Critical ${critical}` },
    { id: "other", label: `Other ${other}` },
  ];
  return (
    <>
      <div className="segmented" role="radiogroup" aria-label="Filter alerts">
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={filter === o.id} className="segment" onClick={() => setFilter(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <Section>
        {shown.length === 0 ? (
          <div className="group empty">
            <StatusGlyph kind="ok" size={44} />
            <p className="t-title3">{alerts.length === 0 ? "No active alerts" : "Nothing in this filter"}</p>
            <p className="t-subhead secondary">{alerts.length === 0 ? "Everything being monitored is within its limits." : "Try another filter."}</p>
          </div>
        ) : (
          <ul className="group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {shown.map((a, i) => <AlertRow key={`${a.name}-${i}-${a.activeAt}-${a.labels.instance ?? ""}`} alert={a} now={now} />)}
          </ul>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Client zones
const ms = (value: number | null) => (value === null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`);

function ZoneRow({ zone }: { zone: EdgeProbeZone }) {
  const metrics: Array<[string, string, boolean]> = [
    ["DHCP offer", ms(zone.dhcpOfferMs), false],
    ["DNS", ms(zone.dnsMs), false],
    ["Captive portal", zone.portalUp === null ? "—" : zone.portalUp ? "OK" : "Failing", zone.portalUp === false],
    ["RADIUS", ms(zone.radiusMs), false],
  ];
  return (
    <li className="row row-stack">
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <h3 className="t-headline row-grow">{zone.zone}</h3>
        <StatusPill status={zone.up ? "ok" : "critical"} />
      </div>
      <dl className="zone-metrics" style={{ margin: 0 }}>
        {metrics.map(([label, value, bad]) => (
          <div key={label}>
            <dt className="t-footnote secondary">{label}</dt>
            <dd className={`t-callout num ${bad ? "tone-critical" : ""}`} style={{ margin: 0, fontWeight: bad ? 600 : 400, display: "flex", alignItems: "center", gap: "0.3125rem" }}>
              {bad && <StatusGlyph kind="critical" size={14} />}
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

export function ZonesView({ zones }: { zones: EdgeProbeZone[] }) {
  if (zones.length === 0) {
    return (
      <div className="group empty rise">
        <StatusGlyph kind="unknown" size={44} />
        <p className="t-title3">No probes reporting</p>
        <p className="t-subhead secondary">Raspberry Pi probes in dorms, libraries and lecture halls appear here once Prometheus can scrape them.</p>
      </div>
    );
  }
  return (
    <Section>
      <ul className="group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {zones.map((z) => <ZoneRow key={z.zone} zone={z} />)}
      </ul>
    </Section>
  );
}
