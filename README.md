# CampusNet-Sentinel

Early-warning monitoring for a school or university campus network. It watches the
internet gateway/firewall, DNS/DHCP, AAA/RADIUS, core and distribution switches,
Wi-Fi controllers/APs and the captive portal, and raises a warning *before* users
start filing tickets.

It is a three-part system, deployed on three different kinds of machine:

```
                       ┌─────────────────────────── campus VPS / on-prem server ───────────────────────────┐
 switches, firewall ──▶│ Vector :514 (syslog)──┐                                                            │
 controllers  (SNMP) ◀─│ snmp-exporter ────────┤                                                            │
 gateway/APs  (ICMP) ◀─│ blackbox-exporter ────┼──▶ Prometheus ──▶ Grafana (127.0.0.1:3000, operators)       │
 DNS/DHCP/RADIUS/portal│ node-exporter ────────┤        │                                                    │
                       │ kea-exporter (opt.) ──┘        ▼                                                    │
                       │                       Caddy :443  (TLS + bearer token, read-only query API)        │
                       └──────────────▲─────────────────┬───────────────────────────────────────────────────┘
 Raspberry Pi / mini PC│ scrape :8000 │                 │ HTTPS + Authorization: Bearer …
 in dorm / library /   │              │                 ▼
 lecture hall          │   edge-probe/probe.py   Vercel: Next.js dashboard (app/)
 (DHCP, DNS, portal,   │   tests as a student    browser ──▶ /api/metrics ──▶ Prometheus
  RADIUS)              └─────────────┘           (the token never reaches the browser)
```

| Directory | Runs on | What it is |
|-----------|---------|------------|
| [`app/`](app) | Vercel | Next.js 15 + Tailwind dashboard and the `/api/metrics` proxy route |
| [`docker/`](docker) | Campus VPS / server | Docker Compose stack: Prometheus, Grafana, Vector, SNMP exporter, Blackbox exporter, node-exporter, Caddy (+ optional Kea exporter) |
| [`edge-probe/`](edge-probe) | Raspberry Pi / mini PC in client zones | Python synthetic probe exposing Prometheus metrics on `:8000` |

## What is alerted on

All rules live in [`docker/prometheus/alerts.yml`](docker/prometheus/alerts.yml) and carry a `severity`
(`critical` / `warning` / `info`) and a `component` label that the dashboard uses to colour its cards.

| Alert | Condition | For | Severity | Data source |
|-------|-----------|-----|----------|-------------|
| `DHCPPoolExhaustionWarning` | scope usage > 85 % | 5 m | warning | Kea exporter (`kea` profile) |
| `DHCPPoolExhaustionCritical` | scope usage > 95 % | 2 m | critical | Kea exporter |
| `APOffline` | no ICMP heartbeat | 90 s | critical | Blackbox ICMP, 15 s interval |
| `HighGatewayPacketLoss` | > 1 % loss over a 3-minute window | 1 m | critical | Blackbox ICMP, 5 s interval |
| `RADIUSAuthLatency` | AAA response > 500 ms | 3 m | warning | Edge probe (real RADIUS round trip) |
| `CoreSwitchInterfaceErrors` | CRC > 0.1/s, errors > 0.5/s or discards > 5/s per port | 10 m | warning | SNMP (IF-MIB, EtherLike-MIB) |

Supporting alerts cover switch/controller/DNS/DHCP/RADIUS/portal availability, portal certificate expiry,
slow or failing DNS/DHCP from each client zone, silent or stale edge probes, link flapping seen in syslog,
and the health of the monitoring stack itself.

Thresholds are deliberately conservative starting points. Tune them in `alerts.yml` after a week of data.

---

## 1. Push to GitHub and connect `app/` to Vercel

```bash
git clone https://github.com/cckhaw/eaziguard.git     # or: git init && git remote add origin <your repo>
cd eaziguard
git add . && git commit -m "Initial CampusNet-Sentinel import"
git push -u origin main
```

Then in Vercel:

1. **Add New → Project** and import the GitHub repository.
2. **Root Directory:** set it to `app` (this is what makes the monorepo work; `app/vercel.json` is read from there).
   Framework preset is detected as Next.js. Leave the build and install commands as-is.
