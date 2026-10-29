# Poultry IoT System V2

Environmental monitoring for broiler houses, hardened against the NIST CSF 2.0
outcomes that apply to a small farm deployment.

ESP32 sensor nodes publish JSON over MQTT with TLS. A subscriber validates each
message and forwards it to a Flask API, which stores readings in PostgreSQL. A
Flask dashboard shows live values, history and alerts. Nginx is the only public
entry point; every other port binds to `127.0.0.1`.

```
ESP32 node --MQTTS 8883--> Mosquitto --> subscriber --POST /lecturas--> API --> PostgreSQL
                                                                         ^
                       browser --HTTPS--> Nginx --> dashboard (proxy) ---+
```

| Component | Path | Notes |
|---|---|---|
| API | `api_avicola/api.py` | JWT and session auth, RBAC (`admin`, `operador`, `visor`), TOTP MFA for admins, persistent lockout, audit log, alerts |
| MQTT subscriber | `api_avicola/mqtt_subscriber.py` | Validates topic and payload, queue with retry, node status and heartbeat |
| Dashboard | `dashboard_avicola/` | Server-rendered Flask; front-end libraries are vendored (no CDN) |
| Broker | `mosquitto/config/` | Username and password, per-user ACL, MQTTS on 8883 |
| Reverse proxy | `deploy/nginx/` | TLS, security headers, strips internal proxy headers |
| Node firmware | `Modulos_IoT/firmware_modulo_iot_json/` | ESP32: MQTTS, NTP time, contract keys |
| Node simulator | `scripts/simulate_raspberry_node.py` | Publishes contract-valid telemetry over MQTTS |
| Pentest harness | `Pentesting/` | Scenarios T01-T16, baseline (E0) versus hardened (E1) |
| Tests | `local_tests/` | `python -m pytest -q local_tests` (real SQLite schema, no database mocks) |

## Telemetry contract

Topic `sensor/modulo<N>/data` (stored as module `M<N>`), JSON payload:

| Key | Unit | Range | Required |
|---|---|---|---|
| `id_lectura` | text, unique | up to 100 chars | yes |
| `hora` | ISO 8601 UTC | not older than 24 h, not more than 5 min ahead | yes |
| `temp` | °C | -40 to 125 | yes |
| `hum` | % | 0 to 100 | yes |
| `co2` | ppm | 400 to 5000 | yes |
| `co` | ppm | 0 to 500 | no |
| `nh3` | ppm | 0 to 100 | no |
| `o2` | % vol. | 0 to 25 | no |
| `vel` (or `wind`) | m/s | 0 to 30 | no |

Optional keys may be missing or `null`. A value outside its range rejects the
whole reading. Nodes also publish `online`/`offline` (retained, with LWT) to
`sensor/modulo<N>/status` and `{"timestamp", "uptime_seconds"}` to
`sensor/modulo<N>/heartbeat`.

## Quick start (Docker Compose)

Requirements: Docker Engine with Compose v2.24 or later, OpenSSL.

1. Create the environment file and replace every placeholder. The API refuses
   to start with placeholder or known-leaked secrets.

   ```bash
   cp .env.example .env
   python3 -c 'import secrets; print(secrets.token_hex(32))'   # SECRET_KEY, JWT_SECRET_KEY, INGEST_API_KEY
   python3 -c 'import secrets; print(secrets.token_urlsafe(48))' # SECURITY_EVENTS_API_KEY, DASHBOARD_PROXY_KEY
   python3 -c 'import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())'  # MFA_ENCRYPTION_KEY
   ```

2. Create the broker certificates and the MQTT users. Add the names or
   addresses the nodes will use to reach the broker.

   ```bash
   MQTT_TLS_IPS=10.42.0.1 scripts/generate_mqtt_tls_certs.sh
   docker run --rm -v "$PWD/mosquitto/config:/mosquitto/config" eclipse-mosquitto:2 \
     mosquitto_passwd -b -c /mosquitto/config/passwd mqtt_sensor_user '<MQTT_PASSWORD>'
   docker run --rm -v "$PWD/mosquitto/config:/mosquitto/config" eclipse-mosquitto:2 \
     mosquitto_passwd -b /mosquitto/config/passwd mqtt_subscriber_user '<MQTT_SUBSCRIBER_PASSWORD>'
   ```

