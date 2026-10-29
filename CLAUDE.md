# CLAUDE.md — Poultry IoT System V2

> Read automatically by Claude Code when the project is opened. Keep it short
> and current: it describes the code as it is, not its history (that is in
> `git log`).

## What this is

Environmental monitoring for broiler houses. Sensor nodes publish JSON over
MQTT; a subscriber validates each message and forwards it to a Flask API that
stores readings in PostgreSQL; a Flask dashboard shows live values, history and
alerts. The stack is hardened against the NIST CSF 2.0 outcomes listed in
`docs/endpoint-inventory-risk-matrix.md` and measured with the pentest harness
in `Pentesting/`.

Deployment context: Querétaro, México, 1,820 m above sea level.

## Stack

| Layer | Technology |
|---|---|
| Node firmware | ESP32 + PubSubClient + ArduinoJson 7, config in `config.h` (`Modulos_IoT/`) |
| Broker | Eclipse Mosquitto 2: auth + ACL, MQTTS on 8883, 1883 only on the container's localhost |
| API | Flask + SQLAlchemy on Gunicorn, port 5000 |
| Dashboard | Flask (server-rendered) + Bootstrap 5.3 + Chart.js 4.4 + Luxon + flatpickr, port 5001 |
| Database | PostgreSQL 15 |
| Subscriber | paho-mqtt, internal queue with retry, posts to `/lecturas` with an ingest key |
| Frontend assets | Vendored in `dashboard_avicola/static/vendor/` (no CDN) |

All published ports bind to `127.0.0.1`; Nginx is the only public entry
(`deploy/nginx/`).

## Run

```bash
cp .env.example .env          # replace every placeholder; the API refuses to start without them
scripts/generate_mqtt_tls_certs.sh
docker compose up -d --build
```

There are no default credentials and no public sign-up (`/register` only
redirects). Create the first admin once (it enrols TOTP at its first login),
then further users with `create-user`:

```bash
docker compose exec api flask --app api_avicola.api:app create-admin --username <name>
docker compose exec api flask --app api_avicola.api:app create-user --username <name> --role operador
for f in scripts/migrations/*.sql; do docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$f"; done  # existing databases only
```

## Key files

```
api_avicola/api.py              API: models, validation, auth (JWT/session), RBAC, MFA, alerts, audit, CLI (create-admin, create-user)
api_avicola/mqtt_subscriber.py  MQTT → validation → queue → POST /lecturas; heartbeat/LWT; security events
api_avicola/mfa_security.py     TOTP + Fernet-encrypted secrets
dashboard_avicola/dashboard.py  Dashboard routes and authenticated proxy to the API
dashboard_avicola/static/js/    dashboard.js (live data, charts, thresholds), i18n.js (ES/EN)
scripts/migrations/             SQL migrations 001-008, applied manually in order
scripts/simulate_raspberry_node.py  MQTTS node simulator used for end-to-end tests
Pentesting/                     Harness T01-T16 (E0 baseline vs E1 hardened)
local_tests/                    pytest suite (real SQLite schema, no DB mocks)
```

## Telemetry contract

Topic `sensor/<modulo>/data`, JSON keys:

| Key | Column | Unit | Range | Required |
|---|---|---|---|---|
| `temp` | temperatura | °C | -40 to 125 | yes |
| `hum` | humedad | % | 0 to 100 | yes |
| `co2` | co2 | ppm | 400 to 5000 | yes |
| `co` | co | ppm | 0 to 500 | no |
| `nh3` | amoniaco | ppm | 0 to 100 | no |
| `o2` | oxigeno | % vol. | 0 to 25 | no |
| `vel` (or `wind`) | velocidad_aire | m/s | 0 to 30 | no |

Optional values may be missing or `null`. The API also checks a 24 h freshness
window, a 5 min future skew, finite numbers and a unique `id_lectura`.
Timestamps are stored as naive UTC and returned with `Z` (`utc_iso()`); the
dashboard sends custom ranges in UTC. Never return a naive `isoformat()` to
the browser: it reads it as local time (6 h off in Querétaro).

Gas values must arrive in ppm. The firmware in `Modulos_IoT/` follows this
contract (MQTTS, NTP time, `id_lectura`, LWT, heartbeat) and sends `null` for
any gas channel whose calibration constant in `config.h` is still 0, and for
any optional value outside its range (one out-of-range value rejects the whole
reading). It has not been compiled in CI; build it with the Arduino ESP32 core.

## Roles

`admin` (MFA required), `operador`, `visor`. Permissions are in
`ROLE_PERMISSIONS` (dashboard) and `auth_required(roles=...)` (API).

## Tests

```bash
python -m pytest -q local_tests
```

Tests use the real schema through SQLite `create_all`; do not add mocks of the
database (a past migration passed with mocks and failed in production).

## Git

`feature/xxx → dev → main`. Commits: `feat:`, `fix:`, `docs:`, `security:`,
`ops:`, `chore:`. Releases are tagged `vX.Y.Z` on `main`.

## Design decisions

- Effective temperature is not computed. Air velocity is shown on its own
  until the farm confirms which index or table it uses.
- Air velocity is behind a dashboard toggle because not every node has an
  anemometer.
- The dashboard shows gas values in ppm as stored; there is no client-side
  sensor calibration in the live cards.
