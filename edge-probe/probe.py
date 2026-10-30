#!/usr/bin/env python3
"""eaziguard edge probe.

Runs on a Raspberry Pi / mini PC plugged into a client VLAN (dorm, library,
lecture hall) and behaves like a student device: it asks for a DHCP lease, resolves
names through the campus resolvers, requests a connectivity-check URL to see whether
the captive portal redirects, and (optionally) performs a RADIUS round trip. The
results are published as Prometheus gauges on ``:8000/metrics``.

Every test cycle produces an atomic snapshot of all samples, so a scrape never sees
a half-updated cycle and stale label sets disappear on their own.

The ``zone`` label is NOT attached here: Prometheus adds it from the target file
(``docker/prometheus/targets/edge_probes.yml``). ``edgeprobe_info`` carries the
locally configured zone (``probe_zone``) so mismatches are easy to spot.

Privileges: DHCP needs to bind UDP/68 (CAP_NET_BIND_SERVICE) and pin the socket to a
NIC (CAP_NET_RAW). The systemd unit shipped next to this file grants exactly those two
capabilities to an unprivileged user.

Usage:
    probe.py            # run forever
    probe.py --once     # run one cycle, print the metrics and exit (debugging)
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import logging
import os
import secrets
import signal
import socket
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import dns.exception
import dns.resolver
import requests
from prometheus_client import CollectorRegistry, start_http_server
from prometheus_client.core import GaugeMetricFamily
from prometheus_client.exposition import generate_latest

VERSION = "1.0.0"
LOG = logging.getLogger("edge-probe")


# ============================================================================
# Configuration
# ============================================================================
class ConfigError(Exception):
    """Raised for invalid or missing configuration; the process exits with code 2."""


def _env_str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{name}={raw!r} is not a boolean (use true/false)")


def _env_number(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name}={raw!r} is not a number") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name}={value} must be between {minimum} and {maximum}")
    return value


def _env_csv(name: str) -> List[str]:
    return [part.strip() for part in os.environ.get(name, "").split(",") if part.strip()]


@dataclass(frozen=True)
class Config:
    zone: str
    interface: str
    interval: float
    bind_address: str
    metrics_port: int

    dhcp_enabled: bool
    dhcp_mode: str  # "discover" or "full"
    dhcp_timeout: float
    dhcp_server_port: int
    dhcp_client_port: int
    dhcp_broadcast: str
    dhcp_bind_to_device: bool

    dns_enabled: bool
    dns_resolvers: List[str]
    dns_domains: List[str]
    dns_timeout: float

    portal_enabled: bool
    portal_url: str
    portal_expected_host: str
    portal_expect_redirect: bool
    portal_timeout: float
    portal_verify_tls: bool

    radius_enabled: bool
    radius_servers: List[str]
    radius_port: int
    radius_secret: bytes = field(repr=False)
    radius_username: str = "eaziguard-probe"
    radius_password: str = field(default="", repr=False)
    radius_timeout: float = 3.0

    @staticmethod
    def from_env() -> "Config":
        zone = _env_str("PROBE_ZONE")
        if not zone:
            raise ConfigError("PROBE_ZONE is required (e.g. library, dorm-a)")

        dhcp_mode = _env_str("DHCP_MODE", "discover").lower()
        if dhcp_mode not in ("discover", "full"):
            raise ConfigError("DHCP_MODE must be 'discover' or 'full'")

        dns_resolvers = _env_csv("DNS_RESOLVERS")
        for resolver in dns_resolvers:
            try:
                ipaddress.ip_address(resolver)
            except ValueError as exc:
                raise ConfigError(f"DNS_RESOLVERS entry {resolver!r} is not an IP address") from exc

        portal_url = _env_str("PORTAL_CHECK_URL", "http://connectivitycheck.gstatic.com/generate_204")
        if urlparse(portal_url).scheme not in ("http", "https") or not urlparse(portal_url).hostname:
            raise ConfigError("PORTAL_CHECK_URL must be an http(s) URL")

        radius_enabled = _env_bool("RADIUS_ENABLED", False)
        radius_servers = _env_csv("RADIUS_SERVERS")
        radius_secret = _env_str("RADIUS_SECRET")
        if radius_enabled:
            if not radius_servers:
                raise ConfigError("RADIUS_ENABLED=true requires RADIUS_SERVERS")
            if not radius_secret:
                raise ConfigError("RADIUS_ENABLED=true requires RADIUS_SECRET")

        dns_domains = _env_csv("DNS_DOMAINS") or ["www.wikipedia.org"]

        return Config(
            zone=zone,
            interface=_env_str("PROBE_INTERFACE", "eth0"),
            interval=_env_number("PROBE_INTERVAL_SECONDS", 30, 5, 3600),
            bind_address=_env_str("METRICS_BIND_ADDRESS", "0.0.0.0"),
            metrics_port=int(_env_number("METRICS_PORT", 8000, 1, 65535)),
            dhcp_enabled=_env_bool("DHCP_ENABLED", True),
            dhcp_mode=dhcp_mode,
            dhcp_timeout=_env_number("DHCP_TIMEOUT_SECONDS", 5, 1, 60),
            dhcp_server_port=int(_env_number("DHCP_SERVER_PORT", 67, 1, 65535)),
            dhcp_client_port=int(_env_number("DHCP_CLIENT_PORT", 68, 1, 65535)),
            dhcp_broadcast=_env_str("DHCP_BROADCAST_ADDRESS", "255.255.255.255"),
            dhcp_bind_to_device=_env_bool("DHCP_BIND_TO_DEVICE", True),
            dns_enabled=_env_bool("DNS_ENABLED", True),
            dns_resolvers=dns_resolvers,
            dns_domains=dns_domains,
            dns_timeout=_env_number("DNS_TIMEOUT_SECONDS", 3, 0.5, 30),
            portal_enabled=_env_bool("PORTAL_ENABLED", True),
            portal_url=portal_url,
            portal_expected_host=_env_str("PORTAL_EXPECTED_HOST").lower(),
            portal_expect_redirect=_env_bool("PORTAL_EXPECT_REDIRECT", True),
            portal_timeout=_env_number("PORTAL_TIMEOUT_SECONDS", 8, 1, 60),
            portal_verify_tls=_env_bool("PORTAL_VERIFY_TLS", True),
            radius_enabled=radius_enabled,
            radius_servers=radius_servers,
            radius_port=int(_env_number("RADIUS_PORT", 1812, 1, 65535)),
            radius_secret=radius_secret.encode(),
            radius_username=_env_str("RADIUS_TEST_USERNAME", "eaziguard-probe"),
            radius_password=_env_str("RADIUS_TEST_PASSWORD", "not-a-real-password"),
            radius_timeout=_env_number("RADIUS_TIMEOUT_SECONDS", 3, 0.5, 30),
        )


# ============================================================================
# Sample plumbing: tests return samples, the collector serves the last snapshot
# ============================================================================
@dataclass(frozen=True)
class Sample:
    name: str
    help: str
    value: float
    labels: Tuple[Tuple[str, str], ...] = ()

    @staticmethod
    def of(name: str, help_text: str, value: float, **labels: str) -> "Sample":
        return Sample(name, help_text, float(value), tuple(sorted(labels.items())))


class SnapshotCollector:
    """Serves the most recent complete cycle; replaced atomically by reference."""

    def __init__(self) -> None:
        self._samples: Tuple[Sample, ...] = ()

    def publish(self, samples: Iterable[Sample]) -> None:
        self._samples = tuple(samples)

    def collect(self):  # prometheus_client collector protocol
        families: Dict[str, GaugeMetricFamily] = {}
        for sample in self._samples:
            family = families.get(sample.name)
            label_names = [k for k, _ in sample.labels]
            if family is None:
                family = GaugeMetricFamily(sample.name, sample.help, labels=label_names)
                families[sample.name] = family
            family.add_metric([v for _, v in sample.labels], sample.value)
        yield from families.values()


# ============================================================================
# DHCP
# ============================================================================
DHCP_MAGIC_COOKIE = b"\x63\x82\x53\x63"
DHCPDISCOVER, DHCPOFFER, DHCPREQUEST, DHCPDECLINE, DHCPACK, DHCPNAK, DHCPRELEASE = 1, 2, 3, 4, 5, 6, 7
_DHCP_HEADER = struct.Struct("!BBBBIHH4s4s4s4s16s64s128s4s")


class DhcpError(Exception):
    pass


@dataclass
class DhcpReply:
    msg_type: int
    yiaddr: str
    server_id: Optional[str]
    lease_seconds: Optional[int]


def read_interface_mac(interface: str) -> bytes:
    """MAC of the NIC the probe runs on (Linux sysfs)."""
    path = f"/sys/class/net/{interface}/address"
    try:
        with open(path, encoding="ascii") as handle:
            raw = handle.read().strip()
        mac = bytes(int(part, 16) for part in raw.split(":"))
    except (OSError, ValueError) as exc:
        raise DhcpError(f"cannot read MAC of interface {interface!r} from {path}: {exc}") from exc
    if len(mac) != 6 or mac == bytes(6):
        raise DhcpError(f"interface {interface!r} has no usable MAC address ({raw!r})")
    return mac


def derive_probe_mac(real_mac: bytes) -> bytes:
    """Stable locally-administered MAC used for full handshakes.

    A full DORA exchange with the NIC's own MAC would hand out (and then release)
    the lease the probe host itself is using. A derived MAC keeps the probe lease
    separate and stable between runs, so the server does not accumulate stale leases.
    """
    mac = bytearray(real_mac)
    mac[0] = (mac[0] | 0x02) & 0xFE
    mac[5] ^= 0x5A
    return bytes(mac)


def build_dhcp_packet(
    msg_type: int,
    xid: int,
    mac: bytes,
    options: Optional[List[Tuple[int, bytes]]] = None,
    ciaddr: str = "0.0.0.0",
    broadcast_flag: bool = True,
) -> bytes:
    header = _DHCP_HEADER.pack(
        1,  # op: BOOTREQUEST
        1,  # htype: Ethernet
        6,  # hlen
        0,  # hops
        xid,
        0,  # secs
        0x8000 if broadcast_flag else 0,
        socket.inet_aton(ciaddr),
        bytes(4),  # yiaddr
        bytes(4),  # siaddr
        bytes(4),  # giaddr
        mac.ljust(16, b"\x00"),
        bytes(64),  # sname
        bytes(128),  # file
        DHCP_MAGIC_COOKIE,
    )
    opts: List[Tuple[int, bytes]] = [
        (53, bytes([msg_type])),
        (61, b"\x01" + mac),  # client identifier
        (12, b"eaziguard-probe"),
    ]
    if msg_type in (DHCPDISCOVER, DHCPREQUEST):
        opts.append((55, bytes([1, 3, 6, 15, 51, 54])))  # parameter request list
    opts.extend(options or [])
    body = b"".join(bytes([code, len(value)]) + value for code, value in opts)
    return header + body + b"\xff"


def parse_dhcp_reply(data: bytes, xid: int, mac: bytes) -> Optional[DhcpReply]:
    """Return the parsed reply or None if the datagram is not for this exchange."""
    if len(data) < _DHCP_HEADER.size:
        return None
    fields = _DHCP_HEADER.unpack_from(data)
    op, htype, hlen, _hops, reply_xid, _secs, _flags = fields[:7]
    yiaddr, chaddr, cookie = fields[8], fields[11], fields[14]
    if op != 2 or htype != 1 or hlen != 6 or reply_xid != xid or cookie != DHCP_MAGIC_COOKIE:
        return None
    if chaddr[:6] != mac:
        return None

    msg_type: Optional[int] = None
    server_id: Optional[str] = None
    lease: Optional[int] = None
    pos = _DHCP_HEADER.size
    while pos < len(data):
        code = data[pos]
        if code == 255:
            break
        if code == 0:
            pos += 1
            continue
        if pos + 1 >= len(data):
            break
        length = data[pos + 1]
        value = data[pos + 2 : pos + 2 + length]
        if len(value) != length:
            break
        if code == 53 and length == 1:
            msg_type = value[0]
        elif code == 54 and length == 4:
            server_id = socket.inet_ntoa(value)
        elif code == 51 and length == 4:
            lease = struct.unpack("!I", value)[0]
        pos += 2 + length
    if msg_type is None:
        return None
    return DhcpReply(msg_type, socket.inet_ntoa(yiaddr), server_id, lease)


def _await_dhcp_reply(
    sock: socket.socket, xid: int, mac: bytes, wanted: Tuple[int, ...], deadline: float
) -> DhcpReply:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DhcpError("timed out waiting for DHCP reply")
        sock.settimeout(remaining)
        try:
            data, _addr = sock.recvfrom(4096)
        except socket.timeout as exc:
            raise DhcpError("timed out waiting for DHCP reply") from exc
        reply = parse_dhcp_reply(data, xid, mac)
        if reply is None:
            continue  # someone else's traffic on the shared broadcast port
        if reply.msg_type == DHCPNAK:
            raise DhcpError("server answered DHCPNAK")
        if reply.msg_type in wanted:
            return reply


def _open_dhcp_socket(cfg: Config) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            # Lets the probe coexist with a dhclient/dhcpcd bound to port 68.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        if cfg.dhcp_bind_to_device and hasattr(socket, "SO_BINDTODEVICE"):
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, cfg.interface.encode() + b"\x00")
            except PermissionError as exc:
                raise DhcpError("cannot bind to interface: grant CAP_NET_RAW (or run as root)") from exc
        try:
            sock.bind(("", cfg.dhcp_client_port))
        except PermissionError as exc:
            raise DhcpError(
                f"cannot bind UDP/{cfg.dhcp_client_port}: grant CAP_NET_BIND_SERVICE (or run as root)"
            ) from exc
        except OSError as exc:
            raise DhcpError(f"cannot bind UDP/{cfg.dhcp_client_port}: {exc}") from exc
        return sock
    except Exception:
        sock.close()
        raise


def run_dhcp_test(cfg: Config) -> List[Sample]:
    """DISCOVER -> OFFER (and optionally REQUEST -> ACK -> RELEASE)."""
    ok_help = "1 if the DHCP exchange completed, else 0."
    offer_help = "Seconds from DHCPDISCOVER sent to DHCPOFFER received."
    ack_help = "Seconds from DHCPDISCOVER sent to DHCPACK received (full mode only)."
    samples: List[Sample] = []

    def failed(reason: str) -> List[Sample]:
        LOG.warning("DHCP test failed: %s", reason)
        return samples + [Sample.of("edgeprobe_dhcp_success", ok_help, 0)]

    try:
        real_mac = read_interface_mac(cfg.interface)
        mac = derive_probe_mac(real_mac) if cfg.dhcp_mode == "full" else real_mac
        xid = secrets.randbits(32)
        sock = _open_dhcp_socket(cfg)
    except DhcpError as exc:
        return failed(str(exc))

    with sock:
        try:
            start = time.monotonic()
            deadline = start + cfg.dhcp_timeout
            sock.sendto(
                build_dhcp_packet(DHCPDISCOVER, xid, mac),
                (cfg.dhcp_broadcast, cfg.dhcp_server_port),
            )
            offer = _await_dhcp_reply(sock, xid, mac, (DHCPOFFER,), deadline)
            offer_seconds = time.monotonic() - start
            samples.append(Sample.of("edgeprobe_dhcp_offer_seconds", offer_help, offer_seconds))

            if cfg.dhcp_mode == "full":
                if not offer.server_id:
                    return failed("OFFER carried no server identifier")
                request = build_dhcp_packet(
                    DHCPREQUEST,
                    xid,
                    mac,
                    options=[
                        (50, socket.inet_aton(offer.yiaddr)),
                        (54, socket.inet_aton(offer.server_id)),
                    ],
                )
                sock.sendto(request, (cfg.dhcp_broadcast, cfg.dhcp_server_port))
                _await_dhcp_reply(sock, xid, mac, (DHCPACK,), deadline)
                samples.append(
                    Sample.of("edgeprobe_dhcp_ack_seconds", ack_help, time.monotonic() - start)
                )
                # Hand the address straight back so the pool is not drained by probing.
                release = build_dhcp_packet(
                    DHCPRELEASE,
                    secrets.randbits(32),
                    mac,
                    options=[(54, socket.inet_aton(offer.server_id))],
                    ciaddr=offer.yiaddr,
                    broadcast_flag=False,
                )
                try:
                    sock.sendto(release, (offer.server_id, cfg.dhcp_server_port))
                except OSError as exc:
                    LOG.warning("DHCPRELEASE not sent (lease will expire on its own): %s", exc)

            samples.append(Sample.of("edgeprobe_dhcp_success", ok_help, 1))
            samples.append(
                Sample.of(
                    "edgeprobe_dhcp_offer_info",
                    "Server and address seen in the last DHCPOFFER.",
                    1,
                    server=offer.server_id or "unknown",
                    offered_address=offer.yiaddr,
                )
            )
            return samples
        except DhcpError as exc:
            return failed(str(exc))
        except OSError as exc:
            return failed(f"socket error: {exc}")


# ============================================================================
# DNS
# ============================================================================
def system_resolvers() -> List[str]:
    try:
        return [str(ns) for ns in dns.resolver.Resolver(configure=True).nameservers]
    except dns.resolver.NoResolverConfiguration:
        return []


def run_dns_test(cfg: Config) -> List[Sample]:
    resolvers = cfg.dns_resolvers or system_resolvers()
    ok_help = "1 if the DNS A lookup returned an answer, else 0."
    time_help = "Seconds taken by the DNS A lookup (timeout value when it failed)."
    samples: List[Sample] = []
    if not resolvers:
        LOG.warning("DNS test skipped: no resolvers configured and none in /etc/resolv.conf")
        return samples

    for server in resolvers:
        resolver = dns.resolver.Resolver(configure=False)
        resolver.nameservers = [server]
        resolver.timeout = cfg.dns_timeout
        resolver.lifetime = cfg.dns_timeout
        for domain in cfg.dns_domains:
            start = time.perf_counter()
            success = 1
            try:
                resolver.resolve(domain, "A", raise_on_no_answer=True)
            except (dns.exception.DNSException, OSError) as exc:
                success = 0
                LOG.warning("DNS %s via %s failed: %s", domain, server, exc.__class__.__name__)
            elapsed = time.perf_counter() - start
            samples.append(Sample.of("edgeprobe_dns_success", ok_help, success, resolver=server, domain=domain))
            samples.append(
                Sample.of("edgeprobe_dns_resolution_seconds", time_help, elapsed, resolver=server, domain=domain)
            )
    return samples


# ============================================================================
# Captive portal
# ============================================================================
REDIRECT_CODES = (301, 302, 303, 307, 308)
_PORTAL_USER_AGENT = "CaptiveNetworkSupport-eaziguard-probe/" + VERSION


def run_portal_test(cfg: Config) -> List[Sample]:
    """Request a plain-HTTP connectivity check and verify the portal behaves.

    Expected behaviour for an unauthenticated client: the check URL is answered with
    a redirect to the portal, and the portal login page then loads (HTTP 200).
    """
    p = "edgeprobe_captive_portal_"
    session = requests.Session()
    session.headers["User-Agent"] = _PORTAL_USER_AGENT
    redirect_seen = 0
    check_status = 0
    check_seconds = 0.0
    page_status = 0
    page_seconds = 0.0
    up = 0
    reason = ""

    try:
        started = time.perf_counter()
        response = session.get(
            cfg.portal_url,
            allow_redirects=False,
            timeout=(cfg.portal_timeout, cfg.portal_timeout),
            verify=cfg.portal_verify_tls,
        )
        check_seconds = time.perf_counter() - started
        check_status = response.status_code

        location = response.headers.get("Location", "")
        if response.status_code in REDIRECT_CODES and location:
            target = urlparse(urljoin(cfg.portal_url, location))
            check_host = (urlparse(cfg.portal_url).hostname or "").lower()
            target_host = (target.hostname or "").lower()
            if target.scheme not in ("http", "https") or not target_host:
                reason = "redirect target is not an http(s) URL"
            elif cfg.portal_expected_host and target_host != cfg.portal_expected_host:
                redirect_seen = 1
                reason = f"redirected to unexpected host {target_host}"
            elif target_host == check_host and target.path == urlparse(cfg.portal_url).path:
                reason = "redirect loop on the check URL"
            else:
                redirect_seen = 1
                started = time.perf_counter()
                page = session.get(
                    target.geturl(),
                    allow_redirects=True,
                    timeout=(cfg.portal_timeout, cfg.portal_timeout),
                    verify=cfg.portal_verify_tls,
                )
                page_seconds = time.perf_counter() - started
                page_status = page.status_code
                if page.status_code == 200:
                    up = 1
                else:
                    reason = f"portal page returned HTTP {page.status_code}"
        elif not cfg.portal_expect_redirect and response.status_code < 400:
            up = 1  # network without a portal, or an already-authenticated one
        elif response.status_code < 400:
            reason = "no redirect: unauthenticated clients are reaching the internet directly"
        else:
            reason = f"check URL returned HTTP {response.status_code}"
    except requests.exceptions.SSLError as exc:
        reason = f"TLS error: {exc.__class__.__name__}"
    except requests.exceptions.Timeout:
        reason = "timeout"
    except requests.exceptions.RequestException as exc:
        reason = f"request error: {exc.__class__.__name__}"

    if reason:
        LOG.warning("Captive portal test failed: %s", reason)
    return [
        Sample.of(p + "up", "1 if the portal behaved as expected (redirect + login page 200), else 0.", up),
        Sample.of(p + "redirect_detected", "1 if the check URL was answered with an HTTP redirect.", redirect_seen),
        Sample.of(p + "check_http_status", "HTTP status of the first (non-followed) connectivity check; 0 on error.", check_status),
        Sample.of(p + "check_seconds", "Seconds for the connectivity-check response.", check_seconds),
        Sample.of(p + "page_http_status", "HTTP status of the portal login page; 0 if not fetched.", page_status),
        Sample.of(p + "response_seconds", "Seconds to fetch the portal login page; 0 if not fetched.", page_seconds),
    ]


# ============================================================================
# RADIUS (RFC 2865 Access-Request with Message-Authenticator, RFC 3579)
# ============================================================================
RADIUS_ACCESS_REQUEST, RADIUS_ACCESS_ACCEPT, RADIUS_ACCESS_REJECT, RADIUS_ACCESS_CHALLENGE = 1, 2, 3, 11


def _radius_attr(attr_type: int, value: bytes) -> bytes:
    if len(value) > 253:
        raise ValueError("RADIUS attribute value too long")
    return bytes([attr_type, len(value) + 2]) + value


def _radius_encrypt_password(password: bytes, secret: bytes, authenticator: bytes) -> bytes:
    padded = password.ljust(((max(len(password), 1) + 15) // 16) * 16, b"\x00")
    out = b""
    previous = authenticator
    for offset in range(0, len(padded), 16):
        key = hashlib.md5(secret + previous, usedforsecurity=False).digest()
        block = bytes(a ^ b for a, b in zip(padded[offset : offset + 16], key))
        out += block
        previous = block
    return out


def build_radius_access_request(cfg: Config, identifier: int, authenticator: bytes) -> bytes:
    attrs = (
        _radius_attr(1, cfg.radius_username.encode())
        + _radius_attr(2, _radius_encrypt_password(cfg.radius_password.encode(), cfg.radius_secret, authenticator))
        + _radius_attr(32, f"eaziguard-{cfg.zone}".encode()[:253])
    )
    ma_placeholder = _radius_attr(80, bytes(16))
    length = 20 + len(attrs) + len(ma_placeholder)
    header = struct.pack("!BBH", RADIUS_ACCESS_REQUEST, identifier, length) + authenticator
    message_authenticator = hmac.new(
        cfg.radius_secret, header + attrs + ma_placeholder, hashlib.md5
    ).digest()
    return header + attrs + _radius_attr(80, message_authenticator)


def verify_radius_response(data: bytes, identifier: int, authenticator: bytes, secret: bytes) -> int:
    """Return the response code, or raise ValueError if it is not a valid reply."""
    if len(data) < 20:
        raise ValueError("short RADIUS reply")
    code, reply_id, length = struct.unpack("!BBH", data[:4])
    if reply_id != identifier:
        raise ValueError("identifier mismatch")
    if length < 20 or length > len(data):
        raise ValueError("bad length")
    packet = data[:length]
    expected = hashlib.md5(
        packet[:4] + authenticator + packet[20:] + secret, usedforsecurity=False
    ).digest()
    if not hmac.compare_digest(expected, packet[4:20]):
        raise ValueError("response authenticator mismatch (wrong shared secret?)")
    return code


def run_radius_test(cfg: Config) -> List[Sample]:
    ok_help = "1 if the RADIUS server returned a valid Access-Accept/Reject/Challenge, else 0."
    time_help = "Seconds from Access-Request sent to a valid reply."
    code_help = "RADIUS response code (2 accept, 3 reject, 11 challenge); 0 if none."
    samples: List[Sample] = []

    for server in cfg.radius_servers:
        success, elapsed, code = 0, cfg.radius_timeout, 0
        identifier = secrets.randbelow(256)
        authenticator = secrets.token_bytes(16)
        try:
            packet = build_radius_access_request(cfg, identifier, authenticator)
            family = socket.AF_INET6 if ":" in server else socket.AF_INET
            with socket.socket(family, socket.SOCK_DGRAM) as sock:
                started = time.perf_counter()
                deadline = time.monotonic() + cfg.radius_timeout
                sock.sendto(packet, (server, cfg.radius_port))
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise socket.timeout()
                    sock.settimeout(remaining)
                    data, _addr = sock.recvfrom(4096)
                    try:
                        code = verify_radius_response(data, identifier, authenticator, cfg.radius_secret)
                    except ValueError as exc:
                        LOG.warning("RADIUS %s: ignoring invalid reply: %s", server, exc)
                        continue
                    elapsed = time.perf_counter() - started
                    success = 1
                    break
        except socket.timeout:
            LOG.warning("RADIUS %s: no valid reply within %.1fs", server, cfg.radius_timeout)
        except OSError as exc:
            LOG.warning("RADIUS %s: socket error: %s", server, exc)
        samples.append(Sample.of("edgeprobe_radius_success", ok_help, success, server=server))
        samples.append(Sample.of("edgeprobe_radius_response_seconds", time_help, elapsed, server=server))
        samples.append(Sample.of("edgeprobe_radius_response_code", code_help, code if success else 0, server=server))
    return samples


# ============================================================================
# Orchestration
# ============================================================================
def collect_cycle(cfg: Config) -> List[Sample]:
    """Run all enabled tests in parallel and return one consistent set of samples."""
    started = time.time()
    tests: Dict[str, Callable[[Config], List[Sample]]] = {}
    if cfg.dhcp_enabled:
        tests["dhcp"] = run_dhcp_test
    if cfg.dns_enabled:
        tests["dns"] = run_dns_test
    if cfg.portal_enabled:
        tests["captive_portal"] = run_portal_test
    if cfg.radius_enabled:
        tests["radius"] = run_radius_test

    samples: List[Sample] = []
    errors: Dict[str, int] = {name: 0 for name in tests}
    with ThreadPoolExecutor(max_workers=max(1, len(tests))) as pool:
        futures = {name: pool.submit(fn, cfg) for name, fn in tests.items()}
        for name, future in futures.items():
            try:
                samples.extend(future.result())
            except Exception:  # a bug in one test must not take the others down
                errors[name] = 1
                LOG.exception("test %s crashed", name)

    finished = time.time()
    samples.append(
        Sample.of(
            "edgeprobe_info",
            "Static information about this probe.",
            1,
            probe_zone=cfg.zone,
            hostname=socket.gethostname(),
            version=VERSION,
            interface=cfg.interface,
        )
    )
    samples.append(Sample.of("edgeprobe_last_run_timestamp_seconds", "Unix time the last test cycle finished.", finished))
    samples.append(Sample.of("edgeprobe_run_duration_seconds", "Wall-clock duration of the last test cycle.", finished - started))
    for name, failed in errors.items():
        samples.append(Sample.of("edgeprobe_test_crashed", "1 if the test raised an unexpected exception.", failed, test=name))
    return samples


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="eaziguard edge probe")
    parser.add_argument("--once", action="store_true", help="run one cycle, print metrics, exit")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,  # journald captures stdout
    )

    try:
        cfg = Config.from_env()
    except ConfigError as exc:
        LOG.error("configuration error: %s", exc)
        return 2

    collector = SnapshotCollector()
    registry = CollectorRegistry()
    registry.register(collector)  # type: ignore[arg-type]

    if args.once:
        collector.publish(collect_cycle(cfg))
        sys.stdout.write(generate_latest(registry).decode())
        return 0

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda _signum, _frame: stop.set())

    try:
        start_http_server(cfg.metrics_port, addr=cfg.bind_address, registry=registry)
    except OSError as exc:
        LOG.error("cannot listen on %s:%d: %s", cfg.bind_address, cfg.metrics_port, exc)
        return 1
    LOG.info(
        "edge probe %s started: zone=%s interface=%s interval=%ss metrics=%s:%d",
        VERSION, cfg.zone, cfg.interface, cfg.interval, cfg.bind_address, cfg.metrics_port,
    )

    while not stop.is_set():
        cycle_start = time.monotonic()
        try:
            collector.publish(collect_cycle(cfg))
        except Exception:
            LOG.exception("test cycle failed; previous snapshot stays published")
        # Keep a steady cadence regardless of how long the cycle took.
        stop.wait(max(0.0, cfg.interval - (time.monotonic() - cycle_start)))

    LOG.info("shutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