3. **Environment Variables** (see section 3) — add `PROMETHEUS_URL` and `PROMETHEUS_BEARER_TOKEN` for
   Production *and* Preview, plus `DASHBOARD_BASIC_AUTH_USER` / `DASHBOARD_BASIC_AUTH_PASSWORD`.
4. **Deploy.** Every push to `main` now deploys to production and every pull request gets a preview URL.
   Pushes that only touch `docker/` or `edge-probe/` skip the build (`ignoreCommand` in `app/vercel.json`).

**Protect the dashboard.** It exposes your network's health and device names. Either set the two
`DASHBOARD_BASIC_AUTH_*` variables (the app then requires HTTP Basic auth on every page and API call),
or put the project behind Vercel Authentication / SSO in *Settings → Deployment Protection*.

Try it without a backend (sample data from a fake Prometheus, nothing to configure):

```bash
cd app && npm install
npm run demo               # http://localhost:3000 with sample alerts
npm run demo -- healthy    # all-green variant
```

**Deployment hygiene (already configured).** `app/vercel.json` sets `git.deploymentEnabled` so only `main` deploys; branches and pull requests
create no Preview deployments. On every push to `main` that changes `app/` (the only pushes Vercel builds), the GitHub Action
`.github/workflows/cleanup-vercel-deployments.yml` runs `scripts/cleanup-vercel-deployments.sh`, which deletes every older Preview and Production
deployment of the project once that push's production deployment is READY (the live one, newer ones and in-progress builds are kept; it gives up without deleting after 15 minutes).
Add three repository secrets once (GitHub -> Settings -> Secrets and variables -> Actions): `VERCEL_TOKEN` (vercel.com/account/tokens),
`VERCEL_PROJECT_ID` (Project Settings -> General) and `VERCEL_TEAM_ID` (Team Settings -> General). Try it first from the Actions tab with
"Run workflow" (dry run is the default). Deleting old production deployments also removes them as rollback targets; to roll back, redeploy an earlier commit.

Show it on Vercel without a backend: add the environment variable `DEMO_MODE=true` (Production or Preview) and redeploy.
The page then serves built-in sample data under a "Demo mode" banner and ignores `PROMETHEUS_URL`/`PROMETHEUS_BEARER_TOKEN`.
Remove the variable (or set it to `false`) once the real backend is connected, and keep the Basic-auth variables set so the demo isn't public.

Local development:

```bash
cd app
cp .env.example .env.local        # fill in PROMETHEUS_URL and PROMETHEUS_BEARER_TOKEN
npm install
npm run dev                       # http://localhost:3000
npm run typecheck && npm run lint && npm test
```

## 2. Deploy the backend stack on the campus VPS

**Prerequisites:** a Linux host with Docker Engine 24+ and the Compose plugin, a public DNS name for it
(e.g. `metrics.campus.example.edu`), and these network paths:

| From → To | Port | Why |
|-----------|------|-----|
| Internet → VPS | 80/tcp, 443/tcp | Let's Encrypt challenge and the dashboard's HTTPS queries (Vercel has no fixed egress IPs, so the bearer token is the access control) |
| Switches / firewall / controllers → VPS | 514/udp, 514/tcp | Syslog into Vector. Restrict to your management subnets at the host firewall. |
| VPS → devices | ICMP, 161/udp, 53, 67, 1812/udp, 80/443 | Polling and probing |
| VPS → edge probes | 8000/tcp | Prometheus scrapes the probes |

Steps:

```bash
cd docker
cp .env.example .env
$EDITOR .env                       # set every value; generate the token with: openssl rand -hex 32
```

1. **Inventory** — edit the files in `docker/prometheus/targets/` (gateway, switches, controllers, APs, DNS,
   DHCP, RADIUS, portal, edge probes). The shipped addresses are RFC 1918 examples. The `role` label values
   (`core-switch`, `distribution-switch`, `wifi-controller`, `dhcp-server`, `radius-server`) are used by alert rules, so keep them.
2. **Blackbox probes** — in `docker/prometheus/blackbox.yml` set `dns_internal.query_name` to a record your internal zone serves.
3. **SNMP** — enable SNMP on the devices with the read-only community you put in `.env` (`SNMP_COMMUNITY`).
   For SNMPv3, uncomment `campus_v3` in `docker/snmp/snmp.yml`, pass the variables to the `snmp-exporter` service, and change `auth: [campus_v2]` in `prometheus.yml`.
