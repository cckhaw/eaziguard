"""Tests for notifier.py against an in-process fake SMTP server and fake Twilio API.

Run from docker/notifier:   python -m unittest -v
"""

import base64
import email
import json
import socket
import socketserver
import threading
import unittest
import urllib.parse
import urllib.request
from email import policy
from http.server import BaseHTTPRequestHandler, HTTPServer

import notifier as n


# ---------------------------------------------------------------- fakes
class FakeSMTP:
    """Just enough SMTP for smtplib with SMTP_SECURITY=none."""

    def __init__(self):
        self.messages = []
        outer = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                rcpts, sender = [], ""
                self.wfile.write(b"220 fake ESMTP\r\n")
                while True:
                    line = self.rfile.readline().decode(errors="replace").strip()
                    if not line:
                        return
                    verb = line.split(" ", 1)[0].upper()
                    if verb in ("EHLO", "HELO"):
                        self.wfile.write(b"250 fake\r\n")
                    elif verb == "MAIL":
                        sender = line.split(":", 1)[1].strip("<> ")
                        self.wfile.write(b"250 ok\r\n")
                    elif verb == "RCPT":
                        rcpts.append(line.split(":", 1)[1].strip("<> "))
                        self.wfile.write(b"250 ok\r\n")
                    elif verb == "DATA":
                        self.wfile.write(b"354 go\r\n")
                        data = b""
                        while not data.endswith(b"\r\n.\r\n"):
                            data += self.rfile.readline()
                        outer.messages.append({"from": sender, "to": rcpts, "raw": data[:-5]})
                        self.wfile.write(b"250 queued\r\n")
                    elif verb == "QUIT":
                        self.wfile.write(b"221 bye\r\n")
                        return
                    else:
                        self.wfile.write(b"250 ok\r\n")

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeTwilio:
    def __init__(self, status=201, fail_numbers=()):
        self.requests = []
        self.status = status
        self.fail_numbers = set(fail_numbers)
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"])).decode()
                fields = {k: v[0] for k, v in urllib.parse.parse_qs(body).items()}
                outer.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "fields": fields})
                status = 400 if fields.get("To", "").replace("whatsapp:", "") in outer.fail_numbers else outer.status
                payload = json.dumps({"sid": "SM1"} if status < 300 else {"message": "The 'To' number is not valid", "code": 21211}).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def env(smtp=None, twilio=None, **extra):
    e = {"NOTIFY_NAME": "eaziguard"}
    if smtp:
        e.update(SMTP_HOST="127.0.0.1", SMTP_PORT=str(smtp.port), SMTP_SECURITY="none", SMTP_FROM="alerts@campus.test",
                 EMAIL_TO="ops@campus.test, noc@campus.test")
    if twilio:
        e.update(TWILIO_ACCOUNT_SID="ACtest", TWILIO_AUTH_TOKEN="secret-token", TWILIO_API_BASE=twilio.url,
                 SMS_FROM="+15005550006", SMS_TO="+14155550101,+14155550102",
                 WHATSAPP_FROM="+14155238886", WHATSAPP_TO="+14155550101")
    e.update(extra)
    return e


def alert(name, severity, status="firing", summary=None, **labels):
    return {"status": status, "labels": {"alertname": name, "severity": severity, "component": "gateway", **labels},
            "annotations": {"summary": summary or f"{name} summary", "description": "Some\n  longer   description."},
            "startsAt": "2026-10-30T02:14:03.123456789Z"}


def payload(*alerts):
    return {"version": "4", "status": "firing", "alerts": list(alerts)}


def parse(*alerts):
    return n.parse_payload(payload(*alerts))


