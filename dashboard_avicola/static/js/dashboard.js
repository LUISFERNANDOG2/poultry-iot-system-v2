// Dashboard JavaScript. Los gases llegan en ppm desde la API; aquí no se calibra nada.
let temperatureChart, humidityChart, ammoniaChart, coChart, co2Chart, oxygenChart;
let lastRealUpdate = null;   // Timestamp de la última lectura del sensor (para mostrar en UI)
let lastApiSuccess = null;   // Momento en que live-data respondió OK (para estado de conexión)
let airVelocityChart = null;  // se crea solo si el toggle de velocidad del aire está activo
let previousLiveData = null;   // lectura anterior, para los indicadores ▲/▼

// =========================================================
// DELTA ▲/▼ ENTRE LECTURA ACTUAL Y ANTERIOR
// =========================================================

function flashValue(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth; // force reflow so animation restarts
  el.classList.add('flash');
}

function updateDelta(elementId, current, previous, unit) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (current == null || previous == null) {
    el.innerHTML = '<span class="delta-neutral">—</span>';
    return;
  }
  const diff = current - previous;
  // Mostrado con 1 decimal: por debajo de 0.05 se vería como "▲ 0.0".
  if (Math.abs(diff) < 0.05) {
    el.innerHTML = '<span class="delta-neutral">— sin cambio</span>';
    return;
  }
  const sign = diff > 0 ? '▲' : '▼';
  const cls  = diff > 0 ? 'delta-up' : 'delta-down';
  el.innerHTML = `<span class="${cls}">${sign} ${Math.abs(diff).toFixed(1)} ${unit}</span>`;
}

function updateAllDeltas(current, previous) {
  if (!previous) return;
  updateDelta('temp_delta',   current.temperatura,    previous.temperatura,    '°C');
  updateDelta('hum_delta',    current.humedad,        previous.humedad,        '%');
  updateDelta('nh3_delta',    current.amoniaco,       previous.amoniaco,       'ppm');
  updateDelta('co_delta',     current.co,             previous.co,             'ppm');
  updateDelta('co2_delta',    current.co2,            previous.co2,            'ppm');
  updateDelta('oxygen_delta', current.oxigeno,        previous.oxigeno,        '%');
  updateDelta('air_velocity_delta', current.velocidad_aire, previous.velocidad_aire, 'm/s');
}

// =========================================================
// MINI ALERTAS EN DASHBOARD
// =========================================================

