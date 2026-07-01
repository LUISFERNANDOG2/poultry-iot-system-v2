# CLAUDE.md — Poultry IoT System V2

> Este archivo es leído automáticamente por Claude Code al abrir el proyecto.
> Mantenerlo actualizado es la forma más eficiente de retomar trabajo en cualquier máquina.

---

## ¿Qué es este proyecto?

Sistema de monitoreo ambiental IoT para granjas avícolas. Módulos ESP32 capturan variables ambientales (temperatura, humedad, gases, O₂, viento) vía MQTT, las almacenan en PostgreSQL, y las visualizan en un dashboard web Flask con gráficas en tiempo real e histórico.

**Contexto de despliegue**: Querétaro, México — altitud 1,820 m. Los sensores de gas tienen corrección por altitud (factor 0.79) porque la presión atmosférica es ~800 hPa en lugar de 1013 hPa.

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Firmware | ESP32 + ArduinoJson (`StaticJsonDocument<384>`) |
| Broker MQTT | Mosquitto (Docker), puerto 1883 |
| API backend | Flask + SQLAlchemy, puerto 5000 |
| Dashboard frontend | Flask (server-side render) + Bootstrap 5.3 + Chart.js + Luxon, puerto 5001 |
| Base de datos | PostgreSQL 15 (Docker) |
| Subscriber MQTT | Python paho-mqtt, consume broker y escribe a la API |
| Internacionalización | i18n.js propio (ES/EN), atributos `data-i18n` en HTML |
| Datetime picker | Flatpickr |
| Fuente | Inter (Google Fonts) |

---

## Servicios Docker Compose

```
db              PostgreSQL 15          (interno, sin puerto expuesto)
mqtt            Mosquitto              localhost:1883
api             Flask API              localhost:5000
dashboard       Flask Dashboard        localhost:5001
mqtt_subscriber Python subscriber     (sin puerto, consume broker)
```

### Levantar el stack

```bash
docker compose up -d --build
```

### Credenciales por defecto

- **Dashboard**: `admin` / `admin123`
- La contraseña está guardada como hash bcrypt en la tabla `users`
- Para resetear: entrar al contenedor API y usar `werkzeug.security.generate_password_hash('nueva')`

---

## Mapa de archivos clave

```
api_avicola/
  api.py                  ← API Flask: modelos SQLAlchemy, endpoints REST, migración de columnas al inicio
  mqtt_subscriber.py      ← Consume MQTT, acumula buffer por módulo, POST a /lecturas cada mensaje completo

dashboard_avicola/
  app.py                  ← Dashboard Flask: rutas de páginas, proxy hacia la API
  templates/
    base.html             ← Layout principal: topbar verde oscuro, sidebar gradiente, avatar, lang pill
    dashboard.html        ← Sensor cards, panel de controles, gráficas, mini-alertas
    historical.html       ← Tabla paginada + gráfica rápida, filtros por módulo/rango/búsqueda
    alerts.html           ← Gestión de alertas activas/resueltas
    devices.html          ← CRUD de Granjas, Naves, Módulos, Parvadas
  static/
    css/dashboard.css     ← Design system completo (variables CSS, sensor cards, status strip, flash, etc.)
    js/dashboard.js       ← Lógica de dashboard: live data, gráficas, calibración MQ, umbrales, deltas
    js/i18n.js            ← Traducciones ES/EN, función toggleLanguage(), langToggleBtn pill
    vendor/               ← Luxon + chartjs-adapter-luxon (bundleados localmente)

Modulos_IoT/
  firmware_modulo_iot_json/
    firmware_modulo_iot_json.ino  ← Firmware ESP32: JSON por MQTT, todos los sensores
```

---

## Modelos de base de datos (SQLAlchemy)

### `Lectura` — tabla `lecturas`
```
id, modulo, hora, temperatura, humedad, amoniaco, co, co2, tvoc,
oxigeno (nullable), velocidad_viento (nullable)
```
- `oxigeno` y `velocidad_viento` se añadieron con `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` en el startup de la API (migración idempotente, compatibilidad hacia atrás).
- Índices en `(modulo)` y `(hora)` para queries de histórico rápidas.

### `User` — tabla `users`
```
id, username, full_name, role, initials, profile_image_url, password_hash
```

### `UmbralAlerta` — tabla `umbrales_alerta`
```
id, variable, valor_medio, valor_alto, valor_grave
```
Validación: `medio < alto < grave` antes de guardar.

### Modelos de granja (relaciones)
```
Granja → Nave → Modulo → Parvada (activa)
```

---

## API endpoints principales (puerto 5000)