# ---------------------------------------------------------------- tests
class ConfigTests(unittest.TestCase):
    def test_nothing_configured_enables_nothing(self):
        self.assertEqual(n.Config.from_env({}).enabled_channels(), [])

    def test_channels_need_all_their_settings(self):
        cfg = n.Config.from_env({"SMTP_HOST": "x", "EMAIL_TO": "a@b.co", "SMS_TO": "+14155550101", "TWILIO_ACCOUNT_SID": "AC1"})
        self.assertFalse(cfg.enabled("email"))  # no SMTP_FROM
        self.assertIn("SMTP_FROM", cfg.missing("email"))
        self.assertFalse(cfg.enabled("sms"))
        self.assertEqual(set(cfg.partially_configured()), {"email", "sms"})

    def test_messaging_service_replaces_from_number(self):
        cfg = n.Config.from_env({"TWILIO_ACCOUNT_SID": "AC1", "TWILIO_AUTH_TOKEN": "t", "SMS_TO": "+14155550101", "TWILIO_MESSAGING_SERVICE_SID": "MG1"})
        self.assertTrue(cfg.enabled("sms"))

    def test_validation(self):
        for bad in ({"SMS_TO": "0123"}, {"EMAIL_TO": "not-an-email"}, {"NOTIFY_SMS_MIN_SEVERITY": "urgent"},
                    {"SMTP_SECURITY": "tls13"}, {"NOTIFIER_PORT": "abc"}, {"NOTIFY_RESOLVED": "pager"}, {"TWILIO_API_BASE": "ftp://x"}):
            with self.subTest(bad=bad), self.assertRaises(n.ConfigError):
                n.Config.from_env(bad)

    def test_whatsapp_prefix_is_accepted(self):
        cfg = n.Config.from_env({"WHATSAPP_TO": "whatsapp:+14155550101", "WHATSAPP_FROM": "whatsapp:+14155238886"})
        self.assertEqual(cfg.whatsapp_to, ("+14155550101",))


class RoutingTests(unittest.TestCase):
    def test_severity_floor_per_channel(self):
        cfg = n.Config.from_env(env())
        alerts = parse(alert("A", "critical"), alert("B", "warning"), alert("C", "info"))
        self.assertEqual([a.name for a in n.select_for_channel(cfg, "email", alerts)[0]], ["A", "B"])
        self.assertEqual([a.name for a in n.select_for_channel(cfg, "sms", alerts)[0]], ["A"])

    def test_resolved_only_where_requested(self):
        alerts = parse(alert("A", "critical", "resolved"))
        cfg = n.Config.from_env(env())
        self.assertEqual(len(n.select_for_channel(cfg, "email", alerts)[1]), 1)
        self.assertEqual(n.select_for_channel(cfg, "sms", alerts), ([], []))
        cfg = n.Config.from_env(env(NOTIFY_RESOLVED="email,sms"))
        self.assertEqual(len(n.select_for_channel(cfg, "sms", alerts)[1]), 1)
        self.assertEqual(n.select_for_channel(n.Config.from_env(env(NOTIFY_RESOLVED="")), "email", alerts), ([], []))

    def test_bad_payload(self):
        with self.assertRaises(ValueError):
            n.parse_payload({"nope": 1})
        with self.assertRaises(ValueError):
            n.parse_payload([])

    def test_unknown_severity_becomes_warning_and_time_parsed(self):
        a = parse(alert("A", "page-me-now"))[0]
        self.assertEqual(a.severity, "warning")
        self.assertEqual((a.started.hour, a.started.minute), (2, 14))