3. Start the stack and create the first administrator. There are no default
   accounts. The administrator enrols TOTP at first login and creates the
   other users from the dashboard.

   ```bash
   docker compose up -d --build
   docker compose exec api flask --app api_avicola.api:app create-admin --username <name>
   ```

4. Existing databases only: apply the SQL migrations in order.

   ```bash
   for f in scripts/migrations/*.sql; do
     docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$f"
   done
   ```

5. Publish through Nginx with `deploy/nginx/poultry-api.conf` (see
   [Nginx security headers](docs/nginx-security-headers.md)). The browser
   reaches the dashboard at `/`; the dashboard proxies its `/api/` calls to the
   API. `/backend/` exposes the API itself for clients and for the pentest
   harness.

### Farm profile

When the server runs inside the farm and the nodes publish over the local
network, add the farm override. It publishes only MQTTS (8883) on the LAN; the
API and dashboard stay behind Nginx.

```bash
docker compose -f docker-compose.yml -f docker-compose.farm.yml up -d
```

`Modulos_IoT/localap/` configures a dedicated Wi-Fi access point for the nodes.
Restrict 8883 to that network with the host firewall.

## Nodes

**Simulator.** Useful for end-to-end tests without hardware:

```bash
MQTT_BROKER=localhost MQTT_USERNAME=mqtt_sensor_user MQTT_PASSWORD='<...>' \
MQTT_TLS_CA_CERT=mosquitto/certs/broker/ca.crt SIMULATOR_MODULE=modulo1 \
python scripts/simulate_raspberry_node.py
```

**ESP32 firmware.** Copy `config.example.h` to `config.h` (ignored by git),
fill in Wi-Fi, broker address, MQTT credentials and the CA certificate, and
build with the Arduino ESP32 core and the libraries listed in the sketch
header. Gas channels without a calibration value are sent as `null`, so raw
ADC counts never reach the database as ppm. The CCS811 reports equivalent CO2
estimated from VOCs, not an NDIR measurement.

## Security evaluation

`Pentesting/` contains the harness used for the E0/E1 comparison. See
[Pentesting/README.md](Pentesting/README.md) for the scenarios, the dedicated
test accounts and the pacing needed for the login rate limit:

```bash
cd Pentesting && cp .env.example .env   # point it at your own test deployment only
PENTEST_LOGIN_PAUSE=6.5 python runner.py --env E1 --reps 30 --cooldown 61
python report.py
```

## Citation and license

See [CITATION.cff](CITATION.cff) and [LICENSE](LICENSE).

## Repository Hygiene

Do not commit:

- `.env` or any real environment file
- certificates or private keys
- tunnel credentials
- MQTT credential files
- database dumps, backups, logs, or debug captures

Production credentials, private TLS material and host-generated state remain
outside this repository. Reproducible deployment templates may be versioned as
long as they contain no secrets.

## Container hardening

The API, dashboard and MQTT subscriber images run as an explicit non-root user
with a read-only root filesystem, dropped Linux capabilities, bounded process
counts and service-specific healthchecks. See the
[container hardening procedure](docs/container-hardening.md) for the control
matrix, justified vendor-image exceptions, manual validation and rollback.

## Nginx security headers

The production Nginx virtual host is versioned without certificates or private
keys. Nginx emits one canonical set of security headers, enables HSTS only on
HTTPS, hides its version and preserves the existing Certbot and reverse-proxy
layout. See the
[Nginx security header procedure](docs/nginx-security-headers.md) for local
tests, browser checks, deployment and HSTS-aware rollback.

## Deployment and security evidence

The final phase 6 operator runbook is available in the
[deployment and security evidence guide](docs/deployment-security-evidence-guide.md).
It consolidates the dependency, container and Nginx validations, defines safe
screenshot handling, documents the documentation-only deployment path and
provides rollback and troubleshooting procedures.

## Endpoint inventory and risk matrix

The final hardening inventory maps the public and internal HTTP routes, Docker
and host ports, MQTT topics, authentication models, RBAC decisions and
residual risks. See the
[endpoint inventory and risk matrix](docs/endpoint-inventory-risk-matrix.md)
for the source-of-truth precedence, validation commands and residual-risk
decisions. The unnumbered remediation is recorded in the
[final hardening closure](docs/hardening-final-closure.md).