4. **Syslog** — point devices at the VPS, e.g. Cisco IOS `logging host <vps-ip> transport udp port 514`.
5. **Start it:**

```bash
docker compose up -d
docker compose ps                  # every service should be "running" / "healthy"
docker compose logs -f prometheus caddy
```

6. **Verify** (replace host and token):

```bash
curl -s -H "Authorization: Bearer $PROMETHEUS_BEARER_TOKEN" \
  "https://metrics.campus.example.edu/api/v1/query?query=up" | head -c 300
curl -s -o /dev/null -w "%{http_code}\n" "https://metrics.campus.example.edu/api/v1/query?query=up"   # 401 without the token
```

   Grafana and the full Prometheus UI are bound to `127.0.0.1` on purpose. Reach them through an SSH tunnel or VPN:
   `ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 user@vps`, then open http://localhost:3000.

**DHCP scope alerts** need a metric source. The stack ships an optional exporter for ISC Kea:
set `KEA_CONTROL_AGENT_URLS` in `.env` and run `docker compose --profile kea up -d`. The recording rule
`campus:dhcp_scope_usage:ratio` in `alerts.yml` reads `kea_dhcp4_addresses_assigned_total` /
`kea_dhcp4_addresses_total`; for another DHCP server, change that one rule (or export metrics with those names).
Without a source, `DHCPPoolExhaustion*` never fires and the dashboard shows the scope-usage value as "—".

**Day-to-day:** edit a `targets/*.yml` file and Prometheus picks it up automatically. After editing `prometheus.yml`,
`alerts.yml` or `blackbox.yml`, reload with `docker compose kill -s SIGHUP prometheus` (or restart `blackbox-exporter`).
Validate rule changes before deploying them:

```bash
docker run --rm -v "$PWD/prometheus":/w -w /w --entrypoint promtool prom/prometheus:v2.55.1 test rules alerts.test.yml
```

Raw syslog is kept under the `vector-logs` volume (one directory per day, one file per host); prune it with a cron job.

## 3. Connect Vercel and the backend securely

Two variables tie the halves together:

| Variable | Set on Vercel | Set on the VPS (`docker/.env`) | Meaning |
|----------|---------------|--------------------------------|---------|
| `PROMETHEUS_URL` | `https://metrics.campus.example.edu` | `PROMETHEUS_PUBLIC_HOST=metrics.campus.example.edu` | Public HTTPS address of the Caddy front door |
| `PROMETHEUS_BEARER_TOKEN` | the token | the same token | Shared secret; Caddy rejects any request without it |

How the pieces protect it:

- Browsers only ever call `/api/metrics` on your Vercel domain. The route runs a **fixed list of PromQL queries** on the server and
  adds the `Authorization` header there; the token is never sent to the browser or logged.
- Caddy terminates TLS, requires the exact bearer token, and forwards only `GET/POST` on `/api/v1/query`, `/api/v1/query_range`,
  `/api/v1/alerts` and `/api/v1/rules`. Everything else (UI, admin and lifecycle endpoints, remote write) returns 401.
- The app refuses a non-HTTPS `PROMETHEUS_URL` (except localhost) and refuses to follow redirects, so the token cannot leak to another host.
- Mark both variables **Sensitive** in Vercel, scope them to the environments that need them, and never commit `.env` files (they are git-ignored).

Rotating the token:

```bash
openssl rand -hex 32                       # 1. generate
$EDITOR docker/.env                        # 2. update PROMETHEUS_BEARER_TOKEN on the VPS
docker compose up -d caddy                 # 3. recreate Caddy with the new value
# 4. update PROMETHEUS_BEARER_TOKEN in Vercel and redeploy (Deployments → ⋯ → Redeploy)
```

Between steps 3 and 4 the dashboard shows "backend rejected the bearer token"; do them back to back.

## 4. Run the edge probe on Raspberry Pis

Deploy one probe per client zone: plug the Pi into a **client VLAN port** (the same VLAN as the devices you want to represent, with the same
DHCP, DNS and captive-portal treatment) and give it a stable address or DHCP reservation so Prometheus can scrape it.

What it measures every `PROBE_INTERVAL_SECONDS` (default 30 s):

