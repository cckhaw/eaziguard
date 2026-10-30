"""End-to-end tests for probe.py against in-process mock DHCP/DNS/portal/RADIUS servers.

Run:  python -m unittest discover -s tests -v      (from edge-probe/)
Uses loopback and unprivileged high ports only.
"""

import hashlib
import hmac
import os
import socket
import struct
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import dns.message
import dns.rcode
import dns.rrset

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import probe  # noqa: E402

SECRET = b"testing123"
MAC_IFACE = next(
    (n for n in os.listdir("/sys/class/net") if n != "lo" and probe.read_interface_mac(n)), None
) if os.path.isdir("/sys/class/net") else None


def free_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class UdpServer(threading.Thread):
    """Runs handler(data, addr, sock) for each datagram until stopped."""

    def __init__(self, handler):
        super().__init__(daemon=True)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.handler = handler
        self.running = True

    def run(self):
        while self.running:
            try:
                data, addr = self.sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            self.handler(data, addr, self.sock)

    def stop(self):
        self.running = False
        self.join(timeout=2)
        self.sock.close()


def base_env(**extra):
    env = {
        "PROBE_ZONE": "unit-test",
        "PROBE_INTERFACE": MAC_IFACE or "eth0",
        "DHCP_ENABLED": "false",
        "DNS_ENABLED": "false",
        "PORTAL_ENABLED": "false",
        "RADIUS_ENABLED": "false",
    }
    env.update(extra)
    return env


def run_with_env(env, fn):
    saved = dict(os.environ)
    for key in [k for k in os.environ if k.startswith(("PROBE_", "DHCP_", "DNS_", "PORTAL_", "RADIUS_", "METRICS_"))]:
        del os.environ[key]
    os.environ.update(env)
    try:
        return fn(probe.Config.from_env())
    finally:
        os.environ.clear()
        os.environ.update(saved)


def by_name(samples):
    out = {}
    for s in samples:
        out.setdefault(s.name, []).append(s)
    return out


class ConfigTests(unittest.TestCase):
    def test_zone_required(self):
        with self.assertRaises(probe.ConfigError):
            run_with_env({"PROBE_ZONE": ""}, lambda c: c)

    def test_bad_boolean(self):
        with self.assertRaises(probe.ConfigError):
            run_with_env(base_env(DHCP_ENABLED="maybe"), lambda c: c)

    def test_radius_needs_secret(self):
        with self.assertRaises(probe.ConfigError):
            run_with_env(base_env(RADIUS_ENABLED="true", RADIUS_SERVERS="127.0.0.1"), lambda c: c)


@unittest.skipIf(MAC_IFACE is None, "needs a NIC with a MAC address")
class DhcpTests(unittest.TestCase):
    def mock_server(self, client_port, nak=False, wrong_xid=False):
        events = []

        def handler(data, addr, sock):
            msg_type = None
            pos = probe._DHCP_HEADER.size
            while data[pos] != 255:
                code, length = data[pos], data[pos + 1]
                if code == 53:
                    msg_type = data[pos + 2]
                pos += 2 + length
            events.append(msg_type)
            xid = struct.unpack("!I", data[4:8])[0]
            chaddr = data[28:34]
            reply_type = {probe.DHCPDISCOVER: probe.DHCPOFFER, probe.DHCPREQUEST: probe.DHCPACK}.get(msg_type)
            if reply_type is None:
                return
            if nak and msg_type == probe.DHCPREQUEST:
                reply_type = probe.DHCPNAK
            header = probe._DHCP_HEADER.pack(
                2, 1, 6, 0, xid + 1 if wrong_xid else xid, 0, 0x8000, bytes(4),
                socket.inet_aton("192.0.2.77"), socket.inet_aton("127.0.0.1"), bytes(4),
                chaddr.ljust(16, b"\0"), bytes(64), bytes(128), probe.DHCP_MAGIC_COOKIE,
            )
            opts = bytes([53, 1, reply_type, 54, 4]) + socket.inet_aton("127.0.0.1") + bytes([51, 4]) + struct.pack("!I", 3600) + b"\xff"
            sock.sendto(header + opts, ("127.0.0.1", client_port))

        return UdpServer(handler), events

    def run_dhcp(self, mode="discover", **kw):
        client_port = free_udp_port()
        server, events = self.mock_server(client_port, **kw)
        server.start()
        try:
            env = base_env(
                DHCP_ENABLED="true", DHCP_MODE=mode, DHCP_BIND_TO_DEVICE="false",
                DHCP_SERVER_PORT=str(server.port), DHCP_CLIENT_PORT=str(client_port),
                DHCP_BROADCAST_ADDRESS="127.0.0.1", DHCP_TIMEOUT_SECONDS="1",
            )
            return by_name(run_with_env(env, probe.run_dhcp_test)), events
        finally:
            server.stop()

    def test_discover_offer(self):
        samples, events = self.run_dhcp()
        self.assertEqual(samples["edgeprobe_dhcp_success"][0].value, 1)
        self.assertIn("edgeprobe_dhcp_offer_seconds", samples)
        self.assertNotIn("edgeprobe_dhcp_ack_seconds", samples)
        self.assertEqual(events, [probe.DHCPDISCOVER])

    def test_full_handshake_releases(self):
        samples, events = self.run_dhcp(mode="full")
        self.assertEqual(samples["edgeprobe_dhcp_success"][0].value, 1)
        self.assertIn("edgeprobe_dhcp_ack_seconds", samples)
        # release is sent unicast to server id (127.0.0.1:server port) - allow it to arrive
        self.assertEqual(events[:2], [probe.DHCPDISCOVER, probe.DHCPREQUEST])

    def test_nak_fails(self):
        samples, _ = self.run_dhcp(mode="full", nak=True)
        self.assertEqual(samples["edgeprobe_dhcp_success"][0].value, 0)

    def test_foreign_xid_is_ignored_then_times_out(self):
        samples, _ = self.run_dhcp(wrong_xid=True)
        self.assertEqual(samples["edgeprobe_dhcp_success"][0].value, 0)
        self.assertNotIn("edgeprobe_dhcp_offer_seconds", samples)

    def test_no_server(self):
        env = base_env(
            DHCP_ENABLED="true", DHCP_BIND_TO_DEVICE="false", DHCP_SERVER_PORT=str(free_udp_port()),
            DHCP_CLIENT_PORT=str(free_udp_port()), DHCP_BROADCAST_ADDRESS="127.0.0.1", DHCP_TIMEOUT_SECONDS="1",
        )
        samples = by_name(run_with_env(env, probe.run_dhcp_test))
        self.assertEqual(samples["edgeprobe_dhcp_success"][0].value, 0)


