"""Demo-only fake Prometheus for the CampusNet-Sentinel dashboard (standard library only).

Serves the two endpoints the dashboard uses (POST /api/v1/query, GET /api/v1/alerts)
with canned campus data, and enforces the same bearer token as the real gateway.
Never deploy this; it exists so the UI can be previewed without a monitoring server.

    python3 mock-prometheus.py PORT [mixed|healthy]
"""
import json, sys, time, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
TOKEN = "demo-token"
SCENARIO = sys.argv[2] if len(sys.argv) > 2 else "mixed"
import random
def vec(v, **labels):
    if isinstance(v, float) or v > 5: v = round(v * random.uniform(0.9, 1.1), 2)
    return {"metric": labels, "value": [time.time(), str(v)]}
# (substring in query) -> result list; first match wins, no match -> empty vector
def answer(q):
    t = [
      ('min(probe_success{job="blackbox-icmp-gateway"})', [vec(1)]),
      ('campus:gateway_packet_loss', [vec(1.7)]),
      ('probe_icmp_duration_seconds', [vec(8.4)]),
      ('sum(probe_success{job=~"blackbox-dns', [vec(4)]),
      ('count(probe_success{job=~"blackbox-dns', [vec(4)]),
      ('max(probe_duration_seconds', [vec(21)]),
      ('max(edgeprobe_dns_resolution_seconds) *', [vec(34)]),
      ('campus:dhcp_scope_usage', [vec(88.2)]),
      ('max(edgeprobe_dhcp_offer_seconds) *', [vec(180)]),
      ('count(edgeprobe_dhcp_success == 0)', [vec(0)]),
      ('count(edgeprobe_dhcp_success)', [vec(3)]),
      ('sum(probe_success{job="blackbox-icmp-ap"})', [vec(41)]),
      ('count(probe_success{job="blackbox-icmp-ap"})', [vec(42)]),
      ('role="wifi-controller"', [vec(1)]),
      ('sum(probe_success{job="blackbox-icmp-infra",role=~"core', [vec(5)]),
      ('count(probe_success{job="blackbox-icmp-infra",role=~"core', [vec(5)]),
      ('ALERTS{alertname="CoreSwitchInterfaceErrors"', [vec(1)]),
      ('max(edgeprobe_radius_response_seconds) *', [vec(120)]),
      ('sum(probe_success{job="blackbox-icmp-infra",role="radius', [vec(2)]),
      ('count(probe_success{job="blackbox-icmp-infra",role="radius', [vec(2)]),
      ('blackbox-http-portal-redirect', [vec(1)]),
      ('blackbox-http-portal-page', [vec(1)]),
      ('sum(edgeprobe_captive_portal_up)', [vec(2)]),
      ('count(edgeprobe_captive_portal_up)', [vec(3)]),
      ('max(edgeprobe_captive_portal_response_seconds)', [vec(640)]),
      ('max by (zone) (up{job="edge-probe"})', [vec(1, zone="dorm-a"), vec(1, zone="library"), vec(0, zone="lecture-hall-1")]),
      ('max by (zone) (edgeprobe_dhcp_offer_seconds)', [vec(120, zone="dorm-a"), vec(180, zone="library")]),
      ('max by (zone) (edgeprobe_dns_resolution_seconds)', [vec(30, zone="dorm-a"), vec(34, zone="library")]),
      ('min by (zone) (edgeprobe_captive_portal_up)', [vec(1, zone="dorm-a"), vec(0, zone="library")]),
      ('max by (zone) (edgeprobe_radius_response_seconds)', [vec(110, zone="dorm-a")]),
    ]
    for k, r in t:
        if k in q: return r
    return []
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 600))
ALERTS = [
 {"labels": {"alertname": "HighGatewayPacketLoss", "severity": "critical", "component": "gateway", "instance": "10.0.0.1"},
  "annotations": {"summary": "1.7% packet loss to gateway 10.0.0.1", "description": "More than 1% of probes to the internet gateway were lost over the last 3 minutes."}, "state": "firing", "activeAt": now, "value": "1.7"},
 {"labels": {"alertname": "DHCPPoolExhaustionWarning", "severity": "warning", "component": "dhcp", "subnet": "10.20.0.0/22"},
  "annotations": {"summary": "DHCP scope 10.20.0.0/22 is 88% full", "description": "Scope has stayed above 85% for 5 minutes."}, "state": "firing", "activeAt": now, "value": "0.88"},
 {"labels": {"alertname": "APOffline", "severity": "critical", "component": "wifi", "instance": "10.10.3.21"},
  "annotations": {"summary": "Access point ap-hall-101-01 (10.10.3.21) offline", "description": "No ICMP heartbeat for over 90 seconds."}, "state": "pending", "activeAt": now, "value": "0"},
 {"labels": {"alertname": "CoreSwitchInterfaceErrors", "severity": "warning", "component": "switch", "instance": "10.0.2.12"},
  "annotations": {"summary": "crc on 10.0.2.12 Gi1/0/24 (0.45/s)", "description": "Sustained CRC errors."}, "state": "firing", "activeAt": now, "value": "0.45"},
 {"labels": {"alertname": "ZoneCaptivePortalFailure", "severity": "critical", "component": "portal", "zone": "library"},
  "annotations": {"summary": "Captive portal broken as seen from library", "description": "no redirect"}, "state": "firing", "activeAt": now, "value": "0"},
]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def authed(self):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send(401, {"status": "error"}); return False
        return True
    def do_GET(self):
        if not self.authed(): return
        if self.path == "/api/v1/alerts":
            self.send(200, {"status": "success", "data": {"alerts": ALERTS if SCENARIO != "healthy" else []}})
        else: self.send(404, {})
    def do_POST(self):
        if not self.authed(): return
        n = int(self.headers.get("Content-Length", 0)); body = urllib.parse.parse_qs(self.rfile.read(n).decode())
        if self.path != "/api/v1/query": return self.send(404, {})
        self.send(200, {"status": "success", "data": {"resultType": "vector", "result": answer(body["query"][0])}})
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
