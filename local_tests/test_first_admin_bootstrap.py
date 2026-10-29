"""Creación del primer administrador en una instalación nueva."""
import base64
from contextlib import redirect_stdout
from io import StringIO
import os
import unittest


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
    base64.urlsafe_b64encode(b"first-admin-bootstrap-test-00000").decode("ascii"),
)

with redirect_stdout(StringIO()):
    from api_avicola import api


class FirstAdminBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.runner = api.app.test_cli_runner()
        with api.app.app_context():
            api.db.drop_all()
            api.db.create_all()

    def invoke(self, username, password):
        return self.runner.invoke(
            args=["create-admin", "--username", username, "--password", password],
        )

    def test_creates_admin_on_empty_install(self):
        result = self.invoke("granja_admin", "una-contrasena-larga-1")
        self.assertEqual(result.exit_code, 0, result.output)
        with api.app.app_context():
            user = api.User.query.filter_by(username="granja_admin").one()
            self.assertEqual(user.role, "admin")
            self.assertFalse(user.mfa_enabled)
            self.assertTrue(user.check_password("una-contrasena-larga-1"))
            event = api.SecurityEvent.query.filter_by(
                event_type="first_admin_bootstrapped"
            ).one()
            self.assertEqual(event.actor_username, "granja_admin")

    def test_refuses_when_an_admin_exists(self):
        self.assertEqual(self.invoke("granja_admin", "una-contrasena-larga-1").exit_code, 0)
        result = self.invoke("segundo_admin", "otra-contrasena-larga-2")
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("Ya existe un administrador", result.output)

    def test_rejects_short_password(self):
        result = self.invoke("granja_admin", "corta")
        self.assertNotEqual(result.exit_code, 0)
        with api.app.app_context():
            self.assertEqual(api.User.query.count(), 0)


class CreateUserCommandTests(unittest.TestCase):
    """Altas adicionales desde el servidor (el tablero no tiene pantalla de altas)."""

    def setUp(self):
        self.runner = api.app.test_cli_runner()
        with api.app.app_context():
            api.db.drop_all()
            api.db.create_all()

    def invoke(self, username, role, password="una-contrasena-larga-1"):
        return self.runner.invoke(args=[
            "create-user", "--username", username, "--role", role, "--password", password,
        ])

    def test_creates_operator_and_records_event(self):
        result = self.invoke("operador_nave1", "operador")
        self.assertEqual(result.exit_code, 0, result.output)
        with api.app.app_context():
            user = api.User.query.filter_by(username="operador_nave1").one()
            self.assertEqual(user.role, "operador")
            event = api.SecurityEvent.query.filter_by(event_type="user_created").one()
            self.assertEqual(event.source, "api_cli")

    def test_rejects_unknown_role_and_duplicates(self):
        self.assertNotEqual(self.invoke("x_user", "superuser").exit_code, 0)
        self.assertEqual(self.invoke("visor_1", "visor").exit_code, 0)
        result = self.invoke("VISOR_1", "visor")
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("ya existe", result.output)

    def test_rejects_short_password(self):
        self.assertNotEqual(self.invoke("visor_2", "visor", "corta").exit_code, 0)
        with api.app.app_context():
            self.assertEqual(api.User.query.count(), 0)


if __name__ == "__main__":
    unittest.main()
