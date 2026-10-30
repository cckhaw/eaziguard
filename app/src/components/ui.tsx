// Shared building blocks. Icons are Lucide (outlined, open source): SF Symbols may not be used on the web.
// Per Apple HIG: status is shown with a filled glyph AND a text label, never colour alone.
// Audit by HIG Compliance Auditor (Omraj Kumar).
import type { ReactNode } from "react";
import type { Severity, Status } from "@/lib/types";

export type GlyphKind = Status | "info";

const STATUS_LABEL: Record<Status, string> = { ok: "Healthy", warning: "Warning", critical: "Critical", unknown: "No data" };
export const statusLabel = (status: Status): string => STATUS_LABEL[status];

/** Filled status glyph in the style of SF Symbols' checkmark.circle.fill / exclamationmark.triangle.fill / xmark.circle.fill. */
export function StatusGlyph({ kind, size = 22 }: { kind: GlyphKind; size?: number }) {
  const fill = { ok: "var(--green)", warning: "var(--orange)", critical: "var(--red)", unknown: "var(--gray)", info: "var(--tint-fill)" }[kind];
  const ink = "var(--on-fill)";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flex: "none" }}>
      {kind === "warning" ? (
        <>
          <path d="M12 2.8 22 20.2H2z" fill={fill} stroke={fill} strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M12 9.2v5" stroke={ink} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="12" cy="17.3" r="1.25" fill={ink} />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="11" fill={fill} />
          {kind === "ok" && <path d="m7.2 12.6 3.1 3.1 6.4-6.9" fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />}
          {kind === "critical" && <path d="m8.2 8.2 7.6 7.6m0-7.6-7.6 7.6" fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />}
          {kind === "unknown" && <path d="M7.8 12h8.4" fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />}
          {kind === "info" && (
            <>
              <path d="M12 11v5.2" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
              <circle cx="12" cy="7.7" r="1.35" fill={ink} />
            </>
          )}
        </>
      )}
    </svg>
  );
}

export const severityGlyph = (severity: Severity): GlyphKind => (severity === "critical" ? "critical" : severity === "warning" ? "warning" : "info");

export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`pill pill-${status}`}>
      <StatusGlyph kind={status} size={14} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Small marker beside a value that is outside its normal range, so colour is never the only cue. */
export function ToneMark({ tone }: { tone: "ok" | "warning" | "critical" | "muted" }) {
  if (tone === "warning" || tone === "critical") return <StatusGlyph kind={tone} size={14} />;
  return null;
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill="#0a84ff" />
      <path d="M32 12 48 18v12c0 10.2-6.6 18.4-16 22-9.4-3.6-16-11.8-16-22V18z" fill="#fff" />
      <path d="m24.5 31.5 5.2 5.2 10-11" fill="none" stroke="#0a84ff" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rise" aria-label={title}>
      {title && <h2 className="section-title t-footnote caps">{title}</h2>}
      {children}
    </section>
  );
}