class DnsTests(unittest.TestCase):
    @staticmethod
    def handler(data, addr, sock):
        query = dns.message.from_wire(data)
        response = dns.message.make_response(query)
        name = query.question[0].name.to_text()
        if name.startswith("good."):
            response.answer.append(dns.rrset.from_text(query.question[0].name, 60, "IN", "A", "192.0.2.10"))
        else:
            response.set_rcode(dns.rcode.NXDOMAIN)
        sock.sendto(response.to_wire(), addr)

    def test_success_and_failure(self):
        server = UdpServer(self.handler)
        server.start()
        try:
            # dnspython resolver can only target port 53 via nameserver list; use `nameserver_ports`.
            env = base_env(DNS_ENABLED="true", DNS_RESOLVERS="127.0.0.1", DNS_DOMAINS="good.example.test,bad.example.test", DNS_TIMEOUT_SECONDS="1")

            original = probe.dns.resolver.Resolver

            class PortResolver(original):
                def __init__(self, *a, **k):
                    super().__init__(*a, **k)
                    self.nameserver_ports = {"127.0.0.1": server.port}

            probe.dns.resolver.Resolver = PortResolver
            try:
                samples = by_name(run_with_env(env, probe.run_dns_test))
            finally:
                probe.dns.resolver.Resolver = original
            ok = {dict(s.labels)["domain"]: s.value for s in samples["edgeprobe_dns_success"]}
            self.assertEqual(ok, {"good.example.test": 1.0, "bad.example.test": 0.0})
            self.assertEqual(len(samples["edgeprobe_dns_resolution_seconds"]), 2)
        finally:
            server.stop()


