#!/usr/bin/env python3
"""eaziguard notifier: Alertmanager webhook receiver that sends email, SMS and WhatsApp.

Alertmanager groups, de-duplicates and silences alerts, then POSTs each group to
``/alerts``. This service decides which channels get which alerts and delivers them:

  email     SMTP (STARTTLS, implicit TLS or plain)
  SMS       Twilio Programmable Messaging
  WhatsApp  Twilio WhatsApp (sandbox, approved sender, or an approved template)

A channel is enabled only when all of its settings are present. Each channel has its
own minimum severity, so a warning can go to email while only critical alerts page by
SMS and WhatsApp. SMS and WhatsApp have an hourly cap so a flapping alert cannot run
up a bill.

Standard library only. No secret is ever logged; phone numbers are masked.

    notifier.py                  run the webhook server
    notifier.py --check-config   print which channels are enabled and exit
    notifier.py --test           send a test alert through every enabled channel
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import logging
import os
import re
import smtplib
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Deque, Dict, List, Mapping, Optional, Tuple

LOG = logging.getLogger("notifier")

SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}
CHANNELS = ("email", "sms", "whatsapp")
MAX_BODY_BYTES = 1_000_000
SMS_MAX_CHARS = 300
WHATSAPP_MAX_LISTED = 8

_E164 = re.compile(r"^\+[1-9]\d{6,14}$")
_EMAIL = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")


class ConfigError(Exception):
    """Invalid configuration; the process exits with code 2."""


# ============================================================================
# Configuration
# ============================================================================
def _csv(env: Mapping[str, str], name: str) -> List[str]:
    return [part.strip() for part in env.get(name, "").split(",") if part.strip()]


def _severity(env: Mapping[str, str], name: str, default: str) -> str:
    value = env.get(name, default).strip().lower() or default
    if value not in SEVERITY_RANK:
        raise ConfigError(f"{name}={value!r} must be one of {', '.join(SEVERITY_RANK)}")
    return value


def _int(env: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name}={raw!r} is not an integer") from exc
    if not low <= value <= high:
        raise ConfigError(f"{name}={value} must be between {low} and {high}")
    return value


def _strip_whatsapp(number: str) -> str:
    return number[len("whatsapp:"):] if number.lower().startswith("whatsapp:") else number


def _phones(env: Mapping[str, str], name: str) -> List[str]:
    numbers = [_strip_whatsapp(n) for n in _csv(env, name)]
    for number in numbers:
        if not _E164.match(number):
            raise ConfigError(f"{name} entry {number!r} is not an E.164 number such as +14155550123")
    return numbers


@dataclass(frozen=True)
class Config:
    name: str
    dashboard_url: str
    listen_port: int
    http_timeout: int

    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str = field(repr=False)
    smtp_from: str = ""
    smtp_security: str = "starttls"
    email_to: Tuple[str, ...] = ()

    twilio_sid: str = ""
    twilio_token: str = field(default="", repr=False)
    twilio_base: str = "https://api.twilio.com"
    sms_from: str = ""
    sms_messaging_service: str = ""
    sms_to: Tuple[str, ...] = ()
    whatsapp_from: str = ""
    whatsapp_to: Tuple[str, ...] = ()
    whatsapp_content_sid: str = ""

    min_severity: Mapping[str, str] = field(default_factory=dict)
    send_resolved: Tuple[str, ...] = ("email",)
    max_per_hour: Mapping[str, int] = field(default_factory=dict)

    @staticmethod
    def from_env(env: Optional[Mapping[str, str]] = None) -> "Config":
        env = os.environ if env is None else env

        security = env.get("SMTP_SECURITY", "starttls").strip().lower() or "starttls"
        if security not in ("starttls", "ssl", "none"):
            raise ConfigError("SMTP_SECURITY must be starttls, ssl or none")
        default_port = {"starttls": 587, "ssl": 465, "none": 25}[security]

        email_to = _csv(env, "EMAIL_TO")
        for address in email_to:
            if not _EMAIL.match(address):
                raise ConfigError(f"EMAIL_TO entry {address!r} is not an email address")

        base = env.get("TWILIO_API_BASE", "https://api.twilio.com").strip().rstrip("/")
        if not base.startswith(("https://", "http://")):
            raise ConfigError("TWILIO_API_BASE must start with https://")

        resolved = tuple(c.lower() for c in _csv(env, "NOTIFY_RESOLVED")) if "NOTIFY_RESOLVED" in env else ("email",)
        for channel in resolved:
            if channel not in CHANNELS:
                raise ConfigError(f"NOTIFY_RESOLVED entry {channel!r} must be one of {', '.join(CHANNELS)}")

        return Config(
            name=env.get("NOTIFY_NAME", "eaziguard").strip() or "eaziguard",
            dashboard_url=env.get("DASHBOARD_URL", "").strip(),
            listen_port=_int(env, "NOTIFIER_PORT", 9099, 1, 65535),
            http_timeout=_int(env, "NOTIFY_TIMEOUT_SECONDS", 15, 1, 120),
            smtp_host=env.get("SMTP_HOST", "").strip(),
            smtp_port=_int(env, "SMTP_PORT", default_port, 1, 65535),
            smtp_user=env.get("SMTP_USER", "").strip(),
            smtp_password=env.get("SMTP_PASSWORD", ""),
            smtp_from=env.get("SMTP_FROM", "").strip(),
            smtp_security=security,
            email_to=tuple(email_to),
            twilio_sid=env.get("TWILIO_ACCOUNT_SID", "").strip(),
            twilio_token=env.get("TWILIO_AUTH_TOKEN", "").strip(),
            twilio_base=base,
            sms_from=(_phones(env, "SMS_FROM") or [""])[0],
            sms_messaging_service=env.get("TWILIO_MESSAGING_SERVICE_SID", "").strip(),
            sms_to=tuple(_phones(env, "SMS_TO")),
            whatsapp_from=(_phones(env, "WHATSAPP_FROM") or [""])[0],
            whatsapp_to=tuple(_phones(env, "WHATSAPP_TO")),
            whatsapp_content_sid=env.get("TWILIO_WHATSAPP_CONTENT_SID", "").strip(),
            min_severity={
                "email": _severity(env, "NOTIFY_EMAIL_MIN_SEVERITY", "warning"),
                "sms": _severity(env, "NOTIFY_SMS_MIN_SEVERITY", "critical"),
                "whatsapp": _severity(env, "NOTIFY_WHATSAPP_MIN_SEVERITY", "critical"),
            },
            send_resolved=resolved,
            max_per_hour={
                "sms": _int(env, "NOTIFY_SMS_MAX_PER_HOUR", 20, 1, 10_000),
                "whatsapp": _int(env, "NOTIFY_WHATSAPP_MAX_PER_HOUR", 20, 1, 10_000),
            },
        )

    # --- which channels have everything they need --------------------------------
    def missing(self, channel: str) -> List[str]:
        if channel == "email":
            need = {"SMTP_HOST": self.smtp_host, "SMTP_FROM": self.smtp_from, "EMAIL_TO": self.email_to}
        elif channel == "sms":
            need = {
                "TWILIO_ACCOUNT_SID": self.twilio_sid,
                "TWILIO_AUTH_TOKEN": self.twilio_token,
                "SMS_FROM or TWILIO_MESSAGING_SERVICE_SID": self.sms_from or self.sms_messaging_service,
                "SMS_TO": self.sms_to,
            }
        else:
            need = {
                "TWILIO_ACCOUNT_SID": self.twilio_sid,
                "TWILIO_AUTH_TOKEN": self.twilio_token,
                "WHATSAPP_FROM": self.whatsapp_from,
                "WHATSAPP_TO": self.whatsapp_to,
            }
        return [key for key, value in need.items() if not value]

    def enabled(self, channel: str) -> bool:
        return not self.missing(channel)

    def enabled_channels(self) -> List[str]:
        return [c for c in CHANNELS if self.enabled(c)]

    def partially_configured(self) -> Dict[str, List[str]]:
        """Channels with some but not all settings, so a typo is reported at start-up."""
        out = {}
        for channel in CHANNELS:
            missing = self.missing(channel)
            if missing and channel == "email" and (self.smtp_host or self.email_to):
                out[channel] = missing
            elif missing and channel == "sms" and (self.sms_to or self.sms_from or self.sms_messaging_service):
                out[channel] = missing
            elif missing and channel == "whatsapp" and (self.whatsapp_to or self.whatsapp_from):
                out[channel] = missing
        return out


# ============================================================================
# Alert model
# ============================================================================
@dataclass(frozen=True)
class Alert:
    name: str
    severity: str
    component: str
    status: str  # "firing" | "resolved"
    summary: str
    description: str
    started: Optional[datetime]
    where: str

    @property
    def rank(self) -> int:
        return SEVERITY_RANK[self.severity]


def _parse_time(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or value.startswith("0001-"):
        return None
    match = re.match(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)$", value)
    if not match:
        return None
    base, fraction, zone = match.groups()
    fraction = (fraction or "")[:7]
    zone = "+00:00" if zone == "Z" else zone
    try:
        return datetime.fromisoformat(base + fraction + zone).astimezone(timezone.utc)
    except ValueError:
        return None


def parse_payload(payload: object) -> List[Alert]:
    """Normalise an Alertmanager webhook (version 4) body. Raises ValueError if it is not one."""
    if not isinstance(payload, dict) or not isinstance(payload.get("alerts"), list):
        raise ValueError("not an Alertmanager webhook payload")
    alerts: List[Alert] = []
    for item in payload["alerts"]:
        if not isinstance(item, dict):
            continue
        labels = item.get("labels") if isinstance(item.get("labels"), dict) else {}
        notes = item.get("annotations") if isinstance(item.get("annotations"), dict) else {}
        severity = str(labels.get("severity", "warning")).lower()
        if severity not in SEVERITY_RANK:
            severity = "warning"
        name = str(labels.get("alertname", "UnnamedAlert"))
        where = " ".join(str(labels[k]) for k in ("zone", "instance", "subnet", "ifName") if labels.get(k))
        alerts.append(
            Alert(
                name=name,
                severity=severity,
                component=str(labels.get("component", "")),
                status="resolved" if item.get("status") == "resolved" else "firing",
                summary=str(notes.get("summary") or name),
                description=" ".join(str(notes.get("description", "")).split()),
                started=_parse_time(item.get("startsAt")),
                where=where,
            )
        )
    return alerts


def select_for_channel(cfg: Config, channel: str, alerts: List[Alert]) -> Tuple[List[Alert], List[Alert]]:
    """(firing, resolved) alerts this channel should announce, worst first."""
    floor = SEVERITY_RANK[cfg.min_severity[channel]]
    firing = [a for a in alerts if a.status == "firing" and a.rank >= floor]
    resolved = [a for a in alerts if a.status == "resolved" and a.rank >= floor] if channel in cfg.send_resolved else []
    key = lambda a: (-a.rank, a.name, a.where)  # noqa: E731
    return sorted(firing, key=key), sorted(resolved, key=key)


# ============================================================================
# Message formatting
# ============================================================================
def _counts(alerts: List[Alert]) -> str:
    parts = []
    for severity in ("critical", "warning", "info"):
        n = sum(1 for a in alerts if a.severity == severity)
        if n:
            parts.append(f"{n} {severity}")
    return ", ".join(parts)


def _since(alert: Alert) -> str:
    return alert.started.strftime("since %H:%M UTC") if alert.started else ""


def format_email(cfg: Config, firing: List[Alert], resolved: List[Alert]) -> Tuple[str, str, str]:
    if firing:
        subject = f"[{cfg.name}] {_counts(firing)} firing"
    else:
        names = ", ".join(sorted({a.name for a in resolved}))
        subject = f"[{cfg.name}] Resolved: {names}"
    subject = subject[:200]

    text: List[str] = []
    rows: List[str] = []
    for title, group in (("FIRING", firing), ("RESOLVED", resolved)):
        if not group:
            continue
        text.append(f"{title} ({len(group)})")
        for a in group:
            text.append(f"- [{a.severity.upper()}] {a.name}: {a.summary}")
            if a.description:
                text.append(f"    {a.description}")
            meta = " | ".join(x for x in (a.component and f"component: {a.component}", a.where, _since(a)) if x)
            if meta:
                text.append(f"    {meta}")
            colour = {"critical": "#d70015", "warning": "#b25e00", "info": "#0062cc"}[a.severity]
            if title == "RESOLVED":
                colour = "#1e7e34"
            rows.append(
                f'<tr><td style="padding:8px 12px;border-top:1px solid #e5e5ea;vertical-align:top">'
                f'<span style="color:{colour};font-weight:600">{html.escape(("resolved" if title == "RESOLVED" else a.severity).upper())}</span></td>'
                f'<td style="padding:8px 12px;border-top:1px solid #e5e5ea"><strong>{html.escape(a.name)}</strong><br>'
                f"{html.escape(a.summary)}"
                + (f'<br><span style="color:#6c6c70">{html.escape(a.description)}</span>' if a.description else "")
                + (f'<br><span style="color:#6c6c70">{html.escape(" | ".join(x for x in (a.where, _since(a)) if x))}</span>' if (a.where or a.started) else "")
                + "</td></tr>"
            )
        text.append("")
    if cfg.dashboard_url:
        text.append(f"Dashboard: {cfg.dashboard_url}")
    link = f'<p><a href="{html.escape(cfg.dashboard_url)}">Open the dashboard</a></p>' if cfg.dashboard_url else ""
    page = (
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1c1e">'
        f'<h2 style="margin:0 0 12px">{html.escape(cfg.name)}</h2>'
        f'<table style="border-collapse:collapse;width:100%;max-width:640px">{"".join(rows)}</table>{link}</div>'
    )
    return subject, "\n".join(text).strip() + "\n", page


def to_sms_text(text: str) -> str:
    """ASCII only, so a message stays in the cheap 160-character GSM encoding."""
    for a, b in (("\u2013", "-"), ("\u2014", "-"), ("\u00b7", "-"), ("\u2265", ">="), ("\u2264", "<="), ("\u2019", "'")):
        text = text.replace(a, b)
    return " ".join(text.encode("ascii", "replace").decode().split())


def format_sms(cfg: Config, firing: List[Alert], resolved: List[Alert]) -> str:
    if firing:
        top, label, extra = firing[0], firing[0].severity.upper(), len(firing) - 1
    else:
        top, label, extra = resolved[0], "RESOLVED", len(resolved) - 1
    text = f"{cfg.name} {label}: {top.name} - {top.summary}"
    if extra > 0:
        text += f" (+{extra} more)"
    text = to_sms_text(text)
    return text if len(text) <= SMS_MAX_CHARS else text[: SMS_MAX_CHARS - 3] + "..."


def format_whatsapp(cfg: Config, firing: List[Alert], resolved: List[Alert]) -> str:
    icon = "\U0001F534" if any(a.severity == "critical" for a in firing) else ("\U0001F7E0" if firing else "\u2705")
    head = _counts(firing) + " firing" if firing else "resolved"
    lines = [f"{icon} {cfg.name}: {head}"]
    shown = 0
    for prefix, group in (("\u2022", firing), ("\u2705", resolved)):
        for a in group:
            if shown >= WHATSAPP_MAX_LISTED:
                break
            lines.append(f"{prefix} {a.name}: {a.summary}")
            shown += 1
    rest = len(firing) + len(resolved) - shown
    if rest > 0:
        lines.append(f"(+{rest} more)")
    if cfg.dashboard_url:
        lines.append(cfg.dashboard_url)
    return "\n".join(lines)[:1500]


# ============================================================================
# Delivery
# ============================================================================
class DeliveryError(Exception):
    pass


def mask(number: str) -> str:
    return "*" * max(0, len(number) - 4) + number[-4:]


def send_email(cfg: Config, subject: str, text: str, page: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg.smtp_from
    msg["To"] = "undisclosed-recipients:;"
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain=(cfg.smtp_from.split("@")[-1] or "localhost"))
    msg.set_content(text)
    msg.add_alternative(page, subtype="html")
    context = ssl.create_default_context()
    try:
        if cfg.smtp_security == "ssl":
            client: smtplib.SMTP = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=cfg.http_timeout, context=context)
        else:
            client = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=cfg.http_timeout)
        with client:
            client.ehlo()
            if cfg.smtp_security == "starttls":
                client.starttls(context=context)
                client.ehlo()
            if cfg.smtp_user:
                client.login(cfg.smtp_user, cfg.smtp_password)
            client.send_message(msg, from_addr=cfg.smtp_from, to_addrs=list(cfg.email_to))
    except (smtplib.SMTPException, OSError) as exc:
        raise DeliveryError(f"SMTP error: {exc.__class__.__name__}: {exc}") from exc


def _twilio_post(cfg: Config, fields: Dict[str, str]) -> None:
    url = f"{cfg.twilio_base}/2010-04-01/Accounts/{urllib.parse.quote(cfg.twilio_sid)}/Messages.json"
    token = base64.b64encode(f"{cfg.twilio_sid}:{cfg.twilio_token}".encode()).decode()
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(fields).encode(),
        headers={"Authorization": f"Basic {token}", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=cfg.http_timeout) as response:  # noqa: S310 (https base enforced)
            response.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = str(json.loads(exc.read().decode()).get("message", ""))[:200]
        except (ValueError, OSError):
            pass
        raise DeliveryError(f"Twilio HTTP {exc.code}" + (f": {detail}" if detail else "")) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise DeliveryError(f"Twilio unreachable: {exc.__class__.__name__}") from exc


def send_sms(cfg: Config, to: str, body: str) -> None:
    fields = {"To": to, "Body": body}
    if cfg.sms_messaging_service:
        fields["MessagingServiceSid"] = cfg.sms_messaging_service
    else:
        fields["From"] = cfg.sms_from
    _twilio_post(cfg, fields)


def send_whatsapp(cfg: Config, to: str, body: str, template_text: str) -> None:
    fields = {"To": f"whatsapp:{to}", "From": f"whatsapp:{cfg.whatsapp_from}"}
    if cfg.whatsapp_content_sid:
        # Outside a 24-hour customer-service window WhatsApp only delivers approved templates.
        fields["ContentSid"] = cfg.whatsapp_content_sid
        fields["ContentVariables"] = json.dumps({"1": template_text})
    else:
        fields["Body"] = body
    _twilio_post(cfg, fields)


# ============================================================================
# Rate limiting and metrics
# ============================================================================
class RateLimiter:
    """Sliding one-hour window of sent messages."""

    def __init__(self, limit: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self._clock = clock
        self._stamps: Deque[float] = deque()
        self._lock = threading.Lock()

    def take(self, count: int) -> bool:
        with self._lock:
            now = self._clock()
            while self._stamps and now - self._stamps[0] >= 3600:
                self._stamps.popleft()
            if len(self._stamps) + count > self.limit:
                return False
            self._stamps.extend([now] * count)
            return True


class Metrics:
    def __init__(self, cfg: Config) -> None:
        self._lock = threading.Lock()
        self.sent = {c: 0 for c in CHANNELS}
        self.failed = {c: 0 for c in CHANNELS}
        self.limited = {c: 0 for c in CHANNELS}
        self.last_success = {c: 0.0 for c in CHANNELS}
        self.enabled = {c: cfg.enabled(c) for c in CHANNELS}

    def bump(self, table: Dict[str, int], channel: str, n: int = 1) -> None:
        with self._lock:
            table[channel] += n
            if table is self.sent:
                self.last_success[channel] = time.time()

    def render(self) -> str:
        with self._lock:
            lines = []
            for name, help_text, table in (
                ("notifier_messages_sent_total", "Messages delivered, by channel.", self.sent),
                ("notifier_messages_failed_total", "Delivery attempts that failed, by channel.", self.failed),
                ("notifier_messages_rate_limited_total", "Messages dropped by the hourly cap, by channel.", self.limited),
            ):
                lines += [f"# HELP {name} {help_text}", f"# TYPE {name} counter"]
                lines += [f'{name}{{channel="{c}"}} {table[c]}' for c in CHANNELS]
            lines += ["# HELP notifier_channel_enabled 1 if the channel has all of its settings.", "# TYPE notifier_channel_enabled gauge"]
            lines += [f'notifier_channel_enabled{{channel="{c}"}} {int(self.enabled[c])}' for c in CHANNELS]
            lines += ["# HELP notifier_last_success_timestamp_seconds Unix time of the last delivered message.", "# TYPE notifier_last_success_timestamp_seconds gauge"]
            lines += [f'notifier_last_success_timestamp_seconds{{channel="{c}"}} {self.last_success[c]:.0f}' for c in CHANNELS]
        return "\n".join(lines) + "\n"


# ============================================================================
# Dispatcher
# ============================================================================
class Dispatcher:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.metrics = Metrics(cfg)
        self.limiters = {c: RateLimiter(cfg.max_per_hour[c]) for c in ("sms", "whatsapp")}

    def dispatch(self, alerts: List[Alert]) -> Dict[str, str]:
        """Deliver to every enabled channel. Returns channel -> sent | failed | skipped | rate_limited."""
        outcome: Dict[str, str] = {}
        for channel in CHANNELS:
            if not self.cfg.enabled(channel):
                continue
            firing, resolved = select_for_channel(self.cfg, channel, alerts)
            if not firing and not resolved:
                outcome[channel] = "skipped"
                continue
            try:
                outcome[channel] = self._send(channel, firing, resolved)
            except DeliveryError as exc:
                LOG.error("%s delivery failed: %s", channel, exc)
                self.metrics.bump(self.metrics.failed, channel)
                outcome[channel] = "failed"
        return outcome

    def _send(self, channel: str, firing: List[Alert], resolved: List[Alert]) -> str:
        cfg = self.cfg
        if channel == "email":
            subject, text, page = format_email(cfg, firing, resolved)
            send_email(cfg, subject, text, page)
            self.metrics.bump(self.metrics.sent, "email")
            LOG.info("email sent to %d recipient(s): %s", len(cfg.email_to), subject)
            return "sent"

        recipients = cfg.sms_to if channel == "sms" else cfg.whatsapp_to
        if not self.limiters[channel].take(len(recipients)):
            LOG.warning("%s hourly cap (%d) reached; message dropped", channel, cfg.max_per_hour[channel])
            self.metrics.bump(self.metrics.limited, channel)
            return "rate_limited"

        if channel == "sms":
            body = format_sms(cfg, firing, resolved)
            sender = lambda to: send_sms(cfg, to, body)  # noqa: E731
        else:
            body = format_whatsapp(cfg, firing, resolved)
            template_text = to_sms_text(format_sms(cfg, firing, resolved))
            sender = lambda to: send_whatsapp(cfg, to, body, template_text)  # noqa: E731

        delivered = 0
        last_error: Optional[DeliveryError] = None
        for to in recipients:
            try:
                sender(to)
                delivered += 1
                self.metrics.bump(self.metrics.sent, channel)
                LOG.info("%s sent to %s", channel, mask(to))
            except DeliveryError as exc:
                last_error = exc
                self.metrics.bump(self.metrics.failed, channel)
                LOG.error("%s to %s failed: %s", channel, mask(to), exc)
        if delivered == 0 and last_error is not None:
            raise last_error
        return "sent"


# ============================================================================
# HTTP server
# ============================================================================
def make_handler(dispatcher: Dispatcher) -> type:
    class Handler(BaseHTTPRequestHandler):
        server_version = "eaziguard-notifier"

        def log_message(self, fmt: str, *args: object) -> None:  # route access logs through logging
            LOG.debug("http: " + fmt, *args)

        def _reply(self, status: int, body: object, content_type: str = "application/json") -> None:
            data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._reply(200, {"status": "ok", "channels": dispatcher.cfg.enabled_channels()})
            elif self.path == "/metrics":
                self._reply(200, dispatcher.metrics.render(), "text/plain; version=0.0.4")
            else:
                self._reply(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/alerts":
                return self._reply(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._reply(411, {"error": "Content-Length required"})
            if not 0 < length <= MAX_BODY_BYTES:
                return self._reply(413, {"error": "body too large or empty"})
            try:
                alerts = parse_payload(json.loads(self.rfile.read(length)))
            except (ValueError, UnicodeDecodeError) as exc:
                return self._reply(400, {"error": str(exc)})

            outcome = dispatcher.dispatch(alerts)
            attempted = [c for c, r in outcome.items() if r in ("sent", "failed")]
            # Every channel that tried failed: ask Alertmanager to retry. A partial failure returns 200
            # because a retry would send duplicates to the channels that already worked.
            if attempted and all(outcome[c] == "failed" for c in attempted):
                return self._reply(502, {"outcome": outcome})
            self._reply(200, {"outcome": outcome})

    return Handler


def test_alerts() -> List[Alert]:
    return [
        Alert("EaziguardTest", "critical", "platform", "firing", "Test notification from eaziguard",
              "If you can read this, this channel works.", datetime.now(timezone.utc), "notifier")
    ]


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="eaziguard notifier")
    parser.add_argument("--check-config", action="store_true", help="print enabled channels and exit")
    parser.add_argument("--test", action="store_true", help="send a test alert through every enabled channel")
    args = parser.parse_args(argv)

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout)
    try:
        cfg = Config.from_env()
    except ConfigError as exc:
        LOG.error("configuration error: %s", exc)
        return 2

    for channel, missing in cfg.partially_configured().items():
        LOG.warning("%s is NOT enabled; missing: %s", channel, ", ".join(missing))
    enabled = cfg.enabled_channels()
    LOG.info("enabled channels: %s", ", ".join(enabled) or "none")

    if args.check_config:
        return 0 if enabled else 1
    dispatcher = Dispatcher(cfg)
    if args.test:
        if not enabled:
            LOG.error("no channel is fully configured")
            return 1
        # A test must reach every enabled channel whatever its severity floor.
        floor = dict(cfg.min_severity)
        cfg_all = Config(**{**cfg.__dict__, "min_severity": {c: "info" for c in floor}})
        outcome = Dispatcher(cfg_all).dispatch(test_alerts())
        LOG.info("test outcome: %s", outcome)
        return 0 if all(r == "sent" for r in outcome.values()) else 1

    if not enabled:
        LOG.warning("no notification channel is configured: alerts will be accepted and dropped")
    server = ThreadingHTTPServer(("0.0.0.0", cfg.listen_port), make_handler(dispatcher))  # noqa: S104 (Docker-internal)
    LOG.info("listening on :%d", cfg.listen_port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
