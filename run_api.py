import sys
import os

# Agregar el directorio raíz al path para importar módulos
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from api_avicola import api

if __name__ == "__main__":
    print("Starting API Service...")
    try:
        api.start(port=5000, host='0.0.0.0')
    except Exception as e:
        print(f"Error starting API: {e}")
        sys.exit(1)