function escapeMiniAlertText(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

async function loadMiniAlerts() {
  try {
    const res = await fetch(`${getBaseUrl()}/api/alerts?status=active&limit=3`);
    if (!res.ok) return;
    const alerts = await res.json();
    const section = document.getElementById('miniAlertsSection');
    const list    = document.getElementById('miniAlertsList');
    if (!section || !list || !Array.isArray(alerts)) return;

    if (!alerts.length) { section.style.display = 'none'; return; }

    section.style.display = '';
    list.innerHTML = alerts.map(a => {
      const dotClass = a.prioridad === 'critical' ? 'critical' : a.prioridad === 'warning' ? 'warning' : 'info';
      const ago = formatTimeAgo(new Date(a.timestamp));
      return `<div class="mini-alert-item">
        <span class="mini-alert-dot ${dotClass}"></span>
        <span>${escapeMiniAlertText(a.mensaje)} <span class="text-muted" style="font-size:0.75rem;">— ${escapeMiniAlertText(ago)}</span></span>
      </div>`;
    }).join('');
  } catch (e) { /* silencioso si falla */ }
}

// =========================================================
// TOGGLE DE VELOCIDAD DEL AIRE
// No todos los nodos tienen anemómetro; el toggle muestra la tarjeta y la
// gráfica solo cuando la nave mide velocidad del aire. La preferencia se
// guarda por navegador.
// =========================================================

const AIR_VELOCITY_STORAGE_KEY = 'air_velocity_enabled';

function isAirVelocityEnabled() {
  try {
    return localStorage.getItem(AIR_VELOCITY_STORAGE_KEY) === 'true';
  } catch (e) {
    return false;
  }
}

function onAirVelocityToggle(enabled) {
  try { localStorage.setItem(AIR_VELOCITY_STORAGE_KEY, enabled); } catch (e) { /* sin almacenamiento */ }
  applyAirVelocityToggle(enabled);
}

function applyAirVelocityToggle(enabled) {
  document.querySelectorAll('.card-air-velocity, .chart-air-velocity').forEach(el => {
    el.style.display = enabled ? '' : 'none';
  });

  if (enabled) {
    if (!airVelocityChart) {
      airVelocityChart = initChart(
        document.getElementById('airVelocityChart'),
        t('dashboard.chart_air_velocity'),
        "#6464c8"
      );
    }
    const range = document.getElementById('rangeSelect');
    if (range && range.value !== 'custom') loadHistorical(range.value);
  }
}

// =========================================================
// ACTUALIZACIÓN DE TARJETAS (ESTRUCTURA CORREGIDA)
// =========================================================

function updateMetricCards(data) {
  if (!data) return;

  const setMetric = (elementId, value, decimals, unit) => {
    const element = document.getElementById(elementId);
    if (!element) return;

    if (value === null || value === undefined || value === "") {
      element.textContent = `-- ${unit}`;
      return;
    }

    const numericValue = Number(value);
    element.textContent = Number.isFinite(numericValue)
      ? `${numericValue.toFixed(decimals)} ${unit}`
      : `-- ${unit}`;
  };

  setMetric("temp", data.temperatura, 1, "°C");
  setMetric("hum", data.humedad, 1, "%");
  setMetric("ammonia", data.amoniaco, 2, "ppm");
  setMetric("co", data.co, 2, "ppm");
  setMetric("co2", data.co2, 0, "ppm");
  setMetric("oxygen", data.oxigeno, 2, "%");

  const airVelocityEnabled = isAirVelocityEnabled();
  if (airVelocityEnabled) {
    setMetric("air_velocity", data.velocidad_aire, 1, "m/s");
  }

  ['temp', 'hum', 'ammonia', 'co', 'co2', 'oxygen'].forEach(flashValue);
  if (airVelocityEnabled) flashValue('air_velocity');
}

// =========================================================
// INICIALIZACIÓN DEL DASHBOARD
// =========================================================

async function initializeDashboard() {
  // Poblar selector de módulos desde la API
  await populateModuleSelector();
  updateParvadaInfo();

  // Configurar selector de rango
  setupRangeSelector();

  // Inicializar gráficas siempre visibles
  temperatureChart = initChart(document.getElementById('temperatureChart'), t('dashboard.chart_temp'), "#43a047");
  humidityChart = initChart(document.getElementById('humidityChart'), t('dashboard.chart_hum'), "#1e88e5");
  ammoniaChart = initChart(document.getElementById('ammoniaChart'), t('dashboard.chart_nh3'), "#fb8c00");
  coChart = initChart(document.getElementById('coChart'), t('dashboard.chart_co'), "#43a047");
  co2Chart = initChart(document.getElementById('co2Chart'), t('dashboard.chart_co2'), "#e53935");
  oxygenChart = initChart(document.getElementById('oxygenChart'), t('dashboard.chart_oxygen'), "#00897b");

  // La gráfica de velocidad del aire se crea en applyAirVelocityToggle()

  // Cargar datos iniciales
  loadHistorical("24h");
  loadMiniAlerts();
}

// =========================================================
// FUNCIONES DE GRÁFICAS
// =========================================================

// Colores para diferentes módulos
const MODULE_COLORS = {
  'M1': { primary: '#43a047', secondary: '#43a04733' },
  'M2': { primary: '#1e88e5', secondary: '#1e88e533' },
  'M3': { primary: '#fb8c00', secondary: '#fb8c0033' },
  'M4': { primary: '#e53935', secondary: '#e5393533' },
  'M5': { primary: '#8e24aa', secondary: '#8e24aa33' }
};

function initChart(ctx, label, color) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label,
        data: [],
        borderColor: color,
        backgroundColor: color + "33",
        fill: false,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            usePointStyle: true,
            padding: 15
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(0,0,0,0.8)',
          titleColor: '#fff',
          bodyColor: '#fff',
          borderColor: '#ddd',
          borderWidth: 1
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            tooltipFormat: 'dd/MM/yyyy HH:mm',
            displayFormats: {
              minute: 'HH:mm',
              hour:   'd MMM, HH:mm',
              day:    'd MMM',
              week:   'd MMM',
              month:  'MMM yyyy',
            }
          },
          adapters: { date: { locale: 'es' } },
          bounds: 'data',
          grid: {
            display: true,
            color: 'rgba(0,0,0,0.1)'
          }
        },
        y: { 
          beginAtZero: false,
          grid: {
            display: true,
            color: 'rgba(0,0,0,0.1)'
          }
        }
      }
    }
  });
}