class FormatTests(unittest.TestCase):
    cfg = n.Config.from_env({"DASHBOARD_URL": "https://eaziguard.khaw.cc"})

    def test_sms_is_short_ascii_and_mentions_extras(self):
        firing, _ = n.select_for_channel(n.Config.from_env({}), "email", parse(
            alert("HighGatewayPacketLoss", "critical", summary="1.7% packet loss ≥ 1% to gateway 10.0.0.1 — check ISP"), alert("B", "warning"), alert("C", "warning")))
        text = n.format_sms(self.cfg, firing, [])
        self.assertTrue(text.isascii())
        self.assertIn("CRITICAL: HighGatewayPacketLoss", text)
        self.assertIn("(+2 more)", text)
        self.assertLessEqual(len(text), n.SMS_MAX_CHARS)

    def test_sms_truncates(self):
        a = parse(alert("A", "critical", summary="x" * 900))
        text = n.format_sms(self.cfg, a, [])
        self.assertEqual(len(text), n.SMS_MAX_CHARS)
        self.assertTrue(text.endswith("..."))

    def test_email_subject_and_html_escaping(self):
        a = parse(alert("A", "critical", summary="<script>alert(1)</script>"), alert("B", "warning"))
        subject, text, page = n.format_email(self.cfg, a, [])
        self.assertEqual(subject, "[eaziguard] 1 critical, 1 warning firing")
        self.assertNotIn("<script>", page)
        self.assertIn("&lt;script&gt;", page)
        self.assertIn("https://eaziguard.khaw.cc", text)

    def test_email_resolved_subject(self):
        subject, _, _ = n.format_email(self.cfg, [], parse(alert("A", "critical", "resolved")))
        self.assertEqual(subject, "[eaziguard] Resolved: A")

    def test_whatsapp_caps_the_list(self):
        many = parse(*[alert(f"A{i}", "warning") for i in range(12)])
        text = n.format_whatsapp(self.cfg, many, [])
        self.assertEqual(text.count("•"), n.WHATSAPP_MAX_LISTED)
        self.assertIn("(+4 more)", text)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.smtp, self.twilio = FakeSMTP(), FakeTwilio()
        self.addCleanup(self.smtp.close)
        self.addCleanup(self.twilio.close)

    def dispatcher(self, **extra):
        return n.Dispatcher(n.Config.from_env(env(self.smtp, self.twilio, **extra)))

    def test_critical_reaches_all_three_channels(self):
        out = self.dispatcher().dispatch(parse(alert("HighGatewayPacketLoss", "critical", instance="10.0.0.1")))
        self.assertEqual(out, {"email": "sent", "sms": "sent", "whatsapp": "sent"})

        mail = self.smtp.messages[0]
        self.assertEqual(sorted(mail["to"]), ["noc@campus.test", "ops@campus.test"])
        msg = email.message_from_bytes(mail["raw"], policy=policy.default)
        self.assertEqual(msg["Subject"], "[eaziguard] 1 critical firing")
        self.assertIn("HighGatewayPacketLoss", msg.get_body(("plain",)).get_content())
        self.assertIn("<strong>HighGatewayPacketLoss</strong>", msg.get_body(("html",)).get_content())

        sms = [r for r in self.twilio.requests if not r["fields"]["To"].startswith("whatsapp:")]
        wa = [r for r in self.twilio.requests if r["fields"]["To"].startswith("whatsapp:")]
        self.assertEqual(sorted(r["fields"]["To"] for r in sms), ["+14155550101", "+14155550102"])
        self.assertEqual(sms[0]["fields"]["From"], "+15005550006")
        self.assertEqual(sms[0]["path"], "/2010-04-01/Accounts/ACtest/Messages.json")
        self.assertEqual(base64.b64decode(sms[0]["auth"].split()[1]).decode(), "ACtest:secret-token")
        self.assertEqual(wa[0]["fields"]["To"], "whatsapp:+14155550101")
        self.assertEqual(wa[0]["fields"]["From"], "whatsapp:+14155238886")
        self.assertIn("HighGatewayPacketLoss", wa[0]["fields"]["Body"])

    def test_warning_goes_to_email_only(self):
        out = self.dispatcher().dispatch(parse(alert("DNSLookupSlow", "warning")))
        self.assertEqual(out, {"email": "sent", "sms": "skipped", "whatsapp": "skipped"})
        self.assertEqual(self.twilio.requests, [])

    def test_whatsapp_template_mode(self):
        d = self.dispatcher(TWILIO_WHATSAPP_CONTENT_SID="HXabc")
        d.dispatch(parse(alert("A", "critical")))
        wa = [r for r in self.twilio.requests if r["fields"]["To"].startswith("whatsapp:")][0]["fields"]
        self.assertEqual(wa["ContentSid"], "HXabc")
        self.assertNotIn("Body", wa)
        self.assertIn("A", json.loads(wa["ContentVariables"])["1"])

    def test_messaging_service_used_instead_of_from(self):
        d = self.dispatcher(TWILIO_MESSAGING_SERVICE_SID="MG1")
        d.dispatch(parse(alert("A", "critical")))
        sms = [r for r in self.twilio.requests if not r["fields"]["To"].startswith("whatsapp:")][0]["fields"]
        self.assertEqual(sms["MessagingServiceSid"], "MG1")
        self.assertNotIn("From", sms)

    def test_hourly_cap_drops_and_counts(self):
        d = self.dispatcher(NOTIFY_SMS_MAX_PER_HOUR="2")  # two recipients = one alert group per hour
        self.assertEqual(d.dispatch(parse(alert("A", "critical")))["sms"], "sent")
        self.assertEqual(d.dispatch(parse(alert("B", "critical")))["sms"], "rate_limited")
        self.assertIn('notifier_messages_rate_limited_total{channel="sms"} 1', d.metrics.render())

    def test_rate_limiter_window(self):
        now = [0.0]
        limiter = n.RateLimiter(2, clock=lambda: now[0])
        self.assertTrue(limiter.take(2))
        self.assertFalse(limiter.take(1))
        now[0] = 3601
        self.assertTrue(limiter.take(2))

    def test_one_bad_recipient_does_not_block_the_other(self):
        self.twilio.fail_numbers = {"+14155550101"}
        d = self.dispatcher()
        out = d.dispatch(parse(alert("A", "critical")))
        self.assertEqual(out["sms"], "sent")
        self.assertIn('notifier_messages_failed_total{channel="sms"} 1', d.metrics.render())

    def test_failures_are_reported_and_secrets_not_logged(self):
        bad = FakeTwilio(status=401)
        self.addCleanup(bad.close)
        cfg = n.Config.from_env(env(self.smtp, bad))
        with self.assertLogs("notifier", level="ERROR") as logs:
            out = n.Dispatcher(cfg).dispatch(parse(alert("A", "critical")))
        self.assertEqual((out["sms"], out["whatsapp"], out["email"]), ("failed", "failed", "sent"))
        joined = "\n".join(logs.output)
        self.assertNotIn("secret-token", joined)
        self.assertNotIn("+14155550101", joined)
        self.assertIn("0101", joined)  # masked, last four digits only

    def test_smtp_down_is_a_delivery_failure(self):
        cfg = n.Config.from_env(env(self.smtp, SMTP_PORT=str(_closed_port())))
        with self.assertLogs("notifier", level="ERROR"):
            out = n.Dispatcher(cfg).dispatch(parse(alert("A", "warning")))
        self.assertEqual(out["email"], "failed")


