"""Contrato de telemetría: variables obligatorias, opcionales y velocidad del aire.

Usa la API real con SQLite en memoria (create_all), igual que las demás
pruebas locales; no hay mocks de la base de datos.
"""
import base64
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from io import StringIO
import os
import unittest
import uuid


os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("FLASK_ENV", "testing")
os.environ.setdefault("SECRET_KEY", "test-secret-key-0123456789-abcdef")
os.environ.setdefault("INGEST_API_KEY", "test-ingest-key-0123456789-abcdef")
os.environ.setdefault(
    "SECURITY_EVENTS_API_KEY", "test-security-events-key-0123456789-abcdef"
)
os.environ.setdefault(
    "DASHBOARD_PROXY_KEY", "test-dashboard-proxy-key-0123456789-abcdef"
)
os.environ.setdefault("JWT_SECRET_KEY", "test-jwt-secret-key-0123456789-abcdef")
os.environ.setdefault(
    "MFA_ENCRYPTION_KEY",
    base64.urlsafe_b64encode(b"telemetry-contract-test-00000000").decode("ascii"),
)

with redirect_stdout(StringIO()):
    from api_avicola import api
    from api_avicola import mqtt_subscriber


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _reading(**overrides):
    payload = {
        "id_lectura": f"test-{uuid.uuid4().hex[:12]}",
        "modulo": "M1",
        "hora": _now_iso(),
        "temperatura": 28.4,
        "humedad": 63.0,
        "co2": 1200,
    }
    payload.update(overrides)
    return payload


class TelemetryContractTests(unittest.TestCase):
    def setUp(self):
        self.client = api.app.test_client()
        self.headers = {"X-Ingest-Key": os.environ["INGEST_API_KEY"]}
        with api.app.app_context():
            api.db.drop_all()
            api.db.create_all()

    def post(self, payload):
        return self.client.post("/lecturas", json=payload, headers=self.headers)

    def stored(self, reading_id):
        with api.app.app_context():
            return api.db.session.get(api.Lectura, reading_id)

    def test_core_variables_only_are_accepted(self):
        payload = _reading()
        response = self.post(payload)

        self.assertEqual(response.status_code, 201, response.get_json())
        row = self.stored(payload["id_lectura"])
        self.assertIsNone(row.co)
        self.assertIsNone(row.amoniaco)
        self.assertIsNone(row.oxigeno)
        self.assertIsNone(row.velocidad_aire)

    def test_optional_variables_in_null_are_stored_as_null(self):
        payload = _reading(co=None, amoniaco=None, oxigeno=None, velocidad_aire=None)
        self.assertEqual(self.post(payload).status_code, 201)

    def test_air_velocity_is_validated_and_stored(self):
        payload = _reading(velocidad_aire=1.8, oxigeno=20.9, amoniaco=12.5, co=3.0)
        self.assertEqual(self.post(payload).status_code, 201)
        row = self.stored(payload["id_lectura"])
        self.assertAlmostEqual(row.velocidad_aire, 1.8)

    def test_air_velocity_out_of_range_is_rejected(self):
        for bad in (-0.1, 30.5, "nan", True):
            with self.subTest(value=bad):
                response = self.post(_reading(velocidad_aire=bad))
                self.assertEqual(response.status_code, 422)

    def test_core_variable_missing_is_rejected(self):
        payload = _reading()
        del payload["co2"]
        self.assertEqual(self.post(payload).status_code, 422)

    def test_old_reading_is_rejected(self):
        old = (datetime.now(timezone.utc) - timedelta(days=30)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        self.assertEqual(self.post(_reading(hora=old)).status_code, 422)

    def test_historical_exposes_air_velocity_series(self):
        with api.app.app_context():
            user = api.User(username="contract_operator", role="operador")
            user.set_password("contract-operator-password")
            api.db.session.add(user)
            api.db.session.commit()
            token = api.generate_jwt_token(user)

        self.post(_reading(velocidad_aire=2.0))
        response = self.client.get(
            "/api/historical?range=1h&modulo=M1",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        body = response.get_json()
        self.assertEqual(body["air_velocity"], [2.0])


class SubscriberContractTests(unittest.TestCase):
    def test_subscriber_validates_air_velocity(self):
        normalized, errors = mqtt_subscriber.validate_reading_before_forwarding(
            _reading(velocidad_aire=1.5)
        )
        self.assertEqual(errors, [])
        self.assertEqual(normalized["velocidad_aire"], 1.5)

        _, errors = mqtt_subscriber.validate_reading_before_forwarding(
            _reading(velocidad_aire=45)
        )
        self.assertTrue(errors)

    def test_subscriber_accepts_missing_optional_sensors(self):
        normalized, errors = mqtt_subscriber.validate_reading_before_forwarding(
            _reading()
        )
        self.assertEqual(errors, [])
        self.assertIsNone(normalized["oxigeno"])


if __name__ == "__main__":
    unittest.main()