function clearAllCharts() {
  // Limpiar completamente todas las gráficas
  const charts = [temperatureChart, humidityChart, ammoniaChart, coChart, co2Chart, oxygenChart, airVelocityChart];
  
  charts.forEach(chart => {
    if (chart) {
      // Limpiar datos
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      
      // Resetear escalas
      if (chart.options.scales && chart.options.scales.x) {
        chart.options.scales.x.min = null;
        chart.options.scales.x.max = null;
      }
      
      // Actualizar gráfica vacía
      chart.update('none');
    }
  });
}


function getRangeFromUI() {
  const rangeSelect = document.getElementById('rangeSelect');
  if (!rangeSelect) return null;
  const range = rangeSelect.value;
  const now = new Date();

  if (range === 'custom') {
    const from = document.getElementById('fromDate').value;
    const to   = document.getElementById('toDate').value;
    return (from && to)
      ? { min: new Date(from.replace(' ', 'T')), max: new Date(to.replace(' ', 'T')) }
      : null;
  }

  const msMap = {
    '1m': 60000, '10m': 600000, '30m': 1800000,
    '1h': 3600000, '2h': 7200000, '12h': 43200000,
    '24h': 86400000, '3d': 259200000, '7d': 604800000,
  };
  const ms = msMap[range];
  return ms ? { min: new Date(now - ms), max: now } : null;
}

function updateChart(chart, labels, data) {
  if (!chart) return;

  const safeLabels = [];
  const safeValues = [];

  (labels || []).forEach((timestamp, index) => {
    const rawValue = (data || [])[index];

    if (
      rawValue === null ||
      rawValue === undefined ||
      rawValue === ""
    ) {
      return;
    }

    const value = Number(rawValue);
    const date = parseTimestamp(timestamp);

    if (!Number.isFinite(value) || Number.isNaN(date.getTime())) {
      return;
    }

    safeLabels.push(
      date.toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
    safeValues.push(value);
  });

  chart.options.scales.x.type = "category";
  chart.options.scales.x.min = undefined;
  chart.options.scales.x.max = undefined;

  chart.data.labels = safeLabels;
  chart.data.datasets[0].data = safeValues;
  chart.update("none");
}

// =========================================================
// PARVADA: selector de módulos y semana de parvada
// =========================================================

async function populateModuleSelector() {
  const sel = document.getElementById('moduleSelect');
  if (!sel) return;
  try {
    const res = await fetch(`${getBaseUrl()}/api/modulos`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const modulos = await res.json();
    if (!modulos.length) throw new Error('empty');
    const current = sel.value;
    sel.innerHTML = '';
    modulos.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.codigo;
      let label = m.codigo;
      if (m.nave) label += ` (${m.nave.nombre}`;
      if (m.granja) label += ` · ${m.granja.nombre}`;
      if (m.nave) label += ')';
      opt.textContent = label;
      sel.appendChild(opt);
    });
    if (current && sel.querySelector(`option[value="${current}"]`)) {
      sel.value = current;
    }
  } catch {
    // Fallback si la API no responde o no hay módulos registrados
    if (!sel.options.length) {
      ['M1', 'M2'].forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        sel.appendChild(opt);
      });
    }
  }
}

