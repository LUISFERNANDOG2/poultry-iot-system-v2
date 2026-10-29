"""La API no arranca con una llave de ingesta retirada por estar publicada."""
import hashlib
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

RETIRED_KEY = "retired-ingest-key-0123456789-abcdef"
RETIRED_DIGEST = hashlib.sha256(RETIRED_KEY.encode()).hexdigest()
# Huella de la llave que estuvo en .env.example; la llave no se guarda aquí.
PUBLISHED_DIGEST = "54d6c557aa9769e898c60aa31265bf6da277298cf27196378763d795ae3240c3"

BASE_ENV = {
    "DATABASE_URL": "sqlite:///:memory:",
    "FLASK_ENV": "testing",
    "SECRET_KEY": "test-secret-key-0123456789-abcdef",
    "SECURITY_EVENTS_API_KEY": "test-security-events-key-0123456789-abcdef",
    "DASHBOARD_PROXY_KEY": "test-dashboard-proxy-key-0123456789-abcdef",
    "JWT_SECRET_KEY": "test-jwt-secret-key-0123456789-abcdef",
    "MFA_ENCRYPTION_KEY": "bGVha2VkLXNlY3JldC1ndWFyZC10ZXN0LTAwMDAwMDA=",
    "LEAKED_SECRET_SHA256": RETIRED_DIGEST,
}


def run_api_import(code, ingest_key):
    env = {**os.environ, **BASE_ENV, "INGEST_API_KEY": ingest_key}
    return subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, env=env,
        capture_output=True, text=True,
    )


class LeakedSecretGuardTests(unittest.TestCase):
    def test_retired_ingest_key_is_refused(self):
        result = run_api_import("from api_avicola import api", RETIRED_KEY)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("publicada en el historial", result.stderr)

    def test_fresh_key_is_accepted_and_published_digest_is_listed(self):
        result = run_api_import(
            "from api_avicola import api; "
            f"assert '{PUBLISHED_DIGEST}' in api.KNOWN_LEAKED_SECRET_SHA256",
            "a-fresh-ingest-key-0123456789-abcdef",
        )
        self.assertEqual(result.returncode, 0, result.stderr[-500:])

    def test_env_example_placeholder_is_refused(self):
        env = {**os.environ, **BASE_ENV,
               "INGEST_API_KEY": "a-fresh-ingest-key-0123456789-abcdef",
               "JWT_SECRET_KEY": "generar_con_python_secrets_token_hex_32"}
        result = subprocess.run(
            [sys.executable, "-c", "from api_avicola import api"], cwd=ROOT, env=env,
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("valor de ejemplo", result.stderr)


if __name__ == "__main__":
    unittest.main()
