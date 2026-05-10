import sys
import os

# Agregar el directorio raíz al path para importar módulos
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from dashboard_avicola import dashboard

if __name__ == "__main__":
    print("Starting Dashboard Service...")
    try:
        dashboard.start(port=5001, host='0.0.0.0')
    except Exception as e:
        print(f"Error starting Dashboard: {e}")
        sys.exit(1)