async function updateParvadaInfo() {
  const sel = document.getElementById('moduleSelect');
  const card = document.getElementById('parvadaCard');
  if (!sel || !card) return;
  const modulo = sel.value;
  if (!modulo) { card.style.display = 'none'; return; }
  try {
    const res = await fetch(`${getBaseUrl()}/api/parvada/${modulo}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.parvada) { card.style.display = 'none'; return; }

    const { semana, dia_semana } = data.parvada;
    const semLabel = t('dashboard.parvada_sem');
    const diaLabel = t('dashboard.parvada_dia');

    document.getElementById('parvadaGranja').textContent = data.granja ? data.granja.nombre : '—';
    document.getElementById('parvadaNave').textContent   = data.nave   ? data.nave.nombre   : '—';
    document.getElementById('parvadaSemanaNum').textContent = `${semLabel} ${semana}`;
    document.getElementById('parvadaDia').textContent       = `${diaLabel} ${dia_semana} / 7`;

    card.style.display = '';
  } catch {
    card.style.display = 'none';
  }
}

// =========================================================
// FUNCIONES UTILITARIAS
// =========================================================

function setupRangeSelector() {
  const rangeSelect = document.getElementById('rangeSelect');
  const customContainer = document.getElementById('customRangeContainer');
  const moduleSelect = document.getElementById('moduleSelect');

  if (!rangeSelect || !customContainer) return;

  const updateVisibility = () => {
    const isCustom = rangeSelect.value === 'custom';
    customContainer.classList.toggle('d-none', !isCustom);
    customContainer.classList.toggle('d-flex', isCustom);
  };

  // Flatpickr — date+time pickers
  const fpConfig = {
    enableTime: true,
    time_24hr: true,
    allowInput: true,
    dateFormat: 'Y-m-d H:i',
  };

  const fromPicker = flatpickr('#fromDate', {
    ...fpConfig,
    onChange(dates) {
      if (dates[0]) toPicker.set('minDate', dates[0]);
    },
  });

  const toPicker = flatpickr('#toDate', {
    ...fpConfig,
    onChange(dates) {
      if (dates[0]) fromPicker.set('maxDate', dates[0]);
    },
  });

  rangeSelect.addEventListener('change', () => {
    updateVisibility();
    if (rangeSelect.value === 'custom') {
      if (!fromPicker.selectedDates.length) {
        const now = new Date();
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
        fromPicker.setDate(dayAgo);
        toPicker.setDate(now);
      }
    } else {
      fromPicker.clear();
      toPicker.clear();
      fromPicker.set('maxDate', null);
      toPicker.set('minDate', null);
      loadHistorical(rangeSelect.value, null, null, true);
    }
  });

  // Add module selector event listener
  if (moduleSelect) {
    moduleSelect.addEventListener('change', () => {
      updateParvadaInfo();
      // Update live data immediately
      updateLiveData();

      // Update historical data
      const range = rangeSelect.value;
      if (range === 'custom') {
        const from = document.getElementById('fromDate').value;
        const to = document.getElementById('toDate').value;
        if (from && to) loadHistorical("custom", from, to, true);
      } else {
        loadHistorical(range, null, null, true);
      }
    });
  }

  updateVisibility();
}

function getBaseUrl() {
  return window.location.origin;
}

// "2026-10-28 10:00" del selector (hora local) -> ISO en UTC para la API
function localPickerToUtcIso(value) {
  const date = new Date(String(value).trim().replace(' ', 'T'));
  return isNaN(date) ? value : date.toISOString();
}

async function fetchHistoricalData(range, from = null, to = null) {
  let url = `/api/historical?range=${encodeURIComponent(range)}`;
  if (from && to) {
    url += `&from=${encodeURIComponent(localPickerToUtcIso(from))}&to=${encodeURIComponent(localPickerToUtcIso(to))}`;
  }

  // Add module parameter
  const moduleSelect = document.getElementById('moduleSelect');
  if (moduleSelect) {
    const module = moduleSelect.value;
    url += `&house=${encodeURIComponent(module)}`;
    console.log(`Fetching data for range: ${range}, module: ${module}`);
  }

  console.log(`Final URL: ${url}`);
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`Data received:`, data);
    return data;
  } catch (err) {
    console.error("Error fetching data:", err);
    return null;
  }
}

function parseTimestamp(ts) {
  let date = null;
  if (typeof ts === 'string') date = new Date(ts);
  else if (typeof ts === 'number') {
    if (ts < 10000000000) ts *= 1000;
    date = new Date(ts);
  }
  return isNaN(date) ? new Date() : date;
}

function formatTimeAgo(date) {
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'Hace ' + seconds + ' segundos';
  if (minutes < 60) return 'Hace ' + minutes + ' minuto' + (minutes > 1 ? 's' : '');
  if (hours < 24) return 'Hace ' + hours + ' hora' + (hours > 1 ? 's' : '');
  return 'Hace ' + days + ' día' + (days > 1 ? 's' : '');
}

async function loadHistorical(range, from = null, to = null, clearFirst = false) {
  const historicalStatus =
    document.getElementById("historicalStatus") || createHistoricalStatus();

  historicalStatus.style.display = "none";

  if (clearFirst) clearAllCharts();

  const data = await fetchHistoricalData(range, from, to);

  if (!data || !data.timestamps || data.timestamps.length === 0) {
    historicalStatus.textContent = "Sin datos históricos";
    historicalStatus.className = "badge bg-warning";
    historicalStatus.style.display = "";
    return;
  }

  const chartsReady =
    temperatureChart &&
    humidityChart &&
    ammoniaChart &&
    coChart &&
    co2Chart &&
    oxygenChart;

  if (!chartsReady) {
    historicalStatus.textContent = "Gráficas no inicializadas";
    historicalStatus.className = "badge bg-warning";
    historicalStatus.style.display = "";
    return;
  }

  try {
    updateChart(temperatureChart, data.timestamps, data.temperature);
    updateChart(humidityChart, data.timestamps, data.humidity);
    updateChart(ammoniaChart, data.timestamps, data.ammonia);
    updateChart(coChart, data.timestamps, data.co);
    updateChart(co2Chart, data.timestamps, data.co2);
    updateChart(oxygenChart, data.timestamps, data.oxygen);
  } catch (error) {
    historicalStatus.textContent = `Error al graficar: ${error.message}`;
    historicalStatus.className = "badge bg-danger";
    historicalStatus.style.display = "";
    console.error("Error de gráficas:", error);
  }
  if (airVelocityChart && isAirVelocityEnabled()) {
    updateChart(airVelocityChart, data.timestamps, data.air_velocity || []);
  }
}

function applyCustomRange() {
  const from = document.getElementById('fromDate').value;
  const to = document.getElementById('toDate').value;

  if (!from || !to) {
    showDashboardAlert(t('dashboard.custom_range_required'), 'warning');
    return;
  }

  loadHistorical("custom", from, to, true);
}

// =========================================================
// DATOS EN TIEMPO REAL
// =========================================================

async function updateLiveData() {
  try {
    const moduleSelect = document.getElementById('moduleSelect');
    const module = moduleSelect ? moduleSelect.value : 'M1';

    const res = await fetch(`${getBaseUrl()}/api/live-data?modulo=${module}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    lastApiSuccess = Date.now();

    updateAllDeltas(data, previousLiveData);
    previousLiveData = data;
    updateMetricCards(data);

    if (data && data.timestamp) {
      const lastTs = parseTimestamp(data.timestamp);
      lastRealUpdate = lastTs;

      const dateStr = lastTs.toLocaleDateString('es-MX', {
        year: 'numeric', month: '2-digit', day: '2-digit'
      });
      const timeStr = lastTs.toLocaleTimeString('es-MX', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      document.getElementById('lastUpdate').textContent = `${dateStr} ${timeStr}`;
    }
  } catch (err) {
    console.error('Error actualizando live data:', err);
  }
}

// =========================================================
// MONITOREO DE CONEXIÓN
// =========================================================

setInterval(() => {
  const status  = document.getElementById("connectionStatus");
  const dot     = document.getElementById("connectionDot");
  const timeAgoEl = document.getElementById("lastUpdateTime");
  const lastDataTimeEl = document.getElementById("lastDataTime");

  if (!lastApiSuccess) {
    if (status) { status.className = 'fw-semibold text-muted'; status.textContent = t('dashboard.disconnected'); }
    if (dot)    dot.className = 'live-dot pending';
    if (timeAgoEl) timeAgoEl.textContent = "";
    return;
  }

  const secondsSinceApi = (Date.now() - lastApiSuccess) / 1000;
  const isConnected = secondsSinceApi <= 30;

  if (status) {
    status.className = `fw-semibold ${isConnected ? 'text-success' : 'text-danger'}`;
    status.textContent = isConnected ? t('dashboard.connected') : t('dashboard.disconnected');
  }
  if (dot) dot.className = `live-dot ${isConnected ? 'connected' : 'disconnected'}`;

  if (timeAgoEl && lastRealUpdate) {
    const sensorDiff = (Date.now() - lastRealUpdate.getTime()) / 1000;
    timeAgoEl.textContent = sensorDiff > 10 ? `· ${formatTimeAgo(lastRealUpdate)}` : '';
  }
  if (lastDataTimeEl && lastRealUpdate) {
    lastDataTimeEl.textContent = lastRealUpdate.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}, 2000);

function createHistoricalStatus() {
  const statusEl = document.createElement('span');
  statusEl.id = 'historicalStatus';
  statusEl.className = 'badge';
  statusEl.style.marginLeft = '10px';

  const connectionStatus = document.getElementById('connectionStatus');
  if (connectionStatus && connectionStatus.parentNode) {
    connectionStatus.parentNode.insertBefore(statusEl, connectionStatus.nextSibling);
  }

  return statusEl;
}

// =========================================================
// INICIALIZACIÓN Y INTERVALOS
// =========================================================

// Live data cada 1 segundo
// La actualización coincide con el firmware (5s) para ahorrar recursos
setInterval(updateLiveData, 5000); // 5000ms = 5 segundos

// Mini alertas cada 30 segundos
setInterval(loadMiniAlerts, 30000);

// Histórico cada 10 segundos
setInterval(() => {
  const range = document.getElementById('rangeSelect').value;
  if (range === 'custom') {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    if (from && to) loadHistorical("custom", from, to);
  } else {
    loadHistorical(range);
  }
}, 10000);

// =========================================================
// GESTIÓN DE UMBRALES
// =========================================================

// Configuración de rangos para sliders de umbrales
const THRESHOLD_SLIDER_CONFIG = {
  temperatura: { min: -40, max: 125, step: 0.5 },
  humedad: { min: 0, max: 100, step: 1 },
  co: { min: 0, max: 500, step: 1 },
  co2: { min: 400, max: 5000, step: 10 },
  amoniaco: { min: 0, max: 100, step: 1 }
};

function getThresholdSliderConfig(variable) {
  return THRESHOLD_SLIDER_CONFIG[variable] || { min: 0, max: 100, step: 1 };
}

// ... rest of the code remains the same ...
function syncThresholdSlider(variable, level, value) {
  const slider = document.getElementById(`${variable}_${level}_slider`);
  if (!slider) return;
  const num = parseFloat(value);
  if (!isNaN(num)) slider.value = num;
}

// Sincronizar input numérico cuando cambia el slider
function syncThresholdInput(variable, level, value) {
  const input = document.getElementById(`${variable}_${level}_input`);
  if (!input) return;
  input.value = value;
}

async function loadThresholds() {
  try {
    const res = await fetch(`${getBaseUrl()}/api/umbrales`);
    if (!res.ok) throw new Error('Error loading thresholds');
    const data = await res.json();

    const tbody = document.getElementById('thresholdsTableBody');
    tbody.innerHTML = '';

    // Order: temp, hum, co, co2, ammonia
    const order = ['temperatura', 'humedad', 'co', 'co2', 'amoniaco'];

    let items = data;

    // If there are no thresholds yet, create empty rows so the user can define them
    if (!Array.isArray(items) || items.length === 0) {
      items = order.map(variable => ({
        variable,
        valor_medio: '',
        valor_alto: '',
        valor_grave: ''
      }));
    } else {
      // Sort data based on preferred order
      items.sort((a, b) => order.indexOf(a.variable) - order.indexOf(b.variable));
    }

    items.forEach(item => {
      const row = document.createElement('tr');
      const label = item.variable.charAt(0).toUpperCase() + item.variable.slice(1);

      const cfg = getThresholdSliderConfig(item.variable);

      const medioVal = item.valor_medio !== '' && item.valor_medio != null ? item.valor_medio : cfg.min;
      const altoVal = item.valor_alto !== '' && item.valor_alto != null ? item.valor_alto : cfg.min;
      const graveVal = item.valor_grave !== '' && item.valor_grave != null ? item.valor_grave : cfg.min;

      row.innerHTML = `
            <td>${label}</td>
            <td>
              <div class="d-flex flex-column">
                <input
                  id="${item.variable}_medio_input"
                  type="number"
                  step="${cfg.step}"
                  class="form-control form-control-sm mb-1"
                  name="${item.variable}_medio"
                  value="${medioVal}"
                  oninput="syncThresholdSlider('${item.variable}','medio', this.value)">
                <input
                  id="${item.variable}_medio_slider"
                  type="range"
                  class="form-range"
                  min="${cfg.min}"
                  max="${cfg.max}"
                  step="${cfg.step}"
                  value="${medioVal}"
                  oninput="syncThresholdInput('${item.variable}','medio', this.value)">
              </div>
            </td>
            <td>
              <div class="d-flex flex-column">
                <input
                  id="${item.variable}_alto_input"
                  type="number"
                  step="${cfg.step}"
                  class="form-control form-control-sm mb-1"
                  name="${item.variable}_alto"
                  value="${altoVal}"
                  oninput="syncThresholdSlider('${item.variable}','alto', this.value)">
                <input
                  id="${item.variable}_alto_slider"
                  type="range"
                  class="form-range"
                  min="${cfg.min}"
                  max="${cfg.max}"
                  step="${cfg.step}"
                  value="${altoVal}"
                  oninput="syncThresholdInput('${item.variable}','alto', this.value)">
              </div>
            </td>
            <td>
              <div class="d-flex flex-column">
                <input
                  id="${item.variable}_grave_input"
                  type="number"
                  step="${cfg.step}"
                  class="form-control form-control-sm mb-1"
                  name="${item.variable}_grave"
                  value="${graveVal}"
                  oninput="syncThresholdSlider('${item.variable}','grave', this.value)">
                <input
                  id="${item.variable}_grave_slider"
                  type="range"
                  class="form-range"
                  min="${cfg.min}"
                  max="${cfg.max}"
                  step="${cfg.step}"
                  value="${graveVal}"
                  oninput="syncThresholdInput('${item.variable}','grave', this.value)">
              </div>
            </td>
        `;
      tbody.appendChild(row);
    });
  } catch (err) {
    console.error('Error loading thresholds:', err);
    alert('Error cargando umbrales');
  }
}

async function saveThresholds() {
  // Solo leer los inputs numéricos (los sliders son solo para ajuste visual)
  const inputs = document.querySelectorAll('#thresholdsTableBody input[type="number"]');
  const updates = {};

  inputs.forEach(input => {
    const [variable, type] = input.name.split('_');
    if (!updates[variable]) updates[variable] = { variable: variable };

    if (type === 'medio') updates[variable].valor_medio = parseFloat(input.value);
    if (type === 'alto') updates[variable].valor_alto = parseFloat(input.value);
    if (type === 'grave') updates[variable].valor_grave = parseFloat(input.value);
  });

  const payload = Object.values(updates);

  try {
    const res = await fetch(`${getBaseUrl()}/api/umbrales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      showDashboardAlert(t('dashboard.thresholds_saved'), 'success');
      const modal = bootstrap.Modal.getInstance(document.getElementById('thresholdsModal'));
      modal.hide();
    } else {
      throw new Error(await dashboardApiError(
        res,
        t('dashboard.thresholds_error')
      ));
    }
  } catch (err) {
    console.error('Error saving thresholds:', err);
    showDashboardAlert(
      err.message || t('dashboard.thresholds_error'),
      'danger'
    );
  }
}

// Expose to window
window.saveThresholds = saveThresholds;

// Add event listener for modal open
document.addEventListener('DOMContentLoaded', () => {
  const modalEl = document.getElementById('thresholdsModal');
  if (modalEl) {
    modalEl.addEventListener('show.bs.modal', loadThresholds);
  }
});