class PortalTests(unittest.TestCase):
    def serve(self, routes):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                status, headers, body = routes.get(self.path, (404, {}, b""))
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        httpd = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return f"http://127.0.0.1:{httpd.server_port}"

    def run_portal(self, url, **extra):
        env = base_env(PORTAL_ENABLED="true", PORTAL_CHECK_URL=url, PORTAL_TIMEOUT_SECONDS="2", **extra)
        return {k: v[0].value for k, v in by_name(run_with_env(env, probe.run_portal_test)).items()}

    def test_healthy_portal(self):
        routes = {"/check": (302, {"Location": "/login"}, b""), "/login": (200, {}, b"<html>login</html>")}
        base = self.serve(routes)
        m = self.run_portal(base + "/check")
        self.assertEqual(m["edgeprobe_captive_portal_up"], 1)
        self.assertEqual(m["edgeprobe_captive_portal_redirect_detected"], 1)
        self.assertEqual(m["edgeprobe_captive_portal_page_http_status"], 200)

    def test_portal_page_error(self):
        base = self.serve({"/check": (302, {"Location": "/login"}, b""), "/login": (500, {}, b"boom")})
        m = self.run_portal(base + "/check")
        self.assertEqual(m["edgeprobe_captive_portal_up"], 0)
        self.assertEqual(m["edgeprobe_captive_portal_redirect_detected"], 1)

    def test_no_redirect_is_failure_when_expected(self):
        base = self.serve({"/check": (204, {}, b"")})
        self.assertEqual(self.run_portal(base + "/check")["edgeprobe_captive_portal_up"], 0)

    def test_no_redirect_ok_when_not_expected(self):
        base = self.serve({"/check": (204, {}, b"")})
        m = self.run_portal(base + "/check", PORTAL_EXPECT_REDIRECT="false")
        self.assertEqual(m["edgeprobe_captive_portal_up"], 1)
        self.assertEqual(m["edgeprobe_captive_portal_redirect_detected"], 0)

    def test_unexpected_redirect_host(self):
        base = self.serve({"/check": (302, {"Location": "http://evil.example/"}, b"")})
        m = self.run_portal(base + "/check", PORTAL_EXPECTED_HOST="portal.campus.example.edu")
        self.assertEqual(m["edgeprobe_captive_portal_up"], 0)

    def test_connection_refused(self):
        m = self.run_portal("http://127.0.0.1:1/check")
        self.assertEqual(m["edgeprobe_captive_portal_up"], 0)
        self.assertEqual(m["edgeprobe_captive_portal_check_http_status"], 0)


class RadiusTests(unittest.TestCase):
    @staticmethod
    def make_handler(secret=SECRET, code=probe.RADIUS_ACCESS_REJECT, delay=0.0):
        def handler(data, addr, sock):
            c, ident, length = struct.unpack("!BBH", data[:4])
            req_auth = data[4:20]
            attrs = data[20:length]
            # Validate the Message-Authenticator exactly as a real server would.
            pos, ma = 0, None
            while pos < len(attrs):
                t, l = attrs[pos], attrs[pos + 1]
                if t == 80:
                    ma, ma_pos = attrs[pos + 2 : pos + 2 + l - 2], pos
                pos += l
            zeroed = data[:20] + attrs[:ma_pos] + bytes([80, 18]) + bytes(16) + attrs[ma_pos + 18 :]
            if ma != hmac.new(secret, zeroed, hashlib.md5).digest():
                return  # real servers silently drop packets that fail MA validation
            if delay:
                import time
                time.sleep(delay)
            resp = struct.pack("!BBH", code, ident, 20) + req_auth
            resp_auth = hashlib.md5(resp[:4] + req_auth + secret).digest()
            sock.sendto(resp[:4] + resp_auth, addr)
        return handler

    def run_radius(self, server, secret="testing123", timeout="1"):
        env = base_env(
            RADIUS_ENABLED="true", RADIUS_SERVERS="127.0.0.1", RADIUS_PORT=str(server.port),
            RADIUS_SECRET=secret, RADIUS_TIMEOUT_SECONDS=timeout,
        )
        return {k: v[0].value for k, v in by_name(run_with_env(env, probe.run_radius_test)).items()}

    def test_reject_counts_as_responsive(self):
        server = UdpServer(self.make_handler())
        server.start()
        try:
            m = self.run_radius(server)
            self.assertEqual(m["edgeprobe_radius_success"], 1)
            self.assertEqual(m["edgeprobe_radius_response_code"], 3)
            self.assertLess(m["edgeprobe_radius_response_seconds"], 0.5)
        finally:
            server.stop()

    def test_latency_is_measured(self):
        server = UdpServer(self.make_handler(delay=0.3))
        server.start()
        try:
            m = self.run_radius(server, timeout="2")
            self.assertGreaterEqual(m["edgeprobe_radius_response_seconds"], 0.3)
        finally:
            server.stop()

    def test_wrong_secret_fails(self):
        server = UdpServer(self.make_handler())
        server.start()
        try:
            m = self.run_radius(server, secret="wrong")
            self.assertEqual(m["edgeprobe_radius_success"], 0)
        finally:
            server.stop()


class CollectorTests(unittest.TestCase):
    def test_snapshot_replaces_previous_labels(self):
        c = probe.SnapshotCollector()
        c.publish([probe.Sample.of("edgeprobe_x", "h", 1, resolver="a")])
        c.publish([probe.Sample.of("edgeprobe_x", "h", 2, resolver="b")])
        fams = list(c.collect())
        self.assertEqual([s.labels for s in fams[0].samples], [{"resolver": "b"}])

    def test_full_cycle_has_meta_metrics(self):
        cfg = run_with_env(base_env(), lambda c: c)
        names = {s.name for s in probe.collect_cycle(cfg)}
        self.assertTrue({"edgeprobe_info", "edgeprobe_last_run_timestamp_seconds", "edgeprobe_run_duration_seconds"} <= names)


if __name__ == "__main__":
    unittest.main()