## PostgreSQL backup

Create a compressed logical backup from the running Docker Compose database:

```bash
./scripts/backup_postgres.sh
```

Backups are written to `backups/postgres/` by default with directory mode
`700` and file mode `600`. The script validates the database connection and
the generated gzip archive before publishing the final `.sql.gz` file. Backup
files are intentionally ignored by Git.

On WSL paths mounted from Windows, such as `/mnt/c` or `/mnt/e`, NTFS may show
permissions such as `777` even after `chmod`. The script reports this condition.
Production backups must use a Linux filesystem that enforces the expected
`700` directory and `600` file permissions.

For a protected destination on the server, pass the directory as an argument
or set `BACKUP_DIR`:

```bash
./scripts/backup_postgres.sh /srv/poultry-backups
BACKUP_DIR=/srv/poultry-backups ./scripts/backup_postgres.sh
```

This commit only creates a local backup. Off-site copies, retention policy and
restore testing are handled separately in the continuity workflow.

## Daily 3-2-1 backup workflow

The 3-2-1 workflow keeps a compressed backup on the Droplet and uploads an
immutable, client-side encrypted copy to a Google Drive folder through an
`rclone crypt` remote. The production database, the local dump and the
off-site encrypted object provide three copies across Droplet and Google
storage, with one copy outside the server. A host-side pull can retain an
additional independent copy on the operator workstation.

Install `rclone` and configure a Google Drive remote authenticated with an
account that can edit the shared backup folder. In the advanced Drive options,
set `root_folder_id` to the final segment of that folder's browser URL. Then
create an `rclone crypt` remote that wraps the Drive remote so database content
and filenames are encrypted before upload. Keep the OAuth token, crypt password
and crypt salt outside this repository.

```bash
rclone config
rclone lsd poultry-drive:
rclone lsd poultry-offsite-crypt:
```

Prepare the configuration and systemd units on the server:

```bash
sudo install -d -m 700 /etc/poultry-iot
sudo install -m 600 deploy/backup/backup.env.example /etc/poultry-iot/backup.env
sudo install -m 644 deploy/systemd/poultry-backup@.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/poultry-backup@.timer /etc/systemd/system/
sudoedit /etc/poultry-iot/backup.env
sudo systemctl daemon-reload
sudo systemctl enable --now "poultry-backup@$(id -un).timer"
```

Run one manual service execution before relying on the timer:

```bash
sudo systemctl start "poultry-backup@$(id -un).service"
sudo systemctl status "poultry-backup@$(id -un).service" --no-pager
sudo journalctl -u "poultry-backup@$(id -un).service" -n 50 --no-pager
systemctl list-timers "poultry-backup@$(id -un).timer"
```

The timer runs daily at 02:15 with a randomized delay of up to 15 minutes and
uses `Persistent=true` to run a missed backup after the server becomes
available again. Retention remains a documented, manually controlled operation
until a separate automation change is implemented.

From the local WSL environment, use the existing crypt remote to pull decrypted
backup files onto the Windows host disk without exposing an inbound service on
the workstation:

```bash
./scripts/sync_backups_to_host.sh /mnt/e/PoultryBackups
```

Protect the host destination with NTFS access controls and full-disk encryption
such as BitLocker. The script only copies missing or changed files and does not
delete older backups from the host.

## PostgreSQL restore test

Validate a local or off-site backup in an isolated temporary PostgreSQL 15
container without modifying the production database:

```bash
./scripts/test_postgres_restore.sh \
  /srv/poultry-backups/poultry_postgres_YYYYMMDDTHHMMSSZ.sql.gz
```

The test stops on SQL errors, validates the critical application tables and
hardening fields, reports only table row counts and removes the temporary
container when finished. See the
[PostgreSQL restore test procedure](docs/restore-test-procedure.md) for local
and Google Drive recovery steps, evidence rules and expected results.

## Backup continuity policy

Retention responsibilities, recovery order and measurable RTO/RPO targets are
defined in the
[backup continuity policy](docs/backup-retention-rto-rpo.md). The current
targets are a 24-hour-and-15-minute RPO during normal operation and a four-hour
RTO after an incident is declared. Backup deletion is not automated by this
repository.