```
GET  /api/live-data?modulo=M1          ← Última lectura del buffer en memoria
GET  /api/historical?range=24h&modulo=M1  ← Arrays paralelos: timestamps, temperature, humidity, ...
POST /lecturas                          ← Insertar lectura (usado por mqtt_subscriber)
GET  /api/alerts?status=active&limit=3 ← Alertas activas
GET  /api/umbrales                      ← Umbrales configurados
POST /api/umbrales                      ← Guardar umbrales (valida orden)
GET  /api/modulos                       ← Lista módulos con nave/granja
GET  /api/parvada/:modulo               ← Parvada activa del módulo (semana, día)
PUT  /api/user/:id                      ← Actualizar perfil de usuario
```

### Respuesta de `/api/historical`
```json
{
  "timestamps": [...],
  "temperature": [...],
  "humidity": [...],
  "ammonia": [...],
  "co": [...],
  "co2": [...],
  "oxygen": [...],
  "wind_speed": [...],
  "house": [...]
}
```

---

## Firmware ESP32 — payload MQTT

**Topic**: `sensores/json`

```json
{
  "modulo": "M1",
  "temp": 24.5,
  "hum": 65.0,
  "nh3": 522,
  "co": 111,
  "eco2": 400,
  "tvoc": 10,
  "o2": 20.9,
  "wind": 2.3
}
```

- `o2`: pin 34 (Grove O2), escala `(raw/4095)*25.0` → % O₂
- `wind`: pin 35 (anemómetro), escala `(raw/4095)*32.4` → m/s
- `StaticJsonDocument<384>` (se subió de 200 para acomodar los nuevos campos)

**Flujo legacy** (topics separados): el subscriber también acepta `sensores/M1/temperature`, `sensores/M1/humidity`, etc., acumulando en buffer hasta tener todos los campos.

---

## Frontend — arquitectura

### Flujo de datos en tiempo real
1. `setInterval(updateLiveData, 5000)` → `GET /api/live-data?modulo=M1`
2. `updateAllDeltas(data, previousLiveData)` → calcula ▲/▼ entre lectura actual y anterior
3. `updateMetricCards(data)` → actualiza DOM + dispara `flashValue()` (highlight amarillo 0.7s)
4. `setInterval` de 2s → actualiza `connectionDot` (verde pulsante / rojo sin datos)

### Gráficas
- **Chart.js** con escala de tiempo tipo `luxon` (bundleado en `/vendor/`)
- 6 gráficas siempre visibles + 2 opcionales (viento + temperatura efectiva)
- Las gráficas de viento/temp efectiva se crean *lazy* solo cuando el toggle está ON
- `loadHistorical()` alimenta todas las gráficas con arrays del endpoint `/api/historical`

### Toggle de viento
- Persiste en `localStorage` con key `wind_speed_enabled`
- Al activarse muestra tarjetas `.card-wind` y gráficas `.chart-wind`
- **Temperatura efectiva** (Steadman AT): `AT = Ta + 0.33×e − 0.70×WS − 4.00` donde `e = (RH/100)×6.105×exp(17.27×Ta/(237.7+Ta))`

### i18n
- `window.currentLang` (`es` | `en`), persiste en `localStorage`
- Atributos `data-i18n="key"` en HTML, actualizados por `applyLanguage(lang)`
- El botón `#langToggleBtn` es un pill que muestra `ES | EN` con el activo en bold

---

## Design system (dashboard.css)

### Variables CSS
```css
--green-dark:  #1b4d1a
--green-mid:   #2e7d32
--green-light: #43a047
--bg-page:     #f3f5f3
--card-shadow: 0 2px 10px rgba(0,0,0,0.07)
--radius-card: 14px
```

### Componentes principales
- `.sensor-card` — tarjeta de sensor: icono circular + label + valor + delta ▲/▼
- `.sensor-icon-wrap.sensor-icon-{temp|hum|nh3|co|co2|o2|wind|eff}` — círculo de color por sensor
- `.controls-panel` — panel blanco con filtros (módulo, rango, wind chip)
- `.wind-chip` — toggle de anemómetro como pastilla estilizada
- `.status-strip` — barra de estado con `.live-dot` pulsante (reemplazó el `alert alert-info`)
- `.chart-header` — header de gráfica con `.chart-title-icon` + nombre
- `.sensor-value.flash` — animación `flash-update` 0.7s al recibir datos
- `.stat-card` — tarjetas de resumen en página histórico
- `.breadcrumb-bar` / `.page-breadcrumb` — migas de pan en dashboard e histórico

### Iconos por sensor (Bootstrap Icons 1.11)
| Sensor | Ícono |
|---|---|
| Temperatura | `bi-thermometer-half` |
| Humedad | `bi-droplet-fill` |
| NH₃ | `bi-exclamation-diamond-fill` |
| CO | `bi-cloud-fog-fill` |
| CO₂ | `bi-cloud-fog2-fill` |
| O₂ | `bi-circle` |
| Viento | `bi-tornado` |
| Temp. efectiva | `bi-thermometer-sun` |

---

## Calibración de sensores (Querétaro)

