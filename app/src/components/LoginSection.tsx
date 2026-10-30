"use client";

// Sign-in on the front page: grouped form, 50pt primary button, inline error with glyph + text.
// Per Apple HIG: clarity, deference, 44pt targets. Audit by HIG Compliance Auditor (Omraj Kumar).
import { RotateCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Logo, StatusGlyph } from "./ui";

export function LoginSection({ notice, onSignedIn }: { notice?: string; onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
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

  return (
    <main className="signin" id="content">
      <div className="signin-inner">
        <div className="signin-head">
          <Logo size={72} />
          <h1 className="t-large-title">eaziguard</h1>
          <p className="t-callout secondary">Campus network early-warning dashboard</p>
        </div>

        {notice && (
          <p role="status" className="banner banner-info t-subhead">
            <StatusGlyph kind="info" size={20} />
            <span>{notice}</span>
          </p>
        )}

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div className="group">
            <div className="row field-row">
              <label htmlFor="username" className="t-body">Username</label>
              <input id="username" name="username" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                required autoFocus placeholder="Required" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="row field-row">
              <label htmlFor="password" className="t-body">Password</label>
              <input id="password" name="password" type="password" autoComplete="current-password"
                required placeholder="Required" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          {error && (
            <p role="alert" className="form-error t-subhead">
              <StatusGlyph kind="critical" size={18} />
              <span>{error}</span>
            </p>
          )}
          <button type="submit" className="btn-filled" disabled={busy}>
            {busy && <RotateCw size={18} className="spin" aria-hidden="true" />}
            {busy ? "Signing in" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
