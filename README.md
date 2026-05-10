# Poultry IoT System V2

Clean local Docker baseline for the poultry IoT monitoring system.

This repository is intentionally local-only. It does not include production tunnels, private keys, real `.env` files, or deployment certificates.

## Services

- PostgreSQL: internal Docker database
- Mosquitto: local MQTT broker on `localhost:1883`
- API: `http://localhost:5000`
- Dashboard: `http://localhost:5001`
- MQTT subscriber: consumes local MQTT messages and posts readings to the API

## Local Setup

1. Create your private environment file:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and replace the placeholder values.

3. Start the local stack:

   ```bash
   docker compose up --build
   ```

4. Open the dashboard:

   ```text
   http://localhost:5001
   ```

## Repository Hygiene

Do not commit:

- `.env` or any real environment file
- certificates or private keys
- tunnel credentials
- MQTT credential files
- database dumps, backups, logs, or debug captures

Remote deployment, TLS, and production security modules are intentionally out of scope for this local baseline.
