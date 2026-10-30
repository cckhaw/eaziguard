"use client";

// Responsive shell: translucent sidebar on wide screens, bottom tab bar on compact ones.
// Per Apple HIG: Liquid Glass belongs to the control layer only (sidebar, tab bar, toolbar), never the content;
// the toolbar turns frosted only once content scrolls under it. Audit by HIG Compliance Auditor (Omraj Kumar).
import { Bell, ExternalLink, LayoutGrid, LogOut, type LucideIcon, Radio, RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "./ui";

export type Tab = "overview" | "alerts" | "zones";

const TABS: Array<{ id: Tab; label: string; short: string; Icon: LucideIcon }> = [
  { id: "overview", label: "Overview", short: "Overview", Icon: LayoutGrid },
  { id: "alerts", label: "Alerts", short: "Alerts", Icon: Bell },
  { id: "zones", label: "Client zones", short: "Zones", Icon: Radio },
];

export const TAB_TITLES: Record<Tab, string> = { overview: "Overview", alerts: "Alerts", zones: "Client zones" };

export function AppShell(props: {
  tab: Tab;
  alertCount: number;
  refreshing: boolean;
  onRefresh: () => void;
  canSignOut: boolean;
  onSignOut: () => void;
  grafanaUrl?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { tab, alertCount, refreshing, onRefresh, canSignOut, onSignOut, grafanaUrl, subtitle, children } = props;
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 36);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const badge = () =>
    alertCount > 0 ? (
      <span className="badge" aria-label={`${alertCount} active`}>
        {alertCount > 99 ? "99+" : alertCount}
      </span>
    ) : null;

  return (
    <div className="shell">
      <a className="skip-link" href="#content">Skip to content</a>

      {/* Sidebar (wide screens): outlined icons, selected row filled with the tint */}
      <nav className="sidebar glass" aria-label="Sections">
        <div className="brand">
          <Logo />
          <span className="t-title3">eaziguard</span>
        </div>
        {TABS.map(({ id, label, Icon }) => (
          <a key={id} className="side-item t-callout" href={`#${id}`} aria-current={tab === id ? "page" : undefined}>
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>
            {id === "alerts" && badge()}
          </a>
        ))}
        <div className="side-foot">
          <div className="side-sep" role="separator" />
          {grafanaUrl && (
            <a className="side-item t-callout" href={grafanaUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={20} strokeWidth={1.75} aria-hidden="true" />
              <span>Grafana</span>
            </a>
          )}
          {canSignOut && (
            <button type="button" className="side-item t-callout" onClick={onSignOut}>
              <LogOut size={20} strokeWidth={1.75} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          )}
        </div>
      </nav>

      <div className="main">
        <header className="toolbar" data-scrolled={scrolled}>
          <div className="toolbar-spacer" aria-hidden="true" />
          <span className="toolbar-title t-headline" aria-hidden="true">{TAB_TITLES[tab]}</span>
          <div className="toolbar-actions">
            <button type="button" className="icon-btn" onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? "Refreshing" : "Refresh now"}>
              <RotateCw size={22} strokeWidth={1.75} className={refreshing ? "spin" : undefined} aria-hidden="true" />
            </button>
            {canSignOut && (
              <button type="button" className="icon-btn compact-only" onClick={onSignOut} aria-label="Sign out">
                <LogOut size={22} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </header>

        <main id="content" className="content" tabIndex={-1}>
          <div>
            <h1 className="t-large-title">{TAB_TITLES[tab]}</h1>
            {subtitle && <p className="t-subhead secondary" style={{ marginTop: "0.25rem" }}>{subtitle}</p>}
          </div>
          {children}
        </main>
      </div>

      {/* Tab bar (compact screens): the active tab uses a filled icon */}
      <nav className="tabbar glass" aria-label="Sections">
        {TABS.map(({ id, short, Icon }) => {
          const active = tab === id;
          return (
            <a key={id} className="tab t-caption2" href={`#${id}`} aria-current={active ? "page" : undefined}>
              <span className="tab-icon">
                <Icon size={24} strokeWidth={1.75} fill={active ? "currentColor" : "none"} aria-hidden="true" />
                {id === "alerts" && badge()}
              </span>
              <span style={{ fontWeight: active ? 600 : 500 }}>{short}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
