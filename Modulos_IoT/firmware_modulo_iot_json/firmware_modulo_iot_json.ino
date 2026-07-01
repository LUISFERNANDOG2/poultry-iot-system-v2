/* ============================================================================
 * Autor: Luis Fernando González González
 * Fecha de edición: Junio de 2025
 * Reedición: Noviembre de 2025
 * Modificado: Diciembre 2025 - JSON MQTT Implementation
 *
 * Archivo: firmware_modulo_iot_json.ino
 * Descripción: Firmware para ESP32 que monitorea temperatura, humedad, CO, NH3 y CO2,
 *   enviando los datos mediante protocolo MQTT en formato JSON a un servidor para su análisis.
 * Proyecto: Plataforma de monitoreo ambiental y predicción 
 *           para bienestar avícola basada en IoT y aprendizaje automático
 * ============================================================================
 */

#include <DHT.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include "Adafruit_CCS811.h"
#include <ArduinoJson.h>

// =============================
// CONFIGURACIÓN Wi-Fi
// =============================

const char* ssid = "YOUR_LOCAL_WIFI_SSID";
const char* password = "YOUR_LOCAL_WIFI_PASSWORD";

// Example: const char* ssid = "YourHomeNetwork";
// Example: const char* password = "YourHomeNetworkPassword";

// Configuración MQTT local
// Use the IP address of the machine running Docker on your local network.

// MQTT server local
const char* mqtt_server = "192.168.1.100";

// Nuevo topic único para JSON
const char* topic_data = "sensor/modulo1/data";

// =============================
// CONFIGURACIÓN DE SENSORES
// =============================

#define DHTPIN 4
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

int mq7_pin  = 32;
int mq137_pin = 33;
int o2_pin = 34;       // Grove O2 sensor (analógico)
int wind_pin = 35;     // Anemómetro (analógico, señal 0–3.3V)

Adafruit_CCS811 ccs;
bool ccs811_initialized = false;

WiFiClient espClient;
PubSubClient client(espClient);

// Variables para debugging
unsigned long lastDebugTime = 0;
const int DEBUG_INTERVAL = 10000; // Debug cada 10 segundos
unsigned long lastSendTime = 0;
// INTERVALO DE ENVIO DE DATOS LOCAL
// 5000ms = 5 segundos
const int SEND_INTERVAL = 5000;

// Contadores para diagnóstico
int successfulReads = 0;
int failedReads = 0;
int zeroReadings = 0;

