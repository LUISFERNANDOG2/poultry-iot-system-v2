"""
Carga datos_pollitos.xlsx en la base de datos PostgreSQL local (Docker).

Uso:
    python local_tests/load_data.py
    python local_tests/load_data.py --truncate   # borra registros previos primero

Requiere Docker corriendo con: docker compose up -d
Dependencias Python: pandas, openpyxl  (se instalan automáticamente si faltan)
"""

import subprocess
import sys
import os
import argparse

XLSX_PATH = os.path.join(os.path.dirname(__file__), "datos_pollitos.xlsx")
TEMP_CSV = os.path.join(os.path.dirname(__file__), "_temp_lecturas.csv")
CONTAINER_CSV_PATH = "/tmp/lecturas_import.csv"

DB_USER = "avicola_local_user"
DB_NAME = "avicola_local_db"


def pip_install(package):
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", package])


def ensure_deps():
    try:
        import pandas  # noqa: F401
    except ImportError:
        print("Instalando pandas...")
        pip_install("pandas")
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        print("Instalando openpyxl...")
        pip_install("openpyxl")


def find_db_container():
    result = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True, text=True
    )
    names = result.stdout.splitlines()
    # Preferir contenedor con "db" en el nombre dentro del proyecto
    for name in names:
        if "-db-" in name.lower():
            return name
    # Fallback: cualquier contenedor postgres
    for name in names:
        if "db" in name.lower() or "postgres" in name.lower():
            return name
    return None


def run_psql(container, sql):
    """Ejecuta SQL en el contenedor PostgreSQL."""
    return subprocess.run(
        ["docker", "exec", "-i", container,
         "psql", "-U", DB_USER, "-d", DB_NAME, "-v", "ON_ERROR_STOP=1"],
        input=sql,
        capture_output=True,
        text=True,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--truncate", action="store_true",
                        help="Eliminar registros existentes antes de importar")
    args = parser.parse_args()

    ensure_deps()
    import pandas as pd

    # Verificar Excel
    if not os.path.exists(XLSX_PATH):
        print(f"ERROR: No se encontró el archivo: {XLSX_PATH}")
        sys.exit(1)

    # Localizar contenedor
    container = find_db_container()
    if not container:
        print("ERROR: No se encontró el contenedor de base de datos.")
        print("Inicia el sistema con:  docker compose up -d")
        sys.exit(1)
    print(f"Contenedor DB: {container}")

    # Leer Excel
    print(f"\nLeyendo {os.path.basename(XLSX_PATH)} ...")
    df = pd.read_excel(XLSX_PATH, sheet_name="datos_pollitos")
    print(f"  {len(df):,} filas cargadas")

    # Limpiar y mapear columnas
    print("Procesando datos...")

    df["modulo"] = df["modulo"].apply(
        lambda x: f"M{int(x)}" if pd.notna(x) and str(x).strip() not in ("", "NULL") else None
    )
    for col in ["temperatura", "humedad", "CO", "CO2", "NH3"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["hora"] = pd.to_datetime(df["hora"], errors="coerce") - pd.Timedelta(hours=6)

    out = pd.DataFrame({
        "id_lectura":  df["id_lectura"].astype(str).str.strip(),
        "modulo":      df["modulo"],
        "hora":        df["hora"],
        "temperatura": df["temperatura"],
        "humedad":     df["humedad"],
        "co":          df["CO"],
        "co2":         df["CO2"],
        "amoniaco":    df["NH3"],
    })

    # Guardar CSV temporal
    print(f"Generando CSV temporal...")
    out.to_csv(TEMP_CSV, index=False, na_rep="\\N")

    # Copiar al contenedor
    print(f"Copiando CSV al contenedor...")
    cp = subprocess.run(
        ["docker", "cp", TEMP_CSV, f"{container}:{CONTAINER_CSV_PATH}"],
        capture_output=True, text=True
    )
    if cp.returncode != 0:
        print(f"ERROR al copiar CSV: {cp.stderr}")
        sys.exit(1)

    # Importar en PostgreSQL
    print("Importando en PostgreSQL...")

    truncate_line = "TRUNCATE lecturas;\n" if args.truncate else ""
    if args.truncate:
        print("  (Borrando registros previos...)")

    sql = f"""
CREATE TEMP TABLE _import_lecturas (
    id_lectura  TEXT,
    modulo      TEXT,
    hora        TIMESTAMP,
    temperatura FLOAT,
    humedad     FLOAT,
    co          FLOAT,
    co2         FLOAT,
    amoniaco    FLOAT
);

COPY _import_lecturas (id_lectura, modulo, hora, temperatura, humedad, co, co2, amoniaco)
FROM '{CONTAINER_CSV_PATH}'
CSV HEADER
NULL '\\N';

{truncate_line}
INSERT INTO lecturas (id_lectura, modulo, hora, temperatura, humedad, co, co2, amoniaco)
SELECT id_lectura, modulo, hora, temperatura, humedad, co, co2, amoniaco
FROM _import_lecturas
ON CONFLICT (id_lectura) DO NOTHING;

SELECT COUNT(*) AS registros_totales FROM lecturas;
"""

    result = run_psql(container, sql)

    if result.returncode == 0:
        print("\nImportacion completada exitosamente.")
        for line in result.stdout.splitlines():
            if line.strip():
                print(" ", line)
    else:
        print(f"\nERROR en psql:\n{result.stderr}")
        if result.stdout:
            print(result.stdout)
        sys.exit(1)

    # Limpieza
    if os.path.exists(TEMP_CSV):
        os.remove(TEMP_CSV)

    print(f"\nListo. Abre el dashboard en http://localhost:5001")


if __name__ == "__main__":
    main()