| Test | Metrics |
|------|---------|
| DHCP | `edgeprobe_dhcp_success`, `edgeprobe_dhcp_offer_seconds` (DISCOVER→OFFER), `edgeprobe_dhcp_ack_seconds` in `full` mode |
| DNS | `edgeprobe_dns_success`, `edgeprobe_dns_resolution_seconds` per resolver and domain |
| Captive portal | `edgeprobe_captive_portal_up`, `…_redirect_detected`, `…_check_seconds`, `…_response_seconds`, HTTP statuses |
| RADIUS (optional) | `edgeprobe_radius_success`, `edgeprobe_radius_response_seconds`, `edgeprobe_radius_response_code` |
| Probe health | `edgeprobe_info`, `edgeprobe_last_run_timestamp_seconds`, `edgeprobe_run_duration_seconds`, `edgeprobe_test_crashed` |

Install as a systemd service (Raspberry Pi OS / Debian / Ubuntu, Python 3.9+):

```bash
git clone https://github.com/cckhaw/eaziguard.git && cd eaziguard/edge-probe
sudo ./install.sh                                  # user, venv in /opt/campus-edge-probe, unit, config template
sudoedit /etc/campus-edge-probe/probe.env          # PROBE_ZONE, PROBE_INTERFACE, DNS_*, PORTAL_*, RADIUS_*
sudo systemctl start campus-edge-probe
```

```bash
journalctl -u campus-edge-probe -f                 # logs
curl -s localhost:8000/metrics | grep ^edgeprobe_  # metrics
```

Then add the Pi to `docker/prometheus/targets/edge_probes.yml` (`- targets: ["<pi-ip>:8000"]`, `labels: {zone: library, role: edge-probe}`).
The `zone` label comes from that file. Re-run `sudo ./install.sh` to upgrade; it never overwrites your `probe.env`.

Notes:

- The service runs as an unprivileged user with only `CAP_NET_BIND_SERVICE` (bind UDP/68) and `CAP_NET_RAW` (pin to the NIC).
  To run by hand: `sudo env $(grep -v '^#' /etc/campus-edge-probe/probe.env | xargs) python3 probe.py --once`.
- `DHCP_MODE=discover` (default) sends DISCOVER and times the OFFER; it takes no lease. `full` completes REQUEST/ACK and then RELEASEs, using a
  derived locally-administered MAC so the Pi's own lease is untouched. If DHCP snooping verifies chaddr against the source MAC, `full` will be dropped; stay on `discover`.
- A captive-portal test is only meaningful from an **unauthenticated** network. On VLANs without a portal set `PORTAL_EXPECT_REDIRECT=false`.
- RADIUS needs the Pi registered as a RADIUS client with `RADIUS_SECRET`; the probe sends an Access-Request with a Message-Authenticator and treats
  Access-Accept, -Reject and -Challenge as "server responded", measuring the round trip. Use a throw-away test account.
- Tests: `cd edge-probe && pip install -r requirements.txt && python -m unittest discover -s tests -v`.

---

## Verification status

What was actually run while building this repository:

- `promtool check config` on `prometheus.yml` and `alerts.yml` (Prometheus 2.55.1), and `promtool test rules alerts.test.yml`: the five required alerts
  fire, hold off for their `for:` period, and render their annotations correctly on synthetic series.
- Edge probe: 20 unit/integration tests against in-process mock DHCP, DNS, HTTP-portal and RADIUS servers; a live `/metrics` endpoint check.
- Dashboard: `tsc`, ESLint, `next build`, 8 unit tests of the status logic, and an end-to-end run against a mock Prometheus that enforces the bearer token
  (healthy, degraded, wrong-token, unconfigured, non-HTTPS and Basic-auth paths), plus light, dark and phone-width screenshots.
- `docker compose config` parses the stack.

Not exercised, because there was no Docker daemon or lab network: the containers themselves, the Caddyfile and Vector pipeline
(`vector validate` was not run), `snmp.yml` against real devices, the Blackbox modules against real servers, and the Kea exporter. Run `docker compose up -d` and
work through the verification steps above on first deployment.

Known limits: UDP checks from Blackbox (`udp_radius_auth`, `udp_dhcp_server`) can only prove that a datagram was sent; the authoritative AAA and DHCP signals come from the edge
probes. No Alertmanager is included, so alerts are visible in the dashboard, Prometheus and Grafana but not pushed to email/Slack/pager. Add Alertmanager when you are ready to route notifications.