def _closed_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.smtp, self.twilio = FakeSMTP(), FakeTwilio()
        self.addCleanup(self.smtp.close)
        self.addCleanup(self.twilio.close)

    def serve(self, cfg):
        server = HTTPServer(("127.0.0.1", 0), n.make_handler(n.Dispatcher(cfg)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

    def post(self, base, body, path="/alerts", raw=None):
        data = raw if raw is not None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_webhook_end_to_end_and_endpoints(self):
        base = self.serve(n.Config.from_env(env(self.smtp, self.twilio)))
        status, body = self.post(base, payload(alert("A", "critical")))
        self.assertEqual((status, body["outcome"]["sms"]), (200, "sent"))
        with urllib.request.urlopen(base + "/healthz") as r:
            self.assertEqual(json.loads(r.read())["channels"], ["email", "sms", "whatsapp"])
        with urllib.request.urlopen(base + "/metrics") as r:
            self.assertIn('notifier_messages_sent_total{channel="email"} 1', r.read().decode())

    def test_all_channels_failing_returns_502_so_alertmanager_retries(self):
        bad = FakeTwilio(status=500)
        self.addCleanup(bad.close)
        base = self.serve(n.Config.from_env(env(twilio=bad)))
        with self.assertLogs("notifier", level="ERROR"):
            status, body = self.post(base, payload(alert("A", "critical")))
        self.assertEqual(status, 502)

    def test_partial_failure_returns_200_to_avoid_duplicates(self):
        bad = FakeTwilio(status=500)
        self.addCleanup(bad.close)
        base = self.serve(n.Config.from_env(env(self.smtp, bad)))
        with self.assertLogs("notifier", level="ERROR"):
            status, body = self.post(base, payload(alert("A", "critical")))
        self.assertEqual((status, body["outcome"]["email"], body["outcome"]["sms"]), (200, "sent", "failed"))

    def test_bad_requests(self):
        base = self.serve(n.Config.from_env({}))
        self.assertEqual(self.post(base, None, raw=b"not json")[0], 400)
        self.assertEqual(self.post(base, {"alerts": "x"})[0], 400)
        self.assertEqual(self.post(base, {}, path="/elsewhere")[0], 404)

    def test_nothing_configured_accepts_and_drops(self):
        base = self.serve(n.Config.from_env({}))
        self.assertEqual(self.post(base, payload(alert("A", "critical"))), (200, {"outcome": {}}))


if __name__ == "__main__":
    unittest.main()