// ===========================================================
// FUNCIÓN: ESCANEAR REDES Y MOSTRAR LISTA
// ===========================================================
void scan_networks() {
    Serial.println("\nBuscando redes Wi-Fi...");
    
    int n = WiFi.scanNetworks();
    if (n == 0) {
        Serial.println("No se detectó ninguna red.");
        return;
    }

    Serial.printf("Se detectaron %d redes:\n", n);
    for (int i = 0; i < n; i++) {
        Serial.printf("  %d) SSID: %s | RSSI: %d dBm | Canal: %d | Encriptada: %s\n",
            i + 1,
            WiFi.SSID(i).c_str(),
            WiFi.RSSI(i),
            WiFi.channel(i),
            (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "No" : "Sí"
        );
    }
    Serial.println();
}

// ===========================================================
// FUNCIÓN: INTENTAR CONECTAR A LA RED DURANTE 60 SEGUNDOS
// ===========================================================
bool try_connect_wifi() {
    WiFi.begin(ssid, password);
    Serial.println("Intentando conectar...");

    unsigned long start = millis();

    while (WiFi.status() != WL_CONNECTED) {
        Serial.print(".");
        delay(1000);

        if (millis() - start > 60000) {  // 60 segundos
            Serial.println("\nNo se pudo conectar en 60 segundos");
            return false;
        }
    }

    Serial.println("\n¡Conectado a Wi-Fi!");
    Serial.print("IP asignada: ");
    Serial.println(WiFi.localIP());
    return true;
}

// ===========================================================
// FUNCIÓN PRINCIPAL DE CONEXIÓN WiFi CON REINTENTOS
// ===========================================================
void setup_wifi() {
    WiFi.mode(WIFI_STA);

    while (true) {
        scan_networks();

        if (try_connect_wifi()) {
            break;  // conexión exitosa
        }

        Serial.println("Reintentando...\n");
        delay(1000);
    }
}

// ===========================================================
// MQTT RECONNECT
// ===========================================================
void reconnect() {
    while (!client.connected()) {
        Serial.print("Conectando a MQTT... ");
        if (client.connect("ESP32Client")) {
            Serial.println("Conectado!");
            Serial.println("Enviando datos a topic: " + String(topic_data));
        } else {
            Serial.print("Error rc=");
            Serial.print(client.state());
            Serial.println(" -> Reintentando");
            delay(1000);
        }
    }
}

// ===========================================================
// FUNCIÓN: LEER TODOS LOS SENSORES Y CREAR JSON
// ===========================================================
String createSensorJSON() {
    // Crear documento JSON
    StaticJsonDocument<384> doc;
    
    
    // Variables para validación
    bool hasValidData = false;
    
    // Leer DHT22
    float temperature = dht.readTemperature();
    float humidity = dht.readHumidity();
    
    if (!isnan(temperature) && !isnan(humidity)) {
        doc["temp"] = round(temperature * 10) / 10;  // 1 decimal
        doc["hum"] = round(humidity * 10) / 10;      // 1 decimal
        hasValidData = true;
    } else {
        doc["temp"] = nullptr;
        doc["hum"] = nullptr;
        failedReads++;
    }
    
    // Leer MQ-7 (CO)
    int coRaw = analogRead(mq7_pin);
    doc["co_raw"] = coRaw;
    
    // Validar lectura del MQ-7
    if (coRaw >= 10 && coRaw <= 4000) {
        doc["co"] = coRaw;  // Enviamos el valor RAW para procesamiento en el dashboard
        hasValidData = true;
        successfulReads++;
    } else {
        doc["co"] = nullptr;
        if (coRaw < 10) zeroReadings++;
        failedReads++;
    }
    
    // Leer MQ-137 (NH3)
    int nh3Raw = analogRead(mq137_pin);
    doc["nh3_raw"] = nh3Raw;
    
    // Validar lectura del MQ-137
    if (nh3Raw >= 10 && nh3Raw <= 4000) {
        doc["nh3"] = nh3Raw;  // Enviamos el valor RAW para procesamiento en el dashboard
        hasValidData = true;
        successfulReads++;
    } else {
        doc["nh3"] = nullptr;
        if (nh3Raw < 10) zeroReadings++;
        failedReads++;
    }
    
    // Leer CCS811 (CO2)
    if (ccs811_initialized && ccs.available() && !ccs.readData()) {
        int co2Value = ccs.geteCO2();
        int tvocValue = ccs.getTVOC();
        doc["co2"] = co2Value;
        doc["tvoc"] = tvocValue;
        hasValidData = true;
        successfulReads++;
    } else {
        doc["co2"] = nullptr;
        doc["tvoc"] = nullptr;
        failedReads++;
    }
    
    // Leer sensor de oxígeno (Grove O2 - analógico 0–3.3V → 0–25%)
    int o2Raw = analogRead(o2_pin);
    if (o2Raw >= 10 && o2Raw <= 4095) {
        float o2Pct = (o2Raw / 4095.0) * 25.0;  // Grove O2: 0V=0%, 3.3V=25%
        doc["o2"] = round(o2Pct * 10) / 10;
        hasValidData = true;
    } else {
        doc["o2"] = nullptr;
    }

    // Leer anemómetro (señal analógica 0–3.3V → 0–32.4 m/s)
    int windRaw = analogRead(wind_pin);
    if (windRaw >= 0 && windRaw <= 4095) {
        float windMs = (windRaw / 4095.0) * 32.4;
        doc["wind"] = round(windMs * 10) / 10;
        hasValidData = true;
    } else {
        doc["wind"] = nullptr;
    }

    // Agregar estadísticas
    doc["stats"] = JsonObject();
    doc["stats"]["successful_reads"] = successfulReads;
    doc["stats"]["failed_reads"] = failedReads;
    doc["stats"]["zero_readings"] = zeroReadings;
    doc["stats"]["has_valid_data"] = hasValidData;
    
    // Convertir a String
    String jsonString;
    serializeJson(doc, jsonString);
    
    return jsonString;
}

// ===========================================================
// FUNCIÓN: DEBUG DETALLADO
// ===========================================================
void printDetailedDebug() {
    Serial.println("\n=== DEBUG DETALLADO MÓDULO 1 ===");
    
    // Estado WiFi
    Serial.printf("WiFi: %s | RSSI: %d dBm\n", 
                  WiFi.status() == WL_CONNECTED ? "Conectado" : "Desconectado",
                  WiFi.RSSI());
    
    // Estado MQTT
    Serial.printf("MQTT: %s\n", client.connected() ? "Conectado" : "Desconectado");
    
    // Memoria
    Serial.printf("Memoria libre: %d bytes\n", ESP.getFreeHeap());
    
    // Estadísticas
    Serial.printf("Estadísticas - Exitosos: %d | Fallidos: %d | Ceros: %d\n", 
                  successfulReads, failedReads, zeroReadings);
    
    // Lecturas actuales
    float temp = dht.readTemperature();
    float hum = dht.readHumidity();
    int co = analogRead(mq7_pin);
    int nh3 = analogRead(mq137_pin);
    
    Serial.printf("Sensores - Temp: %.1f°C | Hum: %.1f%% | CO: %d | NH3: %d\n", 
                  isnan(temp) ? 0 : temp,
                  isnan(hum) ? 0 : hum,
                  co, nh3);
    
    // CCS811
    if (ccs811_initialized && ccs.available() && !ccs.readData()) {
        Serial.printf("CCS811 - CO2: %d ppm | TVOC: %d ppb\n", ccs.geteCO2(), ccs.getTVOC());
    } else {
        Serial.println("CCS811 - Error en lectura");
    }
    
    Serial.println("===============================");
}

// ===========================================================
// SETUP
// ===========================================================
void setup() {
    Serial.begin(115200);
    Serial.println("=== INICIANDO MÓDULO 1 - MQTT JSON ===");
    
    setup_wifi();
    dht.begin();

    pinMode(mq7_pin, INPUT);
    pinMode(mq137_pin, INPUT);
    pinMode(o2_pin, INPUT);
    pinMode(wind_pin, INPUT);

    // I2C en pines personalizados
    Wire.begin(25, 26);

    if (ccs.begin()) {
        ccs811_initialized = true;
        Serial.println("CCS811 inicializado correctamente.");
    } else {
        Serial.println("Error al iniciar CCS811.");
    }

    client.setServer(mqtt_server, 1883);
    
    // Lectura inicial para diagnóstico
    Serial.println("\n=== LECTURA INICIAL DE SENSORES ===");
    printDetailedDebug();
    
    Serial.println("Setup completado. Iniciando loop principal...");
}

// ===========================================================
// LOOP PRINCIPAL
// ===========================================================
void loop() {
    // Reconectar MQTT si es necesario
    if (!client.connected()) {
        reconnect();
    }
    client.loop();
    
    unsigned long currentTime = millis();
    
    // Enviar datos cada segundo
    if (currentTime - lastSendTime >= SEND_INTERVAL) {
        String jsonData = createSensorJSON();
        
        // Siempre enviar el JSON, incluso con valores nulos
        // Esto ayuda a diagnosticar problemas de sensores
        bool published = client.publish(topic_data, jsonData.c_str());
        
        if (published) {
            Serial.println("JSON enviado: " + jsonData);
        } else {
            Serial.println("Error al enviar JSON");
        }
        
        lastSendTime = currentTime;
    }
    
    // Debug detallado cada 10 segundos
    if (currentTime - lastDebugTime >= DEBUG_INTERVAL) {
        printDetailedDebug();
        lastDebugTime = currentTime;
    }
    
    delay(100);  // Pequeño delay para no sobrecargar el CPU
}
