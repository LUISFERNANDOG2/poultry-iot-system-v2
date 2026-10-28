/* ============================================================================
 * Firmware del nodo ambiental (ESP32) — contrato de telemetría v1
 * Autores: Luis Fernando González González, Isaac Castro Islas
 *
 * Publica en MQTT sobre TLS (8883) con usuario y contraseña:
 *   sensor/modulo<N>/data       JSON con id_lectura, hora (UTC) y variables
 *   sensor/modulo<N>/status     "online"/"offline" retenido (LWT)
 *   sensor/modulo<N>/heartbeat  {"timestamp","uptime_seconds"}
 *
 * Contrato (CLAUDE.md, "Telemetry contract"):
 *   temp °C, hum %, co2 ppm son obligatorios; co, nh3 (ppm), o2 (% vol.)
 *   y vel (m/s) son opcionales y se envían null si no hay sensor, si no están
 *   calibrados o si salen del rango del contrato. Un valor opcional fuera de
 *   rango haría que el suscriptor descarte toda la lectura, por eso se
 *   anula aquí.
 *
 * Configuración: copiar config.example.h como config.h.
 * Bibliotecas: DHT sensor library, Adafruit CCS811, PubSubClient, ArduinoJson 7.
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <DHT.h>
#include <math.h>
#include <time.h>
#include "Adafruit_CCS811.h"

#include "config.h"

// ---------- Tópicos ----------
static char topicData[48];
static char topicStatus[48];
static char topicHeartbeat[48];
static char clientId[40];

// ---------- Límites del contrato ----------
struct Range { float minV; float maxV; };
static const Range R_TEMP = {-40.0f, 125.0f};
static const Range R_HUM  = {0.0f, 100.0f};
static const Range R_CO2  = {400.0f, 5000.0f};
static const Range R_CO   = {0.0f, 500.0f};
static const Range R_NH3  = {0.0f, 100.0f};
static const Range R_O2   = {0.0f, 25.0f};
static const Range R_VEL  = {0.0f, 30.0f};

// ---------- Hardware ----------
DHT dht(DHT_PIN, DHT22);
Adafruit_CCS811 ccs;
bool ccsReady = false;

WiFiClientSecure tlsClient;
PubSubClient mqtt(tlsClient);

unsigned long lastTelemetry = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastMqttAttempt = 0;
uint32_t sequence = 0;

// ============================================================================
// Utilidades
// ============================================================================
static bool inRange(float v, const Range& r) {
    return isfinite(v) && v >= r.minV && v <= r.maxV;
}

static void setOptional(JsonDocument& doc, const char* key, float v, const Range& r, int decimals) {
    if (inRange(v, r)) {
        float p = powf(10.0f, decimals);
        doc[key] = roundf(v * p) / p;
    } else {
        doc[key] = nullptr;
    }
}

static bool clockIsValid() {
    return time(nullptr) > 1704067200;  // 2024-01-01T00:00:00Z
}

static void isoUtcNow(char* out, size_t len) {
    time_t now = time(nullptr);
    struct tm t;
    gmtime_r(&now, &t);
    strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &t);
}

// ============================================================================
// Red
// ============================================================================
static void ensureWifi() {
    if (WiFi.status() == WL_CONNECTED) return;

    Serial.printf("[WIFI] Conectando a %s", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 30000UL) {
        delay(500);
        Serial.print('.');
    }
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\n[WIFI] IP %s RSSI %d dBm\n",
                      WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        Serial.println("\n[WIFI] Sin conexión; se reintenta en el siguiente ciclo");
    }
}

static void ensureClock() {
    if (clockIsValid()) return;

    configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
    Serial.print("[NTP] Sincronizando");
    unsigned long start = millis();
    while (!clockIsValid() && millis() - start < 20000UL) {
        delay(500);
        Serial.print('.');
    }
    Serial.println(clockIsValid() ? " ok" : " sin hora; no se publicará telemetría");
}

static void ensureMqtt() {
    if (mqtt.connected()) return;
    if (WiFi.status() != WL_CONNECTED || !clockIsValid()) return;
    if (millis() - lastMqttAttempt < 5000UL) return;
    lastMqttAttempt = millis();

    Serial.printf("[MQTT] Conectando a %s:%d como %s... ", MQTT_HOST, MQTT_PORT, clientId);
    bool ok = mqtt.connect(
        clientId,
        MQTT_USERNAME, MQTT_PASSWORD,
        topicStatus, 1, true, "offline",   // LWT retenido
        true);                              // clean session
    if (ok) {
        Serial.println("ok");
        mqtt.publish(topicStatus, "online", true);
    } else {
        // -2: TCP/TLS (CA, nombre del certificado o puerto); 4/5: usuario o ACL.
        Serial.printf("error rc=%d\n", mqtt.state());
    }
}

// ============================================================================
// Sensores
// ============================================================================
static float readMilliVolts(int pin) {
    uint32_t sum = 0;
    for (int i = 0; i < 16; i++) {
        sum += analogReadMilliVolts(pin);
        delay(2);
    }
    return sum / 16.0f;
}

// Rs a partir de la tensión en la resistencia de carga del módulo MQ.
static float mqRs(int pin) {
    float vOut = readMilliVolts(pin) * MQ_DIVIDER_RATIO;
    if (vOut <= 1.0f || vOut >= MQ_SUPPLY_MV) return NAN;
    return MQ_RL_OHMS * (MQ_SUPPLY_MV - vOut) / vOut;
}

static float mqPpm(int pin, float r0, float a, float b) {
    if (r0 <= 0.0f) return NAN;  // sin calibrar: null
    float rs = mqRs(pin);
    if (!isfinite(rs)) return NAN;
    return a * powf(rs / r0, b);
}

static float readO2Percent() {
    if (O2_AIR_MV <= 0.0f) return NAN;  // sin calibrar: null
    return readMilliVolts(O2_PIN) * 20.9f / O2_AIR_MV;
}

static float readWindMs() {
    float mv = readMilliVolts(WIND_PIN);
    if (mv < WIND_MIN_MV * 0.9f) return NAN;  // sensor desconectado
    float ms = (mv - WIND_MIN_MV) * WIND_MAX_MS / (WIND_MAX_MV - WIND_MIN_MV);
    return ms < 0.0f ? 0.0f : ms;
}

// ============================================================================
// Publicación
// ============================================================================
static void publishTelemetry() {
    float temp = dht.readTemperature();
    float hum = dht.readHumidity();

    float co2 = NAN;
    if (ccsReady) {
        if (inRange(temp, R_TEMP) && inRange(hum, R_HUM)) {
            ccs.setEnvironmentalData(hum, temp);
        }
        if (ccs.available() && !ccs.readData()) {
            co2 = ccs.geteCO2();
        }
    }

    // Obligatorios: sin ellos el suscriptor rechaza la lectura, así que no se envía.
    if (!inRange(temp, R_TEMP) || !inRange(hum, R_HUM) || !inRange(co2, R_CO2)) {
        Serial.printf("[DATA] Lectura omitida: temp=%.1f hum=%.1f co2=%.0f\n", temp, hum, co2);
        return;
    }

    char hora[25];
    isoUtcNow(hora, sizeof(hora));

    char idLectura[64];
    snprintf(idLectura, sizeof(idLectura), "M%d-%lu-%lu",
             MODULE_NUMBER, (unsigned long)time(nullptr), (unsigned long)sequence++);

    JsonDocument doc;
    doc["id_lectura"] = idLectura;
    doc["hora"] = hora;
    doc["temp"] = roundf(temp * 10.0f) / 10.0f;
    doc["hum"] = roundf(hum * 10.0f) / 10.0f;
    doc["co2"] = roundf(co2);

    setOptional(doc, "co",  HAS_MQ7   ? mqPpm(MQ7_PIN, MQ7_R0_OHMS, MQ7_CURVE_A, MQ7_CURVE_B) : NAN, R_CO, 1);
    setOptional(doc, "nh3", HAS_MQ137 ? mqPpm(MQ137_PIN, MQ137_R0_OHMS, MQ137_CURVE_A, MQ137_CURVE_B) : NAN, R_NH3, 1);
    setOptional(doc, "o2",  HAS_O2    ? readO2Percent() : NAN, R_O2, 1);
    setOptional(doc, "vel", HAS_WIND  ? readWindMs() : NAN, R_VEL, 2);

    char payload[320];
    size_t n = serializeJson(doc, payload, sizeof(payload));
    if (n == 0 || n >= sizeof(payload)) {
        Serial.println("[DATA] JSON demasiado grande");
        return;
    }

    bool ok = mqtt.publish(topicData, payload);
    Serial.printf("[DATA] %s %s\n", ok ? "enviado" : "ERROR", payload);
}

static void publishHeartbeat() {
    char ts[25];
    isoUtcNow(ts, sizeof(ts));

    JsonDocument doc;
    doc["timestamp"] = ts;
    doc["uptime_seconds"] = millis() / 1000UL;

    char payload[96];
    serializeJson(doc, payload, sizeof(payload));
    mqtt.publish(topicHeartbeat, payload);
}

// ============================================================================
// Arduino
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(200);

    snprintf(topicData, sizeof(topicData), "sensor/modulo%d/data", MODULE_NUMBER);
    snprintf(topicStatus, sizeof(topicStatus), "sensor/modulo%d/status", MODULE_NUMBER);
    snprintf(topicHeartbeat, sizeof(topicHeartbeat), "sensor/modulo%d/heartbeat", MODULE_NUMBER);
    snprintf(clientId, sizeof(clientId), "esp32-modulo%d-%06llX",
             MODULE_NUMBER, (unsigned long long)(ESP.getEfuseMac() & 0xFFFFFF));

    Serial.printf("=== Nodo modulo%d (contrato v1, MQTTS) ===\n", MODULE_NUMBER);

    analogReadResolution(12);
    analogSetAttenuation(ADC_11db);  // hasta ~3.1 V en la entrada del ADC

    dht.begin();
    Wire.begin(I2C_SDA, I2C_SCL);
    ccsReady = ccs.begin();
    Serial.println(ccsReady ? "[CCS811] listo" : "[CCS811] no responde; no se publicará telemetría");

    if (!HAS_MQ7 || MQ7_R0_OHMS <= 0.0f)     Serial.println("[MQ-7] sin calibrar: co = null");
    if (!HAS_MQ137 || MQ137_R0_OHMS <= 0.0f) Serial.println("[MQ-137] sin calibrar: nh3 = null");
    if (!HAS_O2 || O2_AIR_MV <= 0.0f)        Serial.println("[O2] sin calibrar: o2 = null");

    tlsClient.setCACert(MQTT_CA_CERT);  // valida la cadena y el nombre del broker
    mqtt.setServer(MQTT_HOST, MQTT_PORT);
    mqtt.setBufferSize(512);
    mqtt.setKeepAlive(30);

    ensureWifi();
    ensureClock();
}

void loop() {
    ensureWifi();
    ensureClock();
    ensureMqtt();
    mqtt.loop();

    if (!mqtt.connected()) {
        delay(50);
        return;
    }

    unsigned long now = millis();
    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS || lastHeartbeat == 0) {
        publishHeartbeat();
        lastHeartbeat = now;
    }
    if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS || lastTelemetry == 0) {
        publishTelemetry();
        lastTelemetry = now;
    }
    delay(50);
}