```js
// MQ-7 para CO
MQ7_A = 99.04, MQ7_B = -1.518, MQ7_R0 = 58000Ω
MQ7_EMPIRICAL_FACTOR = 0.5

// MQ-137 para NH3
MQ137_A = 36.665, MQ137_B = -1.461, MQ137_R0 = 9500Ω
MQ137_EMPIRICAL_FACTOR = 0.4

// Altitud
ALTITUDE_METERS = 1820, ALTITUDE_FACTOR = 0.79
CO2_EXTERIOR_REF = 410 ppm

// Fórmula PPM: ppm = A × (Rs/R0)^B × empiricalFactor × altitudeFactor
// Rs calculado de ADC con divisor 2:1 y RL=9.9kΩ
```

Los valores de R0 y offsets se guardan en `localStorage`. Se pueden ajustar desde la consola del navegador con `calibrateWithOutsideAir()`, `calibrateMQ7()`, `calibrateMQ137()`.

---

## Flujo Git

```
feature/xxx  →  dev  →  main
```

### Convención de commits
```
feat: descripción breve del feature
fix: descripción breve del bug fix
```

### Merge a main
```
Merge dev: descripción de lo que entra
```

### Estado actual de ramas
- `dev` y `main` sincronizados (dev adelantado 3 commits a `origin/dev` — pendiente push)
- `origin/main` puede estar desactualizado si no se ha hecho `git push origin main`

---

## Historial de features (cronológico)

| Commit(s) | Feature |
|---|---|
| `9abcf42` | Baseline inicial: Docker stack, UI profesional |
| `c71bf12`–`6ac7e5c` | Modelos Granja/Nave/Modulo/Parvada + endpoints CRUD |
| `18a7390`–`4ba6e43` | Parvada card en dashboard, selector de módulos dinámico |
| `bc0a24b` | Tabla de Granjas en página Devices |
| `60c2f30`–`7c09f7d` | Sistema i18n ES/EN completo (dashboard, histórico, alertas, login, devices) |
| `c93f768` | Parvada card profesional + estado activo en devices |
| `f72af38` | Fix flickering de gráficas en auto-refresh |
| `bcf9e2d` | Fix badge de conexión (falsos disconnects) |
| `f8eb563` | Estandarización param `modulo` en `/api/historical` |
| `7b448d0` | Validación orden umbrales: medio < alto < grave |
| `d110ff7` | Índices DB en `lecturas(modulo)` y `lecturas(hora)` |
| `06ed91d` | Fix hardcoded M1 en `/api/live-data` |
| `d20f8bd` | Alertas Telegram para valores críticos |
| `2c67328` | Flatpickr datetime picker + rango absoluto en gráficas |
| `a1a90de` | Labels adaptativos en eje X de gráficas según rango |
| `63c0329` | Fix timezone UTC-6 al importar datos Excel |
| `4b7c151` | **Sensores O₂ y velocidad del viento** — DB, API, MQTT, firmware, dashboard, histórico, i18n |
| `71acb05` | **Rediseño visual** — sensor cards con iconos, topbar #1b4d1a, sidebar gradiente, deltas ▲/▼ |
| `fb4b340` | **Pulido UX** — Inter font, controls panel, status strip + live dot, flash animations, chart headers, breadcrumb, lang pill |

---

## Páginas del dashboard

| Ruta | Archivo | Estado |
|---|---|---|
| `/dashboard` | `dashboard.html` | Activo |
| `/historical` | `historical.html` | Activo |
| `/alerts` | `alerts.html` | Activo |
| `/devices` | `devices.html` | Activo |
| `/analysis` | `analysis.html` | **Comentado** en sidebar |
| `/ml_models` | `ml_models.html` | **Comentado** en sidebar |
| `/reports` | `reports.html` | **Comentado** en sidebar |

---

## Decisiones de diseño importantes

- **Columnas nullable**: `oxigeno` y `velocidad_viento` son nullable para compatibilidad con hardware sin esos sensores.
- **Buffer MQTT en memoria**: el subscriber acumula campos en un dict antes de escribir a la API, evitando escrituras parciales.
- **Gráficas lazy**: `windChart` y `effectiveTempChart` se crean solo cuando el toggle de viento está ON, para evitar errores en canvas oculto.
- **Sin mock en tests**: si se añaden tests deben usar DB real (lección del pasado: mocks que pasaban pero la migración fallaba en producción).
- **dashboard.css en base.html**: el CSS del design system se carga globalmente desde `base.html`, no solo en `dashboard.html`.
- **Flash de actualización**: `flashValue()` dispara `animation: flash-update 0.7s` al actualizar cada valor en vivo — indica al operador que llegó dato nuevo.
- **Status strip**: reemplazó el `alert alert-info` Bootstrap genérico. El `.live-dot` con animación de pulso verde/rojo es más informativo y menos intrusivo.
