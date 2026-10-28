// Copia este archivo como config.h (ignorado por git) y llena los valores.
// Ningún valor real debe subirse al repositorio.
#pragma once

// ---------- Módulo ----------
// Número de módulo: publica en sensor/modulo<N>/{data,status,heartbeat}
// y la API lo guarda como M<N>.
#define MODULE_NUMBER 1

// ---------- Wi-Fi ----------
#define WIFI_SSID     "CHANGE_ME_SSID"
#define WIFI_PASSWORD "CHANGE_ME_WIFI_PASSWORD"

// ---------- MQTT sobre TLS ----------
// Nombre o IP con el que se emitió el certificado del broker
// (scripts/generate_mqtt_tls_certs.sh con MQTT_TLS_DNS / MQTT_TLS_IPS).
#define MQTT_HOST     "10.42.0.1"   // IP del AP de Modulos_IoT/localap (NetworkManager "shared")
#define MQTT_PORT     8883
// Usuario del archivo passwd de Mosquitto con permiso de escritura en sensor/+/...
#define MQTT_USERNAME "CHANGE_ME_MQTT_USER"
#define MQTT_PASSWORD "CHANGE_ME_MQTT_PASSWORD"

// Contenido de mosquitto/certs/broker/ca.crt (la CA, no la llave).
static const char MQTT_CA_CERT[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE_THE_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----
)PEM";

// ---------- Hora ----------
// La API rechaza lecturas con más de 24 h de antigüedad o 5 min en el futuro,
// y el certificado TLS se valida contra la fecha. Si la red de la granja no
// tiene Internet, apunta NTP_SERVER_1 al servidor local (p. ej. chrony).
#define NTP_SERVER_1 "pool.ntp.org"
#define NTP_SERVER_2 "time.nist.gov"

// ---------- Intervalos ----------
#define TELEMETRY_INTERVAL_MS 10000UL
#define HEARTBEAT_INTERVAL_MS 30000UL

// ---------- Pines ----------
#define DHT_PIN       4
#define MQ7_PIN       32   // CO
#define MQ137_PIN     33   // NH3
#define O2_PIN        34   // Grove O2 (ME2-O2)
#define WIND_PIN      35   // Anemómetro analógico
#define I2C_SDA       25   // CCS811
#define I2C_SCL       26

// Sensores presentes en este nodo (0 = se envía null).
#define HAS_MQ7    1
#define HAS_MQ137  1
#define HAS_O2     1
#define HAS_WIND   1

// ---------- Calibración de gases ----------
// Mientras un valor de calibración sea 0, el firmware envía null para esa
// variable. Así el sistema nunca guarda conteos del ADC como si fueran ppm.
//
// MQ-7 y MQ-137: Rs/R0 -> ppm con ppm = A * (Rs/R0)^B.
// R0 es la resistencia del sensor en su gas de referencia (hoja de datos:
// 100 ppm CO para MQ-7, 50 ppm NH3 para MQ-137). Mídela tras el precalentado
// (24-48 h) y anota el valor en ohms.
#define MQ_RL_OHMS          10000.0f  // resistencia de carga del módulo
#define MQ_SUPPLY_MV        5000.0f   // alimentación del divisor del MQ
#define MQ_DIVIDER_RATIO    1.5f      // Vsensor / Vadc si hay divisor 5 V -> 3.3 V
#define MQ7_R0_OHMS         0.0f      // TODO calibrar
#define MQ7_CURVE_A         99.042f
#define MQ7_CURVE_B         -1.518f
#define MQ137_R0_OHMS       0.0f      // TODO calibrar
#define MQ137_CURVE_A       39.5f
#define MQ137_CURVE_B       -3.802f

// Grove O2: tensión de salida en aire limpio (20.9 % vol.), en mV.
#define O2_AIR_MV           0.0f      // TODO calibrar

// Anemómetro tipo Adafruit 1733: 0.4 V = 0 m/s, 2.0 V = 32.4 m/s.
#define WIND_MIN_MV         400.0f
#define WIND_MAX_MV         2000.0f
#define WIND_MAX_MS         32.4f
