import sys
import os

# Agregar el directorio raíz al path para importar módulos
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from api_avicola import mqtt_subscriber

if __name__ == "__main__":
    print("Starting MQTT Subscriber Service...")
    try:
        mqtt_subscriber.start()
    except Exception as e:
        print(f"Error starting MQTT Subscriber: {e}")
        sys.exit(1)