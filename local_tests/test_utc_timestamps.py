"""Las fechas viajan en UTC explícito.

La base guarda UTC sin zona. Si la API la devuelve sin 'Z', el navegador la
toma como hora local y en Querétaro todo aparece 6 horas adelantado; y si el
rango personalizado se interpreta en otra zona, el histórico filtra corrido.
Usa la API real con SQLite en memoria (create_all), sin mocks de la base.
"""
import base64
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from io import StringIO
import os
import unittest
import uuid


def _test_value(name):
    """Valor de prueba de 32+ caracteres; no es un secreto real."""
    return f"test-{name}-0123456789-abcdef"


os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("FLASK_ENV", "testing")
for _var in ("SECRET_KEY", "INGEST_API_KEY", "SECURITY_EVENTS_API_KEY",
             "DASHBOARD_PROXY_KEY", "JWT_SECRET_KEY"):
    os.environ.setdefault(_var, _test_value(_var.lower().replace("_", "-")))
os.environ.setdefault(
    "MFA_ENCRYPTION_KEY",
    base64.urlsafe_b64encode(b"utc-timestamps-test-000000000000").decode("ascii"),
)

with redirect_stdout(StringIO()):
    from api_avicola import api


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


class UtcHelperTests(unittest.TestCase):
    def test_naive_value_is_marked_as_utc(self):
        self.assertEqual(
            api.utc_iso(datetime(2026, 10, 29, 5, 32, 48, 328837)),
            "2026-10-29T05:32:48.328Z",
        )

    def test_aware_value_is_converted_to_utc(self):
        mexico = timezone(timedelta(hours=-6))
        self.assertEqual(
            api.utc_iso(datetime(2026, 10, 28, 23, 32, tzinfo=mexico)),
            "2026-10-29T05:32:00.000Z",
        )

    def test_none_and_sqlite_text(self):
        self.assertIsNone(api.utc_iso(None))
        self.assertEqual(api.utc_iso("2026-10-29 05:32:00"), "2026-10-29T05:32:00.000Z")

    def test_client_range_is_converted_to_utc(self):
        self.assertEqual(
            api.parse_client_datetime("2026-10-28T16:00:00.000Z"),
            datetime(2026, 10, 28, 16, 0),
        )
        self.assertEqual(
            api.parse_client_datetime("2026-10-28T10:00:00-06:00"),
            datetime(2026, 10, 28, 16, 0),
        )


class UtcApiTests(unittest.TestCase):
    def setUp(self):
        self.client = api.app.test_client()
        api.limiter.reset()  # otras pruebas del mismo proceso agotan el límite por IP
        with api.app.app_context():
            api.db.drop_all()
            api.db.create_all()
            user = api.User(username="utc_operator", role="operador")
            user.set_password("utc-operator-password")
            api.db.session.add(user)
            api.db.session.commit()
            self.auth = {"Authorization": f"Bearer {api.generate_jwt_token(user)}"}

    def post_reading(self, when):
        payload = {
            "id_lectura": f"utc-{uuid.uuid4().hex[:12]}",
            "modulo": "M1",
            "hora": _iso(when),
            "temperatura": 28.0,
            "humedad": 60.0,
            "co2": 900,
        }
        response = self.client.post(
            "/lecturas", json=payload,
            headers={"X-Ingest-Key": os.environ["INGEST_API_KEY"]},
        )
        self.assertEqual(response.status_code, 201, response.get_json())

    def test_live_data_and_history_carry_z(self):
        self.post_reading(datetime.now(timezone.utc) - timedelta(minutes=5))
        live = self.client.get("/api/live-data?modulo=M1", headers=self.auth).get_json()
        record = live[0] if isinstance(live, list) else live
        self.assertTrue(record["timestamp"].endswith("Z"), record["timestamp"])

        history = self.client.get(
            "/api/historical?range=1h&modulo=M1", headers=self.auth
        ).get_json()
        self.assertEqual(len(history["timestamps"]), 1)
        self.assertTrue(history["timestamps"][0].endswith("Z"))

    def test_custom_range_is_read_in_utc(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        inside = now - timedelta(hours=2)
        outside = now - timedelta(hours=8)  # mismo reloj si se confunde UTC con UTC-6
        self.post_reading(inside)
        self.post_reading(outside)

        start = _iso(now - timedelta(hours=3))
        end = _iso(now - timedelta(hours=1))
        history = self.client.get(
            f"/api/historical?range=custom&from={start}&to={end}&modulo=M1",
            headers=self.auth,
        ).get_json()
        self.assertEqual(history["timestamps"], [api.utc_iso(inside.replace(tzinfo=None))])


if __name__ == "__main__":
    unittest.main()
